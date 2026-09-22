// Maps Claude Agent SDK messages (incl. Anthropic stream_event) to the same InteractionUpdate
// shapes Cursor emits, so eventsFromUpdate / the timeline stay provider-agnostic.

const GRIFFIN_MCP = /^mcp__griffin__/;

export function createClaudeEventBridge() {
  const blocks = new Map(); // index -> { kind, callId, name, partial }
  let thinkingStartedAt = null;

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
      case "message_delta":
        return event.usage ? [{ type: "turn-ended", usage: event.usage }] : [];
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
      out.push({
        type: "tool-call-completed",
        callId,
        toolCall: {
          type: "mcp",
          args: {
            providerIdentifier: "custom-user-tools",
            toolName: "tool",
            args: null,
          },
          result: normalizeToolResult(block),
        },
      });
    }
    return out;
  }

  function onResult(message) {
    const out = [];
    if (message.usage) out.push({ type: "turn-ended", usage: message.usage });
    return out;
  }

  return {
    consume(message) {
      if (!message) return [];
      if (message.type === "stream_event") return onStreamEvent(message.event);
      if (message.type === "assistant") return onAssistantMessage(message.message || message);
      if (message.type === "user") return onUserMessage(message.message || message);
      if (message.type === "result") return onResult(message);
      return [];
    },
  };
}

function shortToolName(name) {
  const raw = String(name || "tool");
  return raw.replace(GRIFFIN_MCP, "") || raw;
}

function mcpToolCall(name, args) {
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

function normalizeToolResult(block) {
  if (block.is_error || block.isError) {
    return { status: "error", value: contentText(block.content) };
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
