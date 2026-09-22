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
