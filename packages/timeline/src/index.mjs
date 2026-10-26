// Folds stored chat events into renderable messages.
// Shared by the server (final text, tests) and the web UI (live view).
//
// Event: { id, runId, type, data, at }
//   user           { text, intent?, tracked?, from? }  intent: queue | steer (sent while a run was busy);
//                  from { kind, name, personId }: not the owner's own words (a colleague in a mother chat)
//   user.queue     { userEventId, state }   that queued message started (reached the agent) | dropped
//   user (cont.)   { clientId? }            with the run's id: steered into that run (or the typed answer to its question)
//   user.read      {}                        the engine took the steered message(s) into its next request
//   run.started    { model }
//   run.phase      { phase, detail? }        connecting | retrying {attempt,max,status,delayMs} | limited {resetsAt,limitType} | working
//   manifest       { changes }               the session's manifest (runId null) -> the running run's manifestChanges
//   text           { text }                  raw delta, appended verbatim
//   thinking       { text }                  raw delta, appended verbatim
//   thinking.done  { durationMs }
//   tool.started   { callId, name, args }
//   tool.updated   { callId, name, args }
//   tool.done      { callId, name, args, result }
//   chapter        { title, summary? }       a chapter marker (chat_chapter) -> part {type:"chapter"}
//   chat.suggested { id, title, tldr }       a suggested new chat (chat_suggest) -> part {type:"suggestion"}
//   chat.suggestion.status { id, status }    that suggestion was started | dismissed
//   usage          { inputTokens, outputTokens, ... }
//   run.started    { retry? }                 a «ارسال دوباره» of a kept message
//   run.started    { movedFrom? }             { from }: answered by the engine the owner moved to at a plan limit
//   run.finished   { status, error?, undelivered? }  finished | error | cancelled; undelivered = message kept for retry
//   tg.note        { kind, name, personId, chatId, text, sent, state, by }  a Telegram desk note -> message {role:"note"}
//   guest.note     { text, from }            a note from the person a private share was given to —
//                                            third-party content, never the owner's message; starts no run

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
  // `earlier` (messages not loaded yet, a page opened with ?limit) rides along.
  return { ...timeline, messages, lastEventId: event.id || timeline.lastEventId };
}

function reduceMessages(messages, event) {
  const data = event.data || {};
  if (event.type === "user") {
    // A «در صف» message from before user.queue existed settles by what followed it (see settleLegacy).
    const behind = messages[findRun(messages, null)]?.runId ?? null;
    const legacy = data.intent === "queue" && !data.tracked ? { legacyBehind: behind } : {};
    const user = { id: `u${event.id}`, role: "user", text: data.text || "", intent: data.intent || null, images: data.images || 0, ...(Array.isArray(data.imageIds) && data.imageIds.length ? { imageIds: data.imageIds } : {}), ...(Array.isArray(data.files) && data.files.length ? { files: data.files } : {}), at: event.at, ...legacy, ...(data.clientId ? { clientId: data.clientId } : {}), ...(data.from ? { from: data.from } : {}) };
    return event.runId ? placeMidRun(messages, user, event) : [...messages, user];
  }
  // A note of the Telegram desk (a mother chat's report, the owner's own Telegram line): a message
  // of its own, never part of a run.
  if (event.type === "tg.note") return [...messages, { ...data, id: `n${event.id}`, role: "note", at: event.at }];
  if (event.type === "guest.note") return [...messages, { id: `g${event.id}`, role: "guest", text: data.text || "", from: data.from || "", at: event.at }];
  // A queued message reached the agent or was dropped: its «در صف» label follows.
  if (event.type === "user.queue") {
    const at = messages.findIndex((m) => m.id === `u${data.userEventId}`);
    if (at < 0) return messages;
    const copy = messages.slice();
    copy[at] = { ...messages[at], queueState: data.state || null };
    return copy;
  }
  if (event.type === "run.started") {
    return [
      ...settleLegacy(messages, () => true, "started"),
      {
        id: `r${event.runId || event.id}`,
        role: "assistant",
        runId: event.runId,
        status: "running",
        phase: "connecting",
        model: data.model || null,
        ...(data.retry ? { retry: true } : {}),
        // Answered by the engine the owner moved the chat to at a plan limit (PLAN_FALLBACK=ask).
        ...(data.movedFrom && typeof data.movedFrom === "object" ? { fallback: { from: String(data.movedFrom.from || ""), ...(data.movedFrom.account ? { account: String(data.movedFrom.account) } : {}) } } : {}),
        parts: [],
        usage: null,
        error: null,
        startedAt: event.at,
        endedAt: null,
      },
    ];
  }
  // A cancel cleared the queue: older «در صف» messages waiting behind that run never ran.
  if (event.type === "run.finished" && data.status === "cancelled") messages = settleLegacy(messages, (m) => m.legacyBehind === event.runId, "dropped");
  // A tool call of a piece above the owner's message (a repeated start, its input, its result) stays there.
  if ((event.type === "tool.started" || event.type === "tool.updated" || event.type === "tool.done") && data.callId) {
    const owner = findToolPiece(messages, event.runId, data.callId);
    if (owner >= 0) {
      const copy = messages.slice();
      copy[owner] = upsertTool(messages[owner], event.type, data);
      return copy;
    }
  }
  // The run ended: a tool still running in an earlier piece of it is closed like one in the last.
  if (event.type === "run.finished" && event.runId) messages = closeEarlierPieces(messages, event.runId, data.status);
  {
    // The first new part after the run read the owner's message: the message sits right above it.
    const at = event.runId ? findRun(messages, event.runId) : -1;
    if (at >= 0 && messages[at].waiting?.length && messages[at].readable && startsNewPart(messages[at], event, data)) messages = splitAt(messages, at, event);
  }
  // A suggestion is started or dismissed long after the run that made it: update its card
  // wherever it is, not in the latest run.
  if (event.type === "chat.suggestion.status") return setSuggestionStatus(messages, data.id, data.status);
  const index = findRun(messages, event.runId);
  if (index < 0) return messages;
  const run = messages[index];
  let updated = reduceRun(run, event, data);
  // A tool round ended after the message: the model's next request carries it (a typed answer to
  // an ask card is that card's result; a steered message joins at the round boundary).
  if (event.type === "tool.done" && updated.waiting?.length && !updated.readable && betweenRounds(updated)) updated = { ...updated, readable: true };
  if (updated === run) return messages;
  const copy = messages.slice();
  copy[index] = updated;
  return copy;
}

// Older «در صف» messages (no user.queue events): the next turn that started ran them, unless the
// turn they waited behind was cancelled first. Only unsettled ones change.
function settleLegacy(messages, match, state) {
  if (!messages.some((m) => "legacyBehind" in m && !m.queueState && match(m))) return messages;
  return messages.map((m) => ("legacyBehind" in m && !m.queueState && match(m) ? { ...m, queueState: state } : m));
}

function findRun(messages, runId) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role !== "assistant") continue;
    if (!runId || message.runId === runId) return i;
  }
  return -1;
}

// The owner's message reached a working run (steered into it, or the typed answer to its ask card).
// The model reads it at its next request, so it waits at the bottom (run.waiting) until the run
// has read it (run.readable: the engine said so with user.read, or a tool round ended after it)
// and then starts a new part; the run splits there: the piece so far ends (continued: true, no
// footer), the message follows it, and the rest of the run is a new piece of the same run. Before,
// every later event folded into the run above and the message sat under the final answer.
function placeMidRun(messages, user, event) {
  const index = findRun(messages, event.runId);
  const run = index >= 0 ? messages[index] : null;
  if (!run || run.status !== "running") return [...messages, user];
  // Nothing shown yet: all the run does comes after the message.
  if (!run.parts.length) return [...messages.slice(0, index), user, ...messages.slice(index)];
  const copy = [...messages, user];
  copy[index] = { ...run, waiting: [...(run.waiting || []), user.id] };
  return copy;
}

// The model's last response ended in tool calls that have all come back.
function betweenRounds(run) {
  return run.parts.at(-1)?.type === "tool" && !run.parts.some((part) => part.type === "tool" && part.status === "running");
}

// Readable means the next request is under way, so anything new comes from it.
function startsNewPart(run, event, data) {
  if (event.type === "text" || event.type === "thinking") return Boolean(data.text);
  if (event.type === "tool.started") return Boolean(data.callId) && !run.parts.some((part) => part.type === "tool" && part.callId === data.callId);
  return false;
}

function splitAt(messages, index, event) {
  const run = messages[index];
  const ids = new Set(run.waiting);
  const moved = messages.filter((m) => ids.has(m.id));
  const rest = messages.filter((m) => !ids.has(m.id));
  const at = rest.indexOf(run);
  const upper = {
    ...run,
    waiting: null,
    readable: false,
    status: "finished",
    continued: true,
    phase: null,
    endedAt: event.at,
    parts: run.parts.map((part) => (part.type === "reasoning" && !part.done ? { ...part, done: true } : part)),
  };
  // The new piece keeps the run's start and usage so far, so its footer shows the whole run.
  const piece = { ...run, id: `r${run.runId}~${event.id}`, waiting: null, readable: false, parts: [], endedAt: null };
  return [...rest.slice(0, at), upper, ...moved, piece, ...rest.slice(at + 1)];
}

// One run as a single message again (its pieces' parts in order, the last piece's state and
// usage), for readers of a run's result: a messenger delivery, the title, the todo bar.
export function wholeRun(messages, runId) {
  const pieces = (messages || []).filter((m) => m.role === "assistant" && m.runId === runId);
  if (!pieces.length) return null;
  const last = pieces.at(-1);
  return pieces.length === 1 ? last : { ...last, id: pieces[0].id, startedAt: pieces[0].startedAt, parts: pieces.flatMap((m) => m.parts) };
}

// The chat's latest run, whole.
export function lastRun(messages) {
  const last = (messages || []).findLast((m) => m.role === "assistant");
  return last ? (last.runId ? wholeRun(messages, last.runId) : last) : null;
}

function findToolPiece(messages, runId, callId) {
  if (!runId) return -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role !== "assistant" || message.runId !== runId) continue;
    const has = message.parts.some((part) => part.type === "tool" && part.callId === callId);
    if (has) return message.continued ? i : -1; // in the last piece: the usual path handles it
  }
  return -1;
}

function closeEarlierPieces(messages, runId, status) {
  let copy = messages;
  messages.forEach((message, i) => {
    if (message.role !== "assistant" || message.runId !== runId || !message.continued) return;
    const parts = message.parts.map((part) => closePart(part, status));
    if (parts.every((part, j) => part === message.parts[j])) return;
    if (copy === messages) copy = messages.slice();
    copy[i] = { ...message, parts };
  });
  return copy;
}

function reduceRun(run, event, data) {
  switch (event.type) {
    case "user.read":
      return run.waiting?.length && !run.readable ? { ...run, readable: true } : run;
    case "run.phase":
      return { ...run, phase: data.phase, phaseDetail: data.detail || null, phaseAt: event.at || null };
    case "manifest":
      // What changed in the rules/tools/engine since the previous session (the footer's «چرا؟» flag).
      return run.status === "running" && Array.isArray(data.changes) && data.changes.length ? { ...run, manifestChanges: data.changes.length } : run;
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
    case "chapter":
      if (!data.title) return run;
      return { ...run, parts: [...run.parts, { type: "chapter", title: String(data.title), summary: data.summary ? String(data.summary) : null }] };
    case "chat.suggested":
      if (!data.id) return run;
      return { ...run, parts: [...run.parts, { type: "suggestion", id: data.id, title: data.title || "", tldr: data.tldr || "", status: data.status || "open" }] };
    case "usage":
      // A turn's usage (Claude: its result) or one request's (other engines): the run's cost is the sum.
      return { ...run, usage: addUsage(run.usage, data) };
    case "usage.request":
      // One request of a Claude turn: the context it filled and one more request; its cost comes with
      // the turn's own "usage" (never counted twice).
      return { ...run, usage: requestUsage(run.usage, data) };
    case "run.finished":
      return {
        ...run,
        // A message the run never read stays after it, where it was written.
        waiting: null,
        readable: false,
        status: data.status || "finished",
        error: data.error || null,
        ...(data.undelivered ? { undelivered: true } : {}),
        phase: null,
        parts: run.parts.map((part) => closePart(part, data.status)),
        endedAt: event.at,
      };
    default:
      return run;
  }
}

function setSuggestionStatus(messages, id, status) {
  if (!id || !status) return messages;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role !== "assistant") continue;
    const at = message.parts.findIndex((part) => part.type === "suggestion" && part.id === id);
    if (at < 0) continue;
    const parts = message.parts.slice();
    parts[at] = { ...parts[at], status };
    const copy = messages.slice();
    copy[i] = { ...message, parts };
    return copy;
  }
  return messages;
}

// Tokens a chat used, by model: each run counted once (a run split by a steered message repeats its
// usage on every piece; the last piece holds the whole run's). tokens = input + output.
// billed: everything the requests billed (usage.total: input, cache writes and reads, output), as
// the Karsara skin's header counts it; otherwise input + output.
export function usageByModel(messages, { billed = false } = {}) {
  const runs = new Map();
  for (const m of messages || []) {
    if (m.role === "assistant" && m.usage) runs.set(m.runId || m.id, m);
  }
  const byModel = new Map();
  let total = 0;
  for (const run of runs.values()) {
    const own = (Number(run.usage.input) || 0) + (Number(run.usage.output) || 0);
    const tokens = billed && run.usage.total != null ? Number(run.usage.total) || 0 : own;
    if (!tokens) continue;
    total += tokens;
    const model = run.model || "auto";
    byModel.set(model, (byModel.get(model) || 0) + tokens);
  }
  return { total, byModel: [...byModel].map(([model, tokens]) => ({ model, tokens })).sort((a, b) => b.tokens - a.tokens) };
}

function requestUsage(prev, data) {
  const n = (v) => Number(v) || 0;
  const input = n(data?.prompt_tokens ?? data?.inputTokens ?? data?.input_tokens);
  return {
    input: n(prev?.input),
    output: n(prev?.output),
    cached: n(prev?.cached),
    cacheWrite: n(prev?.cacheWrite),
    total: n(prev?.total),
    requests: n(prev?.requests) + 1,
    context: input || n(prev?.context),
    seenRequests: n(prev?.seenRequests) + 1,
  };
}

function addUsage(prev, data) {
  const n = (v) => Number(v) || 0;
  const input = n(data?.prompt_tokens ?? data?.inputTokens ?? data?.input_tokens);
  const output = n(data?.completion_tokens ?? data?.outputTokens ?? data?.output_tokens);
  const cached = n(data?.prompt_tokens_details?.cached_tokens ?? data?.cacheReadTokens ?? data?.cache_read_input_tokens);
  // total: everything the request billed, as token-usage.mjs counts it (and the Karsara skin's footer shows):
  // input + output + cache writes + cache reads. OpenAI-style prompt_tokens already hold the cached
  // part, Anthropic-style input_tokens do not; cache writes used to be dropped.
  const cacheWrite = n(data?.cache_creation_input_tokens ?? data?.cacheWriteTokens);
  const billed = (data?.prompt_tokens != null ? input : input + cached) + output + cacheWrite;
  return {
    input: n(prev?.input) + input,
    output: n(prev?.output) + output,
    cached: n(prev?.cached) + cached,
    cacheWrite: n(prev?.cacheWrite) + cacheWrite,
    total: n(prev?.total) + billed,
    // After a Claude turn's own requests (usage.request) the result adds no request, and its input
    // (the turn's sum) is not a context size.
    requests: n(prev?.requests) + (prev?.seenRequests ? 0 : 1),
    context: prev?.seenRequests ? n(prev?.context) : input || n(prev?.context),
    seenRequests: 0,
  };
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

export * from "./mentions.mjs";
