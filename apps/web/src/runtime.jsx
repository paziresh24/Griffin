import { useMemo } from "react";
import {
  AssistantRuntimeProvider,
  SimpleImageAttachmentAdapter,
  useExternalStoreRuntime,
} from "@assistant-ui/react";
import { api, navigate } from "./api.js";
import { unwrapResult } from "./result.js";

export { unwrapResult };

const imageAdapter = new SimpleImageAttachmentAdapter();

// Bridges our event timeline (source of truth on the server) to assistant-ui.
export function GriffinRuntime({ chatId, timeline, settings, onError, children }) {
  const messages = timeline.messages;
  // A queued user message can sit after the running assistant message.
  const lastRun = messages.findLast((m) => m.role === "assistant");
  const isRunning = lastRun?.status === "running";

  const adapter = useMemo(() => {
    const send = async (message, intent) => {
      const payload = toPayload(message);
      try {
        if (!chatId) {
          const { chat } = await api("/api/chats", {
            method: "POST",
            body: {
              ...payload,
              mode: settings.mode,
              model: settings.model,
              agent: settings.agent || "griffin",
            },
          });
          navigate(chat.id);
        } else {
          await api(`/api/chats/${chatId}/messages`, { method: "POST", body: { ...payload, intent } });
        }
      } catch (error) {
        onError(error);
      }
    };
    return {
      messages,
      isRunning,
      convertMessage,
      onNew: (message) => send(message, "send"),
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
  }, [chatId, messages, isRunning, settings.mode, settings.model, settings.agent, onError]);

  const runtime = useExternalStoreRuntime(adapter);
  return <AssistantRuntimeProvider runtime={runtime}>{children}</AssistantRuntimeProvider>;
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
  return { text: text || (images.length ? "این تصویر را ببین." : ""), images };
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
