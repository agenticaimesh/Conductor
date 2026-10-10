# Conductor - project handoff

Give this file and the src/ and tests/ folders to any LLM to continue. Last updated: 2026-10-09 (Conductor zip 3). Every Conductor-update.zip carries a refreshed copy of this file.

## 1. What it is
A SEPARATE Cloudflare Worker (free plan, KV binding CONDUCTOR, cron every 5 minutes) that sits above the existing Stack Builder worker ("the builder", repo Autonomous). The builder plans and runs ONE small goal. Conductor:
1. splits a big goal into 1-8 small sub-goals with contracts (inputs, outputs, types, for_each, final) - decompose.js, contract.js;
2. checks the split with code, no LLM (circles, unknown sources, type mismatches, unused results, caps) and sends errors back to the model up to 3 times; a split that still fails is returned as a labelled draft and cannot be run;
3. for each sub-goal looks in the module library (modules.js) for a PROVEN module that clearly fits (score >= 0.5 and offers the output names later steps need); otherwise asks the builder to /plan a new small plan;
4. runs sub-goals as a JOB with state in KV (executor.js): one step per advance(), retry once, resume from a failed step reusing saved outputs, for_each over a list (cap 10 by default, max 25, 5 items per advance), skip steps whose input step had no data, dry run by default;
5. after a REAL successful run saves a new sub-goal as a candidate module and counts proof.

Owner: solo builder, phone only, free tiers only. Always deliver complete files, never "edit line N"; never spend money automatically; record each failure as a test.

## 2. Files
- src/index.js routes + inline UI + cron; src/contract.js format + deterministic split check; src/decompose.js; src/llm.js (Groq then OpenRouter, live free models, JSON replies); src/builder.js (client of the builder); src/modules.js (library, import, lookup, proof); src/executor.js (jobs); src/util.js.
- tests/ (5 suites, `node tests/run-all.mjs`; tests/lib.mjs has a fake KV and helpers). package.json has "type":"module" (needed because src is several files).

## 3. Routes (Bearer AUTH_TOKEN; GET / is the page)
POST /decompose {goal} -> plan_id + checked split; POST /job {plan_id, inputs, dry, allow_candidates}; GET /job/<id> (?full=1); POST /job/<id>/advance {steps<=3}; POST /job/<id>/resume; GET /jobs; GET /modules; POST /modules/import (reads the builder's recipes as candidate modules, never overwrites proof); GET /builder/check (is BUILDER_URL / BUILDER_TOKEN right; explains 404, 401, unreachable; never shows the token); GET /module/<id>; POST /module/<id>/status {status: candidate|proven|stale} (owner override).

## 4. Environment
Secrets: AUTH_TOKEN, BUILDER_URL (the builder's workers.dev address), BUILDER_TOKEN (the builder's AUTH_TOKEN), GROQ_API_KEY and/or OPENROUTER_API_KEY. KV namespace id goes in wrangler.toml.

## 5. Module rules
candidate -> proven only after 2 successful REAL runs with 2 DIFFERENT input sets; proven -> stale after 2 failures in a row; stale -> candidate on the next success. Dry runs never count and never create modules. Imported recipes start as candidates with a GUESSED output contract (text) and are flagged; the owner can mark one proven after checking it. A module wraps a builder recipe (via.type recipe) or plan (via.type plan).

## 6. Builder dependency
Needs the builder to support `return_outputs: true` on /run and /recipe/<slug>/run (builder zip 17d or later). Without it modules cannot hand data to each other.

## 7. Honest limits
- Unit-tested with mocked builder and LLM only. Never run live yet.
- A new plan made by the builder for a sub-goal can name its inputs differently from the contract; Conductor passes the exact names in the planning notes and the values in the goal text, but the builder may still ignore them (then the step reports missing inputs).
- A plan made from one example may keep literal values from it (fixed_values on the module lists them). Parameterising on save is not automatic yet.
- Output mapping from a run to the contract names is by key name, else the last step's text/whole output.
- No agent-role nodes, token budgets, ledger, replay of proven modules on a schedule, multi-tenant separation or auth beyond one token.
- Goals 5 (thousands of PDFs/audio) and 7 (5-second trades on a firehose) of the original list are only partly possible on free tiers; say so in the product.

## 8. Roadmap (in order)
1. Live proof of the whole chain on a small 2-3 step goal (dry, then real), fix what breaks.
2. Replay proven modules on a cron (dry) and mark stale on failure.
3. Parameterise-on-save for new modules.
4. Agent-role steps (system prompt, tools, token budget) for the procurement and CEO goals; ledger in KV.
5. Goal 1 (error tracker -> ticket -> fix -> pull request, GitHub Actions as the test gate), then goals 2, 3, 8.
6. Pattern library from what worked; client separation before selling.

## 9. History
- zip 1 (2026-10-09): everything above.
- zip 3 (2026-10-09): the 404 was most likely Cloudflare error 1042 (a Worker cannot fetch another Worker of the same account via workers.dev). wrangler.toml now has compatibility_flags = ["global_fetch_strictly_public"]; the connection check names error 1042 and the fix; a stray character before https:// in BUILDER_URL is dropped. NOTE: unpack-update does not overwrite wrangler.toml, so this line must be added by hand once. (A service binding is the other fix; not used because a wrong service name would break the deploy.)
- zip 2 (2026-10-09): "Import builder recipes" failed with a bare "HTTP 404" (BUILDER_URL pointed at the wrong place). BUILDER_URL is now cleaned (https:// added, paths dropped); import errors name the exact address and give a hint; new button/route Check builder connection. Test: builder-link.
