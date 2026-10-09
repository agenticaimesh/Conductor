// Small shared helpers.
export const J = (obj, status = 200) => new Response(JSON.stringify(obj, null, 2), { status, headers: { "content-type": "application/json" } });
export const uid = (p = "") => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
export const cut = (s, n) => { s = String(s ?? ""); return s.length > n ? s.slice(0, n - 1) + "…" : s; };
export const today = () => new Date().toISOString().slice(0, 10);
// Short stable hash of a set of input values (to count how many DIFFERENT inputs a module has worked with).
export function hashInputs(obj) {
  const keys = Object.keys(obj || {}).sort();
  const str = JSON.stringify(keys.map((k) => [k, obj[k]]));
  let h = 5381; for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}
const STOP = new Set("the and for with from that this then into your their them have has will are was were not but all any each per out new get gets make makes use using via its it's you can".split(" "));
export const wordSet = (text) => new Set(String(text || "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter((w) => w.length >= 3 && !STOP.has(w)).map((w) => w.slice(0, 5)));
export function extractJson(text) {
  let t = String(text || "").trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  try { return JSON.parse(t); } catch {}
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch {} }
  return null;
}
