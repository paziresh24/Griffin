import { createContext, useContext, useMemo } from "react";
import {
  AssistantRuntimeProvider,
  SimpleImageAttachmentAdapter,
  useExternalStoreRuntime,
} from "@assistant-ui/react";
import { api, navigate } from "./api.js";
import { unwrapResult } from "./result.js";
import { t } from "./i18n.js";
import { loadDraft, saveDraft } from "./draft.js";
import { quoteStore, withQuotes } from "./quotes.js";
import { retryableRunId } from "./side.js";

export { unwrapResult };

const imageAdapter = new SimpleImageAttachmentAdapter();

// The chat this runtime sends to (the composer keys its draft and quotes by it), a send of the
// waiting quotes alone (an empty box cannot be submitted through the composer itself), and the
// kept message's retry/delete.
// boxId keys the composer's draft and quotes (the chat; null = a new chat).
const RuntimeChat = createContext({ chatId: null, boxId: null, sendQuotes: () => {} });
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

function returnToBox(chatId, text) {
  if (!text) return;
  const detail = { chatId, text, handled: false };
  window.dispatchEvent(new CustomEvent(RESTORE_EVENT, { detail }));
  // No composer of that chat on screen: it waits there as the draft.
  if (!detail.handled) saveDraft(browserStorage(), chatId, [text, loadDraft(browserStorage(), chatId)].filter(Boolean).join("\n"));
}

// Bridges our event timeline (source of truth on the server) to assistant-ui.
// kept: the chat's kept message ids (oldest first) — "delete" removes the oldest.
export function GriffinRuntime({ chatId, timeline, settings, kept = [], onError, children }) {
  const messages = timeline.messages;
  // A queued user message can sit after the running assistant message.
  const lastRun = messages.findLast((m) => m.role === "assistant");
  const isRunning = lastRun?.status === "running";
  const retryId = chatId ? retryableRunId(messages, kept.length) : null;
  const keptId = kept[0] || null;
  const boxId = chatId;

  const adapter = useMemo(() => {
    const send = async (message, intent) => {
      const typed = toPayload(message);
      // The folded quotes join the message here and leave the box only once it is delivered.
      const quotes = freeQuotes(boxId);
      for (const q of quotes) quotesInFlight.add(q.id);
      const payload = quotes.length ? { ...typed, text: withQuotes(quotes, typed.typed) } : typed;
      delete payload.typed;
      try {
        if (!chatId) {
          const { chat } = await api("/api/chats", {
            method: "POST",
            body: {
              ...payload,
              mode: settings.mode,
              model: settings.model,
              effort: settings.effort || undefined,
              agent: settings.agent || "griffin",
              ...(settings.repo != null ? { repo: settings.repo } : {}),
            },
          });
          navigate(chat.id);
        } else {
          await api(`/api/chats/${chatId}/messages`, { method: "POST", body: { ...payload, intent } });
        }
        quoteStore.remove(boxId, quotes.map((q) => q.id));
      } catch (error) {
        // No connection or a refusal: the text returns to the box (the quotes never left it).
        returnToBox(boxId, typed.typed);
        onError(error);
      } finally {
        for (const q of quotes) quotesInFlight.delete(q.id);
      }
    };
    return {
      messages,
      isRunning,
      convertMessage: (message) => {
        const converted = convertMessage(message);
        if (message.id !== retryId) return converted;
        const onRetry = () => api(`/api/chats/${chatId}/retry`, { method: "POST" }).catch(onError);
        const onDelete = () => (keptId ? api(`/api/chats/${chatId}/kept/${encodeURIComponent(keptId)}`, { method: "DELETE" }).catch(onError) : null);
        return { ...converted, metadata: { custom: { ...converted.metadata.custom, onRetry, onDelete } } };
      },
      onNew: (message) => send(message, "send"),
      sendQuotes: () => (freeQuotes(boxId).length ? send({ content: [], attachments: [] }, isRunning ? "steer" : "send") : undefined),
      onCancel: async () => {
        if (chatId) await api(`/api/chats/${chatId}/cancel`, { method: "POST" }).catch(onError);
      },
      // With a queue adapter assistant-ui routes every send here: steer while running,
      // enqueue otherwise. The server keeps the real queue and falls back steer -> queue.
      queue: {
        items: [],
        steerItems: [],
        enqueue: (message) => send(message, isRunning ? "queue" : "send"),
        steer: (message) => send(message, isRunning ? "steer" : "send"),
        move: () => {},
        edit: () => {},
        remove: () => {},
      },
      adapters: { attachments: imageAdapter },
      unstable_capabilities: { copy: true },
    };
  }, [chatId, boxId, messages, isRunning, retryId, keptId, settings.mode, settings.model, settings.agent, settings.repo, onError]);

  const runtime = useExternalStoreRuntime(adapter);
  const sendQuotes = adapter.sendQuotes;
  const runtimeChat = useMemo(() => ({ chatId, boxId, sendQuotes }), [chatId, boxId, sendQuotes]);
  return (
    <RuntimeChat.Provider value={runtimeChat}>
      <AssistantRuntimeProvider runtime={runtime}>{children}</AssistantRuntimeProvider>
    </RuntimeChat.Provider>
  );
}

function toPayload(message) {
  const text = message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
  const images = [];
  for (const attachment of message.attachments || []) {
    for (const part of attachment.content || []) {
      if (part.type !== "image") continue;
      const match = String(part.image).match(/^data:([^;]+);base64,(.*)$/);
      if (match) images.push({ mimeType: match[1], data: match[2] });
    }
  }
  return { text: text || (images.length ? t("این تصویر را ببین.") : ""), images, typed: text };
}

function convertMessage(message) {
  if (message.role === "user") {
    return {
      id: message.id,
      role: "user",
      content: [{ type: "text", text: message.text }],
      createdAt: message.at ? new Date(message.at) : undefined,
      metadata: { custom: { intent: message.intent || null, images: message.images || 0 } },
    };
  }
  return {
    id: message.id,
    role: "assistant",
    createdAt: message.startedAt ? new Date(message.startedAt) : undefined,
    status: messageStatus(message),
    content: message.parts.map((part) => {
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
