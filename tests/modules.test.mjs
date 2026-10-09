import { importRecipes, findModules, recordRun, getModule, listModules, putModule, moduleFromRecipe } from "../src/modules.js";
import { makeKV, suite } from "./lib.mjs";
const { ok, done } = suite();
const env = { CONDUCTOR: makeKV() };
const bpWeather = { secrets_needed: ["RESEND_API_KEY"], routing_table: [
  { node: "node1", tool: "weather_forecast", url: "https://api.open-meteo.com/v1/forecast", method: "GET", static: { latitude: 40.71, longitude: -74.0 } },
  { node: "node2", tool: "llm_text", url: "https://api.groq.com/openai/v1/chat/completions", method: "POST", static: { instruction: "x" } },
  { node: "node3", tool: "email_send", url: "https://api.resend.com/emails", method: "POST", static: { to: "a@b.c" } }] };
const b = { recipes: async () => ({ ok: true, data: { recipes: [{ slug: "weather-morning" }, { slug: "other" }] } }),
  recipe: async (s) => s === "other" ? { ok: false, status: 404, data: {} } : { ok: true, data: { slug: s, goal: "Every morning, get the weather forecast for Newyork and email me a one-sentence summary.", bp_id: "r-" + s, inputs_needed: [], config_needed: [], tools: "weather_forecast, llm_text, email_send", proven: true, proven_on: "2026-10-03" } },
  blueprint: async () => ({ ok: true, data: bpWeather }) };
let r = await importRecipes(env, b);
const m = await getModule(env, "weather-morning");
ok(r.ok && r.added.join() === "weather-morning" && r.failed.join() === "other", "recipes are imported; an unreadable one is reported");
ok(m.status === "candidate" && m.inputs.some((i) => i.name === "city" && !i.required) && m.effects.includes("api.resend.com"), "imported as a candidate, with an optional city input and its side effect noted");
ok(m.fixed_values.some((x) => x.includes("latitude")) && m.notes.some((n) => /guessed/.test(n)), "fixed values and the guessed output contract are flagged");
m.proof.ok_runs = 5; await putModule(env, m);
r = await importRecipes(env, b); ok(r.kept.includes("weather-morning") && (await getModule(env, "weather-morning")).proof.ok_runs === 5, "a second import never overwrites existing proof");

const sg = { title: "Get weather", does: "get the weather forecast for a city and write one sentence", inputs: [{ name: "city", type: "string", from: "user.city" }], outputs: [{ name: "text", type: "string" }] };
const mods = [{ ...m, status: "proven" }, { id: "gh", status: "proven", does: "list github issues for a repository", tags: ["github"], inputs: [{ name: "repo", required: true, type: "string" }], outputs: [{ name: "issues", type: "list" }], proof: {} }];
let f = findModules(mods, sg);
ok(f[0]?.id === "weather-morning" && !f.some((x) => x.id === "gh"), "lookup picks the weather module and not the github one");
ok(findModules([{ ...m, status: "candidate" }], sg).length === 0 && findModules([{ ...m, status: "candidate" }], sg, { includeCandidates: true }).length === 1, "candidates are used only when asked");
ok(findModules([{ ...m, status: "stale" }], sg, { includeCandidates: true }).length === 0, "stale modules are never offered");
const need = { ...sg, inputs: [], outputs: [{ name: "report", type: "string" }] };
ok((findModules(mods, sg)[0]?.score || 0) > (findModules(mods, need)[0]?.score || 0), "matching output names raises the score");

const e2 = { CONDUCTOR: makeKV() }; await putModule(e2, moduleFromRecipe({ slug: "w", goal: "weather forecast", inputs_needed: [] }, bpWeather));
await recordRun(e2, "w", { city: "Paris" }, true); ok((await getModule(e2, "w")).status === "candidate", "one success does not prove a module");
await recordRun(e2, "w", { city: "Paris" }, true); ok((await getModule(e2, "w")).status === "candidate", "two successes with the SAME input do not prove it");
await recordRun(e2, "w", { city: "Manila" }, true); ok((await getModule(e2, "w")).status === "proven", "successes with two different inputs prove it");
await recordRun(e2, "w", { city: "Rome" }, false); await recordRun(e2, "w", { city: "Rome" }, false);
ok((await getModule(e2, "w")).status === "stale", "two failures in a row make a proven module stale");
await recordRun(e2, "w", { city: "Oslo" }, true); ok((await getModule(e2, "w")).status === "candidate", "a success after stale returns it to candidate");
ok((await listModules(e2)).length === 1, "listing works");
done();
