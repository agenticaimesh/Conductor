// Runs a checked split as a JOB. Each sub-goal is a step with its own saved state in KV, so a job survives restarts, a failed
// step can be retried or resumed alone, and later steps reuse the saved outputs of earlier ones. One advance() call does a
// bounded amount of work (one step, or up to 5 items of a for_each) so it stays inside the free plan's 50-subrequest limit.
import { builder } from "./builder.js";
import { checkSplit, isList, DEFAULT_CAP, MAX_CAP } from "./contract.js";
import { listModules, getModule, findModules, recordRun, moduleFromSubgoal, putModule } from "./modules.js";
import { uid, cut } from "./util.js";

export const MAX_ATTEMPTS = 2;
const JOB = (id) => "job:" + id;
export const getJob = async (env, id) => (await env.CONDUCTOR.get(JOB(id), "json")) || null;
export const putJob = async (env, j) => { j.updated = new Date().toISOString(); await env.CONDUCTOR.put(JOB(j.id), JSON.stringify(j)); return j; };

export async function createJob(env, { goal, plan, inputs = {}, dry = true, allow_candidates = false }) {
  const check = checkSplit(plan);
  if (!check.ok) throw new Error("the split is not consistent: " + check.errors.slice(0, 3).join(" | "));
  const missing = (plan.user_inputs || []).filter((u) => inputs[u.name] === undefined || inputs[u.name] === "").map((u) => u.name);
  if (missing.length) throw new Error("missing values: " + missing.join(", "));
  const modules = await listModules(env);
  const steps = {};
  for (const id of check.order) {
    const sg = plan.subgoals.find((s) => s.id === id);
    const hit = findModules(modules, sg, { includeCandidates: allow_candidates })[0];
    const use = hit && hit.score >= 0.5 && hit.outputs_match ? hit : null; // a module is reused only when it clearly fits AND offers the outputs later steps need
    steps[id] = { status: "pending", module: use?.id || null, match_score: hit?.score ?? null, attempts: 0, output: null, error: null, items: [] };
  }
  return putJob(env, { id: uid("j"), goal: goal || plan.goal || "", plan, order: check.order, inputs, dry: dry !== false, allow_candidates: !!allow_candidates, status: "running", steps, created: new Date().toISOString() });
}

const depsOf = (sg) => {
  const d = new Set(); const add = (f) => { const m = String(f || "").match(/^([a-z][a-z0-9_]*)\./); if (m && m[1] !== "user") d.add(m[1]); };
  for (const i of sg.inputs || []) if (i.from !== "each") add(i.from);
  if (sg.for_each) add(sg.for_each.from);
  return [...d];
};
const lookup = (job, from) => {
  if (String(from).startsWith("user.")) return job.inputs?.[from.slice(5)];
  const [sid, ...rest] = String(from).split("."); const out = job.steps[sid]?.output;
  return out ? out[rest.join(".")] : undefined;
};
function gather(job, sg, item) {
  const vals = {}, missing = [];
  for (const i of sg.inputs || []) {
    const v = i.from === "each" ? item : lookup(job, i.from);
    if (v === undefined || v === null || v === "") missing.push(i.name); else vals[i.name] = v;
  }
  if (sg.for_each && item !== undefined && vals[sg.for_each.as] === undefined) vals[sg.for_each.as] = item;
  return { vals, missing };
}
const asList = (v) => { if (Array.isArray(v)) return v; if (v && typeof v === "object") { const a = Object.values(v).find(Array.isArray); if (a) return a; } return null; };

function extractOutputs(sg, data, job) {
  const nodes = data.outputs || {};
  const done = (data.report || []).filter((r) => r.ok && !r.skipped).map((r) => r.node).reverse();
  const lastNode = [...done, ...Object.keys(nodes).reverse()].find((n) => nodes[n] !== undefined);
  const out = {}; const missing = [];
  for (const o of sg.outputs || []) {
    let v;
    for (const n of done) { const x = nodes[n]; if (x && typeof x === "object" && o.name in x) { v = x[o.name]; break; } }
    if (v === undefined && sg.outputs.length === 1 && lastNode) { const x = nodes[lastNode]; v = x && typeof x === "object" && x.text !== undefined ? x.text : x; }
    if (!sg.for_each && isList(o.type) && v && !Array.isArray(v)) v = asList(v) ?? v;
    if (v === undefined) missing.push(o.name);
    out[o.name] = v === undefined ? null : v;
  }
  if (missing.length && !(sg.final && job.dry)) return { error: `the run finished but did not produce: ${missing.join(", ")}. The step's output names do not match the contract` };
  return { outputs: out };
}

async function runOnce(env, job, sg, step, vals) {
  const b = builder(env); let res;
  if (step.module) {
    const m = await getModule(env, step.module);
    if (!m) return { error: `module ${step.module} no longer exists` };
    res = m.via.type === "recipe" ? await b.runRecipe(m.via.slug, vals, job.dry) : await b.run(m.via.id, vals, job.dry);
  } else {
    if (!step.plan_id) {
      const names = Object.keys(vals).join(", ");
      const goal = `${sg.does}. Use these input values: ${Object.entries(vals).map(([k, v]) => `${k}=${cut(typeof v === "string" ? v : JSON.stringify(v), 160)}`).join("; ")}. The result needed: ${(sg.outputs || []).map((o) => o.name).join(", ")}.`;
      const p = await b.plan(goal, `Name the inputs exactly: ${names}. These values change on every run: take them as inputs, never as fixed values.`);
      if (!p.ok || !p.data?.id) return { error: "the builder could not plan this sub-goal: " + cut(p.data?.error || p.data?.message || JSON.stringify(p.data), 220) };
      if (p.data.status && p.data.status !== "ok") return { error: `the builder only produced a "${p.data.status}" plan for this sub-goal: ` + cut(p.data.message || p.data.summary || "", 220) };
      step.plan_id = p.data.id;
    }
    res = await b.run(step.plan_id, vals, job.dry);
  }
  if (!res.ok) return { error: `the builder answered HTTP ${res.status}: ${cut(res.data?.error || JSON.stringify(res.data), 220)}` };
  const st = res.data.status;
  if (st === "no_data") return { no_data: true, outputs: {} };
  if (st !== "ok" && st !== "dry_run_ok") {
    const bad = (res.data.report || []).find((r) => r.ok === false && !r.skipped);
    return { error: `run ${st}` + (bad ? `: ${bad.node} (${bad.tool}) HTTP ${bad.status || "?"} ${cut(String(bad.output_preview || bad.reason || ""), 160)}` : ""), failedRun: true };
  }
  return extractOutputs(sg, res.data, job);
}

// A real (not dry) successful run of a step that had no module teaches the library: save it as a candidate and count the run.
async function learn(env, job, sg, step, vals, ok) {
  if (job.dry) return;
  try {
    if (step.module) { await recordRun(env, step.module, vals, ok); return; }
    if (!step.plan_id) return;
    if (!step.saved_module && ok) {
      const bp = await builder(env).blueprint(step.plan_id);
      const m = moduleFromSubgoal(sg, step.plan_id, bp.ok ? bp.data : null);
      if (!(await getModule(env, m.id))) await putModule(env, m);
      step.saved_module = m.id;
    }
    if (step.saved_module) await recordRun(env, step.saved_module, vals, ok);
  } catch {}
}
const fail = (step, msg, immediate) => { step.error = msg; step.attempts = immediate ? MAX_ATTEMPTS : step.attempts + 1; step.status = step.attempts >= MAX_ATTEMPTS ? "failed" : "pending"; };

export async function advance(env, jobId, { maxItems = 5 } = {}) {
  const job = await getJob(env, jobId); if (!job) return null;
  if (job.status !== "running") return job;
  const sgs = Object.fromEntries(job.plan.subgoals.map((s) => [s.id, s]));
  // steps whose input came from a step that had no data are skipped on purpose
  for (const id of job.order) {
    const st = job.steps[id];
    if (st.status === "pending" && depsOf(sgs[id]).some((d) => job.steps[d].no_data || job.steps[d].status === "skipped")) { st.status = "skipped"; st.error = "an earlier step had nothing to pass on"; }
  }
  const id = job.order.find((i) => job.steps[i].status === "pending" && depsOf(sgs[i]).every((d) => job.steps[d].status === "done"));
  if (!id) {
    const sts = job.order.map((i) => job.steps[i].status);
    job.status = sts.every((s) => s === "done" || s === "skipped") ? "done" : "failed";
    return putJob(env, job);
  }
  const sg = sgs[id], step = job.steps[id];
  if (!sg.for_each) {
    const { vals, missing } = gather(job, sg);
    if (missing.length) fail(step, `missing input value(s): ${missing.join(", ")}`, true);
    else {
      const r = await runOnce(env, job, sg, step, vals);
      if (r.error) { fail(step, r.error); if (r.failedRun) await learn(env, job, sg, step, vals, false); }
      else { step.status = "done"; step.error = null; step.no_data = !!r.no_data; step.output = r.outputs; await learn(env, job, sg, step, vals, true); }
    }
  } else {
    const list = asList(lookup(job, sg.for_each.from));
    if (!list) fail(step, `for_each needs a list from ${sg.for_each.from}, but it is not a list`, true);
    else {
      const cap = Math.min(Number(sg.for_each.cap) || DEFAULT_CAP, MAX_CAP), items = list.slice(0, cap);
      step.total = items.length; step.capped = list.length > cap;
      let n = 0;
      while (step.items.length < items.length && n < maxItems) {
        const { vals, missing } = gather(job, sg, items[step.items.length]);
        if (missing.length) { fail(step, `missing input value(s): ${missing.join(", ")}`, true); break; }
        const r = await runOnce(env, job, sg, step, vals);
        if (r.error) { fail(step, `item ${step.items.length + 1} of ${items.length}: ${r.error}`); if (r.failedRun) await learn(env, job, sg, step, vals, false); break; }
        step.items.push(r.no_data ? null : r.outputs); step.error = null; n++;
        await learn(env, job, sg, step, vals, true);
      }
      if (step.status !== "failed" && step.items.length >= items.length && !step.error) {
        step.output = Object.fromEntries((sg.outputs || []).map((o) => [o.name, step.items.filter((x) => x).map((x) => x[o.name])]));
        step.status = "done"; step.no_data = !step.items.some(Boolean) && items.length > 0;
      }
    }
  }
  if (job.order.every((i) => ["done", "skipped"].includes(job.steps[i].status))) job.status = "done";
  else if (job.order.some((i) => job.steps[i].status === "failed")) job.status = "failed";
  return putJob(env, job);
}

export async function resume(env, jobId) {
  const job = await getJob(env, jobId); if (!job) return null;
  for (const id of job.order) { const st = job.steps[id]; if (st.status === "failed" || st.status === "skipped") { st.status = "pending"; st.attempts = 0; st.error = null; } }
  job.status = "running";
  return putJob(env, job);
}

export async function advanceAll(env, { maxJobs = 3 } = {}) {
  const l = await env.CONDUCTOR.list({ prefix: "job:" }); const out = [];
  for (const k of l.keys) {
    if (out.length >= maxJobs) break;
    const j = await env.CONDUCTOR.get(k.name, "json");
    if (j?.status === "running") { const r = await advance(env, j.id); out.push({ id: j.id, status: r?.status }); }
  }
  return out;
}

// What the person sees: step states with short previews (the full outputs stay in KV; ?full=1 returns them).
export function viewJob(job, full) {
  const prev = (v) => (full ? v : v == null ? v : cut(JSON.stringify(v), 400));
  return { id: job.id, goal: job.goal, status: job.status, dry: job.dry, updated: job.updated,
    steps: job.order.map((id) => { const s = job.steps[id], sg = job.plan.subgoals.find((x) => x.id === id);
      return { id, title: sg.title, status: s.status, how: s.module ? `module ${s.module}` : s.plan_id ? `new plan ${s.plan_id}` : "will be planned", attempts: s.attempts, error: s.error || undefined,
        ...(s.total ? { items: `${s.items.length}/${s.total}${s.capped ? " (capped)" : ""}` } : {}), ...(s.saved_module ? { saved_as_module: s.saved_module } : {}), output: prev(s.output) }; }) };
}
