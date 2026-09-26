// Maps @cursor/sdk InteractionUpdate (the single onDelta source) to stored events.
// Text is passed through untouched: SDK deltas already carry their own whitespace.
// Tool args/results pass through redactArgs/redactResult: the event log is a chat timeline,
// and secrets must not persist in it (the agent still gets the real result).

import { redactArgs, redactResult } from "./redact.mjs";

const MAX_STRING = 32_000;

export function eventsFromUpdate(update) {
  switch (update?.type) {
    case "text-delta":
      return update.text ? [{ type: "text", data: { text: update.text } }] : [];
    case "thinking-delta":
      return update.text ? [{ type: "thinking", data: { text: update.text } }] : [];
    case "thinking-completed":
      return [{ type: "thinking.done", data: { durationMs: update.thinkingDurationMs ?? null } }];
    case "tool-call-started":
      return [{ type: "tool.started", data: toolData(update) }];
    case "partial-tool-call":
      return [{ type: "tool.updated", data: toolData(update) }];
    case "tool-call-completed":
      return [{ type: "tool.done", data: { ...toolData(update), result: redactResult(nameOf(update), clip(update.toolCall?.result ?? null)) } }];
    case "turn-ended":
      return update.usage ? [{ type: "usage", data: clip(update.usage) }] : [];
    case "summary-started":
      return [{ type: "run.phase", data: { phase: "summarizing" } }];
    default:
      // token-delta, step-*, shell-output-delta, tool-call-delta, user-message-appended:
      // not needed for the timeline.
      return [];
  }
}

export function nameOf(update) {
  const call = update?.toolCall || {};
  if (call.type !== "mcp") return call.type || "tool";
  const args = call.args ?? {};
  return args.providerIdentifier === "custom-user-tools" ? args.toolName : `mcp:${args.toolName}`;
}

function toolData(update) {
  const call = update.toolCall || {};
  let name = call.type || "tool";
  let args = call.args ?? null;
  if (name === "mcp" && args) {
    // Custom tools arrive as MCP calls on the synthetic "custom-user-tools" server.
    name = args.providerIdentifier === "custom-user-tools" ? args.toolName : `mcp:${args.toolName}`;
    args = args.args ?? null;
  }
  return { callId: update.callId, name, args: redactArgs(name, clip(args)) };
}

export function clip(value, depth = 0) {
  if (typeof value === "string") {
    return value.length > MAX_STRING
      ? `${value.slice(0, MAX_STRING)}\n… [${value.length - MAX_STRING} chars truncated]`
      : value;
  }
  if (!value || typeof value !== "object" || depth > 8) return value;
  if (Array.isArray(value)) return value.slice(0, 500).map((item) => clip(item, depth + 1));
  if (isBinary(value)) return `[binary omitted: ${binaryLength(value)} bytes]`;
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    // Image content (tool results) is kept out of the event log; the text part has its media id.
    // The SDK hands image data back as a byte array ({"0":255,"1":216,…}), not base64.
    out[key] = key === "data" && typeof item === "string" && item.length > 2_000 && ("mimeType" in value || value.type === "image")
      ? `[image omitted: ${item.length} base64 chars]`
      : clip(item, depth + 1);
  }
  return out;
}

// Typed arrays, Buffers, or their JSON form: an object whose keys are exactly 0..n-1 with byte values.
function isBinary(value) {
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return true;
  if (value?.type === "Buffer" && Array.isArray(value.data)) return true;
  const keys = Object.keys(value);
  if (keys.length < 64) return false;
  for (let i = 0; i < 64; i += 1) {
    if (keys[i] !== String(i) || typeof value[keys[i]] !== "number") return false;
  }
  return keys[keys.length - 1] === String(keys.length - 1);
}

function binaryLength(value) {
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return value.byteLength;
  if (value?.type === "Buffer") return value.data.length;
  return Object.keys(value).length;
}
