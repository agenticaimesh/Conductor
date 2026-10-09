// Runs every tests/*.test.mjs in its own process; prints failures; exits non-zero if any suite fails.
import fs from "fs"; import path from "path"; import { spawnSync } from "child_process"; import { fileURLToPath } from "url";
const dir = path.dirname(fileURLToPath(import.meta.url)); let bad = 0, n = 0;
for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".test.mjs")).sort()) {
  n++; const r = spawnSync("node", [path.join(dir, f)], { encoding: "utf8" });
  const out = (r.stdout || "") + (r.stderr || "");
  if (r.status !== 0) { bad++; console.log("FAIL " + f); console.log(out.split("\n").filter((l) => /^FAIL|Error|at /.test(l)).slice(0, 8).join("\n")); } else console.log("OK   " + f);
}
console.log(bad ? `\n${bad} suite(s) failed` : `\nall ${n} suites passed`); process.exit(bad ? 1 : 0);
