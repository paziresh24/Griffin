import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openStore } from "../src/db.mjs";
import { createRunner } from "../src/runner.mjs";

const until = async (check, ms = 2000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("timeout");
};

function makeAgent(agentId, { busyOnce = false, sends } = {}) {
  let busy = busyOnce;
  return {
    agentId,
    async send(message, options) {
      sends.push({ agentId, message });
      if (busy) {
        busy = false;
        const err = new Error(`Agent ${agentId} already has active run`);
        err.name = "AgentBusyError";
        throw err;
      }
      const run = {
        id: `sdk-${sends.length}`,
        supports: () => true,
        async cancel() {},
        async wait() {
          await options.onDelta?.({ update: { type: "text-delta", text: "ok" } });
          return { id: run.id, status: "finished" };
        },
      };
      return run;
    },
    close() {},
  };
}

test("AgentBusyError clears stuck run then retries; falls back to fresh agent", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "griffin-busy-"));
  const store = openStore(path.join(dir, "db.sqlite"));
  const sends = [];
  const cleared = [];
  let creates = 0;
  const sdk = {
    async create() {
      creates += 1;
      return makeAgent(`agent-fresh-${creates}`, { sends });
    },
    async resume(id) {
      return makeAgent(id, { busyOnce: true, sends });
    },
    async clearStuck(agentId) {
      cleared.push(agentId);
      // Still busy after clear → forces mint path on second send failure... 
      // First retry after clearStuck uses same agent without busyOnce again.
      return { cancelled: 1 };
    },
  };
  // resume returns agent that is busy once; after clearStuck, agentFor returns cached agent
  // which still has busy=false after first throw. So retry on same agent succeeds.
  const runner = createRunner({ store, sdk, agentOptions: async () => ({}), log: { error() {} } });
  const chat = store.createChat({ title: "t" });
  store.setAgentId(chat.id, "agent-old");

  const { runId } = await runner.send(chat.id, { text: "ادامه بده" });
  await until(() => store.eventsAfter(chat.id).some((e) => e.type === "run.finished" && e.runId === runId));

  assert.deepEqual(cleared, ["agent-old"]);
  assert.equal(sends.length, 2, "first send busy, second after clearStuck succeeds");
  assert.equal(creates, 0, "no fresh agent when clearStuck unblocks");
  const finished = store.eventsAfter(chat.id).filter((e) => e.type === "run.finished").at(-1);
  assert.equal(finished.data.status, "finished");

  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("AgentBusyError without successful clearStuck mints a fresh agent", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "griffin-busy2-"));
  const store = openStore(path.join(dir, "db.sqlite"));
  const sends = [];
  let creates = 0;
  const sdk = {
    async create() {
      creates += 1;
      return makeAgent(`agent-new-${creates}`, { sends });
    },
    async resume(id) {
      // Always busy — clearStuck "succeeds" but resume cache still busy on every send
      return {
        agentId: id,
        async send() {
          sends.push({ agentId: id, failed: true });
          const err = new Error(`Agent ${id} already has active run`);
          err.name = "AgentBusyError";
          throw err;
        },
        close() {},
      };
    },
    async clearStuck() {
      return { cancelled: 0 };
    },
  };
  const runner = createRunner({ store, sdk, agentOptions: async () => ({}), log: { error() {} } });
  const chat = store.createChat({ title: "t" });
  store.setAgentId(chat.id, "agent-stuck");

  const { runId } = await runner.send(chat.id, { text: "ادامه" });
  await until(() => store.eventsAfter(chat.id).some((e) => e.type === "run.finished" && e.runId === runId));

  assert.ok(creates >= 1);
  assert.equal(store.getChat(chat.id).agent_id, "agent-new-1");
  const finished = store.eventsAfter(chat.id).filter((e) => e.type === "run.finished").at(-1);
  assert.equal(finished.data.status, "finished");

  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("shutdown cancels active runs before exit", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "griffin-shutdown-"));
  const store = openStore(path.join(dir, "db.sqlite"));
  let cancelled = false;
  let release;
  const gate = new Promise((r) => (release = r));
  const sdk = {
    async create() {
      return {
        agentId: "a1",
        async send() {
          return {
            id: "r1",
            supports: () => true,
            async cancel() {
              cancelled = true;
              release();
            },
            async wait() {
              await gate;
              return { status: "cancelled" };
            },
          };
        },
        close() {},
      };
    },
    async resume() {
      throw new Error("not used");
    },
  };
  const runner = createRunner({ store, sdk, agentOptions: async () => ({}), log: {} });
  const chat = store.createChat({ title: "t" });
  await runner.send(chat.id, { text: "long" });
  await until(() => runner.isActive(chat.id));

  const result = await runner.shutdown({ timeoutMs: 2000 });
  assert.equal(cancelled, true);
  assert.equal(result.stillActive, 0);
  await until(() => !runner.isActive(chat.id));

  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("sweepStale cancels a run that produced no event for staleMs (e.g. a hung native `task` subagent call)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "griffin-stale-"));
  const store = openStore(path.join(dir, "db.sqlite"));
  let cancelCalls = 0;
  let waiting = false; // true once run.wait() has actually been entered (entry.run is set by then)
  let release;
  const gate = new Promise((r) => (release = r));
  const sdk = {
    async create() {
      return {
        agentId: "a1",
        async send() {
          return {
            id: "r1",
            supports: () => true,
            async cancel() {
              cancelCalls += 1;
              release(); // the SDK confirms the cancel — wait() can now return
            },
            async wait() {
              waiting = true;
              await gate; // hangs until cancelled, like a stuck native subagent tool call
              return { status: "cancelled" };
            },
          };
        },
        close() {},
      };
    },
    async resume() {
      throw new Error("not used");
    },
  };
  const runner = createRunner({ store, sdk, agentOptions: async () => ({}), log: {} });
  const chat = store.createChat({ title: "t" });
  await runner.send(chat.id, { text: "کار طولانی" });
  // isActive() flips true as soon as the run is registered, before the SDK handle (entry.run) is
  // attached — wait for wait() itself to start so sweepStale's cancel actually reaches the SDK.
  await until(() => waiting);

  const acted = await runner.sweepStale({ staleMs: -1 }); // -1: any elapsed time counts as stale
  assert.deepEqual(acted, [{ chatId: chat.id, action: "cancelled", minutes: acted[0]?.minutes }]);
  assert.equal(cancelCalls, 1, "the SDK run was asked to cancel");

  await until(() => !runner.isActive(chat.id));
  const events = store.eventsAfter(chat.id);
  assert.ok(events.some((e) => e.type === "run.phase" && e.data.phase === "stale"), "a stale marker was recorded");
  const finished = events.filter((e) => e.type === "run.finished").at(-1);
  assert.equal(finished.data.status, "cancelled");

  // Idle chats (no run) and freshly-active ones (an event just happened) are left alone.
  assert.deepEqual(await runner.sweepStale({ staleMs: -1 }), [], "no active run left to sweep");

  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("sweepStale finalizes the run locally when the SDK never confirms a cancel, so activeRuns cannot stay stuck forever", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "griffin-stale-force-"));
  const store = openStore(path.join(dir, "db.sqlite"));
  const sdk = {
    async create() {
      return {
        agentId: "a1",
        async send() {
          return {
            id: "r1",
            supports: () => true,
            async cancel() {
              /* accepted, but the underlying connection is wedged: wait() never returns */
            },
            async wait() {
              return new Promise(() => {}); // never settles
            },
          };
        },
        close() {},
      };
    },
    async resume() {
      throw new Error("not used");
    },
  };
  const cancelled = [];
  const runner = createRunner({ store, sdk, agentOptions: async () => ({}), onCancel: (id) => cancelled.push(id), log: {} });
  const chat = store.createChat({ title: "t" });
  await runner.send(chat.id, { text: "کار گیرکرده" });
  await until(() => runner.isActive(chat.id));

  // First pass: requests the cancel, but forceMs has not elapsed yet — still active.
  const first = await runner.sweepStale({ staleMs: -1, forceMs: 999_999 });
  assert.deepEqual(first, [{ chatId: chat.id, action: "cancelled", minutes: first[0]?.minutes }]);
  assert.equal(runner.isActive(chat.id), true, "cancel requested but the SDK never confirmed it");
  assert.deepEqual(cancelled, [chat.id]);

  // Second pass: the unconfirmed cancel is now older than forceMs — finalize locally.
  const second = await runner.sweepStale({ staleMs: -1, forceMs: -1 });
  assert.deepEqual(second, [{ chatId: chat.id, action: "forced" }]);
  assert.equal(runner.isActive(chat.id), false);
  const finished = store.eventsAfter(chat.id).filter((e) => e.type === "run.finished").at(-1);
  assert.equal(finished.data.status, "cancelled");
  assert.match(finished.data.error, /SDK جواب نداد/);
  assert.deepEqual(cancelled, [chat.id, chat.id], "onCancel runs once at the request and once at the forced finalize");

  // A third sweep must not touch the now-inactive chat again.
  assert.deepEqual(await runner.sweepStale({ staleMs: -1, forceMs: -1 }), []);

  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

// A run parked on an open question must survive the stale sweeper: the owner answers when they
// see it, minutes or hours later, and cancelling would throw away work they are about to approve.
test("sweepStale leaves a run that is waiting for an answer alone", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "griffin-stale-blocked-"));
  const store = openStore(path.join(dir, "db.sqlite"));
  const sdk = {
    async create() {
      return {
        agentId: "a1",
        async send() {
          return { id: "r1", supports: () => true, async cancel() {}, async wait() { return new Promise(() => {}); } };
        },
        close() {},
      };
    },
    async resume() {
      throw new Error("not used");
    },
  };
  let waiting = true;
  const runner = createRunner({ store, sdk, agentOptions: async () => ({}), isBlocked: () => waiting, log: {} });
  const chat = store.createChat({ title: "t" });
  await runner.send(chat.id, { text: "سؤال از Owner" });
  await until(() => runner.isActive(chat.id));

  assert.deepEqual(await runner.sweepStale({ staleMs: -1 }), [], "an open question is not staleness");
  assert.ok(runner.isActive(chat.id));

  waiting = false;
  const after = await runner.sweepStale({ staleMs: -1, forceMs: 999_999 });
  assert.equal(after[0]?.action, "cancelled", "once nothing is waiting, silence is stuck again");
  // The wedged cancel keeps writing after this point; leave the store open and just drop the dir.
  fs.rmSync(dir, { recursive: true, force: true });
});

// run.started carries the model and provider the run really uses (the UI badge showed "auto").
test("run.started is labelled with the resolved provider and model", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "griffin-label-"));
  const store = openStore(path.join(dir, "db.sqlite"));
  const sdk = {
    async create() {
      return { agentId: "a", async send() { return { id: "r", supports: () => false, async cancel() {}, wait: async () => ({ status: "finished" }) }; } };
    },
  };
  const runner = createRunner({ store, sdk, agentOptions: async () => ({}), runLabel: () => ({ provider: "openai", model: "glm-5.3-flash" }), log: {} });
  const chat = store.createChat({ title: "t", agent: "griffin" });
  await runner.send(chat.id, { text: "hi", images: [] });
  const started = store.allEvents(chat.id).find((e) => e.type === "run.started");
  assert.equal(started.data.model, "glm-5.3-flash");
  assert.equal(started.data.provider, "openai");
});

test("messages queued during a run go in as one merged turn", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "griffin-queue-"));
  const store = openStore(path.join(dir, "db.sqlite"));
  const sends = [];
  let release;
  const gate = new Promise((r) => { release = r; });
  const agent = {
    agentId: "a1",
    async send(message) {
      sends.push(message);
      const first = sends.length === 1;
      return { id: `r${sends.length}`, supports: () => true, async cancel() {}, async wait() { if (first) await gate; return { status: "finished" }; } };
    },
    close() {},
  };
  const sdk = { async create() { return agent; }, async resume() { return agent; } };
  const runner = createRunner({ store, sdk, agentOptions: async () => ({}), log: { error() {} } });
  const chat = store.createChat({ title: "t" });

  await runner.send(chat.id, { text: "اول" });
  await until(() => sends.length === 1);
  await runner.send(chat.id, { text: "دوم", intent: "queue" });
  await runner.send(chat.id, { text: "سوم", intent: "queue" });
  release();
  await until(() => sends.length === 2);
  await until(() => !runner.isActive(chat.id));
  assert.equal(sends.length, 2, "one turn for both queued messages");
  assert.equal(sends[1], "دوم\n\nسوم");

  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("plan limit: the run is retried once on the fallback provider with the same message", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "griffin-limit-"));
  const store = openStore(path.join(dir, "db.sqlite"));
  const sends = [];
  let limited = true;
  const sdk = {
    async create() {
      return {
        agentId: `a-${sends.length}`,
        async send(message) {
          sends.push(message);
          const hit = limited;
          limited = false;
          return { id: "r", supports: () => true, async cancel() {}, wait: async () => (hit ? { status: "error", error: { message: "You've hit your limit", code: "plan_limit" } } : { status: "finished" }) };
        },
      };
    },
    async resume() {
      return this.create();
    },
  };
  const calls = [];
  const runner = createRunner({ store, sdk, agentOptions: () => ({}), log: {}, onPlanLimit: (chat) => (calls.push(chat.id), true) });
  try {
    const chat = store.createChat({ title: "t" });
    await runner.send(chat.id, { text: "سلام", images: [] });
    await until(() => store.listRuns?.(chat.id)?.length === 2 || sends.length === 2);
    await until(() => !store.runningRuns().length);
    assert.deepEqual(sends.map((m) => (typeof m === "string" ? m : m.text)), ["سلام", "سلام"]);
    assert.equal(calls.length, 1);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// 2026-10-10: a colleague thread died on every message — Claude resumes lazily, so a session it no
// longer has fails at send ("No conversation found"). The runner retries once on a fresh session.
test("a session lost at send time is retried once on a fresh one", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "griffin-gone-"));
  const store = openStore(path.join(dir, "db.sqlite"));
  const sends = [];
  const made = [];
  const agent = (agentId) => ({
    agentId,
    async send(message) {
      sends.push(agentId);
      const gone = agentId === "stale";
      return { id: "r", supports: () => true, async cancel() {}, wait: async () => (gone ? { status: "error", error: { message: "No conversation found with session ID: stale", code: "agent_not_found" } } : { status: "finished" }) };
    },
  });
  const sdk = {
    async create() { made.push("new"); return agent("fresh"); },
    async resume(id) { return agent(id); },
  };
  const runner = createRunner({ store, sdk, agentOptions: () => ({}), log: {} });
  try {
    const chat = store.createChat({ title: "t" });
    store.setAgentId(chat.id, "stale");
    await runner.send(chat.id, { text: "سلام", images: [] });
    await until(() => sends.length === 2);
    await until(() => !store.runningRuns().length);
    assert.deepEqual(sends, ["stale", "fresh"]);
    assert.equal(store.getChat(chat.id).agent_id, "fresh");
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// 2026-10-11: a colleague thread routed GLM → Claude kept its agent_id; the runner returned the cached
// GLM agent and Z.ai answered "Unknown Model" for "opus". A cached agent belongs to one provider.
test("a chat whose provider changed does not reuse the other provider's cached agent", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "griffin-switch-"));
  const store = openStore(path.join(dir, "db.sqlite"));
  const sends = [];
  const engine = (id) => ({
    id,
    async create() { return { agentId: "same", async send() { sends.push(id); return { id: "r", supports: () => true, async cancel() {}, wait: async () => ({ status: "finished" }) }; } }; },
    async resume() { return this.create(); },
  });
  const engines = { openai: engine("openai"), claude: engine("claude") };
  let current = "openai";
  const runner = createRunner({ store, providerFor: () => engines[current], agentOptions: () => ({}), log: {} });
  try {
    const chat = store.createChat({ title: "t" });
    await runner.send(chat.id, { text: "a", images: [] });
    await until(() => !store.runningRuns().length && sends.length === 1);
    current = "claude";
    await runner.send(chat.id, { text: "b", images: [] });
    await until(() => !store.runningRuns().length && sends.length === 2);
    assert.deepEqual(sends, ["openai", "claude"]);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// 2026-10-13: a new Claude key was saved (the provider rebuilt), yet chats that had run once kept
// failing with «Invalid API key» — their cached agent still carried the old key.
test("a rebuilt provider (a new key) is used even where an agent was cached", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "griffin-rekey-"));
  const store = openStore(path.join(dir, "db.sqlite"));
  const sends = [];
  const engine = (key) => ({
    id: "claude",
    async create() { return { agentId: "same", async send() { sends.push(key); return { id: "r", supports: () => true, async cancel() {}, wait: async () => ({ status: "finished" }) }; } }; },
    async resume() { return this.create(); },
  });
  let provider = engine("old-key");
  const runner = createRunner({ store, providerFor: () => provider, agentOptions: () => ({}), log: {} });
  try {
    const chat = store.createChat({ title: "t" });
    await runner.send(chat.id, { text: "a", images: [] });
    await until(() => !store.runningRuns().length && sends.length === 1);
    provider = engine("new-key");
    await runner.send(chat.id, { text: "b", images: [] });
    await until(() => !store.runningRuns().length && sends.length === 2);
    assert.deepEqual(sends, ["old-key", "new-key"]);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("kept messages: a run that fails before anything reached the owner keeps the message; FIFO, retry, delete", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "griffin-kept-"));
  const store = openStore(path.join(dir, "db.sqlite"));
  const sent = [];
  let failing = true;
  const sdk = {
    async create() {
      return {
        agentId: "a1",
        async send(message, options) {
          sent.push(typeof message === "string" ? message : message.text);
          return {
            id: `sdk-${sent.length}`,
            supports: () => true,
            async cancel() {},
            async wait() {
              if (failing) return { status: "error", error: { message: "429 rate limit" } };
              await options.onDelta?.({ update: { type: "text-delta", text: "ok" } });
              return { status: "finished" };
            },
          };
        },
        close() {},
      };
    },
  };
  const runner = createRunner({ store, sdk, agentOptions: async () => ({}), log: { error() {}, info() {} } });
  const chat = store.createChat({ title: "t" });
  const finished = () => store.eventsAfter(chat.id).filter((e) => e.type === "run.finished");
  const kept = () => store.getKv(`kept:${chat.id}`) || [];

  await runner.send(chat.id, { text: "اول" });
  await until(() => finished().length === 1 && !runner.isActive(chat.id));
  assert.equal(finished()[0].data.undelivered, true);
  assert.deepEqual(kept().map((k) => k.message), ["اول"]);

  // A newer message does not jump it: the kept one is retried first, both stay kept on failure.
  await runner.send(chat.id, { text: "دوم" });
  await until(() => finished().length === 2 && !runner.isActive(chat.id));
  assert.deepEqual(sent, ["اول", "اول"]);
  assert.deepEqual(kept().map((k) => [k.message, k.fails]), [["اول", 1], ["دوم", 0]]);

  // «ارسال دوباره» gets through: the head is delivered and the next kept message follows by itself.
  failing = false;
  runner.retry(chat.id);
  await until(() => finished().length === 4 && !runner.isActive(chat.id));
  assert.deepEqual(sent.slice(2), ["اول", "دوم"]);
  assert.deepEqual(kept(), []);

  // «حذف» drops a kept message by id without sending it.
  failing = true;
  await runner.send(chat.id, { text: "سوم" });
  await until(() => finished().length === 5 && !runner.isActive(chat.id));
  assert.equal(runner.dropKept(chat.id, kept()[0].id), true);
  assert.deepEqual(kept(), []);
});
