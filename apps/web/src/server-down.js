// While the server restarts (an update, a crash) the CDN in front answers 502/503/504 or nothing,
// and the chats stop mid-sentence (owner 2026-10-18: «وقتی سرور داره ری‌استارت میشه یه کاری کن
// مردم بفهمن»). The page pings /healthz and, after a couple of misses in a row, covers itself with
// «در حال آپدیت…» until the server answers again; public/sw.js does the same for a reload.

export const DOWN_AFTER = 2; // one slow or lost answer is not a restart
export const UP_EVERY_MS = 10_000;
export const DOWN_EVERY_MS = 2_000;

export function isDownAnswer(status) {
  return !status || status === 502 || status === 503 || status === 504;
}

/** tick() pings once and returns the delay until the next one. onDown/onBack fire on a change. */
export function createDownWatch({ ping, onDown, onBack, downAfter = DOWN_AFTER }) {
  let misses = 0;
  let shown = false;
  return async function tick() {
    let status = 0;
    try {
      status = await ping();
    } catch {
      status = 0;
    }
    if (isDownAnswer(status)) {
      misses += 1;
      if (!shown && misses >= downAfter) {
        shown = true;
        onDown();
      }
    } else {
      misses = 0;
      if (shown) {
        shown = false;
        onBack();
      }
    }
    return misses ? DOWN_EVERY_MS : UP_EVERY_MS;
  };
}
