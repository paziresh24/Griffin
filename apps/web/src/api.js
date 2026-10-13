import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { emptyTimeline } from "@griffin/timeline";
import { createTimelineMemo } from "./timeline-memo.js";
import { keepOpen } from "./stream-keeper.js";
import { catchUpTimeline, openTimeline } from "./timeline-stream.js";

export class ApiError extends Error {
  constructor(status, body) {
    super(body?.error || `http ${status}`);
    this.status = status;
  }
}

export async function api(path, { method = "GET", body } = {}) {
  const response = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (response.status === 401) window.dispatchEvent(new Event("griffin:unauthorized"));
  if (!response.ok) throw new ApiError(response.status, data);
  return data;
}

// Told whenever the owner's inbox may have changed (inbox.js refetches): after each chat-list load
// (a 'chats' event or a reconnect) and on the stream's own 'inbox' event.
export const INBOX_EVENT = "griffin:inbox";

// Chat list, refreshed whenever the server says something changed.
export function useChats() {
  const [state, setState] = useState({ chats: [], archived: [], groups: [], loading: true });
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        // The owner's chat groups ride along: a group change emits the same list event.
        const [active, archived, groups] = await Promise.all([
          api("/api/chats"),
          api("/api/chats?archived=1"),
          api("/api/groups").catch(() => null),
        ]);
        // A failed groups read keeps the last list: an empty one would drop a chosen group silently.
        if (alive) {
          setState((s) => ({ chats: active.chats, archived: archived.chats, groups: groups ? groups.groups || [] : s.groups, loading: false }));
          window.dispatchEvent(new Event(INBOX_EVENT));
        }
      } catch {
        if (alive) setState((s) => ({ ...s, loading: false }));
      }
    };
    load();
    // A stream the browser gave up on (a 502 during a deploy) is reopened (stream-keeper.js).
    const keeper = keepOpen({
      open: () => {
        const source = new EventSource("/api/stream");
        source.addEventListener("chats", load);
        source.addEventListener("inbox", () => window.dispatchEvent(new Event(INBOX_EVENT)));
        return source;
      },
      onOpen: load,
      onState: () => {},
    });
    return () => {
      alive = false;
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
    };
  }, [chatId, reloadKey]);

  // Until the effect for a newly chosen chat has run, state still belongs to the previous one:
  // show the remembered copy (or nothing), never another chat's thread.
  if (!chatId) return { timeline: EMPTY, connection: "idle", reconnect };
  if (state.chatId === chatId) return { timeline: state.timeline, connection: state.connection, reconnect };
  const remembered = memo.recall(chatId);
  return { timeline: remembered?.timeline || EMPTY, connection: remembered ? "refreshing" : "loading", reconnect };
}

export function usePolling(path, intervalMs) {
  const [data, setData] = useState(null);
  useEffect(() => {
    let alive = true;
    let timer;
    const tick = async () => {
      try {
        const value = await api(path);
        if (alive) setData(value);
      } catch {
        if (alive) setData((d) => d && { ...d, stale: true });
      }
      if (alive) timer = setTimeout(tick, intervalMs);
    };
    tick();
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

// "#/settings" and "#/jobs" are pages that replace the thread.
export function usePageRoute() {
  const hash = useSyncExternalStore(subscribeHash, () => window.location.hash);
  const match = /^#\/(settings|jobs|agents|telegram(?:\/[0-9a-f-]{36})?|incidents|peers|workbench|setup(?:\/\w+)?)$/.exec(hash);
  return match ? match[1].split("/")[0] : null;
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
