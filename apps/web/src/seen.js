// Per-chat read state, client-side: which chats carry content the owner has not seen yet.
//
// The sidebar's old dot meant «در حال اجرا», so nothing ever marked a chat as unread. Here a chat
// counts as seen when it was on screen (open route, visible tab) with its current updatedAt; the
// server bumps updatedAt when a run starts and again when it finishes, so a run that completes
// elsewhere — or in a hidden tab, or after the owner looked at a mid-run answer and moved on —
// leaves the chat unread until it is opened again. State lives in localStorage: this app is the
// owner's single-browser tool, and a server table would need a migration for the same result.
//
// Pure core is exported for tests; the DOM parts no-op safely when localStorage is missing.
import { useSyncExternalStore } from "react";

const KEY = "griffin.seen.v1";
let cache = null;
let version = 0;
const listeners = new Set();

function map() {
  if (cache) return cache;
  try {
    cache = JSON.parse(localStorage.getItem(KEY)) || {};
  } catch {
    cache = {};
  }
  return cache;
}

/** updatedAt the chat was last seen at, or null. */
export function seenOf(chatId) {
  return map()[chatId] || null;
}

/** Stored in place of a seen time for a chat the owner marked unread by hand. */
export const MARKED_UNREAD = "unread";

/** force: the owner opened the chat (a click, a route change). Without it — the tab became
 * visible again, the open chat got new content — a hand-made unread mark stays. */
export function markSeen(chatId, updatedAt, { force = true } = {}) {
  if (!chatId || !updatedAt) return;
  const m = map();
  if (m[chatId] === updatedAt) return;
  if (!force && m[chatId] === MARKED_UNREAD) return;
  m[chatId] = updatedAt;
  try {
    localStorage.setItem(KEY, JSON.stringify(m));
  } catch {
    /* storage full or blocked — unread state simply resets next load */
  }
  version += 1;
  for (const listener of listeners) listener();
}

// «علامت خوانده‌نشده» from the chat's menu: the badge returns until the chat is opened again.
export function markUnread(chatId) {
  if (!chatId) return;
  const m = map();
  if (m[chatId] === MARKED_UNREAD) return;
  m[chatId] = MARKED_UNREAD;
  try {
    localStorage.setItem(KEY, JSON.stringify(m));
  } catch {
    /* storage full or blocked — the mark lasts until reload */
  }
  version += 1;
  for (const listener of listeners) listener();
}

/** A finished chat is unread when its updatedAt differs from the last seen one (pass
 * seenOf(chat.id)). Running chats show the running spinner instead; the badge takes over the
 * moment the run ends. */
export function isUnreadChat(chat, seenAt) {
  if (!chat || chat.runStatus === "running") return false;
  return !!chat.updatedAt && seenAt !== chat.updatedAt;
}

/** First run after this feature arrived: without a baseline every old chat would show as
 * unread. Everything already in the list counts as seen; only later activity earns a badge. */
export function seedSeen(chats) {
  if (typeof localStorage === "undefined") return false;
  if (localStorage.getItem(KEY) != null) return false;
  const m = map();
  for (const chat of Array.isArray(chats) ? chats : []) {
    if (chat?.id && chat.updatedAt) m[chat.id] = chat.updatedAt;
  }
  try {
    localStorage.setItem(KEY, JSON.stringify(m));
  } catch {
    /* storage blocked — every chat shows unread once; harmless */
  }
  version += 1;
  for (const listener of listeners) listener();
  return true;
}

/** The open chat's "have I looked at it" rule, kept pure for tests. `state` lives across renders
 * ({ chat, pending }). A look counts as the owner opening the chat — and clears a hand-made
 * unread mark — once per arrival at that chat, at the first moment the tab is visible; later
 * looks (the tab coming back, new content) are passive. Leaving for a page with no chat and
 * coming back is a new arrival. */
export function arriveAt(state, chatId) {
  if (state.chat === (chatId || null)) return;
  state.chat = chatId || null;
  state.pending = Boolean(chatId);
}

export function lookAt(state, chatId, updatedAt, visible) {
  if (!visible || !chatId || !updatedAt || state.chat !== chatId) return;
  markSeen(chatId, updatedAt, { force: state.pending });
  state.pending = false;
}

/** Re-render hook: returns a version counter that bumps on every markSeen / markUnread. */
export function useSeenVersion() {
  return useSyncExternalStore(
    (onChange) => {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
    () => version,
    () => version,
  );
}
