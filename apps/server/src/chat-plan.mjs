// A chat's plan (owner 2026-11-05: «هر چت میتونه تسک و ساب تسک برای خودش تعریف کنه و طبق اون ها پیش بره.
// ایجنت میتونه پیشنهاد بده و با تایید اونر اینطوری پیش بره»). kv chatplan:<chatId> =
// { state: "proposed" | "active", tasks: [{ id, title, subs: [{ id, title, status }] }],
//   suggestions: [{ id, taskId, title }], seq, at }. The agent proposes, starts nothing until the owner
// approves, then keeps the statuses; anything new it wants waits as a suggestion. A plan the owner
// writes himself is active at once. Every change goes through applyEdit, one at a time, so the
// owner's click and the agent's update never overwrite each other.

import { maskText } from "./redact.mjs";

export const PLAN_TOOL = "chat_plan";
const STATUSES = new Set(["pending", "in_progress", "done"]);
const MAX_TASKS = 20;
const MAX_SUBS = 30;
// Suggestions wait for him one by one; a flood of them is a wall above the chat box (owner 2026-11-07).
const MAX_WAITING = 5;
const key = (chatId) => `chatplan:${chatId}`;
const clean = (text) => maskText(String(text ?? "")).trim().slice(0, 200);
const reply = (value, isError = false) => ({ ...(isError ? { isError: true } : {}), content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }] });

export const getPlan = (store, chatId) => store.getKv(key(chatId)) || null;
const savePlan = (store, chatId, plan) => {
  const next = { ...plan, at: new Date().toISOString() };
  store.setKv(key(chatId), next);
  return next;
};
export const dropPlan = (store, chatId) => store.deleteKv(key(chatId));

const nextId = (plan, prefix) => {
  plan.seq = (plan.seq || 0) + 1;
  return `${prefix}${plan.seq}`;
};

/** Agent's or owner's whole list -> a plan; no valid task means null. */
export function buildPlan(tasks, state) {
  const plan = { state, tasks: [], suggestions: [], seq: 0 };
  for (const task of Array.isArray(tasks) ? tasks.slice(0, MAX_TASKS) : []) {
    const title = clean(task?.title);
    if (!title) continue;
    const subs = (Array.isArray(task?.subtasks) ? task.subtasks : []).slice(0, MAX_SUBS).map(clean).filter(Boolean);
    plan.tasks.push({ id: nextId(plan, "t"), title, subs: subs.map((sub) => ({ id: nextId(plan, "s"), title: sub, status: "pending" })) });
  }
  return plan.tasks.length ? plan : null;
}

export const planDone = (plan) => {
  const subs = (plan?.tasks || []).flatMap((t) => t.subs);
  return plan?.state === "active" && subs.length > 0 && subs.every((s) => s.status === "done");
};

const withTask = (plan, id, change) => ({ ...plan, tasks: plan.tasks.map((t) => (t.id === id ? change(t) : t)) });
const withSub = (plan, id, change) => ({ ...plan, tasks: plan.tasks.map((t) => ({ ...t, subs: t.subs.map((s) => (s.id === id ? change(s) : s)) })) });
const hasSub = (plan, id) => plan.tasks.some((t) => t.subs.some((s) => s.id === id));
const hasTask = (plan, id) => plan.tasks.some((t) => t.id === id);

/**
 * One change, pure. -> { plan } or { error }. plan null means «no plan any more».
 * add-task on no plan starts the owner's own, already active.
 */
export function applyEdit(current, edit) {
  const op = edit?.op;
  const title = clean(edit?.title);
  let plan = current ? { ...current, tasks: current.tasks, suggestions: current.suggestions || [] } : null;
  if (op === "add-task") {
    if (!title) return { error: "title is required" };
    plan = plan || { state: "active", tasks: [], suggestions: [], seq: 0 };
    if (plan.tasks.length >= MAX_TASKS) return { error: `at most ${MAX_TASKS} tasks` };
    const id = nextId(plan, "t");
    return { plan: { ...plan, tasks: [...plan.tasks, { id, title, subs: [] }] } };
  }
  if (!plan) return { error: "this chat has no plan" };
  if (op === "add-sub") {
    if (!title) return { error: "title is required" };
    const task = plan.tasks.find((t) => t.id === edit.taskId);
    if (!task) return { error: `no task ${edit.taskId}` };
    if (task.subs.length >= MAX_SUBS) return { error: `at most ${MAX_SUBS} subtasks` };
    const id = nextId(plan, "s");
    return { plan: withTask(plan, task.id, (t) => ({ ...t, subs: [...t.subs, { id, title, status: "pending" }] })) };
  }
  if (op === "remove-sub") {
    if (!hasSub(plan, edit.id)) return { error: `no subtask ${edit.id}` };
    return { plan: { ...plan, tasks: plan.tasks.map((t) => ({ ...t, subs: t.subs.filter((s) => s.id !== edit.id) })) } };
  }
  if (op === "remove-task") {
    if (!hasTask(plan, edit.id)) return { error: `no task ${edit.id}` };
    const tasks = plan.tasks.filter((t) => t.id !== edit.id);
    return { plan: tasks.length ? { ...plan, tasks, suggestions: plan.suggestions.filter((s) => s.taskId !== edit.id) } : null };
  }
  if (op === "set") {
    if (!STATUSES.has(edit.status)) return { error: `status must be one of ${[...STATUSES].join(", ")}` };
    if (plan.state !== "active") return { error: "the plan is not approved yet: start nothing until the owner approves" };
    if (!hasSub(plan, edit.id)) return { error: `no subtask ${edit.id}` };
    return { plan: withSub(plan, edit.id, (s) => ({ ...s, status: edit.status })) };
  }
  if (op === "suggest") {
    if (!title) return { error: "title is required" };
    if (!hasTask(plan, edit.taskId)) return { error: `no task ${edit.taskId}` };
    if (plan.suggestions.length >= MAX_WAITING) return { error: `${MAX_WAITING} suggestions already wait for the owner: keep only what really matters, and wait for his answer before suggesting more` };
    const id = nextId(plan, "n");
    return { plan: { ...plan, suggestions: [...plan.suggestions, { id, taskId: edit.taskId, title }] } };
  }
  if (op === "accept" || op === "dismiss") {
    const suggestion = plan.suggestions.find((s) => s.id === edit.id);
    if (!suggestion) return { error: `no suggestion ${edit.id}` };
    const rest = { ...plan, suggestions: plan.suggestions.filter((s) => s.id !== edit.id) };
    if (op === "dismiss") return { plan: rest };
    return applyEdit(rest, { op: "add-sub", taskId: suggestion.taskId, title: suggestion.title });
  }
  return { error: `unknown edit ${op}` };
}

export function editPlan(store, chatId, edit) {
  const result = applyEdit(getPlan(store, chatId), edit);
  if (result.error) return result;
  if (result.plan) return { plan: savePlan(store, chatId, result.plan) };
  dropPlan(store, chatId);
  return { plan: null };
}

export const offersPlan = (chat, { rootCaller, unattended }) => !unattended && rootCaller === "owner" && !chat.parent_chat_id && !chat.side_of;

export function chatPlanTool({ store, chatId }) {
  return {
    description:
      "This chat's plan: tasks and subtasks the owner sees beside the chat. For work with several real steps, or anything he should agree to before it starts, propose one (action propose), end your turn and wait: he approves, changes or rejects it, and nothing of it starts before he approves. Skip it for a quick job. " +
      "Once approved, follow it: mark each subtask in_progress when you start it and done when it is really finished (action update). Something new the plan really lacks goes to him as a suggestion (action suggest), a few at most, never a list of ideas; keep working on the rest meanwhile. Short Persian titles, never tool names.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["propose", "update", "suggest"] },
        tasks: {
          type: "array",
          maxItems: MAX_TASKS,
          description: "propose: the whole plan.",
          items: {
            type: "object",
            properties: { title: { type: "string" }, subtasks: { type: "array", maxItems: MAX_SUBS, items: { type: "string" } } },
            required: ["title"],
            additionalProperties: false,
          },
        },
        updates: {
          type: "array",
          description: "update: subtask ids and their new status.",
          items: {
            type: "object",
            properties: { id: { type: "string" }, status: { type: "string", enum: [...STATUSES] } },
            required: ["id", "status"],
            additionalProperties: false,
          },
        },
        task_id: { type: "string", description: "suggest: the task the new subtask belongs to." },
        title: { type: "string", description: "suggest: the new subtask." },
      },
      required: ["action"],
      additionalProperties: false,
    },
    async execute(args) {
      const action = args?.action;
      const current = getPlan(store, chatId);
      if (action === "propose") {
        // A running plan changes only by his yes: replacing it would throw his approval away.
        if (current?.state === "active" && !planDone(current)) return reply("a plan is already approved and running: follow it, and use action suggest for anything new", true);
        const plan = buildPlan(args?.tasks, "proposed");
        if (!plan) return reply("tasks is empty", true);
        return reply({ placed: "پلن به Owner نشان داده شد. تا تأیید نکند کاری از آن را شروع نکن و نوبتت را تمام کن.", plan: savePlan(store, chatId, plan) });
      }
      if (action === "update") {
        const updates = Array.isArray(args?.updates) ? args.updates : [];
        if (!updates.length) return reply("updates is empty", true);
        let plan = current;
        for (const update of updates) {
          const result = applyEdit(plan, { op: "set", id: update?.id, status: update?.status });
          if (result.error) return reply(result.error, true);
          plan = result.plan;
        }
        return reply({ plan: savePlan(store, chatId, plan) });
      }
      if (action === "suggest") {
        const result = editPlan(store, chatId, { op: "suggest", taskId: args?.task_id, title: args?.title });
        if (result.error) return reply(result.error, true);
        return reply({ placed: "پیشنهاد به Owner نشان داده شد. تا تأیید نکند جزو پلن نیست؛ بقیهٔ کار را ادامه بده.", plan: result.plan });
      }
      return reply("action must be propose, update or suggest", true);
    },
  };
}

/** The line a turn of this conversation reads while it has a plan. */
export function planLine(store, chatId) {
  const plan = getPlan(store, chatId);
  if (!plan) return null;
  if (plan.state === "proposed") return "[پلنی که پیشنهاد دادی هنوز تأیید Owner را ندارد: کاری از آن را شروع نکن. اگر چیزی در پلن خواست عوض شود، با chat_plan {action: \"propose\"} نسخهٔ تازه را بده.]";
  if (planDone(plan)) return null;
  const mark = { pending: " ", in_progress: "~", done: "x" };
  const lines = plan.tasks.map((t) => `${t.id} ${t.title}\n${t.subs.map((s) => `  [${mark[s.status]}] ${s.id} ${s.title}`).join("\n")}`).join("\n");
  return `[پلن تأییدشدهٔ این گفتگو. طبق همین پیش برو و وضعیت هر زیرتسک را با chat_plan {action: "update"} ثبت کن؛ چیز تازه با {action: "suggest"}:\n${lines}]`;
}

export function chatPlanRoutes(api, { store, send }) {
  const chatOf = (c) => store.getChat(c.req.param("id"));
  const json = (c) => c.req.json().catch(() => ({}));
  api.get("/api/chats/:id/plan", (c) => (chatOf(c) ? c.json({ plan: getPlan(store, c.req.param("id")) }) : c.json({ error: "not found" }, 404)));
  api.post("/api/chats/:id/plan/edit", async (c) => {
    if (!chatOf(c)) return c.json({ error: "not found" }, 404);
    const result = editPlan(store, c.req.param("id"), await json(c));
    return result.error ? c.json({ error: result.error }, 400) : c.json({ plan: result.plan });
  });
  // His answer to a proposal wakes the chat: the agent ended its turn waiting for it.
  api.post("/api/chats/:id/plan/approve", async (c) => {
    if (!chatOf(c)) return c.json({ error: "not found" }, 404);
    const chatId = c.req.param("id");
    const plan = getPlan(store, chatId);
    if (plan?.state !== "proposed") return c.json({ error: "no plan is waiting for approval" }, 409);
    const next = savePlan(store, chatId, { ...plan, state: "active" });
    await send(chatId, "پلن را تأیید کردم. طبق آن شروع کن.");
    return c.json({ plan: next });
  });
  api.post("/api/chats/:id/plan/reject", async (c) => {
    if (!chatOf(c)) return c.json({ error: "not found" }, 404);
    const chatId = c.req.param("id");
    if (getPlan(store, chatId)?.state !== "proposed") return c.json({ error: "no plan is waiting for approval" }, 409);
    dropPlan(store, chatId);
    await send(chatId, "پلن را رد کردم. چیزی از آن را شروع نکن و بپرس به‌جایش چه کار کنی.");
    return c.json({ plan: null });
  });
}
