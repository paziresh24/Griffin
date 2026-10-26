import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openStore } from "../src/db.mjs";
import { createRunner } from "../src/runner.mjs";
import { createClaudeProvider } from "../src/providers/claude.mjs";
import { createToolBuilder } from "../src/tool-builder.mjs";
import { FOLLOW_THROUGH_NUDGE, leavesWorkOpen } from "../src/follow-through.mjs";
import { addOwnerTask, buildInbox, listOwnerTasks } from "../src/inbox.mjs";
import { openChoresLine, ownerTaskTool } from "../src/todos.mjs";

// 2026-10-20 (owner): «کارها باید به سرانجام برسند». A chat read «تمام شد» while its work waited on
// a watcher nobody saw, a promise nothing would wake, a tool build whose merge never reached the
// chain that asked, or an access card that stayed on his page after he granted it in the chat.

const until = async (cond, ms = 2_000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};
const tmpStore = (prefix) => openStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), prefix)), "db.sqlite"));
const events = (store, chatId, type) => store.eventsAfter(chatId).filter((e) => e.type === type);
const dataOf = (e) => e.data ?? e.payload ?? {};

test("leavesWorkOpen: a promise for later, not an offer or a question", () => {
  // The closing lines of chat «دیزاین ماژولار» that left the owner asking «نصب شد؟».
  assert.equal(leavesWorkOpen("کامیت پوش شد. بعد از سبز شدن تست‌ها ایمیج را می‌سازم و نگهبان آن را نصب می‌کند."), true);
  assert.equal(leavesWorkOpen("منتظر تمام شدن تست‌های CI هستم."), true);
  assert.equal(leavesWorkOpen("الان ۳ چت در حال کارند. چند دقیقه بعد از ساخت بپرسید، یا اگر همین گفتگو را رها کنید خودش نصب می‌شود."), true);
  assert.equal(leavesWorkOpen("Pushed. Once CI is green I'll build the images."), true);
  assert.equal(leavesWorkOpen("انجام شد و روی نوا نصب است."), false);
  assert.equal(leavesWorkOpen("اگر بخواهید بعد از ادغام نصبش می‌کنم."), false);
  assert.equal(leavesWorkOpen("همین امروز metabase را شروع کنم؟"), false);
  assert.equal(leavesWorkOpen(""), false);
});

// A fake engine whose turn ends on the text it is given (one per send).
function scriptedSdk(texts) {
  const sends = [];
  const agent = {
    agentId: "a1",
    async send(message, options) {
      sends.push(typeof message === "string" ? message : message?.text);
      const text = texts[Math.min(sends.length - 1, texts.length - 1)];
      return {
        id: `r${sends.length}`,
        supports: () => true,
        async cancel() {},
        async wait() {
          await options.onDelta?.({ update: { type: "text-delta", text } });
          return { status: "finished" };
        },
      };
    },
    close() {},
  };
  return { sdk: { kind: "claude", create: async () => agent, resume: async () => agent }, sends };
}

test("runner: a turn that ends on a promise nothing will wake is sent on once", async () => {
  const store = tmpStore("griffin-ft-");
  const { sdk, sends } = scriptedSdk(["پوش شد. بعد از سبز شدن CI ایمیج را می‌سازم.", "باز هم بعد از سبز شدن CI ایمیج را می‌سازم."]);
  const runner = createRunner({ store, sdk, agentOptions: async () => ({}), followThrough: () => true, log: { error() {} } });
  const chat = store.createChat({ title: "t" });
  await runner.send(chat.id, { text: "بساز و نصب کن", ownerText: true });
  await until(() => events(store, chat.id, "run.finished").length === 2);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(sends.length, 2, "one nudge, not a loop");
  assert.equal(sends[1], FOLLOW_THROUGH_NUDGE);
  assert.ok(events(store, chat.id, "note").some((e) => /خودکار دوباره راهش انداختم/.test(dataOf(e).text)));
  // The owner's next message may earn one more.
  await runner.send(chat.id, { text: "ادامه", ownerText: true });
  await until(() => events(store, chat.id, "run.finished").length === 4);
});

test("runner: nothing is sent on where something will wake it, or where it is not enabled", async () => {
  for (const [label, opts] of [["subtask pending", { followThrough: () => true, pendingWork: () => 1 }], ["off", { followThrough: () => false }]]) {
    const store = tmpStore("griffin-ft-");
    const { sdk, sends } = scriptedSdk(["بعد از سبز شدن CI ایمیج را می‌سازم."]);
    const runner = createRunner({ store, sdk, agentOptions: async () => ({}), log: { error() {} }, ...opts });
    const chat = store.createChat({ title: "t" });
    await runner.send(chat.id, { text: "بساز", ownerText: true });
    await until(() => events(store, chat.id, "run.finished").length === 1);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(sends.length, 1, label);
  }
});

// Claude Code answers a background task that ended (the watcher «sleep 200» before checking CI) in a
// turn of its own. That turn is a run of the chat now: seen, and «در حال کار» until it ends.
function fakeClaude() {
  const processes = [];
  const queryImpl = ({ prompt, options }) => {
    const id = options.resume || options.sessionId;
    const proc = { id, exited: false, pending: [], wake: null };
    const emit = (msg) => {
      proc.pending.push(msg);
      proc.wake?.();
    };
    proc.emit = emit;
    processes.push(proc);
    let n = 0;
    const textOf = (m) => m?.message?.content?.find?.((c) => c.type === "text")?.text || "";
    const turn = (text, uuid) => {
      if (!n++) emit({ type: "system", subtype: "init", session_id: id, mcp_servers: [] });
      const bg = /^bg (\S+)/.exec(text);
      if (bg) emit({ type: "system", subtype: "task_started", task_id: bg[1], description: `sleep for ${bg[1]}`, task_type: "local_bash", is_backgrounded: true, session_id: id });
      emit({ type: "assistant", message: { content: [{ type: "text", text: `ok: ${text}` }] }, session_id: id });
      emit({ type: "result", subtype: "success", is_error: false, result: `ok: ${text}`, user_message_uuid: uuid, session_id: id });
    };
    const iter = (async function* () {
      (async () => {
        for await (const m of prompt) turn(textOf(m), m?.uuid || null);
      })();
      options.abortController?.signal.addEventListener("abort", () => proc.wake?.());
      try {
        for (;;) {
          while (proc.pending.length) yield proc.pending.shift();
          if (options.abortController?.signal.aborted) return;
          await new Promise((resolve) => (proc.wake = resolve));
          proc.wake = null;
        }
      } finally {
        proc.exited = true;
      }
    })();
    iter.interrupt = async () => emit({ type: "result", subtype: "error_during_execution", is_error: true, result: "", session_id: id });
    return iter;
  };
  return { queryImpl, processes };
}

test("runner: Claude's own turn after a background task ends is a run of the chat", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "griffin-wake-"));
  const store = openStore(path.join(dir, "db.sqlite"));
  const fake = fakeClaude();
  const sdk = { ...createClaudeProvider({ apiKey: "sk-ant-api-test", queryImpl: fake.queryImpl }), kind: "claude" };
  const opts = { cwd: dir, fileAccess: { read: [dir], write: [dir], deny: [] }, claudeCode: true, idleCloseMs: 30, cliTurnQuietMs: 50, backgroundTasks: true };
  const runner = createRunner({ store, sdk, agentOptions: async () => opts, log: { error() {} } });
  const chat = store.createChat({ title: "t" });
  await runner.send(chat.id, { text: "bg ci", ownerText: true });
  await until(() => events(store, chat.id, "run.finished").length === 1);
  await until(() => runner.backgroundTasks(chat.id).length === 1);
  const p = fake.processes[0];
  // The watcher ends; Claude Code answers it by itself and starts the builds.
  p.emit({ type: "system", subtype: "task_notification", task_id: "ci", status: "completed", summary: "green", session_id: p.id });
  p.emit({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "CI سبز شد؛ ساخت ایمیج را زدم." } }, session_id: p.id });
  await until(() => runner.isActive(chat.id));
  const wake = events(store, chat.id, "run.started").at(-1);
  assert.equal(dataOf(wake).wake, true);
  assert.ok(events(store, chat.id, "text").some((e) => e.runId === wake.runId || e.run_id === wake.runId));
  // The owner writes meanwhile: it waits behind that turn, then runs.
  await runner.send(chat.id, { text: "نصب شد؟", ownerText: true, intent: "queue" });
  p.emit({ type: "result", subtype: "success", is_error: false, result: "CI سبز شد", user_message_uuid: "notification", session_id: p.id });
  await until(() => events(store, chat.id, "run.finished").length === 3);
  const finished = events(store, chat.id, "run.finished").map((e) => dataOf(e).status);
  assert.deepEqual(finished, ["finished", "finished", "finished"]);
  runner.shutdown({ timeoutMs: 200 });
});

test("tool-builder: a run cut by a restart is not the report; the finish is, and the asker is woken when the tool is live", async () => {
  const store = tmpStore("griffin-tb2-");
  const sent = [];
  let live = false;
  const runner = { send: async (chatId, msg) => sent.push({ chatId, text: msg.text }), isActive: () => false };
  const builder = createToolBuilder({
    store,
    runner,
    isYes: (c) => c?.answer === "بله",
    confirm: async () => ({ answer: "بله" }),
    createBuildChat: async ({ title }) => store.createChat({ title: `🛠 ${title}`, agent: "griffin", caller: "owner" }),
    hasTool: async () => live,
    livePollMs: 60_000,
    log: { error() {} },
  });
  const from = store.createChat({ title: "یارا", agent: "arvan-ban", caller: "peer:x" });
  const out = JSON.parse((await builder.tool(from, { requester: "x" }).execute({ title: "arvan_load_balancer_get", need: "خواندن تنظیمات لودبالانسر لازم است", spec: "GET the load balancer, read-only, masked" })).content[0].text);
  store.appendEvent(out.chatId, null, "run.finished", { status: "cancelled", error: "به‌خاطر ری‌استارت سرور قطع شد — بعد از بالا آمدن ادامه می‌دهد" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(sent.length, 0, "a cut run is not reported");
  store.appendEvent(out.chatId, null, "run.finished", { status: "finished" });
  await until(() => sent.length === 1);
  assert.match(sent[0].text, /گزارش خودکار ساخت ابزار/);
  await builder.checkLive();
  assert.equal(sent.length, 1, "not live yet: nobody woken");
  live = true;
  await builder.checkLive();
  assert.equal(sent.length, 2);
  assert.equal(sent[1].chatId, from.id);
  assert.match(sent[1].text, /حالا روی همین نصب فعال است/);
  await builder.checkLive();
  assert.equal(sent.length, 2, "woken once");
  builder.stop();
});

test("owner_task: the agent closes its own card once the access works; turns read the open ones", async () => {
  const store = tmpStore("griffin-ot-");
  const chat = store.createChat({ title: "Platform HA" });
  const other = store.createChat({ title: "other" });
  const tool = ownerTaskTool({ store, chatId: chat.id, agent: "griffin" });
  const placed = JSON.parse((await tool.execute({ access: "سه IP در لیست ArvanCloud روتر تهران" })).content[0].text);
  assert.match(openChoresLine(store, chat.id), new RegExp(`#${placed.id}`));
  assert.equal(openChoresLine(store, other.id), null);
  // Another conversation's card is not this one's to close.
  const foreign = addOwnerTask(store, { title: "دسترسی: x", chatId: other.id, access: "x" });
  assert.equal((await tool.execute({ done: foreign.id })).isError, true);
  const closed = await tool.execute({ done: placed.id });
  assert.equal(closed.isError, undefined);
  assert.deepEqual(listOwnerTasks(store).map((t) => t.id), [foreign.id]);
  assert.equal(openChoresLine(store, chat.id), null);
});

test("inbox: a «پیام نرسید» card is off the board while its retry runs", () => {
  const store = tmpStore("griffin-ib-");
  const chat = store.createChat({ title: "t" });
  store.setKv(`kept:${chat.id}`, [{ id: "k1", message: "سلام", fails: 0 }]);
  assert.equal(buildInbox({ store }).items.filter((i) => i.kind === "kept").length, 1);
  assert.equal(buildInbox({ store, isActive: (id) => id === chat.id }).items.filter((i) => i.kind === "kept").length, 0);
});

test("tool-builder: when a subtask asked, its root is woken and told which thread to steer", async () => {
  const store = tmpStore("griffin-tb3-");
  const sent = [];
  const runner = { send: async (chatId, msg) => sent.push({ chatId, text: msg.text }), isActive: () => false };
  const builder = createToolBuilder({
    store,
    runner,
    isYes: () => true,
    confirm: async () => ({ answer: "بله" }),
    createBuildChat: async ({ title }) => store.createChat({ title: `🛠 ${title}`, agent: "griffin", caller: "owner" }),
    hasTool: async () => true,
    livePollMs: 60_000,
    log: { error() {} },
  });
  const root = store.createChat({ title: "یارا", agent: "griffin", caller: "peer:x" });
  const thread = store.createChat({ title: "← نوا: LB", agent: "arvan-ban", caller: "griffin", parentChatId: root.id });
  const out = JSON.parse((await builder.tool(thread, { requester: "x" }).execute({ title: "arvan_load_balancer_get", need: "خواندن تنظیمات لودبالانسر لازم است", spec: "GET the load balancer, read-only, masked" })).content[0].text);
  store.appendEvent(out.chatId, null, "run.finished", { status: "finished" });
  await until(() => sent.length === 2);
  assert.ok(sent.every((s) => s.chatId === root.id), "the root, not the thread that already reported");
  assert.ok(sent.every((s) => s.text.includes(thread.id) && /subtasks steer/.test(s.text)));
  builder.stop();
});
