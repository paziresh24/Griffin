import { agentSlug } from "../persona.mjs";
// Maps Claude Agent SDK messages (incl. Anthropic stream_event) to the same InteractionUpdate
// shapes Cursor emits, so eventsFromUpdate / the timeline stay provider-agnostic.

// The app's own MCP server is named after the assistant (claude.mjs mcpName); older chats
// carry mcp__griffin__ in their history.
const ownMcp = () => new RegExp(`^mcp__(?:${agentSlug()}|griffin)__`);

export function createClaudeEventBridge() {
  const blocks = new Map(); // index -> { kind, callId, name, partial }
  // callId -> { name, args }: a tool_result carries neither, and a completion named "tool" hid
  // end_agent from finalText — text written after it reached the colleague.
  const calls = new Map();
  const remember = (callId, name, args, rawName) => {
    calls.set(callId, { name, args, rawName: rawName ?? calls.get(callId)?.rawName });
  };
  let thinkingStartedAt = null;
  // The newest conversation entry (assistant/user message uuid): where a fork of this turn ends.
  let lastChainUuid = null;
  // A local slash command (/cost, /context…) answers without the model: its text comes as a
  // local_command_output message and/or the result's `result`. Shown once.
  let localOutputShown = false;

  function flushThinkingDone() {
    if (thinkingStartedAt == null) return [];
    const durationMs = Date.now() - thinkingStartedAt;
    thinkingStartedAt = null;
    return [{ type: "thinking-completed", thinkingDurationMs: durationMs }];
  }

  function onStreamEvent(event) {
    if (!event || typeof event !== "object") return [];
    switch (event.type) {
      case "content_block_start":
        return onBlockStart(event.index, event.content_block);
      case "content_block_delta":
        return onBlockDelta(event.index, event.delta);
      case "content_block_stop":
        return onBlockStop(event.index);
      // One model request's usage: the context it filled, not a cost — the turn's cost comes once,
      // from its result (onResult), which holds every request's sum.
      case "message_delta":
        return event.usage ? [{ type: "request-usage", usage: event.usage }] : [];
      default:
        return [];
    }
  }

  function onBlockStart(index, block) {
    if (!block) return [];
    if (block.type === "thinking" || block.type === "redacted_thinking") {
      thinkingStartedAt = Date.now();
      blocks.set(index, { kind: "thinking" });
      return [];
    }
    if (block.type === "text") {
      blocks.set(index, { kind: "text" });
      return [];
    }
    if (block.type === "tool_use") {
      const callId = block.id || `tool-${index}`;
      const name = shortToolName(block.name);
      blocks.set(index, { kind: "tool", callId, name, partial: "" });
      remember(callId, name, block.input && typeof block.input === "object" ? block.input : {}, block.name);
      return [{
        type: "tool-call-started",
        callId,
        toolCall: mcpToolCall(name, block.input && typeof block.input === "object" ? block.input : {}),
      }];
    }
    return [];
  }

  function onBlockDelta(index, delta) {
    if (!delta) return [];
    const state = blocks.get(index);
    if (delta.type === "text_delta" && delta.text) {
      return [{ type: "text-delta", text: delta.text }];
    }
    if ((delta.type === "thinking_delta" || delta.type === "thinking") && (delta.thinking || delta.text)) {
      return [{ type: "thinking-delta", text: delta.thinking || delta.text }];
    }
    if (delta.type === "input_json_delta" && state?.kind === "tool") {
      state.partial = `${state.partial || ""}${delta.partial_json || ""}`;
      const args = tryParsePartial(state.partial);
      if (!args) return [];
      remember(state.callId, state.name, args);
      return [{
        type: "partial-tool-call",
        callId: state.callId,
        toolCall: mcpToolCall(state.name, args),
      }];
    }
    return [];
  }

  function onBlockStop(index) {
    const state = blocks.get(index);
    blocks.delete(index);
    if (state?.kind === "thinking") return flushThinkingDone();
    return [];
  }

  function onAssistantMessage(message) {
    const out = [];
    for (const block of message?.content || []) {
      if (block.type === "text" && block.text) {
        // Prefer stream deltas; only use complete text when no stream ran for this turn.
        continue;
      }
      if (block.type === "tool_use") {
        remember(block.id, shortToolName(block.name), block.input || {}, block.name);
        out.push({
          type: "tool-call-started",
          callId: block.id,
          toolCall: mcpToolCall(shortToolName(block.name), block.input || {}),
        });
      }
    }
    return out;
  }

  function onUserMessage(message) {
    const out = [];
    for (const block of message?.content || []) {
      if (block.type !== "tool_result") continue;
      const callId = block.tool_use_id || block.toolUseId;
      const call = calls.get(callId);
      out.push({
        type: "tool-call-completed",
        callId,
        toolCall: {
          type: "mcp",
          args: {
            providerIdentifier: "custom-user-tools",
            toolName: call?.name || "tool",
            args: call?.args ?? null,
          },
          result: normalizeToolResult(block, ownMcp().test(String(call?.rawName || ""))),
        },
      });
    }
    return out;
  }

  function onResult(message) {
    const out = [];
    const text = typeof message.result === "string" ? message.result : "";
    if (message.local_command && text.trim() && !localOutputShown) out.push({ type: "text-delta", text });
    localOutputShown = false;
    if (message.usage) out.push({ type: "turn-ended", usage: message.usage });
    // «ادامه در گفتگوی تازه از اینجا» forks the session up to this entry (SDK forkSession).
    if (lastChainUuid) out.push({ type: "checkpoint", lastMessageId: lastChainUuid, sessionId: message.session_id || null });
    // Fast mode as Claude Code reports it at every result ("on", "off", "cooldown").
    if (typeof message.fast_mode_state === "string") {
      out.push({ type: "fast-mode", state: message.fast_mode_state, reason: message.fast_mode_disabled_reason || null });
    }
    return out;
  }

  return {
    consume(message) {
      if (!message) return [];
      if ((message.type === "assistant" || message.type === "user") && message.uuid) lastChainUuid = message.uuid;
      if (message.type === "stream_event") return onStreamEvent(message.event);
      if (message.type === "assistant") return onAssistantMessage(message.message || message);
      if (message.type === "user") return onUserMessage(message.message || message);
      if (message.type === "result") return onResult(message);
      // Claude Code retries a refused or dropped API request: the run's phase says so.
      if (message.type === "system" && message.subtype === "api_retry") {
        return [{ type: "api-retry", attempt: Number(message.attempt) || 1, maxRetries: Number(message.max_retries) || null, delayMs: Number(message.retry_delay_ms) || 0, status: message.error_status ?? null }];
      }
      // Claude Code compacting the context (SDKStatusMessage): «خلاصه‌سازی…» instead of a silent pause.
      if (message.type === "system" && message.subtype === "status" && message.status === "compacting") return [{ type: "summary-started" }];
      // Output of a local slash command (/usage…) on CLIs that send it this way.
      if (message.type === "system" && message.subtype === "local_command_output" && message.content) {
        localOutputShown = true;
        return [{ type: "text-delta", text: String(message.content) }];
      }
      // A closed plan window: shown as the phase until the run ends or moves to another engine.
      if (message.type === "rate_limit_event" && limitClosed(message.rate_limit_info)) {
        const info = message.rate_limit_info;
        return [{ type: "rate-limit", status: "rejected", resetsAt: info.resetsAt ? info.resetsAt * 1000 : null, limitType: info.rateLimitType ?? null }];
      }
      return [];
    },
  };
}

// "rejected" while extra usage carries the request is not a closed limit: the turn goes on.
// The SDK has said it as overageInUse, isUsingOverage and overageStatus.
export function limitClosed(info) {
  if (info?.status !== "rejected") return false;
  return !(info.overageInUse === true || info.isUsingOverage === true || info.overageStatus === "allowed" || info.overageStatus === "allowed_warning");
}

function shortToolName(name) {
  const raw = String(name || "tool");
  return raw.replace(ownMcp(), "") || raw;
}

export function mcpToolCall(name, args) {
  return {
    type: "mcp",
    args: {
      providerIdentifier: "custom-user-tools",
      toolName: name,
      args: args && typeof args === "object" ? args : {},
    },
  };
}

function tryParsePartial(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// app: one of Griffin's own tools. Its first text part is the JSON summary the web card and the
// Telegram sender read (result.js unwrapResult, format.mjs firstJson); joined with the parts meant
// for the model (a text file show_media returns) it was no JSON at all. Kept as MCP content, the
// shape the openai provider emits; only text parts (image bytes stay out of the log).
function normalizeToolResult(block, app = false) {
  if (block.is_error || block.isError) {
    return { status: "error", value: contentText(block.content) };
  }
  if (app && Array.isArray(block.content)) {
    const content = block.content.filter((p) => p?.type === "text" && typeof p.text === "string").map((p) => ({ type: "text", text: p.text }));
    return { status: "success", value: { content, isError: false } };
  }
  return { status: "success", value: contentText(block.content) };
}

function contentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content ?? null;
  const texts = content.filter((p) => p?.type === "text").map((p) => p.text);
  if (texts.length) return texts.join("\n");
  return content;
}
