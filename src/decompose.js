// Step 0: split a goal into 1-8 small sub-goals with contracts, then check the split with code (contract.js).
// A failed check goes back to the model with the exact errors, up to 3 tries. The result is never executed unchecked.
import { llmJson } from "./llm.js";
import { checkSplit, MAX_SUBGOALS } from "./contract.js";

const SYSTEM = `You split a big goal into small independent sub-goals for an automation builder that can only do ONE small job per sub-goal (a few API calls plus at most one language-model step).
Return ONLY JSON of this shape:
{"user_inputs":[{"name":"repo","type":"string"}],
 "subgoals":[{"id":"sg1","title":"short name","does":"one plain sentence of what this job does",
   "inputs":[{"name":"repo","type":"string","from":"user.repo"}],
   "outputs":[{"name":"errors","type":"list"}],
   "for_each":{"from":"sg1.errors","as":"error","cap":10},
   "final":true}]}
Rules:
- 1 to ${MAX_SUBGOALS} sub-goals, ids sg1, sg2... Types: string, number, boolean, object, list, any.
- Every input has a "from": "user.<name>" (declare it in user_inputs), "<earlier id>.<output name>", or "each" (the current item of a for_each).
- for_each (optional) runs the sub-goal once per item of a list output, at most cap items (1-25). A for_each sub-goal's outputs must be typed list, and an input with from "each" must have the same name as for_each.as.
- Every sub-goal's result must be used by a later sub-goal OR be marked "final": true (the deliverable). At least one final.
- Keep each sub-goal small and generic ("fetch recent errors from an error tracker", "summarise a list of items", "open a pull request"), so it can be reused by other goals. Prefer reusing the existing modules listed below, with the same input/output names, when one fits.
- No secrets in values. Do not invent services; say what is needed, not how.`;

export async function decompose(env, goal, modules = [], { attempts = 3 } = {}) {
  const lib = modules.filter((m) => m.status !== "stale").slice(0, 25).map((m) => ({ id: m.id, does: m.does, inputs: (m.inputs || []).map((i) => i.name), outputs: (m.outputs || []).map((o) => o.name) }));
  const trace = []; let plan = null, check = { ok: false, errors: ["not tried"], order: [] }, feedback = "", model = "";
  for (let a = 1; a <= attempts; a++) {
    try {
      const r = await llmJson(env, { system: SYSTEM, user: `Goal:\n${goal}\n\nExisting reusable modules (may be empty):\n${JSON.stringify(lib)}${feedback}` });
      plan = r.json; model = r.model;
    } catch (e) { trace.push(`attempt ${a}: ${e.message}`); break; }
    plan.goal = goal;
    check = checkSplit(plan);
    trace.push(`attempt ${a}: ${check.ok ? "split is consistent" : check.errors.length + " problem(s): " + check.errors.slice(0, 3).join(" | ")}`);
    if (check.ok) break;
    feedback = `\n\nYour previous answer had these problems. Fix ALL of them and return the full JSON again:\n- ${check.errors.join("\n- ")}`;
  }
  return { plan, check, model, trace, draft: !check.ok };
}
