// «حذف» on a «در صف» message: runner.unqueue and DELETE /api/chats/:id/queue/:eventId.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
// Relative, not @griffin/timeline: in a worktree that name can resolve to another checkout.
import { foldEvents } from "../../../packages/timeline/src/index.mjs";
import { createApp } from "../src/app.mjs";
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

// Runs whose text has "hold" (a continue quotes it too) wait until released or cancelled; the rest
// answer "ok" at once, or fail with failWith before anything reaches the owner (only the texts
// failsOn matches, when given; errorFor(text) may name the error per run). clearStuck: a promise
// the boot's continue waits on.
function makeSdk({ failWith = null, failsOn = null, errorFor = () => null, clearStuck = null } = {}) {
  const sent = [];
  const releases = [];
  const agent = {
    agentId: "a1",
    async send(message, options) {
      const text = typeof message === "string" ? message : message.text;
      sent.push(text);
      let release;
      const gate = new Promise((r) => (release = r));
      const hold = text.includes("hold");
      if (hold) releases.push(release);
      return {
        id: `sdk-${sent.length}`,
        supports: () => true,
        async cancel() {
          release("cancelled");
        },
        async wait() {
          if (failWith && (!failsOn || failsOn.test(text))) return { status: "error", error: { message: failWith } };
          const error = errorFor(text);
          if (error) return { status: "error", error };
          if ((hold ? await gate : "finished") === "cancelled") return { status: "cancelled" };
          await options.onDelta?.({ update: { type: "text-delta", text: "ok" } });
          return { status: "finished" };
        },
      };
    },
    close() {},
  };
  return { sent, releases, sdk: { async create() { return agent; }, async resume() { return agent; }, ...(clearStuck ? { clearStuck: () => clearStuck } : {}) } };
}

const log = { error() {}, info() {} };
const users = (store, chatId) => foldEvents(store.eventsAfter(chatId)).messages.filter((m) => m.role === "user");
const stateOf = (store, chatId, text) => users(store, chatId).find((m) => m.text === text)?.queueState || null;
const idOf = (store, chatId, text) => Number(users(store, chatId).find((m) => m.text === text).id.slice(1));

test("a queued message leaves the run's queue and its runq copy; the rest still runs; the route 404s once it is not waiting", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "griffin-unqueue-"));
  const store = openStore(path.join(dir, "db.sqlite"));
  const { sent, releases, sdk } = makeSdk();
  const runner = createRunner({ store, sdk, agentOptions: async () => ({}), log });
  const app = createApp({ store, runner });
  const chat = store.createChat({ title: "t" });

  await runner.send(chat.id, { text: "hold first" });
  await until(() => sent.length === 1);
  await runner.send(chat.id, { text: "دوم", intent: "queue" });
  await runner.send(chat.id, { text: "سوم", intent: "queue" });
  assert.equal(stateOf(store, chat.id, "دوم"), null, "waiting: no queueState yet");

  const del = (text) => app.request(`/api/chats/${chat.id}/queue/${idOf(store, chat.id, text)}`, { method: "DELETE" });
  assert.equal((await del("دوم")).status, 200);
  assert.equal(stateOf(store, chat.id, "دوم"), "removed", "the owner took it back: off the thread, not «اجرا نشد»");
  assert.equal(stateOf(store, chat.id, "سوم"), null);
  assert.deepEqual(store.getKv(`runq:${chat.id}`).queue.map((q) => q.message), ["سوم"], "gone from disk too");
  assert.equal((await del("دوم")).status, 404, "not waiting any more");
  assert.equal(runner.unqueue(chat.id, idOf(store, chat.id, "hold first")), false, "the turn in flight stays");

  releases[0]("finished");
  await until(() => sent.length === 2 && !runner.isActive(chat.id));
  assert.equal(sent[1], "سوم", "only what still waited ran");
  assert.equal(stateOf(store, chat.id, "سوم"), "started");
  assert.equal((await del("سوم")).status, 404);
  assert.ok(!store.priorTurns(chat.id).some((t) => t.content === "دوم"), "a reseeded session never sees it");
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a queued message stops waiting as soon as the engine has its turn, before any text", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "griffin-unqueue-"));
  const store = openStore(path.join(dir, "db.sqlite"));
  const { sent, releases, sdk } = makeSdk();
  const runner = createRunner({ store, sdk, agentOptions: async () => ({}), log });
  const chat = store.createChat({ title: "t" });
  await runner.send(chat.id, { text: "hold first" });
  await until(() => sent.length === 1);
  await runner.send(chat.id, { text: "hold next", intent: "queue" });
  releases[0]("finished");
  await until(() => sent.length === 2 && store.getKv(`runq:${chat.id}`)?.turn?.ids?.length === 0);
  assert.equal(stateOf(store, chat.id, "hold next"), "started", "the agent is on it (thinking, no text yet)");
  assert.equal(runner.unqueue(chat.id, idOf(store, chat.id, "hold next")), false);
  releases[1]("finished");
  await until(() => !runner.isActive(chat.id));
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a message waiting behind kept messages leaves the kept FIFO", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "griffin-unqueue-"));
  const store = openStore(path.join(dir, "db.sqlite"));
  const failing = makeSdk({ failWith: "429" });
  const runner = createRunner({ store, sdk: failing.sdk, agentOptions: async () => ({}), log });
  const chat = store.createChat({ title: "t" });
  await runner.send(chat.id, { text: "اول" });
  await until(() => !runner.isActive(chat.id) && (store.getKv(`kept:${chat.id}`) || []).length === 1);
  await runner.send(chat.id, { text: "دوم" });
  await until(() => !runner.isActive(chat.id) && failing.sent.length === 2);
  assert.equal(stateOf(store, chat.id, "دوم"), null);
  assert.equal(runner.unqueue(chat.id, idOf(store, chat.id, "دوم")), true);
  assert.deepEqual(store.getKv(`kept:${chat.id}`).map((k) => k.message), ["اول"]);
  assert.equal(stateOf(store, chat.id, "دوم"), "removed");
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("across a restart a queued message stays listed (runq) and can still be dropped before it runs", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "griffin-unqueue-"));
  const file = path.join(dir, "db.sqlite");
  const store = openStore(file);
  const first = makeSdk();
  const runner = createRunner({ store, sdk: first.sdk, agentOptions: async () => ({}), log });
  const chat = store.createChat({ title: "t" });
  await runner.send(chat.id, { text: "hold deploy work" });
  await until(() => first.sent.length === 1);
  await runner.send(chat.id, { text: "بعدی", intent: "queue" });
  await runner.shutdown({ timeoutMs: 1000 });
  // Sent while stopping, with no turn left: it waits in runq alone.
  await runner.send(chat.id, { text: "در توقف" });
  assert.equal(runner.unqueue(chat.id, idOf(store, chat.id, "در توقف")), true);
  assert.deepEqual(store.getKv(`runq:${chat.id}`).queue.map((q) => q.message), ["بعدی"]);
  store.close();

  const reopened = openStore(file);
  const second = makeSdk();
  const booted = createRunner({ store: reopened, sdk: second.sdk, agentOptions: async () => ({}), log, resumeGapMs: 0 });
  await until(() => second.sent.length === 1 && booted.isActive(chat.id)); // the continue holds
  assert.equal(stateOf(reopened, chat.id, "بعدی"), null, "still listed as waiting after the boot");
  assert.equal(booted.unqueue(chat.id, idOf(reopened, chat.id, "بعدی")), true);
  second.releases[0]("finished");
  await until(() => !booted.isActive(chat.id));
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(second.sent.length, 1, "the dropped message never ran");
  assert.equal(stateOf(reopened, chat.id, "بعدی"), "removed");
  assert.equal(stateOf(reopened, chat.id, "در توقف"), "removed");
  assert.equal(reopened.getKv(`runq:${chat.id}`), null);
  reopened.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a queued turn the engine accepted and then failed silently: the kept copy still carries its message", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "griffin-unqueue-"));
  const store = openStore(path.join(dir, "db.sqlite"));
  const { sent, releases, sdk } = makeSdk({ failWith: "429", failsOn: /^Q$/ });
  const runner = createRunner({ store, sdk, agentOptions: async () => ({}), log });
  const chat = store.createChat({ title: "t" });
  await runner.send(chat.id, { text: "hold first" });
  await until(() => sent.length === 1);
  await runner.send(chat.id, { text: "Q", intent: "queue" });
  releases[0]("finished");
  await until(() => sent.length === 2 && !runner.isActive(chat.id));
  const [item] = store.getKv(`kept:${chat.id}`);
  assert.deepEqual(item.ids, [idOf(store, chat.id, "Q")], "reached() at accept must not empty the kept copy's ids");
  assert.equal(runner.dropKept(chat.id, item.id), true);
  assert.equal(stateOf(store, chat.id, "Q"), "dropped", "«حل شد»: shown as «اجرا نشد»");
  assert.ok(!store.priorTurns(chat.id).some((t) => t.content === "Q"), "a reseeded session never sees it");
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the same, when the turn first moved engines on a plan limit and the fallback failed silently", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "griffin-unqueue-"));
  const store = openStore(path.join(dir, "db.sqlite"));
  const errors = [{ code: "plan_limit", message: "limit" }, { message: "429" }];
  const { sent, releases, sdk } = makeSdk({ errorFor: (text) => (text === "Q" ? errors.shift() : null) });
  const runner = createRunner({ store, sdk, agentOptions: async () => ({}), onPlanLimit: () => true, log });
  const chat = store.createChat({ title: "t" });
  await runner.send(chat.id, { text: "hold first" });
  await until(() => sent.length === 1);
  await runner.send(chat.id, { text: "Q", intent: "queue" });
  releases[0]("finished");
  await until(() => sent.length === 3 && !runner.isActive(chat.id));
  assert.deepEqual(store.getKv(`kept:${chat.id}`).map((k) => k.ids), [[idOf(store, chat.id, "Q")]]);
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("«حذف» on a queued message merged with others into a kept message: 409 merged, not a false 404", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "griffin-unqueue-"));
  const store = openStore(path.join(dir, "db.sqlite"));
  // "hold A" fails once before any output, then goes through; its retry holds until released.
  let failed = false;
  const sent = [];
  const releases = [];
  const agent = {
    agentId: "a1",
    async send(message, options) {
      const text = typeof message === "string" ? message : message.text;
      sent.push(text);
      let release;
      const gate = new Promise((r) => (release = r));
      if (text.startsWith("hold")) releases.push(release);
      return {
        id: `s${sent.length}`,
        supports: () => true,
        async cancel() { release(); },
        async wait() {
          if (text.startsWith("hold")) await gate;
          if (text === "hold A" && !failed) return (failed = true), { status: "error", error: { message: "429" } };
          await options.onDelta?.({ update: { type: "text-delta", text: "ok" } });
          return { status: "finished" };
        },
      };
    },
    close() {},
  };
  const runner = createRunner({ store, sdk: { async create() { return agent; }, async resume() { return agent; } }, agentOptions: async () => ({}), log });
  const app = createApp({ store, runner });
  const chat = store.createChat({ title: "t" });
  await runner.send(chat.id, { text: "hold A" });
  await until(() => sent.length === 1);
  await runner.send(chat.id, { text: "B", intent: "queue" });
  await runner.send(chat.id, { text: "C", intent: "queue" });
  releases[0]();
  await until(() => sent.length === 2 && runner.isActive(chat.id)); // A's retry; B+C kept, merged
  assert.deepEqual(store.getKv(`kept:${chat.id}`).at(-1).message, "B\n\nC");
  const res = await app.request(`/api/chats/${chat.id}/queue/${idOf(store, chat.id, "B")}`, { method: "DELETE" });
  assert.equal(res.status, 409);
  assert.deepEqual(await res.json(), { error: "merged" });
  assert.throws(() => runner.unqueue(chat.id, idOf(store, chat.id, "C")), { code: "merged" });
  releases[1]();
  await until(() => !runner.isActive(chat.id) && sent.length === 3);
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a message taken back while the boot's continue clears a stuck run does not run", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "griffin-unqueue-"));
  const file = path.join(dir, "db.sqlite");
  const store = openStore(file);
  const first = makeSdk();
  const runner = createRunner({ store, sdk: first.sdk, agentOptions: async () => ({}), log });
  const chat = store.createChat({ title: "t" });
  await runner.send(chat.id, { text: "hold deploy work" });
  await until(() => first.sent.length === 1);
  await runner.send(chat.id, { text: "بعدی", intent: "queue" });
  await runner.shutdown({ timeoutMs: 1000 });
  store.close();

  const reopened = openStore(file);
  let free;
  const second = makeSdk({ clearStuck: new Promise((r) => (free = r)) });
  const booted = createRunner({ store: reopened, sdk: second.sdk, agentOptions: async () => ({}), log, resumeGapMs: 0 });
  await new Promise((r) => setTimeout(r, 30)); // resumeOne waits on clearStuck
  assert.equal(booted.unqueue(chat.id, idOf(reopened, chat.id, "بعدی")), true);
  free();
  await until(() => second.sent.length === 1);
  second.releases[0]("finished");
  await until(() => !booted.isActive(chat.id));
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(second.sent.length, 1, "only the continue ran");
  assert.equal(stateOf(reopened, chat.id, "بعدی"), "removed");
  reopened.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a Stop the engine never confirms (forced local finalize) drops the turn's queued message", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "griffin-unqueue-"));
  const store = openStore(path.join(dir, "db.sqlite"));
  const sent = [];
  const releases = [];
  const agent = {
    agentId: "a1",
    async send(message, options) {
      const text = typeof message === "string" ? message : message.text;
      sent.push(text);
      if (text === "Q") return new Promise(() => {}); // wedged: send never returns
      let release;
      const gate = new Promise((r) => (release = r));
      releases.push(release);
      return { id: "s1", supports: () => true, async cancel() { release(); }, async wait() { await gate; await options.onDelta?.({ update: { type: "text-delta", text: "ok" } }); return { status: "finished" }; } };
    },
    close() {},
  };
  const runner = createRunner({ store, sdk: { async create() { return agent; }, async resume() { return agent; } }, agentOptions: async () => ({}), log });
  const chat = store.createChat({ title: "t" });
  await runner.send(chat.id, { text: "first" });
  await until(() => sent.length === 1);
  await runner.send(chat.id, { text: "Q", intent: "queue" });
  releases[0]();
  await until(() => sent.length === 2);
  await runner.cancel(chat.id);
  await new Promise((r) => setTimeout(r, 10));
  await runner.sweepStale({ forceMs: 0 });
  assert.equal(runner.isActive(chat.id), false);
  assert.equal(stateOf(store, chat.id, "Q"), "dropped", "not listed «در صف» forever");
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
