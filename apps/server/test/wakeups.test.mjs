import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openStore } from "../src/db.mjs";
import { createRunner, WAKEUPS_KEY, lostWakeupsPrompt } from "../src/runner.mjs";
import { createClaudeProvider } from "../src/providers/claude.mjs";

// 2026-10-19/20 (owner's install and a colleague's): a «check CI in 4 minutes» ScheduleWakeup never
// fired. Wake-ups live in the Claude Code process, and a kept process was closed 3 s after its last
// turn. The Stop hook says which wake-ups the session holds; the process stays open for them.

const until = async (cond, ms = 2_000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

// A fake Claude Code: «wake …» ends its turn with a wake-up the Stop hook reports; «done» with none.
function fakeClaude() {
  const processes = [];
  const queryImpl = ({ prompt, options }) => {
    const id = options.resume || options.sessionId;
    const proc = { id, exited: false, pending: [], wake: null, options };
    const emit = (msg) => {
      proc.pending.push(msg);
      proc.wake?.();
    };
    proc.emit = emit;
    processes.push(proc);
    let n = 0;
    const stop = async (crons) => {
      for (const entry of options.hooks?.Stop || []) for (const hook of entry.hooks) await hook({ hook_event_name: "Stop", session_crons: crons });
    };
    proc.stop = stop;
    const textOf = (m) => m?.message?.content?.find?.((c) => c.type === "text")?.text || "";
    const turn = async (text, uuid) => {
      if (!n++) emit({ type: "system", subtype: "init", session_id: id, mcp_servers: [] });
      emit({ type: "assistant", message: { content: [{ type: "text", text: `ok: ${text}` }] }, session_id: id });
      await stop(/^wake/.test(text) ? [{ id: "c1", schedule: "*/4 * * * *", recurring: false, prompt: "pipeline را چک کن" }] : []);
      emit({ type: "result", subtype: "success", is_error: false, result: `ok: ${text}`, user_message_uuid: uuid, session_id: id });
    };
    const iter = (async function* () {
      let inputDone = false;
      (async () => {
        for await (const m of prompt) await turn(textOf(m), m?.uuid || null);
        inputDone = true;
        proc.wake?.();
      })();
      options.abortController?.signal.addEventListener("abort", () => proc.wake?.());
      try {
        for (;;) {
          while (proc.pending.length) yield proc.pending.shift();
          if (options.abortController?.signal.aborted || inputDone) return;
          await new Promise((resolve) => (proc.wake = resolve));
          proc.wake = null;
        }
      } finally {
        proc.exited = true;
      }
    })();
    iter.interrupt = async () => {};
    return iter;
  };
  return { queryImpl, processes };
}

const fullOwner = (extra = {}) => ({ cwd: "/tmp", fileAccess: { read: ["/tmp"], write: ["/tmp"], deny: [] }, claudeCode: true, idleCloseMs: 30, cliTurnQuietMs: 50, backgroundTasks: true, ...extra });

test("a pending wake-up keeps the session open; it closes once none is left", async () => {
  const fake = fakeClaude();
  const agent = createClaudeProvider({ apiKey: "sk-ant-api-test", queryImpl: fake.queryImpl }).create(fullOwner());
  const events = [];
  agent.setBackgroundListener((event) => void events.push(event));
  await (await agent.send("wake me")).wait();
  await new Promise((resolve) => setTimeout(resolve, 150)); // well past the idle close
  assert.equal(fake.processes[0].exited, false, "kept for its wake-up");
  assert.deepEqual(agent.wakeups().map((c) => c.prompt), ["pipeline را چک کن"]);
  assert.ok(events.some((e) => e.type === "crons" && e.crons.length === 1));
  await (await agent.send("done")).wait();
  await until(() => fake.processes[0].exited);
  assert.deepEqual(agent.wakeups(), []);
});

test("past the keep window a wake-up no longer holds the session, and its loss is said", async () => {
  const fake = fakeClaude();
  const agent = createClaudeProvider({ apiKey: "sk-ant-api-test", queryImpl: fake.queryImpl }).create(fullOwner({ wakeupKeepMs: 60 }));
  const events = [];
  agent.setBackgroundListener((event) => void events.push(event));
  await (await agent.send("wake me")).wait();
  await until(() => fake.processes[0].exited, 3_000);
  assert.ok(events.some((e) => e.type === "lost-crons") === false, "the window had run out: nothing was still due");
});

test("without kept processes (the default) no Stop hook is wired", async () => {
  const fake = fakeClaude();
  const agent = createClaudeProvider({ apiKey: "sk-ant-api-test", queryImpl: fake.queryImpl }).create(fullOwner({ backgroundTasks: false }));
  await (await agent.send("wake me")).wait();
  assert.equal(fake.processes[0].options.hooks?.Stop, undefined);
  assert.deepEqual(agent.wakeups(), []);
});

test("runner: the chat lists its wake-ups, saves them for a restart, and the boot re-arms them", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "griffin-wake-"));
  const store = openStore(path.join(dir, "db.sqlite"));
  const fake = fakeClaude();
  const sdk = { ...createClaudeProvider({ apiKey: "sk-ant-api-test", queryImpl: fake.queryImpl }), kind: "claude" };
  const runner = createRunner({ store, sdk, agentOptions: async () => fullOwner({ cwd: dir }), log: { error() {}, info() {} }, resumeGapMs: 10 });
  const chat = store.createChat({ title: "t" });
  await runner.send(chat.id, { text: "wake me", ownerText: true });
  await until(() => runner.wakeups(chat.id).length === 1);
  assert.deepEqual(Object.keys(store.getKv(WAKEUPS_KEY) || {}), [chat.id]);
  await runner.shutdown({ timeoutMs: 200 });
  await until(() => fake.processes[0].exited);
  assert.deepEqual(Object.keys(store.getKv(WAKEUPS_KEY) || {}), [chat.id], "kept for the next boot");

  const fake2 = fakeClaude();
  const sdk2 = { ...createClaudeProvider({ apiKey: "sk-ant-api-test", queryImpl: fake2.queryImpl }), kind: "claude" };
  createRunner({ store, sdk: sdk2, agentOptions: async () => fullOwner({ cwd: dir }), log: { error() {}, info() {} }, resumeGapMs: 10 });
  assert.equal(store.getKv(WAKEUPS_KEY), null, "taken once");
  await until(() => store.eventsAfter(chat.id).some((e) => e.type === "user" && /بیدارباش/.test((e.data ?? e.payload)?.text || "")), 8_000);
  assert.match(lostWakeupsPrompt([{ prompt: "pipeline را چک کن", schedule: "*/4 * * * *" }]), /pipeline را چک کن/);
});
