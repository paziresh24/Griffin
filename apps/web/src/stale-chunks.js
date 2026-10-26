// After an update the build's lazy pieces (code highlighting, charts, module views) get new names and
// the old ones are gone. A tab opened before the update then fails to load them and the chat stays
// blank (2026-10-21, a colleague: «لیست چت‌ها رو باز میکنه ولی چت‌ها رو نمیاره»). Reload once to get the
// new page; a second failure within a minute is a real error and is left to show.
const KEY = "griffin.staleReloadAt";
const STALE = /dynamically imported module|Importing a module script failed|error loading dynamically imported|Unable to preload CSS/i;

export function isStaleChunk(message) {
  return STALE.test(String(message || ""));
}

export function reloadOnce(storage = globalThis.sessionStorage, now = Date.now(), reload = () => location.reload()) {
  let last = 0;
  try { last = Number(storage?.getItem(KEY)) || 0; } catch {}
  if (now - last < 60_000) return false;
  try { storage?.setItem(KEY, String(now)); } catch {}
  reload();
  return true;
}

export function watchStaleChunks(win = globalThis.window) {
  if (!win?.addEventListener) return;
  win.addEventListener("vite:preloadError", (event) => {
    event.preventDefault?.();
    reloadOnce();
  });
  win.addEventListener("unhandledrejection", (event) => {
    if (isStaleChunk(event?.reason?.message || event?.reason)) reloadOnce();
  });
  win.addEventListener("error", (event) => {
    if (isStaleChunk(event?.message)) reloadOnce();
  });
}
