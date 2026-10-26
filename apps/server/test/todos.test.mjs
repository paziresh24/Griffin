import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openStore } from "../src/db.mjs";
import { listOwnerTasks } from "../src/inbox.mjs";
import { buildRules, DECIDE_AND_REPORT } from "../src/prompt.mjs";
import { offersOwnerTask, ownerTaskTool, todoWriteTool, watchTodos } from "../src/todos.mjs";

const fresh = () => openStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "griffin-todos-")), "db.sqlite"));
const text = (result) => result.content[0].text;

test("todo_write: keeps one normalized list, refuses an empty one or two steps in progress", async () => {
  const store = fresh();
  const chat = store.createChat({ title: "دیسک" });
  const tool = todoWriteTool({ store, chatId: chat.id });

  const ok = await tool.execute({ todos: [
    { content: "بررسی دیسک نود worker-3", status: "completed" },
    { content: "پاک کردن کش", status: "in_progress" },
    { content: "گزارش", status: "pending" },
  ] });
  assert.equal(ok.isError, undefined);
  assert.equal(text(ok), "1/3 انجام شد");
  assert.deepEqual(store.getKv(`todo:${chat.id}`).todos.map((t) => t.status), ["completed", "in_progress", "pending"]);

  const two = await tool.execute({ todos: [{ content: "الف", status: "in_progress" }, { content: "ب", status: "in_progress" }] });
  assert.equal(two.isError, true);
  assert.equal(store.getKv(`todo:${chat.id}`).todos[0].content, "بررسی دیسک نود worker-3");

  const empty = await tool.execute({ todos: [{ content: "  ", status: "pending" }] });
  assert.equal(empty.isError, true);
  assert.equal(store.getKv(`todo:${chat.id}`).todos.length, 3);
});

test("watchTodos: copies Claude's and Cursor's lists, only on a change, and clears at run end", () => {
  const store = fresh();
  const chat = store.createChat({ title: "x" });
  const stop = watchTodos(store);
  let inbox = 0;
  store.bus.on("inbox", () => (inbox += 1));
  const key = `todo:${chat.id}`;

  store.appendEvent(chat.id, null, "tool.done", { name: "TodoWrite", args: { todos: [{ content: "a", status: "in_progress", activeForm: "x" }] } });
  assert.deepEqual(store.getKv(key).todos, [{ content: "a", status: "in_progress" }]);

  // Cursor's args carry only the changed items; its result has the whole list.
  store.appendEvent(chat.id, null, "tool.done", {
    name: "updateTodos",
    args: { todos: [{ content: "b", status: "TODO_STATUS_COMPLETED" }] },
    result: { value: { todos: [{ content: "a", status: "TODO_STATUS_COMPLETED" }, { content: "b", status: "TODO_STATUS_IN_PROGRESS" }] } },
  });
  assert.deepEqual(store.getKv(key).todos, [{ content: "a", status: "completed" }, { content: "b", status: "in_progress" }]);

  const before = inbox;
  store.appendEvent(chat.id, null, "tool.done", { name: "kube_status", args: { todos: [{ content: "z", status: "pending" }] } });
  store.appendEvent(chat.id, null, "tool.done", {
    name: "updateTodos",
    result: { value: { todos: [{ content: "a", status: "TODO_STATUS_COMPLETED" }, { content: "b", status: "TODO_STATUS_IN_PROGRESS" }] } },
  });
  assert.equal(inbox, before, "another tool, or the same list again, writes nothing");
  assert.equal(store.getKv(key).todos.length, 2);

  const run = store.startRun(chat.id);
  assert.ok(store.getKv(key), "a run starting keeps the list");
  store.finishRun(chat.id, run, "finished");
  assert.equal(store.getKv(key), null);
  stop();
});

test("owner_task: an access request on the owner's board, linked to the root chat", async () => {
  const store = fresh();
  const root = store.createChat({ title: "سرچ" });
  const tool = ownerTaskTool({ store, chatId: root.id, agent: "griffin" });
  assert.equal((await tool.execute({ access: "  " })).isError, true);
  // Not a chore: the access it needs — or `done`, the id of a card of this chat whose access arrived.
  assert.deepEqual(Object.keys(tool.inputSchema.properties).sort(), ["access", "done", "why"]);
  assert.equal((await tool.execute({ why: "بدون دسترسی" })).isError, true);
  const done = await tool.execute({ access: "Maintainer برای griffin روی alice/search-service", why: "اصلاح‌های MR 45" });
  assert.equal(done.isError, undefined);
  const [chore] = listOwnerTasks(store);
  assert.equal(chore.title, "دسترسی: Maintainer برای griffin روی alice/search-service");
  assert.equal(chore.access, "Maintainer برای griffin روی alice/search-service");
  assert.equal(chore.chatId, root.id);
  assert.equal(chore.agent, "griffin");
  assert.equal(JSON.parse(done.content[0].text).id, chore.id, "the card can be found from the board");
});

test("every agent and caller works as tasks, right after decide-and-report", () => {
  for (const options of [{ agent: "griffin" }, { agent: "platform", caller: "team" }]) {
    const rules = buildRules(options);
    assert.ok(rules.includes("Work as tasks"));
    assert.ok(rules.includes("owner_task"));
    assert.ok(rules.indexOf("Work as tasks") > rules.indexOf(DECIDE_AND_REPORT.trim().slice(0, 40)));
  }
});

test("watchTodos: a task whose turn ended after delegating keeps its steps until a run ends with none pending", () => {
  const store = fresh();
  const chat = store.createChat({ title: "سه کار" });
  let pending = 1;
  const stop = watchTodos(store, { pendingDelegates: (id) => (id === chat.id ? pending : 0) });
  const key = `todo:${chat.id}`;
  store.appendEvent(chat.id, null, "tool.done", { name: "TodoWrite", args: { todos: [{ content: "بررسی دیسک", status: "completed" }, { content: "پاک کردن کش", status: "in_progress" }] } });
  store.finishRun(chat.id, store.startRun(chat.id), "finished");
  assert.equal(store.getKv(key).todos.length, 2, "the subtask still runs: «۱/۲ — پاک کردن کش» stays");
  pending = 0;
  store.finishRun(chat.id, store.startRun(chat.id), "finished"); // the run that read its report
  assert.equal(store.getKv(key), null);
  stop();
});

test("owner_task: only in chains the owner reads — his own and colleagues' Telegram ones", () => {
  assert.equal(offersOwnerTask({ rootCaller: "owner", unattended: false }), true);
  assert.equal(offersOwnerTask({ rootCaller: "team", unattended: false }), false, "a colleague's Telegram chain hands work over instead (handoff_to_owner)");
  assert.equal(offersOwnerTask({ rootCaller: "peer:alice", unattended: false }), false, "a colleague's agent over /mcp");
  assert.equal(offersOwnerTask({ rootCaller: "ops", unattended: true }), false);
  assert.equal(offersOwnerTask({ rootCaller: "owner", unattended: true }), false, "a job");
});

test("the ops room is not told that nobody answers (critical mode asks the owner)", () => {
  const rules = buildRules({ agent: "griffin", caller: "ops" });
  const silent = rules.split(/(?<=\.)\s+/).filter((s) => s.includes("nobody answers"));
  assert.ok(silent.length, "a scheduled job still decides by itself");
  assert.ok(silent.every((s) => !/ops room/.test(s)));
});
