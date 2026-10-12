// The owner's messages on their way to the server, shown in the thread at once with their state:
// "sending…", then "sent", or on a failure a red mark with "send again". Before this
// the bubble appeared only when the live stream echoed the message back, so a message sent while
// the stream was dead left the box and showed nowhere. Each message
// carries a client id; the server stores a resend with the same id only once (app.mjs), and the
// bubble gives way to the server's copy as soon as the timeline holds that id.
import { t } from "./i18n.js";

export const SENDING_LABEL = t("در حال ارسال…");
export const SENT_LABEL = t("ارسال شد");
export const FAILED_LABEL = t("ارسال نشد");

// How long a sent message may wait for its echo before the timeline is fetched directly.
const ECHO_WAIT_MS = 4000;

export function newClientId() {
  try {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  } catch {
    /* an insecure origin (plain http on the LAN) has no randomUUID */
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

// No answer (the network or the server is down) or a server error: the same message may go
// again. A refusal (too long, busy, not found) would only be refused again.
export function retryableError(error) {
  const status = error?.status;
  return !status || status >= 500 || status === 408 || status === 429;
}

export function createOutbox() {
  let entries = [];
  const listeners = new Set();
  const byChat = new Map(); // chatId -> the array last handed out (stable for useSyncExternalStore)
  const changed = () => {
    byChat.clear();
    for (const listener of listeners) listener();
  };
  return {
    add(entry) {
      entries = [...entries, entry];
      changed();
    },
    update(clientId, patch) {
      if (!entries.some((e) => e.clientId === clientId)) return;
      entries = entries.map((e) => (e.clientId === clientId ? { ...e, ...patch } : e));
      changed();
    },
    remove(clientId) {
      if (!entries.some((e) => e.clientId === clientId)) return;
      entries = entries.filter((e) => e.clientId !== clientId);
      changed();
    },
    get(clientId) {
      return entries.find((e) => e.clientId === clientId) || null;
    },
    // A message on its way or not delivered: it lives only in this page.
    unsent() {
      return entries.some((e) => e.state !== "sent");
    },
    forChat(chatId) {
      if (!byChat.has(chatId)) byChat.set(chatId, entries.filter((e) => e.chatId === chatId));
      return byChat.get(chatId);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

function landedIds(messages) {
  const ids = new Set();
  for (const message of messages || []) if (message?.role === "user" && message.clientId) ids.add(message.clientId);
  return ids;
}

// The thread's messages with the owner's messages still on their way after them.
export function mergeOutbox(messages, entries) {
  if (!entries?.length) return messages;
  const landed = landedIds(messages);
  const waiting = entries.filter((e) => !landed.has(e.clientId));
  if (!waiting.length) return messages;
  return [
    ...messages,
    ...waiting.map((e) => ({
      id: `c${e.clientId}`,
      role: "user",
      text: e.text || "",
      intent: (e.shownIntent ?? e.intent) === "send" ? null : e.shownIntent ?? e.intent,
      images: e.images || 0,
      at: e.at,
      clientId: e.clientId,
      sendState: e.state,
    })),
  ];
}

// post(entry) sends it; catchUp(chatId, { force }) fetches the timeline directly when the live
// stream is not delivering; settle(entry, outcome, error) is told how a message ended:
//   sent     the server has it (the quotes can go)
//   refused  a refusal: the text goes back to the box with the reason
//   edited   the owner took a failed message back to the box
// A failure that may be retried settles nothing: the bubble stays red until «ارسال دوباره».
export function createSender({ outbox, post, catchUp, settle, later = (fn, ms) => setTimeout(fn, ms) }) {
  // Each message settles once, whichever way it ends first (its POST's answer or its arrival in
  // the timeline — a failed POST whose message did reach the server arrives on reconnect).
  const settled = new Set();
  const finish = (entry, outcome, error) => {
    if (settled.has(entry.clientId)) return;
    settled.add(entry.clientId);
    settle(entry, outcome, error);
  };
  const attempt = async (clientId) => {
    const entry = outbox.get(clientId);
    if (!entry) return;
    outbox.update(clientId, { state: "sending" });
    try {
      await post(entry);
    } catch (error) {
      if (!outbox.get(clientId)) return; // it arrived in the timeline meanwhile: delivered
      if (retryableError(error)) {
        outbox.update(clientId, { state: "failed" });
        return;
      }
      outbox.remove(clientId);
      finish(entry, "refused", error);
      return;
    }
    outbox.update(clientId, { state: "sent" });
    finish(entry, "sent");
    catchUp(entry.chatId, { force: false });
    later(() => {
      if (outbox.get(clientId)) catchUp(entry.chatId, { force: true });
    }, ECHO_WAIT_MS);
  };
  return {
    submit(entry) {
      outbox.add({ at: new Date().toISOString(), ...entry, state: "sending" });
      return attempt(entry.clientId);
    },
    // A plain send goes again as "queue": the chat may have got busy meanwhile, and the server
    // starts a run for a queued message when nothing is running.
    retry(clientId) {
      const entry = outbox.get(clientId);
      if (!entry || entry.state !== "failed") return undefined;
      if (entry.intent === "send") outbox.update(clientId, { intent: "queue", shownIntent: "send" });
      return attempt(clientId);
    },
    // Messages the timeline now holds leave the outbox, delivered.
    landed(chatId, messages) {
      const ids = landedIds(messages);
      for (const entry of outbox.forChat(chatId)) {
        if (!ids.has(entry.clientId)) continue;
        outbox.remove(entry.clientId);
        finish(entry, "sent");
      }
    },
    edit(clientId) {
      const entry = outbox.get(clientId);
      if (!entry || entry.state !== "failed") return;
      outbox.remove(clientId);
      finish(entry, "edited");
    },
  };
}

export const outbox = createOutbox();
