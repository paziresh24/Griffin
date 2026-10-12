// Timelines of the chats opened in this tab, so going back to one shows it at once instead of
// an empty thread. Each is stored with the server revision that folded it; the next open asks
// the server only whether anything is newer (api.js useTimeline).
const KEEP = 6; // big chats are several MB each

export function createTimelineMemo(keep = KEEP) {
  const held = new Map(); // chatId -> { timeline, rev }; insertion order is oldest first
  return {
    recall(chatId) {
      return held.get(chatId) || null;
    },
    remember(chatId, timeline, rev) {
      if (!chatId || !rev) return;
      held.delete(chatId);
      held.set(chatId, { timeline, rev });
      while (held.size > keep) held.delete(held.keys().next().value);
    },
    forget(chatId) {
      held.delete(chatId);
    },
  };
}

// What the header says about the thread's connection; null = say nothing.
//   loading      the history is on its way and there is nothing to show yet
//   refreshing   a remembered copy is on screen while the server is asked for newer events
//   connecting   the history is shown and the live stream is opening
//   live | reconnecting | closed
// The text is the Persian i18n key; the header shows it through t().
export function connectionNotice(connection) {
  if (connection === "loading") return { text: "بارگذاری…", tone: "muted" }; // i18n-ignore
  if (connection === "reconnecting" || connection === "closed") return { text: "قطع", tone: "warn" }; // i18n-ignore
  return null;
}
