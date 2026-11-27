import { useSyncExternalStore } from "react";

// A touch-first device: its primary pointer is a finger (from Karsara). Not the composer library's
// stricter "(pointer: coarse) and (not (any-pointer: fine))" — a phone that also reports a fine
// pointer (stylus, paired mouse) fails that test and Enter kept sending the message.
export const TOUCH_QUERY = "(pointer: coarse)";

// Enter sends on a keyboard device; on a touch screen it is a new line and the send button (or
// Ctrl/⌘+Enter on a tablet keyboard) sends.
// ENTER_KEY=shiftEnter (server setting): Shift+Enter sends and Enter is a new line — the library gets
// "none" and the composer's own key handler sends (shiftEnterSends).
let enterKey = "enter";
export const setEnterKey = (value) => {
  enterKey = value === "shiftEnter" ? "shiftEnter" : "enter";
};
export const submitMode = (touch) => (touch ? "ctrlEnter" : enterKey === "shiftEnter" ? "none" : "enter");
/** Does this Enter keydown send on a keyboard device with ENTER_KEY=shiftEnter? */
export const shiftEnterSends = (touch, e) => !touch && enterKey === "shiftEnter" && e.shiftKey && !e.ctrlKey && !e.metaKey;

const media = () => (typeof window !== "undefined" && window.matchMedia ? window.matchMedia(TOUCH_QUERY) : null);
const subscribe = (onChange) => {
  const mq = media();
  mq?.addEventListener?.("change", onChange);
  return () => mq?.removeEventListener?.("change", onChange);
};

export function useTouchPrimary() {
  return useSyncExternalStore(subscribe, () => Boolean(media()?.matches), () => false);
}

/**
 * What an Enter keydown does in a one-box answer field: "send" or "newline" (null = not Enter).
 * Follows the composer: keyboard → Enter sends and Shift+Enter breaks the line (or the reverse with
 * ENTER_KEY=shiftEnter); touch → Enter breaks the line and Ctrl/Cmd+Enter sends. An IME's Enter only confirms the word.
 */
export function answerKey(touch, e) {
  if (e.key !== "Enter" || e.isComposing || e.keyCode === 229) return null;
  const mode = submitMode(touch);
  if (mode === "ctrlEnter") return e.ctrlKey || e.metaKey ? "send" : "newline";
  if (mode === "none") return e.shiftKey && !e.ctrlKey && !e.metaKey ? "send" : "newline";
  return e.shiftKey ? "newline" : "send";
}
