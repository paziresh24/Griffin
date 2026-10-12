// Queued-message labels and restart resume.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
// Relative, not @griffin/timeline: in a worktree that name can resolve to another checkout.
import { foldEvents } from "../../../packages/timeline/src/index.mjs";
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

// An engine whose runs whose text starts with "hold" wait until cancelled (or released); the rest
// answer "ok" at once. `sent` records every message that reached it.
function makeSdk({ failWith = null } = {}) {
  const sent = [];
  const releases = [];
  const agent = {
    agentId: "a1",
    async send(message, options) {
      const text = typeof message === "string" ? message : message.text;
      sent.push(text);
      let release;
      const gate = new Promise((r) => (release = r));
      const hold = text.startsWith("hold");
      if (hold) releases.push(release);
      return {
        id: `sdk-${sent.length}`,
        supports: () => true,
        async cancel() {
          release("cancelled");
        },
        async wait() {
          if (failWith) return { status: "error", error: { message: failWith } };
          const outcome = hold ? await gate : "finished";
          if (outcome === "cancelled") return { status: "cancelled" };
          await options.onDelta?.({ update: { type: "text-delta", text: "ok" } });
          return { status: "finished" };
        },
      };
    },
    close() {},
  };
  return { sent, releases, sdk: { async create() { return agent; }, async resume() { return agent; } } };
}

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "griffin-resume-"));
  const file = path.join(dir, "db.sqlite");
  return { dir, file, store: openStore(file) };
}
const log = { error() {}, info() {} };
const labels = (store, chatId) =>
  foldEvents(store.eventsAfter(chatId)).messages.filter((m) => m.role === "user").map((m) => [m.text, m.queueState || null]);

test("a queued message's label follows it: started once its turn reaches the agent, dropped by a Stop", async () => {
  const { dir, store } = setup();
  const { sent, releases, sdk } = makeSdk();
  const runner = createRunner({ store, sdk, agentOptions: async () => ({}), log });
  const chat = store.createChat({ title: "t" });

  await runner.send(chat.id, { text: "hold first" });
  await until(() => sent.length === 1);
  await runner.send(chat.id, { text: "دوم", intent: "queue" });
  assert.deepEqual(labels(store, chat.id).at(-1), ["دوم", null], "waiting while the run works");
  assert.deepEqual(store.getKv(`runq:${chat.id}`).queue.map((q) => q.message), ["دوم"], "the queue is on disk");
  releases[0]("finished");
  await until(() => sent.length === 2 && !runner.isActive(chat.id));
  assert.deepEqual(labels(store, chat.id).at(-1), ["دوم", "started"]);
  assert.equal(store.getKv(`runq:${chat.id}`), null, "nothing left once the turns end");

  await runner.send(chat.id, { text: "hold again" });
  await until(() => sent.length === 3);
  await runner.send(chat.id, { text: "سوم", intent: "queue" });
  await runner.cancel(chat.id);
  await until(() => !runner.isActive(chat.id));
  assert.deepEqual(labels(store, chat.id).at(-1), ["سوم", "dropped"]);
  assert.equal(sent.length, 3, "a Stop drops what queued behind the run");
  const seeded = store.priorTurns(chat.id).map((t) => t.content);
  assert.ok(seeded.includes("دوم") && !seeded.includes("سوم"), "a dropped message never reseeds a session");

  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a message queued behind kept messages stays waiting until its retry gets through; a delete drops it", async () => {
  const { dir, store } = setup();
  const failing = makeSdk({ failWith: "429" });
  const runner = createRunner({ store, sdk: failing.sdk, agentOptions: async () => ({}), log });
  const chat = store.createChat({ title: "t" });
  await runner.send(chat.id, { text: "اول" });
  await until(() => !runner.isActive(chat.id) && (store.getKv(`kept:${chat.id}`) || []).length === 1);
  await runner.send(chat.id, { text: "دوم" });
  await until(() => !runner.isActive(chat.id) && failing.sent.length === 2);
  assert.deepEqual(labels(store, chat.id).at(-1), ["دوم", null]);
  const kept = store.getKv(`kept:${chat.id}`);
  assert.equal(runner.dropKept(chat.id, kept[1].id), true);
  assert.deepEqual(labels(store, chat.id).at(-1), ["دوم", "dropped"]);
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a turn cut by our own stop continues after the boot, then what queued behind it runs, in order", async () => {
  const { dir, file, store } = setup();
  const first = makeSdk();
  const runner = createRunner({ store, sdk: first.sdk, agentOptions: async () => ({}), log });
  const chat = store.createChat({ title: "t" });
  await runner.send(chat.id, { text: "hold deploy work" });
  await until(() => first.sent.length === 1);
  await runner.send(chat.id, { text: "بعدی", intent: "queue" });
  await runner.shutdown({ timeoutMs: 1000 });
  assert.deepEqual(store.getKv("resume:pending"), [{ chatId: chat.id, cont: true }]);
  assert.equal(first.sent.length, 1, "nothing starts while stopping");
  const cut = store.eventsAfter(chat.id).filter((e) => e.type === "run.finished").at(-1);
  assert.equal(cut.data.status, "cancelled");
  assert.match(cut.data.error, /ادامه می‌دهد/);
  store.close();

  const reopened = openStore(file);
  const second = makeSdk();
  const booted = createRunner({ store: reopened, sdk: second.sdk, agentOptions: async () => ({}), log, resumeGapMs: 0 });
  await until(() => second.sent.length === 2 && !booted.isActive(chat.id));
  assert.match(second.sent[0], /ادامه پس از ری‌استارت/);
  assert.match(second.sent[0], /hold deploy work/, "the continue quotes the cut turn's own message");
  assert.doesNotMatch(second.sent[0], /بعدی/, "not the message still queued behind it");
  assert.equal(second.sent[1], "بعدی");
  assert.deepEqual(labels(reopened, chat.id).find(([text]) => text === "بعدی"), ["بعدی", "started"]);
  assert.equal(reopened.getKv("resume:pending"), null);
  reopened.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a crash-cut turn continues too; job chats do not", async () => {
  const { dir, file, store } = setup();
  const first = makeSdk();
  const runner = createRunner({ store, sdk: first.sdk, agentOptions: async () => ({}), log });
  const chat = store.createChat({ title: "t" });
  const job = store.createJob({ name: "j", prompt: "p", triggerType: "manual" });
  const jobChat = store.createChat({ title: "j", jobId: job.id });
  await runner.send(chat.id, { text: "hold crash work" });
  await runner.send(jobChat.id, { text: "hold job work" });
  await until(() => first.sent.length === 2);
  store.close(); // the process dies: no shutdown, the runs stay `running`

  const reopened = openStore(file);
  const second = makeSdk();
  const booted = createRunner({ store: reopened, sdk: second.sdk, agentOptions: async () => ({}), log, resumeGapMs: 0 });
  await until(() => second.sent.length === 1 && !booted.isActive(chat.id) && reopened.getKv("resume:pending") === null);
  assert.match(second.sent[0], /hold crash work/);
  assert.equal(second.sent.length, 1, "the job chat is not continued");
  reopened.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a message to the chat makes its waiting continue stale; the queue still goes first; the owner's Stop drops another", async () => {
  const { dir, file, store } = setup();
  const first = makeSdk();
  const runner = createRunner({ store, sdk: first.sdk, agentOptions: async () => ({}), log });
  const a = store.createChat({ title: "a" });
  const b = store.createChat({ title: "b" });
  const c = store.createChat({ title: "c" });
  for (const chat of [a, b, c]) await runner.send(chat.id, { text: `hold ${chat.title}` });
  await until(() => first.sent.length === 3);
  await runner.send(b.id, { text: "صف b", intent: "queue" });
  await runner.shutdown({ timeoutMs: 1000 });
  store.close();

  const reopened = openStore(file);
  const second = makeSdk();
  const booted = createRunner({ store: reopened, sdk: second.sdk, agentOptions: async () => ({}), log, resumeGapMs: 300 });
  await until(() => second.sent.length === 1); // a resumes at once; b and c wait their turn
  assert.match(second.sent[0], /hold a/);
  await booted.send(b.id, { text: "پیام تازه" });
  await booted.cancel(c.id);
  await until(() => second.sent.length === 2 && !booted.isActive(b.id));
  assert.equal(second.sent[1], "صف b\n\nپیام تازه", "the queued message goes first, in the new turn");
  assert.deepEqual(labels(reopened, b.id).find(([text]) => text === "صف b"), ["صف b", "started"]);
  await new Promise((r) => setTimeout(r, 800));
  assert.equal(second.sent.length, 2, "no stale continue for b, nothing for the stopped c");
  assert.equal(reopened.getKv("resume:pending"), null);
  reopened.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the owner's Stop during the stop wins: the turn does not continue", async () => {
  const { dir, file, store } = setup();
  const first = makeSdk();
  const runner = createRunner({ store, sdk: first.sdk, agentOptions: async () => ({}), log });
  const chat = store.createChat({ title: "t" });
  await runner.send(chat.id, { text: "hold work" });
  await until(() => first.sent.length === 1);
  const stopping = runner.shutdown({ timeoutMs: 1000 });
  await runner.cancel(chat.id);
  await stopping;
  assert.equal(store.getKv("resume:pending"), null);
  store.close();

  const reopened = openStore(file);
  const second = makeSdk();
  createRunner({ store: reopened, sdk: second.sdk, agentOptions: async () => ({}), log, resumeGapMs: 0 });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(second.sent.length, 0);
  reopened.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
