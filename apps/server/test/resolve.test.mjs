import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp } from "../src/app.mjs";
import { createAsks } from "../src/asks.mjs";
import { createRunner } from "../src/runner.mjs";
import { openStore } from "../src/db.mjs";
import { buildInbox } from "../src/inbox.mjs";

function setup({ active = false } = {}) {
  const store = openStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "griffin-resolve-")), "db.sqlite"));
  const asks = createAsks({ store, log: {} });
  const sent = [];
  const retried = [];
  const runner = {
    isActive: () => active,
    activeCount: () => 0,
    send: async (chatId, input) => (sent.push({ chatId, ...input }), { runId: "r", delivered: "run" }),
    retry: (id) => (store.getKv(`kept:${id}`)?.length ? (retried.push(id), { runId: "r", delivered: "retry" }) : { status: "nothing-kept" }),
    dropKept: (id, k) => (store.setKv(`kept:${id}`, (store.getKv(`kept:${id}`) || []).filter((item) => item.id !== k)), true),
    cancelLimitResume: () => {},
  };
  const app = createApp({ store, runner, asks });
  return { store, asks, app, sent, retried };
}
const tick = () => new Promise((r) => setTimeout(r, 5));
const post = (app, url) => app.request(url, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
const chats = async (app) => (await (await app.request("/api/chats")).json()).chats;
const failRun = (store, chatId, error = "boom") => store.finishRun(chatId, store.startRun(chatId), "error", error);

test("«حل شد»: an errored chat stops reading as an error, its kept message and failed card go — until the next run", async () => {
  const { store, asks, app } = setup();
  const a = store.createChat({ title: "خطادار" });
  failRun(store, a.id);
  store.setKv(`kept:${a.id}`, [{ id: "k1", message: { text: "x" }, fails: 0 }]);
  store.setKv("tgwaiting", [{ id: "w", kind: "failed", personId: "p", chatId: a.id, name: "n", text: "t", at: "2026-10-13T10:00:00.000Z" }]);
  store.setKv("tgstate:p", { state: "failed", line: "x", at: "2026-10-13T10:00:00.000Z" });
  assert.equal((await chats(app)).find((c) => c.id === a.id).runStatus, "error");

  await tick(); // the resolve is strictly later than the run's start
  assert.equal((await post(app, `/api/chats/${a.id}/resolve`)).status, 200);
  assert.equal((await chats(app)).find((c) => c.id === a.id).runStatus, "resolved");
  assert.ok(!store.getKv(`kept:${a.id}`)?.length);
  assert.ok(!(store.getKv("tgwaiting") || []).some((w) => w.chatId === a.id));
  assert.equal(store.getKv("tgstate:p").state, "no_reply");
  assert.ok(!buildInbox({ store, asks }).items.some((i) => i.kind === "kept" && i.chatId === a.id));

  await tick();
  failRun(store, a.id, "again");
  assert.equal((await chats(app)).find((c) => c.id === a.id).runStatus, "error", "a later run shows its own failure");
});

test("«حل شد» reaches a sub-agent's status in its parent's children", async () => {
  const { store, app } = setup();
  const parent = store.createChat({ title: "والد" });
  const child = store.createChat({ title: "زیرکار", parentChatId: parent.id, caller: "griffin", agent: "platform" });
  failRun(store, child.id);
  const childOf = async () => (await chats(app)).find((c) => c.id === parent.id).children.find((c) => c.id === child.id);
  assert.equal((await childOf()).runStatus, "error");
  await tick();
  assert.equal((await post(app, `/api/chats/${child.id}/resolve`)).status, 200);
  assert.equal((await childOf()).runStatus, "resolved");
});

test("«حل شد» while the chat runs is refused; an unknown chat is 404", async () => {
  const { store, app } = setup({ active: true });
  const a = store.createChat({ title: "در حال کار" });
  assert.equal((await post(app, `/api/chats/${a.id}/resolve`)).status, 409);
  assert.equal((await post(app, "/api/chats/nope/resolve")).status, 404);
});

test("a closed (archived) chat's kept message leaves the board", () => {
  const { store, asks } = setup();
  const a = store.createChat({ title: "بسته" });
  store.setKv(`kept:${a.id}`, [{ id: "k1", message: { text: "x" }, fails: 0 }]);
  assert.ok(buildInbox({ store, asks }).items.some((i) => i.kind === "kept" && i.chatId === a.id));
  store.updateChat(a.id, { archived: true });
  assert.ok(!buildInbox({ store, asks }).items.some((i) => i.kind === "kept" && i.chatId === a.id));
});

test("«دوباره»: kept goes again; nothing kept + failed last run continues; nothing kept + finished run does nothing", async () => {
  const { store, app, sent, retried } = setup();
  const b = store.createChat({ title: "قطع شده" });
  failRun(store, b.id, "stream stalled");
  let res = await post(app, `/api/chats/${b.id}/retry`);
  assert.equal(res.status, 202);
  assert.equal((await res.json()).delivered, "continue");
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /ادامه بده/);
  assert.match(sent[0].text, /stream stalled/);

  const c = store.createChat({ title: "نگه‌داشته" });
  failRun(store, c.id);
  store.setKv(`kept:${c.id}`, [{ id: "k1", message: { text: "x" }, fails: 0 }]);
  res = await post(app, `/api/chats/${c.id}/retry`);
  assert.equal(res.status, 202);
  assert.deepEqual(retried, [c.id]);
  assert.equal(sent.length, 1, "a kept message goes through runner.retry, not send");

  const d = store.createChat({ title: "تمام شده" });
  store.finishRun(d.id, store.startRun(d.id), "finished");
  res = await post(app, `/api/chats/${d.id}/retry`);
  assert.equal(res.status, 202);
  assert.equal((await res.json()).status, "nothing-kept");
  assert.equal(sent.length, 1);
});

test("a chat opened by id (a sub-agent, not in the list) carries its last run's status, so its error bar shows", async () => {
  const { store, app } = setup();
  const parent = store.createChat({ title: "والد" });
  const child = store.createChat({ title: "زیرکار", parentChatId: parent.id, caller: "griffin", agent: "platform" });
  const one = async () => (await (await app.request(`/api/chats/${child.id}`)).json()).chat;
  assert.equal((await one()).runStatus, null);
  failRun(store, child.id);
  assert.equal((await one()).runStatus, "error");
  assert.ok((await one()).runStartedAt);
  await tick();
  assert.equal((await post(app, `/api/chats/${child.id}/resolve`)).status, 200);
  assert.equal((await one()).runStatus, "resolved");
});

test("a kept message given up on names the buttons the owner has: «دوباره» / «حل شد» / «بستن»", async () => {
  const { store } = setup();
  const sdk = {
    async create() {
      return {
        agentId: "a1",
        async send() {
          return { id: "s", supports: () => true, async cancel() {}, async wait() { return { status: "error", error: { message: "429" } }; } };
        },
        close() {},
      };
    },
  };
  const runner = createRunner({ store, sdk, agentOptions: async () => ({}), log: { error() {}, info() {} } });
  const chat = store.createChat({ title: "t" });
  const finished = () => store.eventsAfter(chat.id).filter((e) => e.type === "run.finished").length;
  const settle = async (n) => {
    for (let i = 0; i < 400 && (finished() < n || runner.isActive(chat.id)); i++) await tick();
  };
  await runner.send(chat.id, { text: "اول" });
  await settle(1);
  for (let n = 2; n <= 4; n++) {
    runner.retry(chat.id);
    await settle(n);
  }
  const note = store.eventsAfter(chat.id).find((e) => e.type === "note" && /بی‌جواب/.test(e.data.text));
  assert.ok(note, "given up after three retries");
  assert.match(note.data.text, /«دوباره»/);
  assert.match(note.data.text, /«حل شد»/);
  assert.doesNotMatch(note.data.text, /«حذف»|«ارسال دوباره»/);
});
