// Failure 2026-10-09: "Import builder recipes" showed only "the builder answered HTTP 404" with no way to see why.
import { builder } from "../src/builder.js";
import { importRecipes } from "../src/modules.js";
import { makeKV, R, suite, call } from "./lib.mjs";
const { ok, done } = suite();
let seen = [], reply = () => R({ error: "not found" }, 404);
globalThis.fetch = async (url) => { seen.push(String(url)); return reply(); };
const env = { AUTH_TOKEN: "tok", CONDUCTOR: makeKV(), BUILDER_URL: "stack-builder.me.workers.dev/plan/", BUILDER_TOKEN: "bt" };
let c = await builder(env).check();
ok(seen[0] === "https://stack-builder.me.workers.dev/recipes", "a pasted path or missing https:// is cleaned to the plain address");
ok(c.status === 404 && /wrong worker/.test(c.hint) && c.called.endsWith("/recipes"), "a 404 is explained and the called address is shown");
const r = await importRecipes(env, builder(env));
ok(!r.ok && /404 at https:\/\/stack-builder\.me\.workers\.dev\/recipes/.test(r.error) && /wrong worker/.test(r.hint), "import failure names the address and gives a hint");
reply = () => R({ error: "wrong token" }, 401); c = await builder(env).check(); ok(/rejected the token/.test(c.hint), "401 says the token is wrong");
reply = () => R({ count: 2, recipes: [] }); c = await builder(env).check(); ok(c.ok && /Connected/.test(c.hint), "success says connected");
const x = await call(env, "/builder/check"); ok(x.d.ok === true && x.d.builder_host === "stack-builder.me.workers.dev", "GET /builder/check works through the route");
done();
