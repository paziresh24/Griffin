import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { applyEvent, emptyTimeline } from "@griffin/timeline";

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
export function useTimeline(chatId) {
  const [timeline, setTimeline] = useState(emptyTimeline);
  const [connection, setConnection] = useState("idle");
  const buffer = useRef([]);

  useEffect(() => {
    setTimeline(emptyTimeline());
    if (!chatId) {
      setConnection("idle");
      return undefined;
    }
    setConnection("connecting");
    let source = null;
    let alive = true;
    let frame = 0;
    const flush = () => {
      frame = 0;
      const events = buffer.current;
      buffer.current = [];
      setTimeline((current) => events.reduce(applyEvent, current));
    };
    const listen = (afterId) => {
      source = new EventSource(`/api/chats/${chatId}/stream?after=${afterId}`);
      source.addEventListener("event", (message) => {
        buffer.current.push(JSON.parse(message.data));
        // batch token bursts into one render per frame
        if (!frame) frame = requestAnimationFrame(flush);
      });
      source.onopen = () => setConnection("live");
      source.onerror = () => setConnection(source.readyState === EventSource.CLOSED ? "closed" : "reconnecting");
    };
    // The whole history arrives folded in one response; only newer events are streamed.
    api(`/api/chats/${chatId}/timeline`)
      .then(({ timeline: snapshot }) => {
        if (!alive) return;
        setTimeline(snapshot);
        listen(snapshot.lastEventId || 0);
      })
      .catch(() => alive && listen(0));
    return () => {
      alive = false;
      if (frame) cancelAnimationFrame(frame);
      buffer.current = [];
      source?.close();
    };
  }, [chatId]);

  return { timeline, connection };
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
  const match = /^#\/(settings|jobs|agents|telegram|incidents|peers)$/.exec(hash);
  return match ? match[1] : null;
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
