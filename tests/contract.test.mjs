import { checkSplit } from "../src/contract.js";
import { suite } from "./lib.mjs";
const { ok, done } = suite();
const good = () => ({ user_inputs: [{ name: "repo", type: "string" }], subgoals: [
  { id: "sg1", title: "Fetch errors", does: "get recent errors", inputs: [{ name: "repo", type: "string", from: "user.repo" }], outputs: [{ name: "errors", type: "list" }] },
  { id: "sg2", title: "Fix each", does: "write a fix per error", inputs: [{ name: "error", type: "object", from: "each" }], outputs: [{ name: "fixes", type: "list" }], for_each: { from: "sg1.errors", as: "error", cap: 5 } },
  { id: "sg3", title: "Open PR", does: "open a pull request", inputs: [{ name: "fixes", type: "list", from: "sg2.fixes" }], outputs: [{ name: "url", type: "string" }], final: true } ] });
let r = checkSplit(good());
ok(r.ok && r.order.join() === "sg1,sg2,sg3", "a consistent split passes and gets an order");
let p = good(); p.subgoals[0].inputs[0].from = "user.nope"; r = checkSplit(p);
ok(!r.ok && r.errors.some((e) => /not a declared user input/.test(e)), "unknown user input is caught");
p = good(); p.subgoals[2].inputs[0].from = "sg2.nothing"; r = checkSplit(p);
ok(r.errors.some((e) => /declares no output called/.test(e)), "unknown output name is caught");
p = good(); p.subgoals[0].inputs = [{ name: "x", type: "string", from: "sg3.url" }]; r = checkSplit(p);
ok(r.errors.some((e) => /circle/.test(e)), "a cycle is caught");
p = good(); p.subgoals[2].final = false; r = checkSplit(p);
ok(r.errors.some((e) => /not marked final/.test(e)) && r.errors.some((e) => /no sub-goal is marked final/.test(e)), "a result nobody uses must be final");
p = good(); p.subgoals[1].for_each.from = "sg1.errors"; p.subgoals[0].outputs[0].type = "string"; r = checkSplit(p);
ok(r.errors.some((e) => /not a list/.test(e)), "for_each over a non-list is caught");
p = good(); p.subgoals[1].outputs[0].type = "string"; r = checkSplit(p);
ok(r.errors.some((e) => /must be typed as a list/.test(e)), "a for_each step must output lists");
p = good(); p.subgoals[2].inputs[0].type = "number"; r = checkSplit(p);
ok(r.errors.some((e) => /typed "number" but sg2.fixes is typed "list"/.test(e)), "type mismatch across a link is caught");
p = good(); p.subgoals[1].for_each.cap = 99; r = checkSplit(p);
ok(r.errors.some((e) => /cap must be/.test(e)), "for_each cap above the limit is caught");
r = checkSplit({ user_inputs: [], subgoals: Array.from({ length: 9 }, (_, i) => ({ id: "s" + i, title: "t", does: "d", inputs: [], outputs: [{ name: "o", type: "any" }], final: true })) });
ok(r.errors.some((e) => /too many/.test(e)), "more than 8 sub-goals is refused");
done();
