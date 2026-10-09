// Client for the existing Stack Builder worker ("the builder"): it plans and runs ONE small goal. Conductor never changes it.
// Needs BUILDER_URL (e.g. https://stack-builder.<you>.workers.dev) and BUILDER_TOKEN (the builder's AUTH_TOKEN).
export function builder(env) {
  let base = String(env.BUILDER_URL || "").trim();
  if (base && !/^https?:\/\//i.test(base)) base = "https://" + base;
  try { base = new URL(base).origin; } catch { base = base.replace(/\/+$/, ""); } // only the address itself: a path pasted by mistake is dropped
  const call = async (path, method = "GET", body) => {
    if (!base || !env.BUILDER_TOKEN) return { ok: false, status: 0, data: { error: "BUILDER_URL and BUILDER_TOKEN are not set on the Conductor worker" } };
    try {
      const r = await fetch(base + path, { method, headers: { authorization: "Bearer " + env.BUILDER_TOKEN, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(150000) });
      const text = await r.text(); let data; try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 500) }; }
      return { ok: r.ok, status: r.status, data, url: base + path };
    } catch (e) { return { ok: false, status: 0, data: { error: "could not reach the builder: " + e.message }, url: base + path }; }
  };
  const check = async () => {
    const r = await call("/recipes");
    const hint = r.ok ? "Connected: the builder answered and has " + (r.data?.count ?? "?") + " recipe(s)."
      : r.status === 401 ? "The builder answered but rejected the token: BUILDER_TOKEN must equal the builder's AUTH_TOKEN."
      : r.status === 404 ? "The address answered 404 for /recipes. BUILDER_URL probably points at the wrong worker (for example Conductor itself, or an old deployment). Open BUILDER_URL in a browser: it should show the Stack Builder page with the Plan button."
      : r.status === 0 ? "Could not connect: " + (r.data?.error || "") : "Unexpected answer from the builder.";
    return { ok: r.ok, status: r.status, called: r.url, builder_host: base ? new URL(base).host : null, hint, body: r.ok ? undefined : JSON.stringify(r.data).slice(0, 300) };
  };
  return {
    check,
    recipes: () => call("/recipes"),
    recipe: (slug) => call("/recipe/" + encodeURIComponent(slug)),
    blueprint: (id) => call("/blueprint/" + encodeURIComponent(id)),
    plan: (goal, notes) => call("/plan", "POST", { goal, notes: notes || "", ignore_recipes: true, budget: { mode: "free" } }),
    run: (id, inputs, dry) => call("/run", "POST", { id, inputs, dry_run: !!dry, return_outputs: true }),
    runRecipe: (slug, inputs, dry) => call("/recipe/" + encodeURIComponent(slug) + "/run", "POST", { inputs, dry_run: !!dry, return_outputs: true }),
  };
}
