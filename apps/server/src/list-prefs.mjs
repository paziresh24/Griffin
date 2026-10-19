// How the owner's chat list is grouped, kept on the server so every device shows the same list
// (before, each browser's localStorage held it, so a new phone started ungrouped).
// Griffin groups each sidebar section on its own: { groupBy: { [section]: grouping } }. A body
// without a section (an older client) sets the main list ("manual").
import { uiPrefsRoutes } from "./ui-prefs.mjs";
import { seenRoutes } from "./seen.mjs";

export const GROUPINGS = ["none", "custom", "owner", "state", "read", "date", "agent", "repo", "model"];
const SECTION = /^[a-z][a-z0-9-]{0,30}$/;

export function listPrefsRoutes(app, { store }) {
  uiPrefsRoutes(app, { store }); // the look and feature flags (ui-prefs.mjs), beside the list's own prefs
  seenRoutes(app, { store }); // which chats are read (seen.mjs): the same on every device
  const sections = () => {
    const saved = store.getKv("list-prefs")?.groupBy;
    // An older format stored one string for a single list.
    const all = typeof saved === "string" ? { manual: saved } : saved && typeof saved === "object" ? saved : {};
    return Object.fromEntries(Object.entries(all).filter(([section, value]) => SECTION.test(section) && GROUPINGS.includes(value)));
  };
  const view = () => {
    const all = sections();
    return { groupBy: all.manual || null, sections: all };
  };
  app.get("/api/list-prefs", (c) => c.json(view()));
  app.put("/api/list-prefs", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    if (!GROUPINGS.includes(body?.groupBy)) return c.json({ error: `groupBy باید یکی از این‌ها باشد: ${GROUPINGS.join("، ")}` }, 400);
    const section = body.section == null ? "manual" : String(body.section);
    if (!SECTION.test(section)) return c.json({ error: "section نامعتبر است." }, 400);
    store.setKv("list-prefs", { ...(store.getKv("list-prefs") || {}), groupBy: { ...sections(), [section]: body.groupBy } });
    return c.json(view());
  });
}
