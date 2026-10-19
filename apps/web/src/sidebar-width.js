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

// The desktop sidebar can be hidden (button or Ctrl/⌘+B, from Karsara); kept across reloads.
const SIDEBAR_HIDDEN_KEY = "griffin.sidebarHidden";

export function loadSidebarHidden(storage) {
  try {
    return storage?.getItem(SIDEBAR_HIDDEN_KEY) === "1";
  } catch {
    return false;
  }
}

export function saveSidebarHidden(storage, hidden) {
  try {
    storage?.setItem(SIDEBAR_HIDDEN_KEY, hidden ? "1" : "0");
  } catch {
    /* storage blocked: the choice lasts for this page only */
  }
}

/**
 * Ctrl+B (⌘B on a Mac). A Latin layout is read by the letter it types (Dvorak's B key is Ctrl+X,
 * Cut); a non-Latin one (Persian «ذ») by the physical key. A held key does not flicker the list.
 */
export function isSidebarToggle(event) {
  if (event.isComposing || event.repeat || event.shiftKey || event.altKey) return false;
  if (!event.ctrlKey && !event.metaKey) return false;
  const key = String(event.key || "");
  if (/^[a-z]$/i.test(key)) return key.toLowerCase() === "b";
  return event.code === "KeyB";
}

/** A plain left click; anything else (middle, Ctrl/Cmd/Shift) is the browser opening a new tab. */
export function isPlainClick(event) {
  return !event.button && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}
