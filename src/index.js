// Conductor: splits a big goal into small checked sub-goals, reuses proven modules, runs the rest through the Stack Builder
// worker, and keeps every job's state so it can resume. Free plan: Cloudflare Worker + one KV namespace (binding CONDUCTOR).
// Secrets: AUTH_TOKEN, BUILDER_URL, BUILDER_TOKEN, GROQ_API_KEY and/or OPENROUTER_API_KEY.
import { J, uid, VERSION } from "./util.js";
import { checkSplit } from "./contract.js";
import { decompose } from "./decompose.js";
import { builder } from "./builder.js";
import { listModules, getModule, putModule, importRecipes } from "./modules.js";
import { createJob, advance, resume, advanceAll, getJob, viewJob } from "./executor.js";

const PAGE = `<!doctype html><meta name=viewport content="width=device-width,initial-scale=1"><title>Conductor</title>
<body style="font-family:system-ui;max-width:760px;margin:12px auto;padding:0 10px">
<h2>Conductor <small style="font-weight:normal;font-size:13px;color:#666">${VERSION}</small></h2>
<input id=t placeholder="AUTH_TOKEN" style="width:100%;padding:8px"><br><br>
<textarea id=g rows=5 placeholder="Describe a big goal" style="width:100%;padding:8px"></textarea><br>
<textarea id=iv rows=2 placeholder='Values, e.g. {"repo":"me/app"}' style="width:100%;padding:8px"></textarea><br>
<label><input type=checkbox id=dr checked> dry run (sends are only previewed)</label>
<label><input type=checkbox id=ac> also use candidate modules</label><br><br>
<button id=dc>1. Split the goal</button> <button id=mj>2. Make job</button> <button id=ad>3. Advance</button> <button id=sj>Show job</button> <button id=rs>Resume</button><br><br>
<input id=jid placeholder="job id" style="padding:6px;width:46%"> <input id=pid placeholder="split id" style="padding:6px;width:46%"><br><br>
<button id=bc>Check builder link</button> <button id=im>Import builder recipes</button> <button id=ml>Modules</button> <input id=mid placeholder="module id" style="padding:6px;width:30%"> <button id=mp>Mark proven</button> <button id=ms>Mark stale</button>
<pre id=o style="white-space:pre-wrap;background:#f4f4f4;padding:8px;margin-top:12px;min-height:60px"></pre>
<script>
const $=i=>document.getElementById(i);t.value=localStorage.ct||"";
const H=()=>{localStorage.ct=t.value;return{"authorization":"Bearer "+t.value.trim(),"content-type":"application/json"}};
const call=async(p,m,b)=>{o.textContent="Working...";try{const x=await fetch(p,{method:m,headers:H(),body:b?JSON.stringify(b):undefined});const s=await x.text();let d=null;try{d=JSON.parse(s)}catch(e){}
if(d&&d.plan_id)pid.value=d.plan_id;if(d&&d.job_id)jid.value=d.job_id;if(d&&d.id&&String(d.id).startsWith("j"))jid.value=d.id;o.textContent=d?JSON.stringify(d,null,2):s}catch(e){o.textContent="Error: "+e.message}};
const vals=()=>{try{return iv.value?JSON.parse(iv.value):{}}catch(e){o.textContent="Values must be valid JSON";return null}};
dc.onclick=()=>call("/decompose","POST",{goal:g.value});
mj.onclick=()=>{const v=vals();if(!v)return;call("/job","POST",{plan_id:pid.value.trim(),goal:g.value,inputs:v,dry:dr.checked,allow_candidates:ac.checked})};
ad.onclick=()=>call("/job/"+jid.value.trim()+"/advance","POST",{});
sj.onclick=()=>call("/job/"+jid.value.trim(),"GET");
rs.onclick=()=>call("/job/"+jid.value.trim()+"/resume","POST",{});
bc.onclick=()=>call("/builder/check","GET");
im.onclick=()=>call("/modules/import","POST",{});
ml.onclick=()=>call("/modules","GET");
mp.onclick=()=>call("/module/"+mid.value.trim()+"/status","POST",{status:"proven"});
ms.onclick=()=>call("/module/"+mid.value.trim()+"/status","POST",{status:"stale"});
</script></body>`;

export default {
  async fetch(req, env) {
    const u = new URL(req.url);
    if (req.method === "GET" && u.pathname === "/") return new Response(PAGE, { headers: { "content-type": "text/html;charset=utf-8" } });
    if (!env.AUTH_TOKEN) return J({ error: "AUTH_TOKEN secret is not set" }, 401);
    if ((req.headers.get("authorization") || "").trim() !== `Bearer ${env.AUTH_TOKEN.trim()}`) return J({ error: "wrong token" }, 401);
    if (!env.CONDUCTOR) return J({ error: "the CONDUCTOR KV namespace is not bound: check wrangler.toml" }, 500);
    const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
    const parts = u.pathname.split("/").filter(Boolean);
    try {
      if (req.method === "POST" && u.pathname === "/decompose") {
        if (!String(body.goal || "").trim()) return J({ error: "give a goal" }, 400);
        const r = await decompose(env, String(body.goal), await listModules(env));
        if (!r.plan) return J({ error: "could not split the goal", trace: r.trace }, 502);
        const plan_id = uid("p");
        await env.CONDUCTOR.put("plan:" + plan_id, JSON.stringify(r.plan));
        return J({ plan_id, status: r.draft ? "draft" : "ok", problems: r.check.errors, order: r.check.order, plan: r.plan, model: r.model, trace: r.trace,
          next: r.draft ? "The split still has problems (see problems). Rewrite the goal more clearly, or split it again." : "Split is consistent. Press Make job (dry run first)." });
      }
      if (req.method === "POST" && u.pathname === "/job") {
        let plan = null;
        if (body.plan_id) plan = await env.CONDUCTOR.get("plan:" + body.plan_id, "json");
        else if (body.plan) plan = body.plan;
        if (!plan) return J({ error: "give a plan_id from /decompose" }, 404);
        const check = checkSplit(plan); if (!check.ok) return J({ error: "the split is not consistent", problems: check.errors }, 400);
        const job = await createJob(env, { goal: body.goal, plan, inputs: body.inputs || {}, dry: body.dry !== false, allow_candidates: !!body.allow_candidates });
        return J({ job_id: job.id, ...viewJob(job), next: "Press Advance until the status is done. Dry run: sends are only previewed." });
      }
      if (parts[0] === "job" && parts[1]) {
        const job = await getJob(env, parts[1]); if (!job) return J({ error: "job not found" }, 404);
        if (req.method === "GET" && !parts[2]) return J(viewJob(job, u.searchParams.get("full") === "1"));
        if (req.method === "POST" && parts[2] === "advance") {
          let j = job; const n = Math.max(1, Math.min(3, Number(body.steps) || 1));
          for (let i = 0; i < n && j.status === "running"; i++) j = await advance(env, j.id);
          return J(viewJob(j));
        }
        if (req.method === "POST" && parts[2] === "resume") return J(viewJob(await resume(env, parts[1])));
      }
      if (req.method === "GET" && u.pathname === "/jobs") {
        const l = await env.CONDUCTOR.list({ prefix: "job:" }); const out = [];
        for (const k of l.keys.slice(-30)) { const j = await env.CONDUCTOR.get(k.name, "json"); if (j) out.push({ id: j.id, status: j.status, goal: String(j.goal).slice(0, 80), dry: j.dry }); }
        return J({ jobs: out });
      }
      if (req.method === "GET" && u.pathname === "/modules") {
        const m = await listModules(env);
        return J({ count: m.length, modules: m.map((x) => ({ id: x.id, status: x.status, does: x.does, inputs: x.inputs.map((i) => i.name), outputs: x.outputs.map((o) => o.name), effects: x.effects, proof: `${x.proof.ok_runs}/${x.proof.real_runs} ok, ${x.proof.ok_inputs.length} different inputs`, notes: x.notes })) });
      }
      if (req.method === "GET" && u.pathname === "/builder/check") return J({ version: VERSION, ...(await builder(env).check()) });
      if (req.method === "POST" && u.pathname === "/modules/import") return J(await importRecipes(env, builder(env)));
      if (parts[0] === "module" && parts[1]) {
        const m = await getModule(env, parts[1]); if (!m) return J({ error: "module not found" }, 404);
        if (req.method === "GET" && !parts[2]) return J(m);
        if (req.method === "POST" && parts[2] === "status") {
          if (!["candidate", "proven", "stale"].includes(body.status)) return J({ error: "status must be candidate, proven or stale" }, 400);
          m.status = body.status; m.notes = [...(m.notes || []), `status set to ${body.status} by the owner on ${new Date().toISOString().slice(0, 10)}`].slice(-8);
          return J(await putModule(env, m));
        }
      }
      return J({ error: "not found" }, 404);
    } catch (e) { return J({ error: e.message }, 500); }
  },
  async scheduled(event, env, ctx) { ctx.waitUntil(advanceAll(env).catch(() => {})); },
};
