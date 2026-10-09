import { createJob, advance, resume, getJob, viewJob } from "../src/executor.js";
import { putModule, getModule, moduleFromRecipe } from "../src/modules.js";
import { makeKV, R, suite } from "../tests/lib.mjs";
const { ok, done } = suite();
const env = { CONDUCTOR: makeKV(), BUILDER_URL: "https://builder", BUILDER_TOKEN: "bt" };
let calls = [], failTipsOnce = false, planStatus = "ok";
globalThis.fetch = async (url, o = {}) => {
  url = String(url); const body = o.body ? JSON.parse(o.body) : {}; calls.push({ url, body });
  if (url.endsWith("/recipe/weather-morning/run")) return R({ status: body.dry_run ? "dry_run_ok" : "ok", report: [{ node: "node2", ok: true }], outputs: { node1: { daily: {} }, node2: { text: "Mild, 28 C in " + (body.inputs.city || "?") } } });
  if (url.endsWith("/plan")) return R({ status: planStatus, id: /list of tips/i.test(body.goal) ? "bpTips" : "bpFmt", message: "draft plan" });
  if (url.endsWith("/run") && body.id === "bpTips") {
    if (failTipsOnce) { failTipsOnce = false; return R({ status: "partial_failure", report: [{ node: "n1", tool: "llm_text", ok: false, status: 429, output_preview: "rate limited" }] }); }
    return R({ status: "ok", report: [{ node: "n1", ok: true }], outputs: { n1: { tips: ["wear a hat", "drink water", "walk", "sleep", "read", "extra1", "extra2", "extra3", "extra4", "extra5", "extra6", "extra7"] } } });
  }
  if (url.endsWith("/run") && body.id === "bpFmt") return R({ status: "ok", report: [{ node: "n1", ok: true }], outputs: { n1: { line: "* " + body.inputs.tip } } });
  if (url.includes("/blueprint/")) return R({ routing_table: [{ node: "n1", tool: "llm_text", url: "https://api.groq.com/openai/v1/chat/completions", method: "POST", static: { instruction: "x" } }], secrets_needed: ["GROQ_API_KEY"] });
  return R({ error: "unexpected " + url }, 500);
};
const mod = moduleFromRecipe({ slug: "weather-morning", goal: "Every morning, get the weather forecast for a city and email me a one-sentence summary.", inputs_needed: [], proven: true }, { routing_table: [{ node: "node1", tool: "weather_forecast", url: "https://x", method: "GET", static: { latitude: 1, longitude: 2 } }] });
mod.status = "proven"; await putModule(env, mod);
const plan = { goal: "weather tips", user_inputs: [{ name: "city", type: "string" }], subgoals: [
  { id: "sg1", title: "Get weather", does: "get the weather forecast for a city and write one sentence", inputs: [{ name: "city", type: "string", from: "user.city" }], outputs: [{ name: "text", type: "string" }] },
  { id: "sg2", title: "Make tips", does: "turn the weather sentence into a list of tips", inputs: [{ name: "text", type: "string", from: "sg1.text" }], outputs: [{ name: "tips", type: "list" }] },
  { id: "sg3", title: "Format tip", does: "format one tip as a bullet line", inputs: [{ name: "tip", type: "string", from: "each" }], outputs: [{ name: "line", type: "list" }], for_each: { from: "sg2.tips", as: "tip", cap: 6 }, final: true } ] };

let job = await createJob(env, { goal: "weather tips", plan, inputs: { city: "Manila" }, dry: true });
ok(job.steps.sg1.module === "weather-morning" && !job.steps.sg2.module && !job.steps.sg3.module, "a proven module is chosen for the matching sub-goal; the others will be planned");
let threw = null; try { await createJob(env, { plan, inputs: {} }); } catch (e) { threw = e.message; }
ok(/missing values: city/.test(threw), "a missing user value is refused up front");

job = await advance(env, job.id);
ok(job.steps.sg1.status === "done" && job.steps.sg1.output.text.includes("Manila"), "step 1 runs the module with the user's city and stores its output");
ok(calls.find((c) => c.url.endsWith("/recipe/weather-morning/run")).body.dry_run === true && calls.find((c) => c.url.endsWith("/recipe/weather-morning/run")).body.return_outputs === true, "dry flag and return_outputs are passed to the builder");
failTipsOnce = true;
job = await advance(env, job.id);
ok(job.steps.sg2.status === "pending" && job.steps.sg2.attempts === 1 && /429/.test(job.steps.sg2.error) && job.status === "running", "a failed step is retried (first failure keeps it pending)");
const planCallsBefore = calls.filter((c) => c.url.endsWith("/plan")).length;
job = await advance(env, job.id);
ok(job.steps.sg2.status === "done" && job.steps.sg2.output.tips.length === 12 && calls.filter((c) => c.url.endsWith("/plan")).length === planCallsBefore, "the retry succeeds and does NOT plan the sub-goal again");
ok(calls.find((c) => c.url.endsWith("/plan")).body.goal.includes("text=Mild") && /Name the inputs exactly: text/.test(calls.find((c) => c.url.endsWith("/plan")).body.notes), "planning gets the real values and the exact input names");
job = await advance(env, job.id);
ok(job.steps.sg3.items.length === 5 && job.steps.sg3.status === "pending" && job.status === "running", "for_each does at most 5 items per advance and stays pending");
job = await advance(env, job.id);
ok(job.steps.sg3.status === "done" && job.steps.sg3.output.line.length === 6 && job.steps.sg3.capped === true && job.status === "done", "for_each stops at its cap (6 of 12), joins the results and the job is done");
ok(job.steps.sg3.output.line[0] === "* wear a hat", "each item was passed to its own run");
ok(!(await getModule(env, "sg2-make-tips")) && !(await getModule(env, "sg3-format-tip")), "a dry run never saves new modules");
ok(viewJob(job).steps.every((s) => s.status === "done") && viewJob(job).steps[0].how === "module weather-morning", "the job view shows each step's state and how it ran");

// resume after a hard failure
planStatus = "draft"; calls = [];
let j2 = await createJob(env, { plan, inputs: { city: "Bangkok" }, dry: true });
j2 = await advance(env, j2.id); j2 = await advance(env, j2.id); j2 = await advance(env, j2.id);
ok(j2.steps.sg2.status === "failed" && j2.status === "failed" && /"draft" plan/.test(j2.steps.sg2.error), "a draft plan from the builder fails the step instead of running it");
ok(j2.steps.sg1.status === "done", "earlier results are kept");
planStatus = "ok"; const before = calls.filter((c) => c.url.includes("/recipe/weather")).length;
j2 = await resume(env, j2.id); j2 = await advance(env, j2.id);
ok(j2.steps.sg2.status === "done" && calls.filter((c) => c.url.includes("/recipe/weather")).length === before, "resume re-runs only the failed step and reuses the saved output of step 1");

// real run: new modules are saved as candidates and counted
let j3 = await createJob(env, { plan, inputs: { city: "Rome" }, dry: false });
for (let i = 0; i < 5 && (await getJob(env, j3.id)).status === "running"; i++) await advance(env, j3.id);
const t = await getModule(env, "sg2-make-tips");
ok(t && t.status === "candidate" && t.proof.ok_runs === 1 && t.via.id === "bpTips", "a real run saves the new step as a candidate module with one counted success");
ok((await getModule(env, "weather-morning")).proof.ok_runs === 1, "a real run counts a success for the module it reused");
// no_data skips the rest
const e3 = { ...env, CONDUCTOR: makeKV() };
globalThis.fetch = async (url) => String(url).endsWith("/plan") ? R({ status: "ok", id: "x" }) : R({ status: "no_data", report: [] });
let j4 = await createJob(e3, { plan, inputs: { city: "Oslo" }, dry: true });
j4 = await advance(e3, j4.id); j4 = await advance(e3, j4.id);
ok(j4.steps.sg1.no_data && j4.steps.sg2.status === "skipped" && j4.status === "done", "when a step has nothing to pass on, later steps are skipped on purpose");
done();
