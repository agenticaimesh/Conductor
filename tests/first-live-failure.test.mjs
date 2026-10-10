// Failure 2026-10-10 (first live test): a step failed as "node1 (weather_fetch) HTTP ?" - the builder's real reason ("missing value(s)
// ...") was dropped, and the same doomed run was repeated. Now: the reason is shown, such failures are not retried, and the plan's
// inputs are checked before running (with one re-plan using the exact input names).
import { createJob, advance, missingInputs } from "../src/executor.js";
import { makeKV, R, suite } from "./lib.mjs";
const { ok, done } = suite();
const env = { CONDUCTOR: makeKV(), BUILDER_URL: "https://builder", BUILDER_TOKEN: "bt" };
let calls = [], planNeeds = [["latitude", "longitude"]], runReply;
globalThis.fetch = async (url, o = {}) => {
  url = String(url); const body = o.body ? JSON.parse(o.body) : {}; calls.push({ url, body });
  if (url.endsWith("/plan")) { const needs = planNeeds.length > 1 ? planNeeds.shift() : planNeeds[0]; return R({ status: "ok", id: "bp" + calls.length, blueprint: { inputs_needed: needs, defaults: {} } }); }
  if (url.endsWith("/run")) return runReply(body);
  return R({ error: "unexpected " + url }, 500);
};
const plan = { goal: "weather", user_inputs: [{ name: "city", type: "string" }], subgoals: [{ id: "sg1", title: "fetch weather", does: "get the weather forecast for a city", inputs: [{ name: "city", type: "string", from: "user.city" }], outputs: [{ name: "forecast", type: "object" }], final: true }] };
const runs = () => calls.filter((c) => c.url.endsWith("/run")).length, plans = () => calls.filter((c) => c.url.endsWith("/plan")).length;

ok(missingInputs({ inputs_needed: ["latitude", "longitude"] }, { city: "Manila" }).length === 0, "coordinates are satisfied by a city (the builder looks it up)");
ok(missingInputs({ inputs_needed: ["latitude"] }, { repo: "a/b" }).join() === "latitude", "coordinates are NOT satisfied by an unrelated value");
ok(missingInputs({ inputs_needed: ["zip"], defaults: { zip: "1" } }, {}).length === 0, "a default from the goal counts as supplied");

// 1. the builder's real reason is shown and a doomed run is not repeated
runReply = () => R({ status: "partial_failure", report: [{ node: "node1", tool: "weather_fetch", ok: false, error: "missing value(s) $input.zip - type them in the Run box", hint: "x" }], missing: [] });
planNeeds = [["latitude", "longitude"]];
let j = await createJob(env, { plan, inputs: { city: "Manila" }, dry: true });
j = await advance(env, j.id);
ok(j.steps.sg1.status === "failed" && /missing value\(s\) \$input\.zip/.test(j.steps.sg1.error) && !/HTTP \?/.test(j.steps.sg1.error), "the builder's real reason is shown (no more 'HTTP ?')");
ok(runs() === 1 && j.steps.sg1.attempts === 2, "a failure that cannot fix itself is not retried");

// 2. a plan that needs inputs we do not have: one re-plan with the exact names, then a clear message
calls = []; planNeeds = [["zip_code"]];
j = await createJob(env, { plan, inputs: { city: "Manila" }, dry: true });
j = await advance(env, j.id);
ok(plans() === 2 && runs() === 0, "a plan needing unknown inputs is planned once more and never run");
ok(/zip_code/.test(j.steps.sg1.error) && /only city is supplied/.test(j.steps.sg1.error), "the message names what the plan needs and what was supplied");
ok(/exactly these names: city/.test(calls.filter((c) => c.url.endsWith("/plan"))[1].body.notes) && /zip_code/.test(calls.filter((c) => c.url.endsWith("/plan"))[1].body.notes), "the second plan is told the exact input names and what was wrong");

// 3. the re-plan fixes it
calls = []; planNeeds = [["zip_code"], ["city"]];
runReply = () => R({ status: "dry_run_ok", report: [{ node: "n1", ok: true }], outputs: { n1: { forecast: { t: 28 } } } });
j = await createJob(env, { plan, inputs: { city: "Manila" }, dry: true });
j = await advance(env, j.id);
ok(j.steps.sg1.status === "done" && plans() === 2 && runs() === 1 && j.steps.sg1.output.forecast.t === 28, "when the second plan matches, the step runs and completes");

// 4. a real service failure still retries once
calls = []; planNeeds = [["city"]];
runReply = () => R({ status: "partial_failure", report: [{ node: "node1", tool: "weather_fetch", ok: false, status: 502, output_preview: "bad gateway" }] });
j = await createJob(env, { plan, inputs: { city: "Manila" }, dry: true });
j = await advance(env, j.id);
ok(j.steps.sg1.status === "pending" && j.steps.sg1.attempts === 1 && /HTTP 502/.test(j.steps.sg1.error), "a real service failure (HTTP 502) is shown with its code and still gets one retry");
done();
