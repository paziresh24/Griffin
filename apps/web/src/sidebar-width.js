// The desktop sidebar's width: dragged on its edge, kept across reloads. The
// Karsara skin starts narrower (288px) than Griffin's (320px); a saved width wins over both.
export const SIDEBAR_WIDTH = { key: "griffin.sidebarWidth", min: 220, max: 560, initial: 320, karsara: 288 };

/** Keeps a width usable: inside the limits and never more than half the window. */
export function clampSidebarWidth(width, viewport = Infinity, initial = SIDEBAR_WIDTH.initial) {
  const n = Number(width);
  if (!Number.isFinite(n)) return initial;
  const max = Math.max(SIDEBAR_WIDTH.min, Math.min(SIDEBAR_WIDTH.max, Math.floor(viewport / 2)));
  return Math.round(Math.max(SIDEBAR_WIDTH.min, Math.min(max, n)));
}

export function loadSidebarWidth(storage, viewport, initial = SIDEBAR_WIDTH.initial) {
  try {
    const saved = storage?.getItem(SIDEBAR_WIDTH.key);
    return saved ? clampSidebarWidth(saved, viewport, initial) : initial;
  } catch {
    return initial;
  }
}

export function saveSidebarWidth(storage, width) {
  try {
    storage?.setItem(SIDEBAR_WIDTH.key, String(clampSidebarWidth(width)));
  } catch {
    /* storage blocked: the width lasts for this page only */
  }
}

/** A plain left click; anything else (middle, Ctrl/Cmd/Shift) is the browser opening a new tab. */
export function isPlainClick(event) {
  return !event.button && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}
