// How the owner's chat list is grouped, sorted and filtered, kept on the server so every device shows
// the same list (before, each browser's localStorage held it, so a new phone started
// ungrouped). Griffin groups each sidebar section on its own: { groupBy: { [section]: grouping } }. A
// body without a section (an older client) sets the main list ("manual"). The sort, its direction and the
// filter are one choice for the whole list: { sort, reverse, filter }.
import { uiPrefsRoutes } from "./ui-prefs.mjs";
import { seenRoutes } from "./seen.mjs";

export const GROUPINGS = ["none", "custom", "owner", "state", "read", "date", "agent", "repo", "model", "origin"];
// The ids both skins offer (apps/web chat-list.js and karsara-chat-list.js); a skin ignores one it lacks.
export const SORTS = ["updated", "created", "state", "unread", "running", "title"];
export const FILTERS = ["all", "unread", "ask", "running", "background", "error", "pinned", "mine", "jobs"];
export const REVERSES = ["yes", "no"];
const CHOICES = { sort: SORTS, filter: FILTERS, reverse: REVERSES };
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
  const choices = () => {
    const saved = store.getKv("list-prefs") || {};
    return Object.fromEntries(Object.entries(CHOICES).filter(([key, allowed]) => allowed.includes(saved[key])).map(([key]) => [key, saved[key]]));
  };
  // The order the owner dragged the sections of a grouping into (by repository, agent, …; web drag.js):
  // { [grouping]: [section keys] }. The owner's own groups keep theirs in chat_groups.
  const sectionOrder = () => {
    const saved = store.getKv("list-prefs")?.sectionOrder;
    return saved && typeof saved === "object" ? Object.fromEntries(Object.entries(saved).filter(([g, list]) => GROUPINGS.includes(g) && Array.isArray(list))) : {};
  };
  const view = () => {
    const all = sections();
    return { groupBy: all.manual || null, sections: all, ...choices(), sectionOrder: sectionOrder() };
  };
  app.get("/api/list-prefs", (c) => c.json(view()));
  app.put("/api/list-prefs", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const next = {};
    for (const [key, allowed] of Object.entries(CHOICES)) {
      if (body?.[key] === undefined) continue;
      if (!allowed.includes(body[key])) return c.json({ error: `${key} باید یکی از این‌ها باشد: ${allowed.join("، ")}` }, 400);
      next[key] = body[key];
    }
    if (body?.sectionOrder !== undefined) {
      const given = body.sectionOrder;
      const ok = given && typeof given === "object" && !Array.isArray(given) && Object.entries(given).every(([g, list]) => GROUPINGS.includes(g) && Array.isArray(list) && list.length <= 300 && list.every((k) => typeof k === "string" && k.length <= 300));
      if (!ok) return c.json({ error: "sectionOrder باید { گروه‌بندی: [کلید بخش‌ها] } باشد." }, 400);
      next.sectionOrder = { ...sectionOrder(), ...given };
    }
    if (body?.groupBy !== undefined || !Object.keys(next).length) {
      if (!GROUPINGS.includes(body?.groupBy)) return c.json({ error: `groupBy باید یکی از این‌ها باشد: ${GROUPINGS.join("، ")}` }, 400);
      const section = body.section == null ? "manual" : String(body.section);
      if (!SECTION.test(section)) return c.json({ error: "section نامعتبر است." }, 400);
      next.groupBy = { ...sections(), [section]: body.groupBy };
    }
    store.setKv("list-prefs", { ...(store.getKv("list-prefs") || {}), ...next });
    return c.json(view());
  });
}
