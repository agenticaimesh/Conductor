// Shared test helpers: fake KV, JSON response helper, and the worker.
import worker from "../src/index.js";
export { worker };
export function makeKV() {
  const m = new Map();
  return { m, get: async (k, t) => { const v = m.get(k); return v == null ? null : t === "json" ? JSON.parse(v) : v; }, put: async (k, v) => { m.set(k, v); }, delete: async (k) => { m.delete(k); },
    list: async ({ prefix = "" } = {}) => ({ keys: [...m.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true }) };
}
export const R = (o, s = 200) => new Response(JSON.stringify(o), { status: s });
export function suite(name) {
  let pass = 0, fail = 0;
  const ok = (c, m) => { c ? pass++ : fail++; console.log((c ? "PASS " : "FAIL ") + m); };
  const done = () => { console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0); };
  return { ok, done };
}
export const call = (env, path, method = "GET", body) => worker.fetch(new Request("https://c" + path, { method, headers: { authorization: "Bearer tok" }, body: body ? JSON.stringify(body) : undefined }), env).then(async (r) => ({ status: r.status, d: await r.json() }));
