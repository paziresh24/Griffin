// A task's steps («۲/۵ — <step>» on the owner's main page and above the chat box): kv
// todo:<chatId> = { todos: [{ content, status }], at }, only while that chat's run is running.
// Each engine keeps its own list: Cursor's updateTodos and Claude's TodoWrite are copied here by
// watchTodos; the OpenAI-compatible engine has none, so it gets todo_write.

import { maskText } from "./redact.mjs";
import { addOwnerTask, listOwnerTasks, removeOwnerTask } from "./inbox.mjs";

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

// A chore shows on the owner's board as the assistant's own: offered only in his own attended chains — never
// a peer:* (/mcp) agent's, a job or the ops room (nobody reads the board there). A colleague's
// Telegram chain hands work to his chats instead (handoff_to_owner, handoff.mjs; owner 2026-10-21).
export const offersOwnerTask = ({ rootCaller, unattended }) => !unattended && rootCaller === "owner";

// The owner gives access; the agents do the work (owner 2026-10-13: «چرا انقدر کار به دوش منه؟ من
// قرار بود فقط دسترسی‌دهنده باشم» — three «کار شما» cards were review fixes and a workflow edit).
// So the card is an access request only, and his «دادم» wakes the chat to carry on (app.mjs).
export function ownerTaskTool({ store, chatId, askedIn = null, agent }) {
  return {
    description:
      "Ask the owner for ACCESS you lack — besides a decision (ask_owner), the only thing that is his. Never work: a code change, the fixes a review asked for, editing a workflow, telling someone, running a fix — those are yours (do them or delegate them). Name the exact access: which permission or credential, on which system, and where it should land (e.g. «Maintainer برای کاربر griffin روی alice/search-service», «API key پنل n8n سرچ در Infisical پروژهٔ alice»). It lands on his main page; when he grants it the main conversation is told which thread asked, and the work goes on there. Do what you can meanwhile. " +
      "The card stays on his page until it is closed: once the access is there (he said so in this chat, or you saw it work) and you have tested it, close it with {done: <its id>} — never leave a granted access waiting on him.",
    inputSchema: {
      type: "object",
      properties: {
        access: { type: "string", maxLength: 110, description: "The access, in one short Persian line: what, on which system." },
        why: { type: "string", maxLength: 600, description: "The work it unblocks, one or two lines." },
        done: { type: "string", maxLength: 20, description: "Instead of asking: the id of this conversation's card whose access has arrived and works — it leaves his page." },
      },
      additionalProperties: false,
    },
    async execute(args) {
      const done = String(args?.done || "").trim().replace(/^#/, "");
      if (done) {
        const task = listOwnerTasks(store).find((t) => t.id === done);
        if (!task || task.chatId !== chatId) return reply(`no open card ${done} of this conversation`, true);
        removeOwnerTask(store, done);
        return reply(JSON.stringify({ closed: done, note: "از صفحهٔ اصلی Owner برداشته شد" }));
      }
      const access = String(args?.access || "").trim();
      const task = access ? addOwnerTask(store, { title: `دسترسی: ${access}`, detail: args?.why, chatId, askedIn, agent, access }) : null;
      if (!task) return reply("access is required: which permission or credential, on which system (or done: a card id)", true);
      // The id lets the board's «باز کردن» find this call's card in the chat (web focus.js).
      return reply(JSON.stringify({ placed: "روی صفحهٔ اصلی Owner گذاشته شد", id: task.id }));
    },
  };
}

/** The line a turn of this conversation reads while access cards it left on the owner's page are open. */
export function openChoresLine(store, chatId) {
  const root = store.rootChatId?.(chatId) ?? chatId;
  const open = listOwnerTasks(store).filter((t) => t.chatId === root && t.access);
  if (!open.length) return null;
  const lines = open.map((t) => `#${t.id} «${t.access}»`).join("\n");
  return `[کارت‌های دسترسی این گفتگو که هنوز روی صفحهٔ اصلی Owner منتظرند:\n${lines}\nاگر دسترسی رسیده (Owner در همین گفتگو گفته یا دیده‌ای کار می‌کند)، اول خودت تستش کن و بعد با owner_task {done: "<id>"} ببندش.]`;
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
