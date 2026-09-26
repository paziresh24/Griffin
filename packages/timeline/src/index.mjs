// Folds stored chat events into renderable messages.
// Shared by the server (final text, tests) and the web UI (live view).
//
// Event: { id, runId, type, data, at }
//   user           { text }
//   run.started    { model }
//   run.phase      { phase, detail? }        connecting | retrying | working
//   text           { text }                  raw delta, appended verbatim
//   thinking       { text }                  raw delta, appended verbatim
//   thinking.done  { durationMs }
//   tool.started   { callId, name, args }
//   tool.updated   { callId, name, args }
//   tool.done      { callId, name, args, result }
//   usage          { inputTokens, outputTokens, ... }
//   run.finished   { status, error? }        finished | error | cancelled

export function emptyTimeline() {
  return { messages: [], lastEventId: 0 };
}

export function foldEvents(events, timeline = emptyTimeline()) {
  let next = timeline;
  for (const event of events) next = applyEvent(next, event);
  return next;
}

export function applyEvent(timeline, event) {
  if (event.id && event.id <= timeline.lastEventId) return timeline;
  const messages = reduceMessages(timeline.messages, event);
  return { messages, lastEventId: event.id || timeline.lastEventId };
}

function reduceMessages(messages, event) {
  const data = event.data || {};
  if (event.type === "user") {
    return [
      ...messages,
      { id: `u${event.id}`, role: "user", text: data.text || "", intent: data.intent || null, images: data.images || 0, at: event.at },
    ];
  }
  if (event.type === "run.started") {
    return [
      ...messages,
      {
        id: `r${event.runId || event.id}`,
        role: "assistant",
        runId: event.runId,
        status: "running",
        phase: "connecting",
        model: data.model || null,
        parts: [],
        usage: null,
        error: null,
        startedAt: event.at,
        endedAt: null,
      },
    ];
  }
  const index = findRun(messages, event.runId);
  if (index < 0) return messages;
  const run = messages[index];
  const updated = reduceRun(run, event, data);
  if (updated === run) return messages;
  const copy = messages.slice();
  copy[index] = updated;
  return copy;
}

function findRun(messages, runId) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role !== "assistant") continue;
    if (!runId || message.runId === runId) return i;
  }
  return -1;
}

function reduceRun(run, event, data) {
  switch (event.type) {
    case "run.phase":
      return { ...run, phase: data.phase, phaseDetail: data.detail || null };
    case "text":
      return appendDelta({ ...run, phase: "working" }, "text", data.text);
    case "thinking":
      return appendDelta({ ...run, phase: "working" }, "reasoning", data.text);
    case "thinking.done": {
      const parts = run.parts.slice();
      for (let i = parts.length - 1; i >= 0; i -= 1) {
        if (parts[i].type === "reasoning" && !parts[i].done) {
          parts[i] = { ...parts[i], done: true, durationMs: data.durationMs ?? null };
          break;
        }
      }
      return { ...run, parts };
    }
    case "tool.started":
    case "tool.updated":
    case "tool.done":
      return upsertTool({ ...run, phase: "working" }, event.type, data);
    case "usage":
      return { ...run, usage: data };
    case "run.finished":
      return {
        ...run,
        status: data.status || "finished",
        error: data.error || null,
        phase: null,
        parts: run.parts.map((part) => closePart(part, data.status)),
        endedAt: event.at,
      };
    default:
      return run;
  }
}

function appendDelta(run, type, text) {
  if (!text) return run;
  const parts = run.parts.slice();
  const last = parts.at(-1);
  if (last && last.type === type && !last.done) {
    parts[parts.length - 1] = { ...last, text: last.text + text };
  } else {
    // a new text/reasoning block closes the previous open reasoning block
    if (last && last.type === "reasoning" && !last.done) {
      parts[parts.length - 1] = { ...last, done: true };
    }
    parts.push({ type, text, done: false });
  }
  return { ...run, parts };
}

function upsertTool(run, type, data) {
  const parts = run.parts.slice();
  const at = parts.findIndex((part) => part.type === "tool" && part.callId === data.callId);
  const status =
    type === "tool.done" ? (toolFailed(data.result) ? "error" : "success") : "running";
  const previous = at >= 0 ? parts[at] : null;
  const part = {
    type: "tool",
    callId: data.callId,
    name: data.name || previous?.name || "tool",
    args: data.args ?? previous?.args ?? null,
    result: type === "tool.done" ? data.result ?? null : previous?.result ?? null,
    status,
  };
  if (at >= 0) parts[at] = part;
  else {
    const last = parts.at(-1);
    if (last && last.type === "reasoning" && !last.done) {
      parts[parts.length - 1] = { ...last, done: true };
    }
    parts.push(part);
  }
  return { ...run, parts };
}

function toolFailed(result) {
  if (!result) return false;
  if (result.status === "error") return true;
  return Boolean(result.value?.isError);
}

function closePart(part, status) {
  if (part.type === "tool" && part.status === "running") {
    return { ...part, status: status === "cancelled" ? "cancelled" : "error" };
  }
  if (part.type === "reasoning" && !part.done) return { ...part, done: true };
  return part;
}

export function finalText(message) {
  if (!message || message.role !== "assistant") return "";
  // The answer is the text written after the last tool call. end_agent closes the conversation:
  // the goodbye is written before it, and anything after it is chatter nobody should receive
  // (2026-09-25 eval: only «مخلصم 🙌» went out; the «write گریفین next time» line was lost).
  const end = message.parts.findIndex((part) => part.type === "tool" && part.name === "end_agent");
  const parts = end >= 0 ? message.parts.slice(0, end) : message.parts;
  let lastTool = -1;
  parts.forEach((part, i) => {
    if (part.type === "tool") lastTool = i;
  });
  return parts
    .slice(lastTool + 1)
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");
}
