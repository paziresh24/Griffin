import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { applyEvent, emptyTimeline } from "@griffin/timeline";
import { createTimelineMemo } from "./timeline-memo.js";

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

// Chat list, refreshed whenever the server says something changed.
export function useChats() {
  const [state, setState] = useState({ chats: [], archived: [], loading: true });
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const [active, archived] = await Promise.all([api("/api/chats"), api("/api/chats?archived=1")]);
        if (alive) setState({ chats: active.chats, archived: archived.chats, loading: false });
      } catch {
        if (alive) setState((s) => ({ ...s, loading: false }));
      }
    };
    load();
    const source = new EventSource("/api/stream");
    source.addEventListener("chats", load);
    source.onopen = load;
    return () => {
      alive = false;
      source.close();
    };
  }, []);
  return state;
}

// One chat's timeline. EventSource resends Last-Event-ID on reconnect, and the server replays
// only newer events, so nothing is duplicated or lost.
// Rewind/edit deletes events the SSE stream can't un-append, so the view must refetch.
export function reloadTimeline() {
  window.dispatchEvent(new Event("griffin:reload-timeline"));
}

const EMPTY = emptyTimeline();
const memo = createTimelineMemo();

// A chat opened before in this tab is shown from memory at once (timeline-memo.js) while the
// server is asked for anything newer.
export function useTimeline(chatId) {
  const [state, setState] = useState({ chatId: null, timeline: EMPTY, connection: "idle" });
  const [reloadKey, setReloadKey] = useState(0);
  const buffer = useRef([]);
  const reloaded = useRef(0);

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
    const remembered = memo.recall(chatId);
    let current = remembered?.timeline || emptyTimeline();
    let rev = remembered?.rev || null;
    let connection = remembered ? "refreshing" : "loading";
    let source = null;
    let alive = true;
    let frame = 0;
    const show = () => {
      if (!alive) return;
      memo.remember(chatId, current, rev);
      setState({ chatId, timeline: current, connection });
    };
    const flush = () => {
      frame = 0;
      const events = buffer.current;
      buffer.current = [];
      current = events.reduce(applyEvent, current);
      show();
    };
    const setConnection = (next) => {
      connection = next;
      show();
    };
    const listen = () => {
      setConnection("connecting");
      source = new EventSource(`/api/chats/${chatId}/stream?after=${current.lastEventId || 0}`);
      source.addEventListener("event", (message) => {
        buffer.current.push(JSON.parse(message.data));
        // batch token bursts into one render per frame
        if (!frame) frame = requestAnimationFrame(flush);
      });
      source.onopen = () => setConnection("live");
      source.onerror = () => setConnection(source.readyState === EventSource.CLOSED ? "closed" : "reconnecting");
    };
    show();
    // The whole history arrives folded in one response; only newer events are streamed. With a
    // remembered copy the server answers {unchanged} unless something is newer.
    const have = remembered ? `?have=${current.lastEventId}&rev=${encodeURIComponent(rev)}` : "";
    api(`/api/chats/${chatId}/timeline${have}`)
      .then((answer) => {
        if (!alive) return;
        if (answer.timeline) {
          current = answer.timeline;
          rev = answer.rev || null;
        }
        listen();
      })
      .catch(() => alive && listen());
    return () => {
      alive = false;
      if (frame) cancelAnimationFrame(frame);
      buffer.current = [];
      source?.close();
    };
  }, [chatId, reloadKey]);

  // Until the effect for a newly chosen chat has run, state still belongs to the previous one:
  // show the remembered copy (or nothing), never another chat's thread.
  if (!chatId) return { timeline: EMPTY, connection: "idle" };
  if (state.chatId === chatId) return { timeline: state.timeline, connection: state.connection };
  const remembered = memo.recall(chatId);
  return { timeline: remembered?.timeline || EMPTY, connection: remembered ? "refreshing" : "loading" };
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
  const match = /^#\/(settings|jobs|agents|telegram|incidents|peers|workbench|setup(?:\/\w+)?)$/.exec(hash);
  return match ? match[1].split("/")[0] : null;
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
