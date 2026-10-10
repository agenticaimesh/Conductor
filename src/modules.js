// The module library: a sub-goal that worked becomes a reusable module with a contract and a proof record.
// Status: candidate -> proven (>= 2 successful REAL runs with >= 2 different inputs) -> stale (2 failures in a row).
// A module wraps either a saved recipe of the builder (via.type "recipe") or a plan of the builder (via.type "plan").
import { hashInputs, today, wordSet, cut } from "./util.js";
import { typesFit } from "./contract.js";

const KEY = (id) => "mod:" + id;
const slug = (x) => String(x || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
export const newProof = () => ({ real_runs: 0, ok_runs: 0, consecutive_fails: 0, ok_inputs: [], last_ok: null, last_fail: null });

export async function getModule(env, id) { return (await env.CONDUCTOR.get(KEY(id), "json")) || null; }
export async function putModule(env, m) { m.updated = new Date().toISOString(); await env.CONDUCTOR.put(KEY(m.id), JSON.stringify(m)); return m; }
export async function listModules(env) {
  const out = []; let cursor;
  do {
    const l = await env.CONDUCTOR.list({ prefix: "mod:", cursor });
    for (const k of l.keys) { const m = await env.CONDUCTOR.get(k.name, "json"); if (m) out.push(m); }
    cursor = l.list_complete === false ? l.cursor : undefined;
  } while (cursor);
  return out;
}

// Literal values typed into a plan's steps: what a saved plan cannot change by itself.
function fixedValues(bp) {
  const out = [];
  const walk = (k, v) => {
    if (v == null) return;
    if (typeof v === "string") { if (!v.startsWith("$") && !v.includes("{{") && v.length <= 80 && !/^(application\/json|GET|POST)$/i.test(v)) out.push(`${k}=${v}`); }
    else if (typeof v === "number" || typeof v === "boolean") out.push(`${k}=${v}`);
    else if (Array.isArray(v)) v.forEach((x, i) => walk(`${k}[${i}]`, x));
    else if (typeof v === "object") for (const [kk, vv] of Object.entries(v)) walk(k ? `${k}.${kk}` : kk, vv);
  };
  for (const n of bp?.routing_table || []) walk("", n.static || {});
  return [...new Set(out)].slice(0, 14);
}
const hasPlace = (bp) => (bp?.routing_table || []).some((n) => /^-?\d/.test(String(n.static?.latitude ?? n.static?.lat ?? "")) && /^-?\d/.test(String(n.static?.longitude ?? n.static?.lon ?? n.static?.lng ?? "")));
const effectsOf = (bp) => [...new Set((bp?.routing_table || []).filter((n) => String(n.method).toUpperCase() !== "GET" && !/\/chat\/completions$/.test(n.url || "")).map((n) => { try { return new URL(n.url).host; } catch { return n.tool; } }))];
const tagsOf = (text, bp) => [...wordSet(text)].concat((bp?.routing_table || []).map((n) => slug(n.tool_name || n.tool))).filter(Boolean).slice(0, 24);

// Build a candidate module from a builder recipe (meta from /recipe/<slug>, bp from /blueprint/<bp_id>).
export function moduleFromRecipe(meta, bp) {
  const notes = [];
  const inputs = (meta.inputs_needed || []).map((n) => ({ name: n, type: "string", required: true }));
  if (hasPlace(bp)) { inputs.push({ name: "city", type: "string", required: false }); notes.push('Place-based: send "city" to change the location (the builder looks it up). Without it the recipe uses the place it was saved with.'); }
  const llm = (bp?.routing_table || []).some((n) => /\/chat\/completions$/.test(n.url || ""));
  const outputs = [{ name: "text", type: "string" }];
  notes.push(llm ? "Output contract guessed: the language-model step's text. Check it." : "Output contract guessed (text). Check it.");
  return {
    id: slug(meta.slug), does: cut(meta.goal || meta.slug, 160), tags: tagsOf(meta.goal + " " + (meta.tools || ""), bp), inputs, outputs,
    via: { type: "recipe", slug: meta.slug }, effects: effectsOf(bp), needs_secrets: [...new Set(bp?.secrets_needed || [])], needs_config: meta.config_needed || [],
    fixed_values: fixedValues(bp), notes, proof: newProof(), legacy_proof: meta.proven ? meta.proven_on : null,
    status: "candidate", source: "recipe-import", created: new Date().toISOString(),
  };
}
// Build a candidate module from a plan the builder made for a sub-goal, after it ran for real.
export function moduleFromSubgoal(sg, planId, bp) {
  return {
    id: slug(sg.id + "-" + sg.title).slice(0, 48), does: cut(sg.does, 160), tags: tagsOf(sg.title + " " + sg.does, bp),
    inputs: (sg.inputs || []).filter((i) => i.from !== "each").concat(sg.for_each ? [{ name: sg.for_each.as, type: "any" }] : []).map((i) => ({ name: i.name, type: i.type || "any", required: true })),
    outputs: (sg.outputs || []).map((o) => ({ name: o.name, type: sg.for_each ? String(o.type).replace(/^list/i, "any") : o.type })),
    via: { type: "plan", id: planId }, effects: effectsOf(bp), needs_secrets: [...new Set(bp?.secrets_needed || [])], needs_config: bp?.config_needed || [],
    fixed_values: fixedValues(bp), notes: ["Made from a sub-goal. Literal values in fixed_values are baked in: check they are not specific to one example."],
    proof: newProof(), status: "candidate", source: "subgoal-run", created: new Date().toISOString(),
  };
}

// Import every saved recipe of the builder as a candidate module. Existing modules (and their proof) are never overwritten.
export async function importRecipes(env, b) {
  const list = await b.recipes();
  if (!list.ok) { const c = await b.check(); return { ok: false, error: `the builder answered HTTP ${list.status} at ${c.called}`, hint: c.hint, body: c.body }; }
  const added = [], kept = [], failed = [];
  for (const r of list.data.recipes || []) {
    const id = slug(r.slug);
    if (await getModule(env, id)) { kept.push(id); continue; }
    const meta = await b.recipe(r.slug);
    if (!meta.ok || !meta.data?.bp_id) { failed.push(r.slug); continue; }
    const bp = await b.blueprint(meta.data.bp_id);
    const m = moduleFromRecipe({ ...meta.data, slug: r.slug }, bp.ok ? bp.data : null);
    if (!bp.ok) m.notes.push("The plan steps could not be read, so fixed values and place support are unknown.");
    await putModule(env, m); added.push(m.id);
  }
  return { ok: true, added, kept, failed };
}

// Deterministic lookup: word overlap + input/output fit. proven modules rank above candidates; stale ones are skipped.
export function findModules(modules, sg, { includeCandidates = false } = {}) {
  const want = wordSet(sg.title + " " + sg.does);
  const outNames = new Set((sg.outputs || []).map((o) => o.name));
  const scored = [];
  // A module that DOES something to the outside world (sends an email, posts, commits...)
  // (kept narrow on purpose: wrongly skipping a module only costs a fresh plan, wrongly reusing one that emails costs a surprise email;
  // so "write", "create", "open", "update" are NOT in the list - a language model also "writes" a sentence) is only reused for a sub-goal that itself
  // asks for such an action. Otherwise a "get the weather" step could silently reuse a recipe that also emails you.
  const asksForAction = /\b(send|sends|email|e-mail|mail|post|notify|message|slack|publish|commit|push|deploy|delete|submit|upload|pay|buy)\b/i.test(`${sg.title} ${sg.does}`);
  for (const m of modules) {
    if (m.status === "stale") continue;
    if (m.status === "candidate" && !includeCandidates) continue;
    if ((m.effects || []).length && !asksForAction) continue;
    const have = wordSet(m.does + " " + (m.tags || []).join(" "));
    let hit = 0; for (const w of want) if (have.has(w)) hit++;
    let score = want.size ? hit / Math.sqrt(want.size * Math.max(1, have.size)) : 0;
    const given = new Set((sg.inputs || []).map((i) => i.name));
    const mustHave = (m.inputs || []).filter((i) => i.required);
    const covered = mustHave.filter((i) => given.has(i.name) || (sg.for_each && sg.for_each.as === i.name)).length;
    if (mustHave.length && covered < mustHave.length) score *= 0.4; // it needs inputs this sub-goal does not supply
    const outOk = [...outNames].every((n) => (m.outputs || []).some((o) => o.name === n)); // names the later steps rely on
    if (outOk && outNames.size) score += 0.15;
    for (const i of sg.inputs || []) { const mi = (m.inputs || []).find((x) => x.name === i.name); if (mi && !typesFit(i.type, mi.type)) score *= 0.7; }
    if (m.status === "proven") score += 0.1;
    scored.push({ id: m.id, status: m.status, score: Math.round(score * 100) / 100, outputs_match: outOk });
  }
  return scored.filter((x) => x.score >= 0.2).sort((a, b) => b.score - a.score).slice(0, 5);
}

// Count one REAL (not dry) run. Promotion needs two successes with two different inputs: one lucky run proves nothing.
export async function recordRun(env, id, inputs, ok) {
  const m = await getModule(env, id); if (!m) return null;
  const p = (m.proof = { ...newProof(), ...(m.proof || {}) });
  p.real_runs++;
  if (ok) { p.ok_runs++; p.consecutive_fails = 0; p.last_ok = today(); const h = hashInputs(inputs); if (!p.ok_inputs.includes(h)) p.ok_inputs = [...p.ok_inputs, h].slice(-20); }
  else { p.consecutive_fails++; p.last_fail = today(); }
  if (m.status === "candidate" && p.ok_runs >= 2 && p.ok_inputs.length >= 2) m.status = "proven";
  else if (m.status === "proven" && p.consecutive_fails >= 2) m.status = "stale";
  else if (m.status === "stale" && ok) m.status = "candidate";
  await putModule(env, m); return m;
}
