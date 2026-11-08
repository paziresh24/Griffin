import test from "node:test";
import assert from "node:assert/strict";
import { applyEdit, buildPlan, chatPlanTool, getPlan, planDone, planLine } from "../src/chat-plan.mjs";
import { chatChanges, chatFileDiff, chatTerminalRun } from "../src/chat-changes.mjs";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const memStore = () => { const kv = new Map(); return { getKv: (k) => kv.get(k), setKv: (k, v) => kv.set(k, v), deleteKv: (k) => kv.delete(k) }; };
const call = async (tool, args) => { const r = await tool.execute(args); return { error: r.isError, text: r.content[0].text }; };
const TASKS = [{ title: "یک", subtasks: ["الف", "ب"] }, { title: "دو", subtasks: ["ج"] }];

test("a proposal starts nothing until the owner approves, and a running plan cannot be replaced", async () => {
  const store = memStore();
  const tool = chatPlanTool({ store, chatId: "c" });
  assert.equal((await call(tool, { action: "propose", tasks: [] })).error, true);
  assert.equal((await call(tool, { action: "propose", tasks: TASKS })).error, undefined);
  const plan = getPlan(store, "c");
  assert.equal(plan.state, "proposed");
  const sub = plan.tasks[0].subs[0].id;
  assert.equal((await call(tool, { action: "update", updates: [{ id: sub, status: "done" }] })).error, true, "no update before approval");
  assert.match(planLine(store, "c"), /تأیید/);
  // A changed proposal replaces the old one while it still waits.
  assert.equal((await call(tool, { action: "propose", tasks: TASKS.slice(0, 1) })).error, undefined);
  assert.equal(getPlan(store, "c").tasks.length, 1);
  store.setKv("chatplan:c", { ...getPlan(store, "c"), state: "active" });
  assert.equal((await call(tool, { action: "propose", tasks: TASKS })).error, true);
  assert.equal((await call(tool, { action: "update", updates: [{ id: "nope", status: "done" }] })).error, true);
  assert.equal((await call(tool, { action: "update", updates: [{ id: sub, status: "in_progress" }] })).error, undefined);
  assert.match(planLine(store, "c"), new RegExp(`\\[~\\] ${sub}`));
});

test("a suggestion is not part of the plan until accepted", async () => {
  const store = memStore();
  const tool = chatPlanTool({ store, chatId: "c" });
  store.setKv("chatplan:c", buildPlan(TASKS, "active"));
  const taskId = getPlan(store, "c").tasks[1].id;
  await call(tool, { action: "suggest", task_id: taskId, title: "تازه" });
  let plan = getPlan(store, "c");
  assert.equal(plan.tasks[1].subs.length, 1);
  assert.equal(plan.suggestions.length, 1);
  plan = applyEdit(plan, { op: "accept", id: plan.suggestions[0].id }).plan;
  assert.equal(plan.tasks[1].subs.at(-1).title, "تازه");
  assert.equal(plan.suggestions.length, 0);
});

test("edits: a hand-written plan is active at once; ids stay unique; the last task gone is no plan", () => {
  let { plan } = applyEdit(null, { op: "add-task", title: "من" });
  assert.equal(plan.state, "active");
  plan = applyEdit(plan, { op: "add-sub", taskId: plan.tasks[0].id, title: "x" }).plan;
  plan = applyEdit(plan, { op: "add-sub", taskId: plan.tasks[0].id, title: "y" }).plan;
  const ids = plan.tasks[0].subs.map((s) => s.id);
  plan = applyEdit(plan, { op: "remove-sub", id: ids[0] }).plan;
  plan = applyEdit(plan, { op: "add-sub", taskId: plan.tasks[0].id, title: "z" }).plan;
  assert.equal(new Set(plan.tasks[0].subs.map((s) => s.id)).size, 2);
  assert.ok(!plan.tasks[0].subs.some((s) => s.id === ids[0]));
  assert.equal(planDone(plan), false);
  for (const s of plan.tasks[0].subs) plan = applyEdit(plan, { op: "set", id: s.id, status: "done" }).plan;
  assert.equal(planDone(plan), true);
  assert.equal(applyEdit(plan, { op: "set", id: "s99", status: "done" }).error, "no subtask s99");
  assert.equal(applyEdit(plan, { op: "set", id: plan.tasks[0].subs[0].id, status: "bogus" }).error?.startsWith("status"), true);
  assert.equal(applyEdit(plan, { op: "remove-task", id: plan.tasks[0].id }).plan, null);
  assert.ok(applyEdit(null, { op: "set", id: "s1", status: "done" }).error);
});

test("changes and terminal stay in the chat's folder", async () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "chat-changes-")));
  const git = (...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: dir });
  git("init", "-q", "-b", "main");
  fs.writeFileSync(path.join(dir, "a.txt"), "one\n");
  git("add", ".");
  git("commit", "-qm", "base");
  git("checkout", "-qb", "work");
  fs.writeFileSync(path.join(dir, "a.txt"), "one\ntwo\n");
  git("commit", "-qam", "committed change");
  fs.writeFileSync(path.join(dir, "new.txt"), "new\n");
  const changes = await chatChanges(dir);
  assert.equal(changes.branch, "work");
  assert.deepEqual(changes.files.map((f) => [f.path, f.status, f.add]), [["a.txt", "modified", 1], ["new.txt", "new", 0]]);
  assert.match((await chatFileDiff(dir, "a.txt")).diff, /\+two/);
  assert.match((await chatFileDiff(dir, "new.txt")).diff, /\+new/);
  assert.equal(await chatFileDiff(dir, "../etc/passwd"), null);
  assert.equal(await chatChanges(os.tmpdir()), null);
  assert.equal((await chatTerminalRun(dir, { command: "pwd" })).stdout.trim(), dir);
  assert.equal((await chatTerminalRun(dir, { command: "pwd", cwd: "/etc" })).stdout.trim(), dir, "a cwd outside the folder is ignored");
  process.env.GRIFFIN_TEST_SECRET = "x";
  assert.equal((await chatTerminalRun(dir, { command: "echo ${GRIFFIN_TEST_SECRET:-none}" })).stdout.trim(), "none");
  delete process.env.GRIFFIN_TEST_SECRET;
  fs.rmSync(dir, { recursive: true, force: true });
});

test("only a few suggestions wait at once", () => {
  let plan = buildPlan(TASKS, "active");
  for (let i = 0; i < 5; i += 1) plan = applyEdit(plan, { op: "suggest", taskId: plan.tasks[0].id, title: `s${i}` }).plan;
  assert.match(applyEdit(plan, { op: "suggest", taskId: plan.tasks[0].id, title: "more" }).error, /already wait/);
  plan = applyEdit(plan, { op: "dismiss", id: plan.suggestions[0].id }).plan;
  assert.ok(applyEdit(plan, { op: "suggest", taskId: plan.tasks[0].id, title: "more" }).plan);
});
