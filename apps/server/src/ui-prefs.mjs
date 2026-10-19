// The owner's UI personalisation (apps/web/src/ui-prefs.js): the look and the feature flags, kept on
// the server so every device shows the same. Stored as given after a shape check (the web knows the
// flags; an unknown key from an older or newer page is kept harmlessly). `{}` after «برگرداندن به
// پیش‌فرض نصب»: stored, so no browser migrates again, and the install's preset applies.
const KEY = "ui-prefs";
const LOOKS = ["griffin", "karsara"];
const FLAG = /^[a-zA-Z][a-zA-Z0-9]{0,40}$/;
const NAV = /^[a-z]{1,30}$/;

export function cleanUiPrefs(body) {
  const out = {};
  if (LOOKS.includes(body?.look)) out.look = body.look;
  const flags = {};
  for (const [key, value] of Object.entries(body?.flags && typeof body.flags === "object" ? body.flags : {}).slice(0, 80)) {
    if (!FLAG.test(key)) continue;
    if (typeof value === "boolean") flags[key] = value;
    else if (Array.isArray(value) && value.length <= 20 && value.every((v) => typeof v === "string" && NAV.test(v))) flags[key] = [...new Set(value)];
  }
  out.flags = flags;
  // The page's prefs revision (ui-prefs.js PREFS_REV): which preset changes this copy already saw.
  if (Number.isInteger(body?.rev) && body.rev >= 0 && body.rev < 1000) out.rev = body.rev;
  if (body?.migrated === true) out.migrated = true;
  return out;
}

export function uiPrefsRoutes(app, { store }) {
  app.get("/api/ui-prefs", (c) => c.json({ stored: store.getKv(KEY) || null }));
  app.put("/api/ui-prefs", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== "object") return c.json({ error: "بدنهٔ JSON لازم است." }, 400);
    const prev = store.getKv(KEY) || {};
    const next = cleanUiPrefs(body);
    // A migration snapshot never overwrites what a device already saved (two devices loading at once).
    if (next.migrated && store.getKv(KEY)) return c.json({ stored: prev });
    const merged = { ...prev, ...next, flags: { ...(prev.flags || {}), ...next.flags }, at: new Date().toISOString() };
    if (!next.migrated) delete merged.migrated;
    store.setKv(KEY, merged);
    return c.json({ stored: merged });
  });
  app.delete("/api/ui-prefs", (c) => {
    store.setKv(KEY, {});
    return c.json({ stored: {} });
  });
}
