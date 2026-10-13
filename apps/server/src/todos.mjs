// A task's steps («۲/۵ — <step>» on the owner's main page and above the chat box): kv
// todo:<chatId> = { todos: [{ content, status }], at }, only while that chat's run is running.
// Each engine keeps its own list: Cursor's updateTodos and Claude's TodoWrite are copied here by
// watchTodos; the OpenAI-compatible engine has none, so it gets todo_write.

import { maskText } from "./redact.mjs";
import { addOwnerTask } from "./inbox.mjs";
import { COVERAGE_CALLER } from "./integrations/coverage.mjs";

export const TODO_TOOL = "todo_write";
export const OWNER_TASK_TOOL = "owner_task";
const NATIVE = new Set(["updateTodos", "TodoWrite"]);
const key = (chatId) => `todo:${chatId}`;
const reply = (text, isError = false) => ({ ...(isError ? { isError: true } : {}), content: [{ type: "text", text }] });

// Engines name statuses their own way (Cursor TODO_STATUS_*, Claude in_progress, a title instead
// of content); the board reads one shape.
export function normalizeTodos(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map((t) => {
      const status = String(t?.status ?? "");
      return {
        content: maskText(String(t?.content ?? t?.title ?? "")).trim().slice(0, 200),
        status: /cancel/i.test(status) ? "cancelled" : /complete|done/i.test(status) ? "completed" : /progress|doing/i.test(status) ? "in_progress" : "pending",
      };
    })
    .filter((t) => t.content)
    .slice(0, 20);
}

/** Writes only on a real change (each write wakes every open board). True when it wrote. */
export function saveTodos(store, chatId, list) {
  const todos = normalizeTodos(list);
  if (!todos.length) {
    if (store.getKv(key(chatId)) == null) return false;
    store.deleteKv(key(chatId));
    return true;
  }
  if (JSON.stringify(store.getKv(key(chatId))?.todos) === JSON.stringify(todos)) return false;
  store.setKv(key(chatId), { todos, at: new Date().toISOString() });
  return true;
}

export function todoWriteTool({ store, chatId }) {
  return {
    description:
      "Your step list for this task, shown to the owner on his main page and above the chat box. Send the WHOLE list each call. Exactly one step in_progress; mark steps completed as you finish them; short Persian actions, never tool names.",
    inputSchema: {
      type: "object",
      properties: {
        todos: {
          type: "array",
          maxItems: 20,
          items: {
            type: "object",
            properties: {
              content: { type: "string" },
              status: { type: "string", enum: ["pending", "in_progress", "completed", "cancelled"] },
            },
            required: ["content", "status"],
            additionalProperties: false,
          },
        },
      },
      required: ["todos"],
      additionalProperties: false,
    },
    async execute(args) {
      const todos = normalizeTodos(args?.todos);
      if (!todos.length) return reply("todos is empty", true);
      if (todos.filter((t) => t.status === "in_progress").length > 1) return reply("only one step may be in_progress", true);
      saveTodos(store, chatId, todos);
      const done = todos.filter((t) => t.status === "completed" || t.status === "cancelled").length;
      return reply(`${done}/${todos.length} انجام شد`);
    },
  };
}

// A chore shows on the owner's board as the assistant's own, with no «از گفتگو با …»: offered only in his own
// chains and his colleagues' Telegram ones, both read by him — never a peer:* (/mcp) agent's, a job
// or the ops room (nobody reads the board there).
export const offersOwnerTask = ({ rootCaller, unattended }) => !unattended && (rootCaller === "owner" || rootCaller === COVERAGE_CALLER);

// A chore for the owner: something only he can do that blocks nobody (a token to rotate, a person
// to talk to). It lands in «منتظر شما» linked to the root chat; nothing waits for his answer.
export function ownerTaskTool({ store, chatId, agent }) {
  return {
    description:
      "Put a chore on the owner's main page: something only he can do that does not block you (rotate a token, talk to someone, review a doc). It does not wait for an answer — keep working. Once per chore; for a decision you need now use ask_owner instead.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", maxLength: 120, description: "The chore in one short Persian line." },
        detail: { type: "string", maxLength: 600, description: "Why and how, if the title is not enough." },
      },
      required: ["title"],
      additionalProperties: false,
    },
    async execute(args) {
      const task = addOwnerTask(store, { title: args?.title, detail: args?.detail, chatId, agent });
      if (!task) return reply("title is required", true);
      return reply("روی صفحهٔ اصلی Owner گذاشته شد");
    },
  };
}

// Copies the native engines' lists, and clears a chat's row when its run ends — unless it still
// waits on delegated subtasks (pendingDelegates, peers.mjs): a task whose turn ended after
// delegating keeps its steps on the board; the run that reads their report clears it. Returns unsubscribe.
export function watchTodos(store, { pendingDelegates = () => 0 } = {}) {
  const onEvent = (chatId, event) => {
    try {
      if (event?.type !== "tool.done" || !NATIVE.has(event.data?.name)) return;
      const value = event.data?.result?.value ?? event.data?.result;
      const list = Array.isArray(value?.todos) ? value.todos : Array.isArray(event.data?.args?.todos) ? event.data.args.todos : null;
      if (list) saveTodos(store, chatId, list);
    } catch (error) {
      console.error(`[todos] chat ${chatId}: ${error.message}`);
    }
  };
  const onChats = (e) => {
    try {
      if (e?.type !== "run" || e.status === "running" || !e.chatId || store.getKv(key(e.chatId)) == null) return;
      if (!pendingDelegates(e.chatId)) store.deleteKv(key(e.chatId));
    } catch (error) {
      console.error(`[todos] ${error.message}`);
    }
  };
  store.bus.on("event", onEvent);
  store.bus.on("chats", onChats);
  return () => {
    store.bus.off("event", onEvent);
    store.bus.off("chats", onChats);
  };
}
