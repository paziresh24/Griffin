// One open chat's timeline on the page: the folded history in one response, then the live stream
// kept open by stream-keeper.js. Plain JavaScript with its browser parts passed in, so the whole
// path — 502, reconnect, a message sent while the stream is down — runs in tests (api.js
// useTimeline is the React wrapper).
import { applyEvent, emptyTimeline } from "@griffin/timeline";
import { keepOpen, retryDelay } from "./stream-keeper.js";

// Open timelines that can fetch what the live stream has not delivered (a message sent while
// the stream is down): chatId -> set of catch-up functions (the main thread and a side panel
// may show the same chat).
const catchUps = new Map();

/** Fetches the chat's new events directly unless its stream is live (force: even then). */
export function catchUpTimeline(chatId, { force = false } = {}) {
  for (const catchUp of catchUps.get(chatId) || []) catchUp(force);
}

// A direct fetch that hangs must not block every later one.
const CATCH_UP_TIMEOUT_MS = 10_000;

/**
 * remembered: { timeline, rev } from timeline-memo.js, or null.
 * onShow({ timeline, rev, connection }) after every change.
 * Returns { catchUp(force), retryNow(), stop() }.
 */
export function openTimeline({
  chatId,
  remembered = null,
  api,
  EventSourceImpl = globalThis.EventSource,
  raf = (fn) => globalThis.requestAnimationFrame(fn),
  caf = (id) => globalThis.cancelAnimationFrame(id),
  timers = globalThis,
  win,
  doc,
  onShow,
  // A session that ended: the page shows its login screen (App.jsx listens for this event).
  onUnauthorized = () => globalThis.window?.dispatchEvent(new Event("griffin:unauthorized")),
}) {
  let current = remembered?.timeline || emptyTimeline();
  let rev = remembered?.rev || null;
  let connection = remembered ? "refreshing" : "loading";
  let alive = true;
  let frame = 0;
  let buffer = [];
  let keeper = null;
  let historyTimer = null;
  let fetching = false;
  let historyIn = false;

  const show = () => alive && onShow({ timeline: current, rev, connection });
  const flush = () => {
    if (frame) caf(frame);
    frame = 0;
    const events = buffer;
    buffer = [];
    current = events.reduce(applyEvent, current);
    show();
  };
  const setConnection = (next) => {
    connection = next;
    show();
    // A stream that keeps failing may be a session that ended (the stream answers 401, which an
    // EventSource cannot see). /api/auth/me answers 200 {authenticated:false} then: the login
    // screen shows instead of retrying forever.
    if (next === "reconnecting") {
      api("/api/auth/me")
        .then((answer) => alive && answer?.authenticated === false && onUnauthorized())
        .catch(() => {});
    }
  };
  const listen = () => {
    if (!alive || keeper) return; // one stream per open chat, whatever answered first
    keeper = keepOpen({
      open: () => {
        // Events still waiting for a frame count as held: ask only for newer ones.
        if (buffer.length) flush();
        const source = new EventSourceImpl(`/api/chats/${chatId}/stream?after=${current.lastEventId || 0}`);
        source.addEventListener("event", (message) => {
          buffer.push(JSON.parse(message.data));
          // batch token bursts into one render per frame
          if (!frame) frame = raf(flush);
        });
        return source;
      },
      onState: setConnection,
      timers,
      win,
      doc,
    });
  };
  // The whole history arrives folded in one response; only newer events are streamed. With a
  // remembered copy the server answers {unchanged} unless something is newer. Without one, a
  // failed load is tried again (1s, 2s, 5s, 15s) — streaming from the first event instead would
  // replay hundreds of thousands of events one by one in a big chat.
  let loadSeq = 0; // only the newest history load counts
  const loadHistory = (attempt) => {
    const seq = (loadSeq += 1);
    const have = remembered ? `?have=${current.lastEventId}&rev=${encodeURIComponent(rev)}` : "";
    api(`/api/chats/${chatId}/timeline${have}`)
      .then((answer) => {
        if (!alive || historyIn || seq !== loadSeq) return;
        historyTimer = null;
        historyIn = true;
        if (answer.timeline) {
          current = answer.timeline;
          rev = answer.rev || null;
        }
        listen();
      })
      .catch(() => {
        if (!alive || historyIn || seq !== loadSeq) return;
        if (remembered) {
          historyIn = true;
          return listen();
        }
        // Said like a lost stream, with «تلاش دوباره»: the owner is not left with «بارگذاری…».
        if (connection !== "reconnecting") setConnection("reconnecting");
        historyTimer = timers.setTimeout(() => {
          historyTimer = null;
          loadHistory(attempt + 1);
        }, retryDelay(attempt));
      });
  };
  // The network back, the tab shown, or «تلاش دوباره» while the history waits: try it now.
  // Only while a retry is waiting: a load on its way is not doubled.
  const hurryHistory = () => {
    if (!alive || historyIn || !historyTimer) return;
    timers.clearTimeout(historyTimer);
    historyTimer = null;
    loadHistory(3);
  };
  const onVisible = () => doc?.visibilityState === "visible" && hurryHistory();
  win?.addEventListener?.("online", hurryHistory);
  doc?.addEventListener?.("visibilitychange", onVisible);

  // Fetches new events directly unless the stream is live (force: even then). Not before the
  // history is in: the history load brings everything.
  const catchUp = async (force = false) => {
    if (!alive || fetching || !historyIn || connection === "refreshing") return;
    if (!force && connection === "live") return;
    fetching = true;
    let timer = null;
    try {
      const answer = await Promise.race([
        api(`/api/chats/${chatId}/events?after=${current.lastEventId || 0}`),
        new Promise((_, reject) => (timer = timers.setTimeout(() => reject(new Error("timeout")), CATCH_UP_TIMEOUT_MS))),
      ]);
      if (!alive || !answer?.events?.length) return;
      buffer.push(...answer.events);
      flush();
    } catch {
      /* still down: the stream's reconnect brings it */
    } finally {
      if (timer) timers.clearTimeout(timer);
      fetching = false;
    }
  };
  if (!catchUps.has(chatId)) catchUps.set(chatId, new Set());
  catchUps.get(chatId).add(catchUp);

  show();
  loadHistory(0);

  return {
    catchUp,
    retryNow() {
      if (keeper) keeper.retryNow();
      else hurryHistory();
    },
    stop() {
      alive = false;
      if (frame) caf(frame);
      buffer = [];
      if (historyTimer) timers.clearTimeout(historyTimer);
      win?.removeEventListener?.("online", hurryHistory);
      doc?.removeEventListener?.("visibilitychange", onVisible);
      keeper?.stop();
      catchUps.get(chatId)?.delete(catchUp);
      if (!catchUps.get(chatId)?.size) catchUps.delete(chatId);
    },
  };
}
