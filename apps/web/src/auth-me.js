import { useSyncExternalStore } from "react";

let current = null;
const listeners = new Set();

export function setAuthMe(next) {
  current = next || null;
  for (const fn of listeners) fn();
}

export function getAuthMe() {
  return current;
}

export const isMember = () => current?.role === "member";

export function useAuthMe() {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => current,
  );
}
