// The owner's inbox (what waits for him, from every source) as one store for the whole page: the
// home-page board, the sidebar badge and the tab title read the same copy (board.js does the work).
import { useEffect, useSyncExternalStore } from "react";
import { api, INBOX_EVENT } from "./api.js";
import { createInboxStore } from "./board.js";

// ponytail: no polling — every source emits 'chats' or 'inbox' on the stream and a reconnect
// reloads the chat list (which fires INBOX_EVENT); add a 60 s poll if a silent writer appears.
const store = createInboxStore(() => api("/api/inbox"));

export const refreshInbox = () => store.refresh();

if (typeof window !== "undefined") window.addEventListener(INBOX_EVENT, refreshInbox);

export function useInbox() {
  const state = useSyncExternalStore(store.subscribe, store.get, store.get);
  useEffect(() => {
    if (!store.get().loaded) refreshInbox();
  }, []);
  return state;
}
