import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createClaudeProvider } from "../src/providers/claude.mjs";
import { openStore } from "../src/db.mjs";
import { createRunner, BG_TASKS_KEY } from "../src/runner.mjs";

// Config CLAUDE_BACKGROUND_TASKS: a background shell the agent started keeps running after the turn
// ends, the next message goes into the same Claude Code process, and each task has its own stop.
// A fake Claude Code that reads a streaming input like the real one: «bg …» starts a backgrounded
// task; the process lives until its input ends or it is aborted.
function fakeClaude() {
  const processes = [];
  const queryImpl = ({ prompt, options }) => {
    const id = options.resume || options.sessionId;
    const proc = { id, exited: false, options, pending: [], wake: null, tasks: new Set() };
    const emit = (msg) => {
      proc.pending.push(msg);
      proc.wake?.();
    };
    proc.emit = emit;
    processes.push(proc);
    const textOf = (m) => (typeof m === "string" ? m : m?.message?.content?.find?.((c) => c.type === "text")?.text || "");
    let n = 0;
    proc.seen = [];
    proc.holding = null; // { uuids } while a «hold» turn waits for release()
    proc.release = ({ split = false } = {}) => {
      const { uuids } = proc.holding;
      proc.holding = null;
      if (split) {
        emit({ type: "result", subtype: "success", is_error: false, result: "first", user_message_uuid: uuids[0], session_id: id });
        emit({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "second" } }, session_id: id });
        emit({ type: "result", subtype: "success", is_error: false, result: "second", user_message_uuids: uuids.slice(1), session_id: id });
      } else emit({ type: "result", subtype: "success", is_error: false, result: "both", user_message_uuids: uuids, session_id: id });
    };
    const turn = (text, uuid = null) => {
      proc.seen.push(text);
      // A message that arrives mid-turn is folded into it, as Claude Code does with a steer.
      if (proc.holding) return void proc.holding.uuids.push(uuid);
      if (!n++) emit({ type: "system", subtype: "init", session_id: id, mcp_servers: [] });
      if (/^hold/.test(text)) {
        proc.holding = { uuids: [uuid] };
        emit({ type: "assistant", message: { content: [{ type: "text", text: "working" }] }, session_id: id });
        return;
      }
      const bg = /^bg (\S+)/.exec(text);
      if (bg) {
        proc.tasks.add(bg[1]);
        emit({ type: "system", subtype: "task_started", task_id: bg[1], description: `sleep for ${bg[1]}`, task_type: "local_bash", is_backgrounded: true, session_id: id });
      }
      emit({ type: "assistant", message: { content: [{ type: "text", text: `ok: ${text}` }] }, session_id: id });
      emit({ type: "result", subtype: "success", is_error: false, result: `ok: ${text}`, session_id: id });
    };
    const iter = (async function* () {
      let inputDone = false;
      (async () => {
        if (typeof prompt === "string") turn(prompt), (inputDone = true);
        else {
          for await (const m of prompt) turn(textOf(m), m?.uuid || null);
          inputDone = true;
        }
        proc.wake?.();
      })();
      options.abortController?.signal.addEventListener("abort", () => proc.wake?.());
      try {
        for (;;) {
          while (proc.pending.length) yield proc.pending.shift();
          if (options.abortController?.signal.aborted) return;
          // A one-shot (string) prompt ends at its result, as Claude Code's print mode does.
          if (inputDone) return;
          await new Promise((resolve) => (proc.wake = resolve));
          proc.wake = null;
        }
      } finally {
        proc.exited = true;
      }
    })();
    iter.stopTask = async (taskId) => {
      proc.tasks.delete(taskId);
      emit({ type: "system", subtype: "task_notification", task_id: taskId, status: "stopped", summary: "stopped by owner", session_id: id });
    };
    proc.interrupts = [];
    iter.interrupt = async (opts) => void proc.interrupts.push(opts ?? null);
    proc.switches = [];
    iter.setModel = async (m) => proc.switches.push(`model:${m}`);
    iter.setPermissionMode = async (m) => proc.switches.push(`mode:${m}`);
    proc.finishTask = (taskId, summary = "done") => {
      proc.tasks.delete(taskId);
      emit({ type: "system", subtype: "task_notification", task_id: taskId, status: "completed", summary, session_id: id });
    };
    return iter;
  };
  return { queryImpl, processes };
}

const fullOwner = (extra = {}) => ({ cwd: "/tmp", fileAccess: { read: ["/tmp"], write: ["/tmp"], deny: [] }, claudeCode: true, idleCloseMs: 30, cliTurnQuietMs: 50, ...extra });
const until = async (cond, ms = 2_000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

test("on: the process and its background task outlive the turn; the next message goes into the same process", async () => {
  const fake = fakeClaude();
  const agent = createClaudeProvider({ apiKey: "sk-ant-api-test", queryImpl: fake.queryImpl }).create(fullOwner({ backgroundTasks: true }));
  const first = await (await agent.send("bg b1")).wait();
  assert.equal(first.status, "finished");
  await new Promise((resolve) => setTimeout(resolve, 100)); // well past the idle close
  assert.equal(fake.processes.length, 1);
  assert.equal(fake.processes[0].exited, false, "the background shell's process is still running");
  assert.equal(fake.processes[0].options.perTaskStopAffordance, true);
  assert.deepEqual(agent.backgroundTasks().map((t) => [t.id, t.description]), [["b1", "sleep for b1"]]);

  const second = await (await agent.send("ادامه")).wait();
  assert.equal(second.status, "finished");
  assert.equal(fake.processes.length, 1, "no second process on the same session");
  agent.close();
});

test("on: each task has its own stop; the process closes once no task is left", async () => {
  const fake = fakeClaude();
  const events = [];
  const agent = createClaudeProvider({ apiKey: "sk-ant-api-test", queryImpl: fake.queryImpl }).create(fullOwner({ backgroundTasks: true }));
  agent.setBackgroundListener((event) => events.push(event));
  await (await agent.send("bg b1")).wait();
  await (await agent.send("bg b2")).wait();
  assert.deepEqual(agent.backgroundTasks().map((t) => t.id), ["b1", "b2"]);
  assert.equal(await agent.stopTask("b1"), true);
  await until(() => agent.backgroundTasks().length === 1);
  assert.deepEqual(agent.backgroundTasks().map((t) => t.id), ["b2"]);
  assert.equal(await agent.stopTask("nope"), false, "an unknown task is not stopped");
  fake.processes[0].finishTask("b2", "all green");
  await until(() => fake.processes[0].exited);
  const ended = events.filter((e) => e.type === "ended").map((e) => [e.task.id, e.status, e.summary]);
  assert.deepEqual(ended, [["b1", "stopped", "stopped by owner"], ["b2", "completed", "all green"]]);
  assert.deepEqual(events.filter((e) => e.type === "tasks").at(-1), { type: "tasks", tasks: [] });
});

test("on: Stop ends the turn but not the background task", async () => {
  const fake = fakeClaude();
  const agent = createClaudeProvider({ apiKey: "sk-ant-api-test", queryImpl: fake.queryImpl }).create(fullOwner({ backgroundTasks: true }));
  await (await agent.send("bg b1")).wait();
  const run = await agent.send("یک کار دیگر");
  await run.cancel();
  await run.wait();
  assert.equal(fake.processes[0].exited, false);
  assert.deepEqual(agent.backgroundTasks().map((t) => t.id), ["b1"]);
  agent.close();
});

test("on: close() (archive, delete, shutdown) ends the process and reports the tasks it took", async () => {
  const fake = fakeClaude();
  const events = [];
  const agent = createClaudeProvider({ apiKey: "sk-ant-api-test", queryImpl: fake.queryImpl }).create(fullOwner({ backgroundTasks: true }));
  agent.setBackgroundListener((event) => events.push(event));
  await (await agent.send("bg b1")).wait();
  agent.close();
  await until(() => fake.processes[0].exited);
  await until(() => events.some((e) => e.type === "lost"));
  assert.deepEqual(events.find((e) => e.type === "lost").tasks.map((t) => t.id), ["b1"]);
  assert.deepEqual(agent.backgroundTasks(), []);
});

test("off (default): one process per turn, as before; no tasks are kept", async () => {
  const fake = fakeClaude();
  const agent = createClaudeProvider({ apiKey: "sk-ant-api-test", queryImpl: fake.queryImpl }).create(fullOwner());
  await (await agent.send("bg b1")).wait();
  await until(() => fake.processes[0].exited);
  assert.equal(fake.processes[0].options.perTaskStopAffordance, undefined);
  await (await agent.send("ادامه")).wait();
  assert.equal(fake.processes.length, 2);
  assert.deepEqual(agent.backgroundTasks(), []);
  assert.equal(await agent.stopTask("b1"), false);
});

test("on, but not full Claude Code (a colleague's chat): the setting does nothing", async () => {
  const fake = fakeClaude();
  const agent = createClaudeProvider({ apiKey: "sk-ant-api-test", queryImpl: fake.queryImpl }).create({ cwd: "/tmp", backgroundTasks: true });
  await (await agent.send("bg b1")).wait();
  await until(() => fake.processes[0].exited);
  await (await agent.send("ادامه")).wait();
  assert.equal(fake.processes.length, 2);
});

// The runner side: the chat lists its tasks, stops one, says when one ends, stops them all when the
// chat is archived or deleted, and a restart says which ones it ended.
function runnerWith({ on = true, dir = fs.mkdtempSync(path.join(os.tmpdir(), "griffin-bg-")) } = {}) {
  const store = openStore(path.join(dir, "db.sqlite"));
  const fake = fakeClaude();
  const sdk = { ...createClaudeProvider({ apiKey: "sk-ant-api-test", queryImpl: fake.queryImpl }), kind: "claude" };
  const runner = createRunner({ store, sdk, agentOptions: async () => fullOwner({ cwd: dir, ...(on ? { backgroundTasks: true } : {}) }), log: { error() {} } });
  return { store, fake, runner, dir };
}
const notes = (store, chatId) => store.eventsAfter(chatId).filter((e) => e.type === "note").map((e) => e.payload?.text ?? e.data?.text ?? JSON.parse(e.payload_json || e.data_json || "{}").text);
const finishedRuns = (store, chatId) => store.eventsAfter(chatId).filter((e) => e.type === "run.finished").length;

test("runner, on: a chat lists its background task, stops it, and says so in the chat", async () => {
  const { store, fake, runner } = runnerWith();
  const chat = store.createChat({ title: "t" });
  await runner.send(chat.id, { text: "bg b1", ownerText: true });
  await until(() => finishedRuns(store, chat.id) === 1);
  await until(() => runner.backgroundTasks(chat.id).length === 1);
  assert.deepEqual(runner.backgroundTasks(chat.id).map((t) => t.id), ["b1"]);
  assert.deepEqual(Object.keys(store.getKv(BG_TASKS_KEY)), [chat.id], "the live list is saved for a restart");
  assert.equal(await runner.stopTask(chat.id, "b1"), true);
  await until(() => runner.backgroundTasks(chat.id).length === 0);
  await until(() => notes(store, chat.id).some((t) => /متوقف شد/.test(t)));
  assert.match(notes(store, chat.id).find((t) => /متوقف شد/.test(t)), /sleep for b1.*stopped by owner/);
  assert.equal(store.getKv(BG_TASKS_KEY), null);
  await until(() => fake.processes[0].exited);
});

test("runner, on: archiving or deleting the chat stops its background tasks", async () => {
  for (const how of ["archive", "delete"]) {
    const { store, fake, runner } = runnerWith();
    const chat = store.createChat({ title: "t" });
    await runner.send(chat.id, { text: "bg b1", ownerText: true });
    await until(() => runner.backgroundTasks(chat.id).length === 1);
    if (how === "archive") store.updateChat(chat.id, { archived: true });
    else store.deleteChat(chat.id);
    await until(() => fake.processes[0].exited);
    assert.deepEqual(runner.backgroundTasks(chat.id), [], how);
    assert.equal(store.getKv(BG_TASKS_KEY), null, how);
  }
});

test("runner, on: a restart says in the chat which background tasks it ended", async () => {
  const first = runnerWith();
  const chat = first.store.createChat({ title: "t" });
  await first.runner.send(chat.id, { text: "bg b1", ownerText: true });
  await until(() => first.runner.backgroundTasks(chat.id).length === 1);
  await first.runner.shutdown({ timeoutMs: 200 });
  await until(() => first.fake.processes[0].exited);
  assert.deepEqual(Object.keys(first.store.getKv(BG_TASKS_KEY) || {}), [chat.id], "shutdown keeps the list for the next boot");
  const again = runnerWith({ dir: first.dir });
  assert.ok(notes(again.store, chat.id).some((t) => /راه‌اندازی دوباره/.test(t) && /sleep for b1/.test(t)));
  assert.equal(again.store.getKv(BG_TASKS_KEY), null, "said once");
});

test("runner, off (default): nothing is kept or listed", async () => {
  const { store, fake, runner } = runnerWith({ on: false });
  const chat = store.createChat({ title: "t" });
  await runner.send(chat.id, { text: "bg b1", ownerText: true });
  await until(() => finishedRuns(store, chat.id) === 1);
  await until(() => fake.processes[0].exited);
  assert.deepEqual(runner.backgroundTasks(chat.id), []);
  assert.equal(await runner.stopTask(chat.id, "b1"), false);
});

// Review round 1: the three blockers.
test("on: a task that ends between turns with no turn of Claude's own holds the next message only until it goes quiet", async () => {
  const fake = fakeClaude();
  const agent = createClaudeProvider({ apiKey: "sk-ant-api-test", queryImpl: fake.queryImpl }).create(fullOwner({ backgroundTasks: true, cliTurnQuietMs: 200 }));
  await (await agent.send("bg b1")).wait();
  await (await agent.send("bg b2")).wait();
  await agent.stopTask("b1");
  await until(() => agent.backgroundTasks().length === 1);
  const next = await agent.send("next");
  const result = await Promise.race([next.wait(), new Promise((resolve) => setTimeout(() => resolve("stuck"), 1_000))]);
  assert.equal(result.status, "finished");
  agent.close();
});

test("on: Stop after the turn is over leaves the kept process and its tasks alone", async () => {
  const fake = fakeClaude();
  const agent = createClaudeProvider({ apiKey: "sk-ant-api-test", queryImpl: fake.queryImpl }).create(fullOwner({ backgroundTasks: true }));
  const run = await agent.send("bg b1");
  await run.wait();
  await run.cancel();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(fake.processes[0].exited, false);
  assert.deepEqual(agent.backgroundTasks().map((t) => t.id), ["b1"]);
  agent.close();
});

test("on: a send with another model or mode is not answered by the kept process on the old settings", async () => {
  const fake = fakeClaude();
  const agent = createClaudeProvider({ apiKey: "sk-ant-api-test", queryImpl: fake.queryImpl }).create(fullOwner({ backgroundTasks: true, idleCloseMs: 5_000 }));
  await (await agent.send("سلام", { model: { id: "sonnet" } })).wait();
  await (await agent.send("ادامه", { model: { id: "opus" }, mode: "plan" })).wait();
  assert.equal(fake.processes.length, 2, "no task ran: a fresh process with the new settings");
  assert.equal(fake.processes[1].options.model, "claude-opus-5-5");
  assert.equal(fake.processes[1].options.permissionMode, "plan");
  agent.close();
});

test("on: a result that answers another message (Claude's own turn) does not finish the owner's turn", async () => {
  const fake = fakeClaude();
  const agent = createClaudeProvider({ apiKey: "sk-ant-api-test", queryImpl: fake.queryImpl }).create(fullOwner({ backgroundTasks: true }));
  await (await agent.send("bg b1")).wait();
  const p = fake.processes[0];
  // Claude's own turn for the finished task and the owner's next message cross.
  p.finishTask("b1");
  p.emit({ type: "result", subtype: "success", is_error: false, result: "own turn", user_message_uuid: "someone-else", session_id: p.id });
  const run = await agent.send("next");
  const result = await run.wait();
  assert.equal(result.status, "finished");
  agent.close();
});

// Review round 2.
test("on, a task running: another mode is switched just before that message goes in", async () => {
  const fake = fakeClaude();
  const agent = createClaudeProvider({ apiKey: "sk-ant-api-test", queryImpl: fake.queryImpl }).create(fullOwner({ backgroundTasks: true }));
  await (await agent.send("bg b1")).wait();
  const result = await (await agent.send("plan this", { mode: "plan" })).wait();
  assert.equal(result.status, "finished");
  assert.equal(fake.processes.length, 1, "the task's process is kept");
  assert.deepEqual(fake.processes[0].switches, ["mode:plan"]);
  agent.close();
});

test("on: after a task ends between turns, the next message waits for Claude's own turn to finish", async () => {
  const fake = fakeClaude();
  const agent = createClaudeProvider({ apiKey: "sk-ant-api-test", queryImpl: fake.queryImpl }).create(fullOwner({ backgroundTasks: true, cliTurnQuietMs: 5_000 }));
  await (await agent.send("bg b1")).wait();
  const p = fake.processes[0];
  p.finishTask("b1");
  await until(() => agent.backgroundTasks().length === 0);
  const run = await agent.send("next");
  let done = false;
  run.wait().then(() => (done = true));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(done, false, "held while Claude answers the finished task");
  p.emit({ type: "assistant", message: { content: [{ type: "text", text: "the task is done" }] }, session_id: p.id });
  p.emit({ type: "result", subtype: "success", is_error: false, result: "the task is done", session_id: p.id });
  const result = await run.wait();
  assert.equal(result.status, "finished");
  agent.close();
});

// Review round 3.
test("on: queued messages each run on their own mode, whatever was queued before them", async () => {
  const fake = fakeClaude();
  const agent = createClaudeProvider({ apiKey: "sk-ant-api-test", queryImpl: fake.queryImpl }).create(fullOwner({ backgroundTasks: true }));
  await (await agent.send("bg b1", { mode: "plan" })).wait();
  const a = await agent.send("A");
  const b = await agent.send("B", { mode: "plan" });
  await a.wait();
  await b.wait();
  assert.deepEqual(fake.processes[0].switches, ["mode:bypassPermissions", "mode:plan"]);
  agent.close();
});

// Config CLAUDE_STEER: a message sent mid-run goes into the running turn.
const steerOwner = (extra = {}) => fullOwner({ backgroundTasks: true, steer: true, ...extra });

test("steer on: a mid-run message goes into the running turn, and the turn ends at the answer to both", async () => {
  const fake = fakeClaude();
  const agent = createClaudeProvider({ apiKey: "sk-ant-api-test", queryImpl: fake.queryImpl }).create(steerOwner());
  const run = await agent.send("hold A");
  await until(() => fake.processes[0]?.holding);
  assert.equal(await run.steer("also B"), "complete_delivered");
  await until(() => fake.processes[0].seen.includes("also B"));
  let done = false;
  run.wait().then(() => (done = true));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(done, false);
  fake.processes[0].release();
  assert.equal((await run.wait()).status, "finished");
  assert.equal(fake.processes.length, 1);
  agent.close();
});

test("steer on: when Claude answers the steered message in a turn right after, the owner's turn waits for it", async () => {
  const fake = fakeClaude();
  const deltas = [];
  const agent = createClaudeProvider({ apiKey: "sk-ant-api-test", queryImpl: fake.queryImpl }).create(steerOwner());
  const run = await agent.send("hold A", { onDelta: ({ update }) => deltas.push(update) });
  await until(() => fake.processes[0]?.holding);
  assert.equal(await run.steer("also B"), "complete_delivered");
  await until(() => fake.processes[0].seen.includes("also B"));
  fake.processes[0].release({ split: true });
  assert.equal((await run.wait()).status, "finished");
  assert.ok(JSON.stringify(deltas).includes("second"), "the answer to the steered message reaches the owner's turn");
  agent.close();
});

test("steer on: after the turn is over, a message falls back to the queue", async () => {
  const fake = fakeClaude();
  const agent = createClaudeProvider({ apiKey: "sk-ant-api-test", queryImpl: fake.queryImpl }).create(steerOwner());
  const run = await agent.send("A");
  await run.wait();
  assert.equal(await run.steer("late"), "revert_to_followup");
  agent.close();
});

test("steer off (default): a mid-run message waits for the next turn, as before", async () => {
  const fake = fakeClaude();
  const agent = createClaudeProvider({ apiKey: "sk-ant-api-test", queryImpl: fake.queryImpl }).create(fullOwner({ backgroundTasks: true }));
  const run = await agent.send("hold A");
  await until(() => fake.processes[0]?.holding);
  assert.equal(await run.steer("also B"), "revert_to_followup");
  assert.equal(fake.processes[0].seen.includes("also B"), false);
  fake.processes[0].release();
  await run.wait();
  agent.close();
});

// Review of the steer change.
test("steer on: a steer on a turn whose own message is not in yet (queued behind another) falls back to the queue", async () => {
  const fake = fakeClaude();
  const agent = createClaudeProvider({ apiKey: "sk-ant-api-test", queryImpl: fake.queryImpl }).create(steerOwner());
  const first = await agent.send("hold A");
  await until(() => fake.processes[0]?.holding);
  const second = await agent.send("B");
  assert.equal(await second.steer("too early"), "revert_to_followup");
  fake.processes[0].release();
  await first.wait();
  await second.wait();
  assert.equal(fake.processes[0].seen.includes("too early"), false);
  agent.close();
});

test("steer on: Stop after a steer ends the turn even when the steered message is never answered", async () => {
  const fake = fakeClaude();
  const agent = createClaudeProvider({ apiKey: "sk-ant-api-test", queryImpl: fake.queryImpl }).create(steerOwner());
  const run = await agent.send("hold A");
  await until(() => fake.processes[0]?.holding);
  assert.equal(await run.steer("also B"), "complete_delivered");
  await run.cancel();
  const p = fake.processes[0];
  const { uuids } = p.holding;
  p.holding = null;
  p.emit({ type: "result", subtype: "error_during_execution", is_error: true, result: "interrupted", user_message_uuid: uuids[0], session_id: p.id });
  const result = await Promise.race([run.wait(), new Promise((resolve) => setTimeout(() => resolve("stuck"), 1_000))]);
  assert.equal(result.status, "cancelled");
  agent.close();
});

// Claude Code keeps a queued message through a plain interrupt
// and runs it as its own turn, which the owner would never see.
test("steer on: Stop after a steer also cancels the steered message inside Claude Code", async () => {
  const fake = fakeClaude();
  const agent = createClaudeProvider({ apiKey: "sk-ant-api-test", queryImpl: fake.queryImpl }).create(steerOwner());
  const run = await agent.send("hold A");
  await until(() => fake.processes[0]?.holding);
  assert.equal(await run.steer("also B"), "complete_delivered");
  await run.cancel();
  assert.deepEqual(fake.processes[0].interrupts, [{ cancelQueued: true }]);
  agent.close();
});

test("steer on, nothing steered: Stop is the plain interrupt, as before", async () => {
  const fake = fakeClaude();
  const agent = createClaudeProvider({ apiKey: "sk-ant-api-test", queryImpl: fake.queryImpl }).create(steerOwner());
  const run = await agent.send("hold A");
  await until(() => fake.processes[0]?.holding);
  await run.cancel();
  assert.deepEqual(fake.processes[0].interrupts, [null]);
  agent.close();
});
