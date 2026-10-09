// The contract format for a split goal, and the DETERMINISTIC check of it (no LLM): this is "step4" one level up.
//
// plan = {
//   goal: "...",
//   user_inputs: [{ name, type }],                       values the person supplies
//   subgoals: [{
//     id: "sg1", title, does,                            one small job, plain words
//     inputs:  [{ name, type, from }],                   from = "user.<name>" | "<subgoal id>.<output name>" | "each"
//     outputs: [{ name, type }],
//     for_each: { from: "sg1.items", as: "item", cap: 10 },   optional: run once per list item
//     final: true                                        true for the subgoal(s) whose result is the goal's deliverable
//   }]
// }
export const MAX_SUBGOALS = 8, DEFAULT_CAP = 10, MAX_CAP = 25;
const baseType = (t) => { t = String(t || "any").toLowerCase().trim(); return /^(list|array)/.test(t) ? "list" : t; };
export const isList = (t) => baseType(t) === "list";
export const typesFit = (from, to) => { const a = baseType(from), b = baseType(to); return a === b || a === "any" || b === "any" || (b === "string" && (a === "number" || a === "boolean")); };
const ID = /^[a-z][a-z0-9_]*$/;

export function checkSplit(plan) {
  const errors = [];
  const err = (m) => errors.push(m);
  if (!plan || typeof plan !== "object") return { ok: false, errors: ["the split is not an object"], order: [] };
  const userIn = Array.isArray(plan.user_inputs) ? plan.user_inputs : [];
  const subs = Array.isArray(plan.subgoals) ? plan.subgoals : [];
  if (!subs.length) return { ok: false, errors: ["there are no sub-goals"], order: [] };
  if (subs.length > MAX_SUBGOALS) err(`too many sub-goals (${subs.length}); the limit is ${MAX_SUBGOALS}. Merge small ones`);
  const userType = {}; for (const u of userIn) { if (!u?.name) err("a user input has no name"); else userType[u.name] = u.type || "any"; }
  const byId = {};
  for (const s of subs) {
    if (!s || !ID.test(String(s.id || ""))) { err(`sub-goal id "${s?.id}" must be lowercase letters/digits/underscore, starting with a letter`); continue; }
    if (byId[s.id]) { err(`sub-goal id "${s.id}" is used twice`); continue; }
    byId[s.id] = s;
    if (!String(s.title || "").trim() || !String(s.does || "").trim()) err(`${s.id}: needs a title and a "does" sentence`);
    if (!Array.isArray(s.outputs) || !s.outputs.length || s.outputs.some((o) => !o?.name)) err(`${s.id}: must declare at least one named output`);
    if (!Array.isArray(s.inputs)) err(`${s.id}: "inputs" must be a list (it can be empty)`);
  }
  const deps = {}, consumed = {};
  for (const s of subs) {
    if (!s || !byId[s.id]) continue;
    deps[s.id] = new Set();
    const outType = Object.fromEntries((s.outputs || []).map((o) => [o?.name, o?.type]));
    void outType;
    const resolve = (from, label) => {
      const f = String(from || "");
      if (f.startsWith("user.")) { const n = f.slice(5); if (!(n in userType)) { err(`${s.id}: ${label} comes from "${f}" but that is not a declared user input`); return null; } return { type: userType[n] }; }
      const m = f.match(/^([a-z][a-z0-9_]*)\.(.+)$/);
      if (!m || !byId[m[1]]) { err(`${s.id}: ${label} comes from "${f}", which is not a user input or an earlier sub-goal output`); return null; }
      if (m[1] === s.id) { err(`${s.id}: ${label} cannot come from itself`); return null; }
      const o = (byId[m[1]].outputs || []).find((x) => x?.name === m[2]);
      if (!o) { err(`${s.id}: ${label} comes from ${m[1]}.${m[2]}, but ${m[1]} declares no output called "${m[2]}"`); return null; }
      deps[s.id].add(m[1]); (consumed[m[1]] = consumed[m[1]] || new Set()).add(m[2]);
      return { type: o.type };
    };
    if (s.for_each) {
      const fe = s.for_each, src = resolve(fe.from, "the for_each list");
      if (src && !isList(src.type)) err(`${s.id}: for_each takes its items from ${fe.from}, which is typed "${src.type}", not a list`);
      if (!fe.as || !/^[a-z][a-z0-9_]*$/i.test(fe.as)) err(`${s.id}: for_each needs an "as" name for each item`);
      if (fe.cap != null && !(Number(fe.cap) >= 1 && Number(fe.cap) <= MAX_CAP)) err(`${s.id}: for_each cap must be 1 to ${MAX_CAP}`);
      for (const o of s.outputs || []) if (o?.name && !isList(o.type)) err(`${s.id}: because it runs once per item, its output "${o.name}" must be typed as a list`);
    }
    for (const i of s.inputs || []) {
      if (!i?.name || !i.from) { err(`${s.id}: every input needs a name and a "from"`); continue; }
      if (i.from === "each") { if (!s.for_each || s.for_each.as !== i.name) err(`${s.id}: input "${i.name}" is marked "each" but for_each does not use "${i.name}" as its item name`); continue; }
      const src = resolve(i.from, `input "${i.name}"`);
      if (src && !typesFit(src.type, i.type)) err(`${s.id}: input "${i.name}" is typed "${i.type}" but ${i.from} is typed "${src.type}"`);
    }
  }
  // order (and cycle check)
  const order = [], left = new Set(Object.keys(byId)), done = new Set();
  while (left.size) {
    const ready = [...left].filter((id) => [...(deps[id] || [])].every((d) => done.has(d)));
    if (!ready.length) { err(`the sub-goals depend on each other in a circle: ${[...left].join(", ")}`); break; }
    for (const id of ready) { order.push(id); done.add(id); left.delete(id); }
  }
  // every result must be used, unless it is a final deliverable
  let finals = 0;
  for (const s of subs) {
    if (!s || !byId[s.id]) continue;
    const used = !!consumed[s.id]?.size;
    if (s.final) finals++;
    else if (!used) err(`${s.id}: nothing uses its result and it is not marked final. Remove it, or feed it into another sub-goal, or mark it final`);
  }
  if (!finals) err("no sub-goal is marked final: say which result is the deliverable");
  return { ok: !errors.length, errors, order };
}
