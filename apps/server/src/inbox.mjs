// What waits for the owner on his main page («منتظر شما»), built on demand from what already
// exists: open questions (asks, in memory), held Telegram drafts (kv tgwaiting), undelivered
// messages (kv kept:<chat>), failed «بعداً» notes, and chores the assistant left him (kv ownertasks).
// Nothing here reads the events table; kv is read by primary-key ranges only.

import { randomBytes } from "node:crypto";
import { ownerAnswers } from "./asks.mjs";
import { motherInfo } from "./integrations/mother.mjs";
import { maskText } from "./redact.mjs";

const OWNER_TASKS = "ownertasks";
const OWNER_TASKS_MAX = 100;

// A chore: something only the owner can do that blocks nobody (a token to rotate, a person to
// talk to). Unlike ask_owner nothing waits on it; it stays on his board until he clears it.
// `who` is the chain it came from, like a question's: a colleague's agent can make the assistant write
// one, and its card must not read as the assistant's own.
export function addOwnerTask(store, { title, detail = "", chatId = null, agent = null } = {}) {
  const clean = maskText(String(title || "")).trim().slice(0, 120);
  if (!clean) return null;
  const root = chatId ? store.getChat(store.rootChatId?.(chatId) ?? chatId) : null;
  const task = {
    id: randomBytes(4).toString("hex"),
    title: clean,
    detail: maskText(String(detail || "")).trim().slice(0, 600),
    chatId: chatId || null,
    agent: agent || null,
    who: root ? whoOf(store, root) : null,
    at: new Date().toISOString(),
  };
  store.setKv(OWNER_TASKS, [...listOwnerTasks(store), task].slice(-OWNER_TASKS_MAX));
  return task;
}

export const listOwnerTasks = (store) => {
  const list = store.getKv(OWNER_TASKS);
  return Array.isArray(list) ? list : [];
};

/** Done or let go — either way it leaves the board. False when it was not there. */
export function removeOwnerTask(store, id) {
  const list = listOwnerTasks(store);
  const rest = list.filter((task) => task.id !== id);
  if (rest.length === list.length) return false;
  store.setKv(OWNER_TASKS, rest);
  return true;
}

/** { done, total, current } of a todo:<chat> row, or null when it has no steps. */
export function todoSummary(value) {
  const list = Array.isArray(value?.todos) ? value.todos : null;
  if (!list?.length) return null;
  const done = list.filter((t) => t?.status === "completed" || t?.status === "cancelled").length;
  const current = (list.find((t) => t?.status === "in_progress") || list.find((t) => t?.status === "pending"))?.content || null;
  return { done, total: list.length, current };
}

const parse = (value) => {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
};

// Who the chain is for, in the owner's words: the colleague, the colleague's agent, or the room.
function whoOf(store, root) {
  if (root.caller === "team") return (root.person_id && store.getPerson?.(root.person_id)?.display_name) || null;
  if (String(root.caller || "").startsWith("peer:")) {
    const id = root.caller.slice(5);
    return store.getPeerUser?.(id)?.label || id;
  }
  if (root.caller === "ops") return "اتاق عملیات";
  return null;
}

export function buildInbox({ store, asks }) {
  const asked = [];
  // A requester question is listed only where nobody but the owner can answer it (ownerAnswers);
  // a sim root is a rehearsal.
  for (const a of (asks?.list?.() || []).filter((item) => ownerAnswers(store, item))) {
    const root = store.getChat(a.rootChatId);
    if (!root || root.sim) continue;
    asked.push({
      id: `ask:${a.id}`,
      kind: a.via === "guard" ? "approval" : "question",
      askId: a.id,
      chatId: a.rootChatId,
      sourceChatId: a.sourceChatId,
      title: root.title || "",
      who: whoOf(store, root),
      agent: store.getChat(a.sourceChatId)?.agent || root.agent || null,
      question: a.question,
      options: a.options || null,
      multiSelect: a.multiSelect,
      at: new Date(a.at).toISOString(),
    });
  }
  const approvals = asked.filter((i) => i.kind === "approval");
  const questions = asked.filter((i) => i.kind === "question");

  const waiting = store.getKv("tgwaiting") || [];
  const telegram = waiting.map((w) => ({
    id: `tg:${w.id}`,
    kind: "telegram",
    waitingId: w.id,
    waitingKind: w.kind,
    op: w.op || null,
    reason: w.reason || null,
    personId: w.personId,
    name: w.name,
    chatId: w.chatId,
    text: String(w.text || "").slice(0, 400),
    at: w.at,
  }));

  const kept = [];
  // runner.mjs LIMIT_RESUME_KEY: { <chatId>: { at, tries } } of chats that continue by themselves
  // after the plan limit resets — their kept message goes again then, nothing for him to do.
  const resuming = store.getKv("limit-resume") || {};
  for (const row of store.db.prepare("SELECT key, value FROM kv WHERE key >= 'kept:' AND key < 'kept;'").all()) {
    const chatId = row.key.slice(5);
    const list = parse(row.value);
    if (!Array.isArray(list) || !list.length) continue;
    // deleteChat leaves the kv row behind. A mother chat's failure is the desk's (its «ارسال نشد»
    // card, which «ولش کن» lets go for good). A sim chain is a rehearsal. A closed (archived) chat leaves the board.
    const chat = store.getChat(chatId);
    if (!chat || chat.archived || chatId in resuming || motherInfo(store, chatId)) continue;
    if (chat.sim || store.getChat(store.rootChatId(chatId))?.sim) continue;
    kept.push({
      id: `kept:${chatId}`,
      kind: "kept",
      chatId,
      keptId: list[0].id,
      count: list.length,
      title: chat.title || "",
      text: String(list[0].message?.text ?? list[0].message ?? "").slice(0, 200),
      at: chat.updated_at,
    });
  }

  const notes = store.listNotes().filter((n) => n.status === "failed").map((n) => ({
    id: `note:${n.id}`,
    kind: "note",
    noteId: n.id,
    text: String(n.text || "").slice(0, 200),
    error: n.error || null,
    chatId: n.chat_id || null,
    chatTitle: n.chat_title || null,
    at: n.updated_at,
  }));

  const chores = listOwnerTasks(store).map((t) => ({
    id: `chore:${t.id}`,
    kind: "chore",
    choreId: t.id,
    title: t.title,
    detail: t.detail || "",
    chatId: t.chatId || null,
    who: t.who || null,
    at: t.at,
  }));

  const todos = {};
  for (const row of store.db.prepare("SELECT key, value FROM kv WHERE key >= 'todo:' AND key < 'todo;'").all()) {
    const summary = todoSummary(parse(row.value));
    if (summary) todos[row.key.slice(5)] = summary;
  }

  const items = [...approvals, ...questions, ...telegram, ...kept, ...notes, ...chores];
  return { items, count: items.length, todos };
}

// The assistant's view of the same board: answer «چی منتظر منه؟» from facts, and do not ask him again
// what already waits for him.
export function inboxTool({ store, asks }) {
  return {
    description:
      "List what is waiting for the owner on his main page right now: questions and approvals from every chain, held Telegram drafts, undelivered messages, failed «بعداً» notes, chores left for him. Read-only. Use it to answer «چی منتظر منه؟» and before asking him something that may already be waiting.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    async execute() {
      const { items } = buildInbox({ store, asks });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              count: items.length,
              items: items.map((i) => ({
                kind: i.kind,
                title: i.title || i.name || i.chatTitle || "",
                who: i.who || i.name || null,
                text: String(i.question || i.text || i.detail || "").slice(0, 200),
                chatId: i.chatId,
                at: i.at,
              })),
            }),
          },
        ],
      };
    },
  };
}
