// Minimal free-tier LLM client: Groq first, then OpenRouter. Live free models are discovered from each /models list
// (nothing is hard-coded); a 429 cools a model for 60 s. Returns parsed JSON.
import { extractJson } from "./util.js";
const PROVIDERS = [
  { name: "groq", base: "https://api.groq.com/openai/v1", key: "GROQ_API_KEY", usable: (id) => !/whisper|guard|tts|embed|playai|orpheus|safeguard/i.test(id), rank: (id) => (/gpt-oss-120b/.test(id) ? 0 : /70b|120b|kimi|qwen/i.test(id) ? 1 : 2) },
  { name: "openrouter", base: "https://openrouter.ai/api/v1", key: "OPENROUTER_API_KEY", usable: (id) => /:free$/.test(id), rank: (id) => (/70b|120b|405b|qwen|deepseek/i.test(id) ? 0 : 1) },
];
const cool = new Map();
async function liveModels(p, env) {
  try {
    const r = await fetch(p.base + "/models", { headers: { authorization: "Bearer " + env[p.key] }, signal: AbortSignal.timeout(15000) });
    if (!r.ok) return [];
    const ids = ((await r.json()).data || []).map((x) => x.id).filter((id) => id && p.usable(id));
    return ids.sort((a, b) => p.rank(a) - p.rank(b)).slice(0, 4);
  } catch { return []; }
}
export async function llmJson(env, { system, user, max_tokens = 3500 }) {
  let last = "no LLM key is set (GROQ_API_KEY or OPENROUTER_API_KEY)";
  for (const p of PROVIDERS) {
    if (!env[p.key]) continue;
    for (const model of await liveModels(p, env)) {
      if ((cool.get(model) || 0) > Date.now()) continue;
      try {
        const r = await fetch(p.base + "/chat/completions", {
          method: "POST", headers: { authorization: "Bearer " + env[p.key], "content-type": "application/json" }, signal: AbortSignal.timeout(60000),
          body: JSON.stringify({ model, max_tokens, temperature: 0.2, ...(p.name === "groq" && /gpt-oss/.test(model) ? { reasoning_effort: "low" } : {}), messages: [{ role: "system", content: system }, { role: "user", content: user }] }),
        });
        if (r.status === 429) { cool.set(model, Date.now() + 60000); last = `${model}: rate limited`; continue; }
        if (!r.ok) { last = `${model}: HTTP ${r.status}`; continue; }
        const content = (await r.json())?.choices?.[0]?.message?.content;
        const json = extractJson(content);
        if (json) return { json, model };
        last = `${model}: reply was not JSON`;
      } catch (e) { last = `${model}: ${e.message}`; }
    }
  }
  throw new Error("no model answered (" + last + ")");
}
