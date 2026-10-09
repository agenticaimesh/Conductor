// Client for the existing Stack Builder worker ("the builder"): it plans and runs ONE small goal. Conductor never changes it.
// Needs BUILDER_URL (e.g. https://stack-builder.<you>.workers.dev) and BUILDER_TOKEN (the builder's AUTH_TOKEN).
export function builder(env) {
  const base = String(env.BUILDER_URL || "").replace(/\/+$/, "");
  const call = async (path, method = "GET", body) => {
    if (!base || !env.BUILDER_TOKEN) return { ok: false, status: 0, data: { error: "BUILDER_URL and BUILDER_TOKEN are not set on the Conductor worker" } };
    try {
      const r = await fetch(base + path, { method, headers: { authorization: "Bearer " + env.BUILDER_TOKEN, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(150000) });
      const text = await r.text(); let data; try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 500) }; }
      return { ok: r.ok, status: r.status, data };
    } catch (e) { return { ok: false, status: 0, data: { error: "could not reach the builder: " + e.message } }; }
  };
  return {
    recipes: () => call("/recipes"),
    recipe: (slug) => call("/recipe/" + encodeURIComponent(slug)),
    blueprint: (id) => call("/blueprint/" + encodeURIComponent(id)),
    plan: (goal, notes) => call("/plan", "POST", { goal, notes: notes || "", ignore_recipes: true, budget: { mode: "free" } }),
    run: (id, inputs, dry) => call("/run", "POST", { id, inputs, dry_run: !!dry, return_outputs: true }),
    runRecipe: (slug, inputs, dry) => call("/recipe/" + encodeURIComponent(slug) + "/run", "POST", { inputs, dry_run: !!dry, return_outputs: true }),
  };
}
