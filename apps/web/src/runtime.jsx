import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import {
  AssistantRuntimeProvider,
  CompositeAttachmentAdapter,
  useExternalStoreRuntime,
} from "@assistant-ui/react";
import { api, apiPiece, catchUpTimeline, navigate } from "./api.js";
import { createSender, mergeOutbox, newClientId, outbox } from "./outbox.js";
import { holdReload } from "./new-version.js";
import { unwrapResult } from "./result.js";
import { t } from "./i18n.js";
import { holdSending, loadDraft, recoverSending, releaseSending, saveDraft } from "./draft.js";
import { quoteStore, sendBody } from "./quotes.js";
import { retryableRunId } from "./side.js";
import { collectChapters } from "./chat-tools.js";
import { noteMessage } from "./telegram.js";
import { guestMessage } from "./guest.js";
import { FileAttachmentAdapter, ImageAttachmentAdapter, attachmentPayload, countProblem, createUploads, filesShown } from "./attachments.js";

export { unwrapResult };

// What a file's upload says to the server (attachments.js sendPieces, server uploads.mjs).
const uploadTalk = {
  start: (file) => api("/api/uploads", { method: "POST", body: file }),
  put: (id, offset, piece, signal) => apiPiece(`/api/uploads/${id}?offset=${offset}`, piece, signal),
  remove: (id) => api(`/api/uploads/${id}`, { method: "DELETE" }),
};

// The chat this runtime sends to (the composer keys its draft and quotes by it), a send of the
// waiting quotes alone (an empty box cannot be submitted through the composer itself), and the
// kept message's retry.
// boxId keys the composer's draft and quotes (the chat; null = a new chat).
const RuntimeChat = createContext({ chatId: null, boxId: null, sendQuotes: () => {}, settings: {}, chapters: [] });
export const useRuntimeChat = () => useContext(RuntimeChat);

// A message that did not reach the server goes back to the composer of its chat.
export const RESTORE_EVENT = "griffin:restore";
// Quotes of a send still on its way: a second Enter must not send them again.
const quotesInFlight = new Set();
const freeQuotes = (chatId) => quoteStore.get(chatId).filter((q) => !quotesInFlight.has(q.id));

function browserStorage() {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

// Held sends (draft.js holdSending) are per tab: sessionStorage survives a reload and a reopened
// tab, and another tab of the same chat never takes over a send this one still owns (review).
function tabStorage() {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

export function returnToBox(chatId, text) {
  if (!text) return;
  const detail = { chatId, text, handled: false };
  window.dispatchEvent(new CustomEvent(RESTORE_EVENT, { detail }));
  // No composer of that chat on screen: it waits there as the draft.
  if (!detail.handled) saveDraft(browserStorage(), chatId, [text, loadDraft(browserStorage(), chatId)].filter(Boolean).join("\n"));
}

// Where a refused send is reported: that chat's runtime on screen (the text waits as its draft).
const errorHandlers = new Map(); // chatId -> onError

// One sender for the page: a message keeps its state (outbox.js) after the owner moves to another
// chat and back. Each message carries a client id, so "send again" never stores it twice.
const sender = createSender({
  outbox,
  post: async (entry) => {
    const out = await api(`/api/chats/${entry.chatId}/messages`, { method: "POST", body: { ...entry.payload, intent: entry.intent, clientId: entry.clientId } });
    // The text answered an open question but its files could not follow: say so (server app.mjs).
    if (out?.filesError) errorHandlers.get(entry.chatId)?.(new Error(t("پاسخ رسید ولی فایل‌ها نرسیدند: {error}", { error: out.filesError })));
    return out;
  },
  catchUp: catchUpTimeline,
  settle: (entry, outcome, error) => {
    if (entry.held) releaseSending(tabStorage(), entry.chatId, entry.held);
    for (const id of entry.quoteIds) quotesInFlight.delete(id);
    // Only the quotes as they were sent leave the box; one edited meanwhile waits for the next message.
    if (outcome === "sent") quoteStore.removeSent(entry.chatId, entry.quotes || []);
    else returnToBox(entry.chatId, entry.typed);
    if (outcome === "refused") errorHandlers.get(entry.chatId)?.(error);
  },
});
export const retrySend = (clientId) => sender.retry(clientId);
// A message on its way or not delivered holds a new version's reload off (a reload would lose it).
let releaseReload = null;
outbox.subscribe(() => {
  if (outbox.unsent() && !releaseReload) releaseReload = holdReload();
  else if (!outbox.unsent() && releaseReload) releaseReload = (releaseReload(), null);
});
export const editSend = (clientId) => sender.edit(clientId);

// Bridges our event timeline (source of truth on the server) to assistant-ui.
// kept: the chat's kept message ids (oldest first); «دوباره» sends them again (Thread.jsx KeptActions,
// which also has «حل شد» and «بستن» for them and for a last run that ended in an error).
export function GriffinRuntime({ chatId, timeline, settings, kept = [], onError, children }) {
  const waiting = useSyncExternalStore(outbox.subscribe, () => outbox.forChat(chatId), () => outbox.forChat(chatId));
  // The owner's messages still on their way show after the thread, each with its state.
  const messages = useMemo(() => mergeOutbox(timeline.messages, waiting), [timeline.messages, waiting]);
  useEffect(() => {
    if (chatId) sender.landed(chatId, timeline.messages);
  }, [chatId, timeline.messages, waiting]);
  // A message this browser was still sending when its last page closed comes back to the box
  // (draft.js holdSending), once the timeline has loaded and can say which of them arrived.
  const recovered = useRef(false);
  const loaded = !chatId || timeline.lastEventId > 0;
  useEffect(() => {
    if (recovered.current || !loaded) return;
    recovered.current = true;
    const landed = new Set((timeline.messages || []).filter((m) => m?.role === "user" && m.clientId).map((m) => m.clientId));
    returnToBox(chatId, recoverSending(tabStorage(), chatId, landed));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatId, loaded]);
  useEffect(() => {
    if (!chatId || !onError) return undefined;
    errorHandlers.set(chatId, onError);
    return () => {
      if (errorHandlers.get(chatId) === onError) errorHandlers.delete(chatId);
    };
  }, [chatId, onError]);
  // A queued user message can sit after the running assistant message.
  const lastRun = messages.findLast((m) => m.role === "assistant");
  const isRunning = lastRun?.status === "running";
  const retryId = chatId ? retryableRunId(messages, kept.length) : null;
  const boxId = chatId;
  // Each box has its own uploads: pictures go as images (a big one shrunk), any other file as a file.
  const uploads = useMemo(() => createUploads(uploadTalk), []);
  const attachmentAdapter = useMemo(() => new CompositeAttachmentAdapter([new ImageAttachmentAdapter(uploads), new FileAttachmentAdapter(uploads)]), [uploads]);
  const uploading = useSyncExternalStore(uploads.subscribe, uploads.busy);
  useEffect(() => () => uploads.stop(), [uploads]);

  // One converter per (last run, retry target): assistant-ui drops every cached conversion when this
  // function changes, so a new one per streamed token rebuilt every message of the chat each time.
  const lastRunId = lastRun?.id;
  const convert = useCallback((message) => {
    const converted = convertMessage(message);
    // The last run (its error actions show only there) and the run a kept message waits under.
    const last = message.id === lastRunId;
    const retry = message.id === retryId;
    if (!last && !retry) return converted;
    const onRetry = retry ? () => api(`/api/chats/${chatId}/retry`, { method: "POST" }).catch(onError) : undefined;
    return { ...converted, metadata: { custom: { ...converted.metadata.custom, ...(last ? { last: true } : {}), ...(onRetry ? { onRetry } : {}) } } };
  }, [chatId, lastRunId, retryId, onError]);
  const adapter = useMemo(() => {
    const send = async (message, intent) => {
      const typed = attachmentPayload(message);
      // Over the server's limits: said in Persian before anything is sent; the text goes back to the box.
      const tooMany = countProblem(typed);
      if (tooMany) {
        returnToBox(boxId, typed.typed);
        onError?.(new Error(tooMany));
        return;
      }
      if (!typed.files.length) delete typed.files;
      // The folded quotes join the message here and leave the box only once it is delivered.
      const quotes = freeQuotes(boxId);
      for (const q of quotes) quotesInFlight.add(q.id);
      const payload = sendBody(typed, quotes);
      // Shown at once with its state, in a chat or on the new chat page.
      const shown = { clientId: newClientId(), text: payload.text || "", images: payload.images?.length || 0, ...(payload.files?.length ? { files: filesShown(payload.files) } : {}), intent };
      if (chatId) {
        // The quotes stay in flight until it is delivered or taken back.
        // Held in the browser until the server answers: a page closed meanwhile gives it back.
        const held = holdSending(tabStorage(), chatId, typed.typed, shown.clientId);
        await sender.submit({ ...shown, chatId, held, typed: typed.typed, payload, quoteIds: quotes.map((q) => q.id), quotes });
        return;
      }
      // Waiting in the outbox also holds a reload off: it could create the chat and still put the
      // text back in the box.
      outbox.add({ ...shown, at: new Date().toISOString(), chatId: null, state: "sending", quoteIds: [] });
      const held = holdSending(tabStorage(), boxId, typed.typed);
      try {
        const { chat } = await api("/api/chats", {
          method: "POST",
          body: {
            ...payload,
            clientId: shown.clientId,
            mode: settings.mode,
            model: settings.model,
            effort: settings.effort || undefined,
            confirm: true,
            agent: settings.agent || "griffin",
            ...(settings.repo != null ? { repo: settings.repo } : {}),
            // «+» on a group's heading: the chat starts in that group.
            ...(settings.groupId ? { groupId: settings.groupId } : {}),
          },
        });
        // The bubble goes with it and gives way when the new chat's timeline holds the message.
        outbox.update(shown.clientId, { chatId: chat.id, state: "sent" });
        navigate(chat.id);
        quoteStore.removeSent(boxId, quotes);
      } catch (error) {
        outbox.remove(shown.clientId);
        // No connection or a refusal: the text returns to the box (the quotes never left it).
        returnToBox(boxId, typed.typed);
        // The toast says the text waits in the box (App.jsx keptText).
        if (typed.typed && error && typeof error === "object") error.keptText = typed.typed;
        onError(error);
      } finally {
        releaseSending(tabStorage(), boxId, held);
        for (const q of quotes) quotesInFlight.delete(q.id);
      }
    };
    return {
      messages,
      isRunning,
      // The first message of a new chat is on its way: the next one has no chat to go to yet.
      isDisabled: !chatId && waiting.length > 0,
      // A message waits for the files in its box: the bar on each says how far it is.
      isSendDisabled: uploading,
      convertMessage: convert,
      onNew: (message) => send(message, "send"),
      // force: «فوری» — reach the agent now (steered into the turn, or the turn is interrupted and
      // continues with it; runner.mjs), not after it.
      sendQuotes: (force = false) => (freeQuotes(boxId).length ? send({ content: [], attachments: [] }, isRunning ? (force ? "force" : "steer") : "send") : undefined),
      onCancel: async () => {
        if (chatId) await api(`/api/chats/${chatId}/cancel`, { method: "POST" }).catch(onError);
      },
      // With a queue adapter assistant-ui routes every send here: steer while running,
      // enqueue otherwise. The server keeps the real queue and falls back steer -> queue.
      queue: {
        items: [],
        steerItems: [],
        enqueue: (message) => send(message, isRunning ? "queue" : "send"),
        // assistant-ui sends here for every message while running; only «فوری» (the button,
        // Ctrl/⌘+Shift+Enter) sets message.steer — the rest keeps the old steer-or-queue.
        steer: (message) => send(message, isRunning ? (message?.steer === true ? "force" : "steer") : "send"),
        move: () => {},
        edit: () => {},
        remove: () => {},
      },
      adapters: { attachments: attachmentAdapter },
      unstable_capabilities: { copy: true },
    };
  }, [chatId, boxId, messages, waiting, uploading, attachmentAdapter, isRunning, convert, settings.mode, settings.model, settings.agent, settings.repo, settings.effort, settings.groupId, onError]);

  const runtime = useExternalStoreRuntime(adapter);
  const sendQuotes = adapter.sendQuotes;
  // settings: what a new chat would start with (the composer's "later" keeps it with the note).
  // The thread's chapter list (chat_chapter) for the floating table of contents.
  const chapters = useMemo(() => collectChapters(messages), [messages]);
  const runtimeChat = useMemo(() => ({ chatId, boxId, sendQuotes, settings, chapters }), [chatId, boxId, sendQuotes, settings, chapters]);
  return (
    <RuntimeChat.Provider value={runtimeChat}>
      <AssistantRuntimeProvider runtime={runtime}>{children}</AssistantRuntimeProvider>
    </RuntimeChat.Provider>
  );
}

function convertMessage(message) {
  // A tg.note (a report, the owner's own Telegram line…): a system row, never a turn.
  if (message.role === "note") return noteMessage(message);
  // A note from the person this chat was privately shared with (guest.js): theirs, labelled.
  if (message.role === "guest") return guestMessage(message);
  if (message.role === "user") {
    return {
      id: message.id,
      role: "user",
      content: [{ type: "text", text: message.text }],
      createdAt: message.at ? new Date(message.at) : undefined,
      metadata: { custom: { intent: message.intent || null, queueState: message.queueState || null, images: message.images || 0, imageIds: message.imageIds || null, files: message.files || null, clientId: message.clientId || null, sendState: message.sendState || null, from: message.from || null, legacy: "legacyBehind" in message } },
    };
  }
  return {
    id: message.id,
    role: "assistant",
    createdAt: message.startedAt ? new Date(message.startedAt) : undefined,
    status: messageStatus(message),
    // Suggestion cards and chapter dividers are drawn from metadata.custom.run, not by assistant-ui.
    content: message.parts.filter((part) => ["text", "reasoning", "tool"].includes(part.type)).map((part) => {
      if (part.type === "tool") {
        const { result, isError } = unwrapResult(part);
        return {
          type: "tool-call",
          toolCallId: part.callId,
          toolName: part.name,
          args: part.args && typeof part.args === "object" ? part.args : {},
          result,
          isError,
        };
      }
      return { type: part.type, text: part.text };
    }),
    metadata: { custom: { run: message } },
  };
}

function messageStatus(message) {
  if (message.status === "running") return { type: "running" };
  if (message.status === "finished") return { type: "complete", reason: "stop" };
  if (message.status === "cancelled") return { type: "incomplete", reason: "cancelled" };
  return { type: "incomplete", reason: "error", error: message.error || "error" };
}
