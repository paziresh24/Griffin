import { setNextStepReturns } from "./assist.js";
import { setEnterKey } from "./touch.js";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { emptyTimeline } from "@griffin/timeline";
import { createTimelineMemo } from "./timeline-memo.js";
import { keepOpen } from "./stream-keeper.js";
import { catchUpTimeline, openTimeline, PAGE } from "./timeline-stream.js";
import { keepSameRows, readChatsCache, writeChatsCache } from "./chats-cache.js";

export class ApiError extends Error {
  constructor(status, body) {
    super(body?.error || `http ${status}`);
    this.status = status;
    this.body = body;
  }
}

export async function api(path, { method = "GET", body } = {}) {
  const response = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return answered(response.status, await response.json().catch(() => ({})));
}

function answered(status, data) {
  if (status === 401) window.dispatchEvent(new Event("griffin:unauthorized"));
  // The install requires two-step sign-in and it is not set up yet (auth.mjs): the setup screen shows.
  if (status === 403 && data?.setupRequired) window.dispatchEvent(new Event("griffin:setup-2fa"));
  if (status < 200 || status >= 300) throw new ApiError(status, data);
  return data;
}

// One piece of an attached file (attachments.js): bytes, not JSON.
export async function apiPiece(path, piece, signal) {
  const response = await fetch(path, { method: "PUT", credentials: "same-origin", headers: { "content-type": "application/octet-stream" }, body: piece, signal });
  return answered(response.status, await response.json().catch(() => ({})));
}

// Told whenever the owner's inbox may have changed (inbox.js refetches): after each chat-list load
// (a 'chats' event or a reconnect) and on the stream's own 'inbox' event.
export const INBOX_EVENT = "griffin:inbox";

// Chat list, refreshed whenever the server says something changed.
// One reload per burst, and never more often than this: each reload is a full list (a few hundred KB on
// a busy install) to build on the server and to parse and diff here.
const LIST_MIN_GAP_MS = 1500;
// The whole list as last read, for what picks a chat (the «@» list, «فرستادن به…»); before the first
// read, the last visit's newest ones.
let lastList = null;
export const listedChats = () => lastList || readChatsCache()?.chats || [];
export function useChats() {
  const [state, setState] = useState(() => {
    // The last list seen shows at once; the server's answer replaces it (chats-cache.js).
    const cached = readChatsCache();
    return { chats: cached?.chats || [], archived: [], groups: cached?.groups || [], looseAt: cached?.looseAt ?? null, sideChat: true, privateShare: false, loading: !cached?.chats.length, failed: false, retry: () => {} };
  });
  useEffect(() => {
    let alive = true;
    let retryTimer = null;
    let inFlight = false;
    let againAfter = false;
    let lastLoad = 0;
    let archiveStamp = null; // the archive as last read (active list's archiveStamp); null: not read yet
    const load = async () => {
      clearTimeout(retryTimer);
      // A change while a read is on its way: one more read when it lands, not two lists racing.
      if (inFlight) {
        againAfter = true;
        return;
      }
      inFlight = true;
      lastLoad = Date.now();
      // The list is drawn as soon as it arrives; the groups go out with it.
      const activeRead = api("/api/chats");
      // The owner's chat groups ride along: a group change emits the same list event.
      const groupsRead = api("/api/groups").catch(() => null);
      try {
        const active = await activeRead;
        if (!alive) return;
        lastList = active.chats;
        setNextStepReturns(active.nextStepReturns === true);
        setEnterKey(active.enterKey);
        // Rows that did not change keep their objects, and an unchanged list its array: nothing redraws for them.
        setState((s) => {
          const chats = keepSameRows(s.chats, active.chats);
          const sideChat = active.sideChat !== false;
          const privateShare = active.privateShare === true;
          return chats === s.chats && sideChat === s.sideChat && privateShare === s.privateShare && !s.loading && !s.failed ? s : { ...s, chats, sideChat, privateShare, loading: false, failed: false };
        });
        window.dispatchEvent(new Event(INBOX_EVENT));
        freshenRemembered(active.chats);
        // The archive is the slowest read and rarely changes: only when the list says it did.
        const stamp = active.archiveStamp ?? null;
        const archivedRead = !stamp || stamp !== archiveStamp ? api("/api/chats?archived=1").catch(() => null) : null;
        const [archived, groups] = await Promise.all([archivedRead, groupsRead]);
        if (!alive) return;
        if (archived) archiveStamp = stamp;
        // A failed archive or groups read keeps the last list: an empty one would drop a chosen group silently.
        setState((s) => {
          const nextArchived = archived ? keepSameRows(s.archived, archived.chats) : s.archived;
          const nextGroups = groups ? groups.groups || [] : s.groups;
          const sameGroups = JSON.stringify(nextGroups) === JSON.stringify(s.groups);
          const looseAt = groups ? groups.looseAt ?? null : s.looseAt;
          return nextArchived === s.archived && sameGroups && looseAt === s.looseAt ? s : { ...s, archived: nextArchived, groups: sameGroups ? s.groups : nextGroups, looseAt };
        });
        writeChatsCache(active.chats, groups ? groups.groups || [] : null, undefined, groups ? groups.looseAt ?? null : undefined);
      } catch {
        // A read that failed is not an empty list: say so, and try again until it works.
        if (alive) {
          setState((s) => ({ ...s, loading: false, failed: true }));
          retryTimer = setTimeout(load, 4000);
        }
      } finally {
        inFlight = false;
        if (againAfter && alive) {
          againAfter = false;
          loadSoon();
        }
      }
    };
    setState((s) => ({ ...s, retry: () => { setState((v) => ({ ...v, loading: true })); load(); } }));
    load();
    // A run starting, a title, a group change… often come as a burst of «chats» events: one reload
    // for the burst, not three lists per event.
    let soon = null;
    function loadSoon() {
      if (!soon) soon = setTimeout(() => { soon = null; load(); }, Math.max(400, lastLoad + LIST_MIN_GAP_MS - Date.now()));
    }
    // A stream the browser gave up on (a 502 during a deploy) is reopened (stream-keeper.js).
    const keeper = keepOpen({
      open: () => {
        const source = new EventSource("/api/stream");
        source.addEventListener("chats", loadSoon);
        source.addEventListener("inbox", () => window.dispatchEvent(new Event(INBOX_EVENT)));
        return source;
      },
      onOpen: load,
      onState: () => {},
    });
    return () => {
      alive = false;
      clearTimeout(retryTimer);
      clearTimeout(soon);
      keeper.stop();
    };
  }, []);
  return state;
}

// Rewind/edit deletes events the SSE stream can't un-append, so the view must refetch.
export function reloadTimeline() {
  window.dispatchEvent(new Event("griffin:reload-timeline"));
}

const EMPTY = emptyTimeline();
const memo = createTimelineMemo();
const shown = new Map(); // chatId -> how many views show it now (the thread, a side panel)

// A chat opened earlier in this tab and changed since (it finished, a message came) used to open
// on the copy from when it was left, one step behind, and then jump to the end (owner 2026-10-28).
// When the list says such a chat changed, its copy is brought up to date in the background, so it
// opens as it is now. Chats on screen stay current through their own stream.
const listMarks = new Map(); // chatId -> what the list last said of it
const freshening = new Set();
async function freshenRemembered(chats) {
  const stale = [];
  for (const chat of chats) {
    const mark = `${chat.updatedAt}|${chat.runStatus}`;
    const before = listMarks.get(chat.id);
    listMarks.set(chat.id, mark);
    if (before !== undefined && before !== mark && memo.recall(chat.id) && !shown.get(chat.id) && !freshening.has(chat.id)) stale.push(chat.id);
  }
  stale.forEach((chatId) => freshening.add(chatId));
  for (const chatId of stale) {
    const held = memo.recall(chatId);
    if (!held) {
      freshening.delete(chatId);
      continue;
    }
    try {
      const answer = await api(`/api/chats/${chatId}/timeline?limit=${PAGE}&have=${held.timeline.lastEventId}&rev=${encodeURIComponent(held.rev)}`);
      // Opened meanwhile (its own load and stream keep it), or the copy moved on: leave it.
      if (answer?.timeline && !shown.get(chatId) && memo.recall(chatId) === held) memo.remember(chatId, answer.timeline, answer.rev || null);
    } catch {
      /* the open itself catches up */
    }
    freshening.delete(chatId);
  }
}

export { catchUpTimeline };

// One chat's timeline (timeline-stream.js does the work). Every (re)connect of the stream asks
// for events after the last one it holds, and the server replays only newer ones, so nothing is
// duplicated or lost; a stream the browser gave up on is reopened. A chat opened before in this
// tab is shown from memory at once (timeline-memo.js) while the server is asked for anything newer.
export function useTimeline(chatId) {
  const [state, setState] = useState({ chatId: null, timeline: EMPTY, connection: "idle" });
  const [reloadKey, setReloadKey] = useState(0);
  const reloaded = useRef(0);
  const openRef = useRef(null);
  const reconnect = useCallback(() => openRef.current?.retryNow(), []);
  const loadOlder = useCallback(() => openRef.current?.loadOlder() ?? Promise.resolve(false), []);

  useEffect(() => {
    const bump = () => setReloadKey((k) => k + 1);
    window.addEventListener("griffin:reload-timeline", bump);
    return () => window.removeEventListener("griffin:reload-timeline", bump);
  }, []);

  useEffect(() => {
    if (!chatId) return undefined;
    // After a rewind the remembered copy holds deleted events.
    if (reloadKey !== reloaded.current) {
      reloaded.current = reloadKey;
      memo.forget(chatId);
    }
    let alive = true;
    shown.set(chatId, (shown.get(chatId) || 0) + 1);
    openRef.current = openTimeline({
      chatId,
      remembered: memo.recall(chatId),
      api,
      win: window,
      doc: document,
      onShow: ({ timeline, rev, connection }) => {
        if (!alive) return;
        memo.remember(chatId, timeline, rev);
        setState({ chatId, timeline, connection });
      },
    });
    return () => {
      alive = false;
      openRef.current?.stop();
      openRef.current = null;
      if ((shown.get(chatId) || 0) <= 1) shown.delete(chatId);
      else shown.set(chatId, shown.get(chatId) - 1);
    };
  }, [chatId, reloadKey]);

  // Until the effect for a newly chosen chat has run, state still belongs to the previous one:
  // show the remembered copy (or nothing), never another chat's thread.
  if (!chatId) return { timeline: EMPTY, connection: "idle", reconnect, loadOlder };
  if (state.chatId === chatId) return { timeline: state.timeline, connection: state.connection, reconnect, loadOlder };
  const remembered = memo.recall(chatId);
  return { timeline: remembered?.timeline || EMPTY, connection: remembered ? "refreshing" : "loading", reconnect, loadOlder };
}

// The last answer per path, for the whole page. The composer is mounted anew for every chat: its repo
// chip and model name used to start empty each time and pop in (owner 2026-11-05: «یهو لود میشه»). A hook
// now draws the last answer at once and asks again behind it; pickers asking together share one request.
const polled = new Map(); // path -> { data, at, asking }
const POLL_FRESH_MS = 15_000; // an answer this young is not asked for again by the next mount
// These three survive a reload too (the composer's repo, model and effort): harmless lists, like the chat cache.
const KEPT_POLLS = ["/api/repos", "/api/agents", "/api/models?provider=all"];
const keptPollKey = (path) => `griffin.polled.v1:${path}`;
function polledEntry(path) {
  if (!polled.has(path)) {
    let data = null;
    if (KEPT_POLLS.includes(path)) {
      try {
        data = JSON.parse(localStorage.getItem(keptPollKey(path)) || "null");
      } catch {
        data = null;
      }
    }
    polled.set(path, { data, at: 0, asking: null });
  }
  return polled.get(path);
}
function askPolled(path) {
  const entry = polledEntry(path);
  entry.asking ||= api(path)
    .then((value) => {
      entry.data = value;
      entry.at = Date.now();
      if (KEPT_POLLS.includes(path)) {
        try {
          localStorage.setItem(keptPollKey(path), JSON.stringify(value));
        } catch {
          /* storage full or blocked: the next visit just asks first */
        }
      }
      return value;
    })
    .finally(() => {
      entry.asking = null;
    });
  return entry.asking;
}
/** At the app's start: the composer's lists are in hand before any composer needs them. */
export function preloadPolls() {
  for (const path of KEPT_POLLS) askPolled(path).catch(() => {});
}

export function usePolling(path, intervalMs) {
  const [data, setData] = useState(() => (path ? polledEntry(path).data : null));
  useEffect(() => {
    // No path: nothing to ask (a hook that only one skin needs).
    if (!path) return setData(null);
    let alive = true;
    let timer;
    const entry = polledEntry(path);
    if (entry.data) setData(entry.data);
    const tick = async () => {
      try {
        const value = await askPolled(path);
        if (alive) setData(value);
      } catch {
        if (alive) setData((d) => d && { ...d, stale: true });
      }
      if (alive) timer = setTimeout(tick, intervalMs);
    };
    const age = Date.now() - entry.at;
    if (age < Math.min(intervalMs, POLL_FRESH_MS)) timer = setTimeout(tick, intervalMs - age);
    else tick();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [path, intervalMs]);
  return data;
}

// Tiny hash router: #/c/<chatId>
function subscribeHash(callback) {
  window.addEventListener("hashchange", callback);
  return () => window.removeEventListener("hashchange", callback);
}

// "#/settings" and "#/jobs" are pages that replace the thread. "#/settings/<section>" opens Settings on
// that section: a link to send someone (2026-10-27: «یه لینک بده اکانت جدید کلاد اضافه کنن» → /#/settings/providers).
export function usePageRoute() {
  const hash = useSyncExternalStore(subscribeHash, () => window.location.hash);
  const match = /^#\/(settings(?:\/[a-z-]{2,32})?|jobs|agents(?:\/new)?|telegram(?:\/[0-9a-f-]{36})?|incidents|peers(?:\/[\w.-]{1,64})?|workbench|inbox(?:\/\d{1,20})?|setup(?:\/\w+)?|m\/[a-z0-9-]{2,32}\/[a-z0-9-]{1,40}(?:\/[A-Za-z0-9_.-]{1,80})?)$/.exec(hash); // a module page may take one argument, like modules.js ROUTE
  return match ? match[1].split("/")[0] : null;
}

// "#/browser/<chatId>": that chat's own browser on a page of its own (BrowserPanel.jsx).
export function useBrowserRoute() {
  const hash = useSyncExternalStore(subscribeHash, () => window.location.hash);
  return /^#\/browser\/([0-9a-f-]{36})$/.exec(hash)?.[1] || null;
}

// "#/peers/<id>": that colleague's page on the colleagues' agents page (Peers.jsx).
export function usePeerRoute() {
  const hash = useSyncExternalStore(subscribeHash, () => window.location.hash);
  return /^#\/peers\/([\w.-]{1,64})$/.exec(hash)?.[1] || null;
}

// "#/telegram/<personId>": that person's mother chat.
export function useTelegramPerson() {
  const hash = useSyncExternalStore(subscribeHash, () => window.location.hash);
  return /^#\/telegram\/([0-9a-f-]{36})$/.exec(hash)?.[1] || null;
}

export function useRoute() {
  const hash = useSyncExternalStore(subscribeHash, () => window.location.hash);
  const match = hash.match(/^#\/c\/([0-9a-f-]{36})$/);
  return match ? match[1] : null;
}

export function navigate(chatId) {
  window.location.hash = chatId ? `/c/${chatId}` : "/";
}

export function fileToImage(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const [, data] = String(reader.result).split(",", 2);
      resolve({ mimeType: file.type, data });
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}
