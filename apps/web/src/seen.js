// Per-chat read state: which chats carry content the owner has not seen yet.
//
// The sidebar's old dot meant «در حال اجرا», so nothing ever marked a chat as unread. Here a chat
// counts as seen when it was on screen (open route, visible tab) with its current updatedAt; the
// server bumps updatedAt when a run starts and again when it finishes, so a run that completes
// elsewhere — or in a hidden tab, or after the owner looked at a mid-run answer and moved on —
// leaves the chat unread until it is opened again.
//
// The truth lives on the server (GET/PUT /api/seen, seen.mjs), so a chat read on the desktop is
// read on the phone too; localStorage is only this browser's copy, for the first paint and for
// when the server cannot be reached. The first device to load after the update uploads its own
// copy plus a baseline (every chat already listed counts as seen). Other devices' reads arrive
// when the tab comes back, on focus, and once a minute while it is visible. Every open tab also
// shares the storage; a «storage» event from another tab re-renders this one at once.
//
// Pure core is exported for tests; the DOM parts no-op safely when localStorage is missing.
import { useSyncExternalStore } from "react";
import { api } from "./api.js";

const KEY = "griffin.seen.v1";
const PULL_MS = 60_000;
const PUSH_MS = 300;
const SYNCED_KEY = "griffin.seen.synced.v1"; // this browser has taken part in the server's read state once
let cache = null;
let version = 0;
const listeners = new Set();

// Server sync: off until syncSeen() runs (tests and signed-out pages never touch the network).
let request = null;
let rev = 0;
let pending = {}; // reads not sent yet
let pendingSoft = {}; // passive looks not sent yet (the open chat, the tab coming back)
let inflight = {}; // reads on their way: a pull answered meanwhile must not undo them
let pushTimer = null;
let syncing = null;
let polling = false;

function map() {
  if (cache) return cache;
  try {
    cache = JSON.parse(localStorage.getItem(KEY)) || {};
  } catch {
    cache = {};
  }
  return cache;
}

function notify() {
  version += 1;
  for (const listener of listeners) listener();
}

/** Another tab wrote the read state (or cleared storage): forget the cached copy and re-render.
 * Returns whether the event was ours to act on. */
export function onStorageChange(event) {
  if (event && event.key != null && event.key !== KEY) return false;
  cache = null;
  notify();
  return true;
}

if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  window.addEventListener("storage", onStorageChange);
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
  persist(m);
  push(chatId, updatedAt, !force);
  notify();
}

// «علامت خوانده‌نشده» from the chat's menu: the badge returns until the chat is opened again.
export function markUnread(chatId) {
  if (!chatId) return;
  const m = map();
  if (m[chatId] === MARKED_UNREAD) return;
  m[chatId] = MARKED_UNREAD;
  persist(m);
  push(chatId, MARKED_UNREAD);
  notify();
}

function persist(m) {
  try {
    localStorage.setItem(KEY, JSON.stringify(m));
  } catch {
    /* storage full or blocked — this browser's copy resets next load; the server's stays */
  }
}

// --- server sync ---

function push(chatId, value, soft = false) {
  // Before the first sync it waits here, and is sent once the server answered. A passive look is
  // «soft»: it never clears an unread mark another device made (the server skips it then).
  if (soft && value !== MARKED_UNREAD) {
    if (!(chatId in pending)) pendingSoft[chatId] = value;
  } else {
    pending[chatId] = value;
    delete pendingSoft[chatId];
  }
  if (!request || pushTimer) return;
  pushTimer = setTimeout(flush, PUSH_MS);
  pushTimer.unref?.();
}

async function flush() {
  pushTimer = null;
  const set = pending;
  const soft = pendingSoft;
  if (!request || !(Object.keys(set).length || Object.keys(soft).length)) return;
  pending = {};
  pendingSoft = {};
  inflight = { ...inflight, ...soft, ...set };
  try {
    const answer = await request("/api/seen", { method: "PUT", body: { set, soft } });
    // Only our own write since the last pull: the map we hold is already the server's.
    if (answer?.rev === rev + 1) rev = answer.rev;
  } catch {
    for (const [id, value] of Object.entries(set)) if (!(id in pending)) pending[id] = value;
    for (const [id, value] of Object.entries(soft)) if (!(id in pending) && !(id in pendingSoft)) pendingSoft[id] = value;
    pushTimer = setTimeout(flush, 5000);
    pushTimer.unref?.();
  } finally {
    for (const [id, value] of Object.entries({ ...soft, ...set })) if (inflight[id] === value) delete inflight[id];
  }
}

/** The server's copy becomes this browser's, except reads the server has not heard yet. */
function adopt(serverMap, serverRev) {
  const next = { ...serverMap, ...inflight, ...pending };
  // a passive look the server has not heard yet never hides an unread mark the server holds
  for (const [id, value] of Object.entries(pendingSoft)) if (serverMap[id] !== MARKED_UNREAD) next[id] = value;
  rev = serverRev || 0;
  const same = JSON.stringify(next) === JSON.stringify(map());
  cache = next;
  persist(next);
  if (!same) notify();
}

async function pull() {
  if (!request) return;
  try {
    const answer = await request(`/api/seen?have=${rev}`);
    if (answer?.seen) adopt(answer.seen, answer.rev);
  } catch {
    /* offline: the local copy stays */
  }
}

function startPolling() {
  if (polling || typeof window === "undefined" || typeof document === "undefined") return;
  polling = true;
  const visible = () => document.visibilityState === "visible";
  document.addEventListener("visibilitychange", () => visible() && pull());
  window.addEventListener("focus", () => pull());
  const timer = setInterval(() => visible() && pull(), PULL_MS);
  timer.unref?.();
}

/** Tests only: forget the sync so a second device can be played in the same process. */
export function resetSyncForTests() {
  syncing = null;
  request = null;
  rev = 0;
  pending = {};
  pendingSoft = {};
  inflight = {};
  cache = null;
}

function syncedBefore() {
  try {
    return localStorage.getItem(SYNCED_KEY) != null;
  } catch {
    return true;
  }
}

function rememberSynced() {
  try {
    localStorage.setItem(SYNCED_KEY, "1");
  } catch {
    /* storage blocked — the next load only tries to restore marks again, which is harmless */
  }
}

/**
 * Sign-in done and the chat list loaded: take the server's read state — or, when it has none yet
 * (the first device after the update), upload this browser's copy over a baseline that counts
 * every chat already listed as seen. Resolves to whether the server answered; false leaves the
 * local copy in charge (see seedSeen). One call does the work; later calls share its answer.
 */
export function syncSeen(chats, { request: send = api } = {}) {
  if (syncing) return syncing;
  syncing = (async () => {
    try {
      const first = await send("/api/seen");
      if (first?.seen) {
        request = send;
        // A browser that held read state before the server did, and has not shared it yet: its
        // hand-made «خوانده‌نشده» marks are the owner's own choice, so they go up, not away.
        const keep = syncedBefore() ? [] : Object.keys(map()).filter((id) => map()[id] === MARKED_UNREAD && first.seen[id] !== MARKED_UNREAD);
        adopt(first.seen, first.rev);
        for (const id of keep) markUnread(id);
      } else {
        const initial = {};
        for (const chat of Array.isArray(chats) ? chats : []) if (chat?.id && chat.updatedAt) initial[chat.id] = chat.updatedAt;
        Object.assign(initial, map());
        const saved = await send("/api/seen", { method: "PUT", body: { set: initial, init: true } });
        request = send;
        adopt(saved?.seen || initial, saved?.rev);
      }
      startPolling();
      rememberSynced();
      if (Object.keys(pending).length || Object.keys(pendingSoft).length) flush();
      return true;
    } catch {
      syncing = null; // try again with the next list load
      return false;
    }
  })();
  return syncing;
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
  notify();
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
