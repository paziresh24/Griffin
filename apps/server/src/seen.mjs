// Which chats the owner has read (apps/web/src/seen.js), kept on the server so every device agrees:
// a chat read on the desktop stops reading as unread on the phone. { map: { [chatId]: <the chat's
// updatedAt when it was last seen> | "unread" }, rev }. `rev` counts writes, so a page that polls
// with the revision it has gets `unchanged` instead of the whole map.
const KEY = "seen";
const MARKED_UNREAD = "unread";
const MAX_CHATS = 20000;
const ID = /^[A-Za-z0-9_-]{1,80}$/;

function valid(value) {
  return value === MARKED_UNREAD || (typeof value === "string" && value.length <= 40 && Number.isFinite(Date.parse(value)));
}

/** One seen entry merged into the stored one: a later seen time wins over an earlier one (a device
 * with a stale list must not make a read chat unread again), a hand-made mark always wins, and a
 * seen time clears the mark — the page only sends it when the owner opened the chat. */
export function mergeSeen(previous, next) {
  if (next === MARKED_UNREAD || previous == null || previous === MARKED_UNREAD) return next;
  return Date.parse(next) >= Date.parse(previous) ? next : previous;
}

export function seenRoutes(app, { store }) {
  const state = () => store.getKv(KEY) || null;
  app.get("/api/seen", (c) => {
    const saved = state();
    if (!saved) return c.json({ seen: null, rev: 0 });
    if (Number(c.req.query("have")) === saved.rev) return c.json({ unchanged: true, rev: saved.rev });
    return c.json({ seen: saved.map, rev: saved.rev });
  });
  // { set: { [chatId]: value }, soft?: { [chatId]: seenTime }, init?: true } — `soft` is a passive
  // look (never clears an unread mark); `init` is the first load after the update (one
  // device uploads its own copy plus a baseline); it never overwrites what a device already saved.
  app.put("/api/seen", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body.set !== "object" || body.set === null || Array.isArray(body.set)) return c.json({ error: "بدنهٔ JSON با set لازم است." }, 400);
    const saved = state();
    if (body.init === true && saved) return c.json({ seen: saved.map, rev: saved.rev });
    const map = { ...(saved?.map || {}) };
    let changed = false;
    const apply = (entries, soft) => {
      for (const [id, value] of Object.entries(entries && typeof entries === "object" && !Array.isArray(entries) ? entries : {})) {
        if (!ID.test(id) || !valid(value)) continue;
        // A passive look (the open chat, the tab coming back) never clears a hand-made unread mark.
        if (soft && map[id] === MARKED_UNREAD) continue;
        const merged = mergeSeen(map[id], value);
        if (merged === map[id]) continue;
        map[id] = merged;
        changed = true;
      }
    };
    apply(body.soft, true);
    apply(body.set, false);
    if (Object.keys(map).length > MAX_CHATS) return c.json({ error: "تعداد گفتگوها از حد بیشتر است." }, 400);
    const rev = (saved?.rev || 0) + (changed || !saved ? 1 : 0);
    if (changed || !saved) store.setKv(KEY, { map, rev, at: new Date().toISOString() });
    return c.json({ rev, ...(body.init === true ? { seen: map } : {}) });
  });
}
