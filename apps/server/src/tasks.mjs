// Cursor SDK `task` (زیرایجنت) returns a nested transcript in result.conversationSteps.
// We materialize that into a hidden child chat so the owner can open it like a subchat.

const TASK_MARKER = "__task__";

export function findTaskChild(store, parentId, callId) {
  if (!parentId || !callId) return null;
  const rows = store.db
    .prepare("SELECT id, call_chain FROM chats WHERE parent_chat_id = ? AND caller = 'task'")
    .all(parentId);
  for (const row of rows) {
    const chain = parseChain(row.call_chain);
    if (chain[0] === TASK_MARKER && chain[1] === callId) return row.id;
  }
  return null;
}

export function findTaskDoneEvent(store, parentId, callId) {
  for (const event of store.allEvents(parentId)) {
    if (event.type !== "tool.done" || event.data?.name !== "task") continue;
    if (event.data?.callId === callId) return event;
  }
  return null;
}

export function materializeTaskChat(store, parentId, callId) {
  const existing = findTaskChild(store, parentId, callId);
  if (existing) return store.getChat(existing);

  const parent = store.getChat(parentId);
  if (!parent) throw new Error("parent chat missing");

  const done = findTaskDoneEvent(store, parentId, callId);
  if (!done) throw new Error("task result not found");

  const args = done.data?.args || {};
  const payload = unwrapTaskValue(done.data?.result);
  const steps = Array.isArray(payload?.conversationSteps) ? payload.conversationSteps : [];
  const description = String(args.description || args.prompt || "زیرایجنت").trim().slice(0, 80);

  const child = store.createChat({
    title: `← زیرایجنت: ${description}`,
    model: parent.model,
    mode: parent.mode === "plan" ? "plan" : "agent",
    caller: "task",
    agent: parent.agent,
    parentChatId: parentId,
    callChain: [TASK_MARKER, callId],
  });

  const runId = store.startRun(child.id);
  store.appendEvent(child.id, runId, "run.started", { model: parent.model || "auto", mode: parent.mode || "agent" });
  if (args.prompt) {
    store.appendEvent(child.id, null, "user", { text: String(args.prompt), images: 0 });
  }
  for (const step of steps) {
    for (const event of eventsFromStep(step)) {
      store.appendEvent(child.id, runId, event.type, event.data);
    }
  }
  store.appendEvent(child.id, runId, "run.finished", { status: "finished" });
  store.finishRun(child.id, runId, "finished");
  return store.getChat(child.id);
}

export function taskSummary(result) {
  const payload = unwrapTaskValue(result);
  const steps = Array.isArray(payload?.conversationSteps) ? payload.conversationSteps : [];
  const texts = [];
  for (const step of steps) {
    const text = step?.assistantMessage?.text;
    if (text) texts.push(String(text));
  }
  return texts.length ? texts[texts.length - 1] : null;
}

export function unwrapTaskValue(result) {
  if (!result || typeof result !== "object") return null;
  if (Array.isArray(result.conversationSteps)) return result;
  if (result.value && typeof result.value === "object") return result.value;
  return result;
}

export function eventsFromStep(step) {
  if (!step || typeof step !== "object") return [];
  if (step.thinkingMessage?.text) {
    return [
      { type: "thinking", data: { text: String(step.thinkingMessage.text) } },
      { type: "thinking.done", data: { durationMs: step.thinkingMessage.durationMs ?? null } },
    ];
  }
  if (step.assistantMessage?.text) {
    return [{ type: "text", data: { text: String(step.assistantMessage.text) } }];
  }
  if (step.toolCall) {
    const mapped = mapToolCall(step.toolCall);
    if (!mapped) return [];
    return [
      { type: "tool.started", data: { callId: mapped.callId, name: mapped.name, args: mapped.args } },
      {
        type: "tool.done",
        data: {
          callId: mapped.callId,
          name: mapped.name,
          args: mapped.args,
          result: mapped.result,
        },
      },
    ];
  }
  return [];
}

function mapToolCall(toolCall) {
  const callId = toolCall.toolCallId || null;
  const key = Object.keys(toolCall).find((k) => k.endsWith("ToolCall"));
  if (!key) return null;
  const inner = toolCall[key] || {};
  const name = key.replace(/ToolCall$/, "").replace(/^[A-Z]/, (c) => c.toLowerCase());
  // readToolCall → read; getMcpToolsToolCall → getMcpTools
  const short = key.replace(/ToolCall$/, "");
  const toolName = short.charAt(0).toLowerCase() + short.slice(1);
  const mappedName = TOOL_NAME_MAP[toolName] || toolName;
  return {
    callId,
    name: mappedName,
    args: inner.args || {},
    result: simplifyToolResult(inner.result),
  };
}

const TOOL_NAME_MAP = {
  read: "read",
  edit: "edit",
  write: "write",
  delete: "delete",
  grep: "grep",
  glob: "glob",
  ls: "ls",
  semSearch: "semSearch",
  webSearch: "webSearch",
  webFetch: "webFetch",
  shell: "shell",
  await: "await",
  task: "task",
};

function simplifyToolResult(result) {
  if (!result || typeof result !== "object") return result;
  if (result.success) return result.success;
  if (result.error) return { error: result.error, ...(typeof result.error === "object" ? result.error : {}) };
  return result;
}

function parseChain(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.map(String);
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}
