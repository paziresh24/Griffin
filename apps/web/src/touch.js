import { useSyncExternalStore } from "react";

// A touch-first device: its primary pointer is a finger. Not the composer library's
// stricter "(pointer: coarse) and (not (any-pointer: fine))" — a phone that also reports a fine
// pointer (stylus, paired mouse) fails that test and Enter kept sending the message.
export const TOUCH_QUERY = "(pointer: coarse)";

// Enter sends on a keyboard device; on a touch screen it is a new line and the send button (or
// Ctrl/⌘+Enter on a tablet keyboard) sends.
export const submitMode = (touch) => (touch ? "ctrlEnter" : "enter");

const media = () => (typeof window !== "undefined" && window.matchMedia ? window.matchMedia(TOUCH_QUERY) : null);
const subscribe = (onChange) => {
  const mq = media();
  mq?.addEventListener?.("change", onChange);
  return () => mq?.removeEventListener?.("change", onChange);
};

export function useTouchPrimary() {
  return useSyncExternalStore(subscribe, () => Boolean(media()?.matches), () => false);
}
