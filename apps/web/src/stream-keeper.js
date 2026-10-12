// Keeps one live stream (EventSource) open for as long as the page wants it. A browser gives up
// on an EventSource for good after a non-200 answer — a 502 while the server restarts during a
// deploy — and the chat stayed dead until a refresh. Here any error closes the source
// and a fresh one opens after 1s, 2s, 5s, then every 15s; at once when the network comes back, the
// tab is shown again, or the owner taps «تلاش دوباره». `open` builds each new source, so it can
// ask for events after the last one it has (nothing shows twice).
//
// States given to onState:
//   connecting    the first open is on its way
//   live          open
//   reconnecting  lost; the next try is scheduled
//   restored      open again after a loss (shown briefly as «وصل شد»), then live
export const RETRY_DELAYS_MS = [1000, 2000, 5000, 15000];

// The server pings an idle stream every 15s at most; this long without anything means a stream
// that still says open is dead (a laptop that slept, a proxy that dropped it quietly).
const SILENCE_MS = 40_000;
const RESTORED_MS = 3000;

export function retryDelay(attempt) {
  return RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)];
}

export function keepOpen({
  open,
  onState,
  onOpen,
  kinds = ["ping", "event", "chats"],
  timers = globalThis,
  win = globalThis.window,
  doc = globalThis.document,
}) {
  let source = null;
  let retryTimer = null;
  let silenceTimer = null;
  let restoredTimer = null;
  let attempt = 0;
  let lost = false;
  let stopped = false;

  const clear = (id) => id && timers.clearTimeout(id);
  const drop = () => {
    if (!source) return;
    source.onopen = null;
    source.onerror = null;
    source.close();
    source = null;
  };
  const heard = () => {
    clear(silenceTimer);
    silenceTimer = timers.setTimeout(fail, SILENCE_MS);
  };
  function fail() {
    if (stopped) return;
    drop();
    clear(silenceTimer);
    clear(restoredTimer);
    clear(retryTimer);
    lost = true;
    onState("reconnecting");
    retryTimer = timers.setTimeout(connect, retryDelay(attempt));
    attempt += 1;
  }
  function connect() {
    if (stopped) return;
    clear(retryTimer);
    retryTimer = null;
    drop();
    if (!lost) onState("connecting");
    const next = open();
    source = next;
    for (const kind of kinds) next.addEventListener(kind, () => source === next && heard());
    next.onopen = () => {
      if (source !== next || stopped) return;
      attempt = 0;
      heard();
      onOpen?.();
      if (!lost) return onState("live");
      lost = false;
      onState("restored");
      restoredTimer = timers.setTimeout(() => !stopped && !lost && onState("live"), RESTORED_MS);
    };
    next.onerror = () => source === next && fail();
  }
  // Only a lost stream is hurried; a live one is left alone.
  const retryNow = () => {
    if (!stopped && lost) connect();
  };
  const onVisible = () => {
    if (doc?.visibilityState === "visible") retryNow();
  };
  win?.addEventListener?.("online", retryNow);
  doc?.addEventListener?.("visibilitychange", onVisible);
  connect();

  return {
    retryNow,
    stop() {
      stopped = true;
      clear(retryTimer);
      clear(silenceTimer);
      clear(restoredTimer);
      drop();
      win?.removeEventListener?.("online", retryNow);
      doc?.removeEventListener?.("visibilitychange", onVisible);
    },
  };
}
