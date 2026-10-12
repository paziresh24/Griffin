import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp } from "../src/app.mjs";
import { openStore } from "../src/db.mjs";

function setup(asks = null) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "griffin-side-"));
  const store = openStore(path.join(dir, "db.sqlite"));
  const sent = [];
  const runner = { isActive: () => false, activeCount: () => 0, send: async (chatId, input) => (sent.push({ chatId, ...input }), { delivered: "run" }) };
  const app = createApp({ store, runner, asks });
  return { store, app, sent };
}
const post = (app, url, body) => app.request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

test("a side chat hangs off its chat, out of the main list, and goes away with it", async () => {
  const { store, app, sent } = setup();
  const main = store.createChat({ title: "اصلی", provider: "openai" });
  const res = await post(app, `/api/chats/${main.id}/side`, { text: "یک سؤال جدا" });
  assert.equal(res.status, 201);
  const { chat } = await res.json();
  assert.equal(chat.sideOf, main.id);
  assert.deepEqual(sent.map((s) => [s.chatId, s.text]), [[chat.id, "یک سؤال جدا"]]);
  const { chats } = await (await app.request("/api/chats")).json();
  assert.deepEqual(chats.map((c) => c.id), [main.id]);
  const { chats: sides } = await (await app.request(`/api/chats/${main.id}/sides`)).json();
  assert.deepEqual(sides.map((c) => c.id), [chat.id]);
  assert.equal((await post(app, `/api/chats/${chat.id}/side`, { text: "x" })).status, 400, "no side of a side");
  store.deleteChat(main.id);
  assert.equal(store.getChat(chat.id), null);
});

test("a typed message answers the question the run is parked on, instead of queueing", async () => {
  const answered = [];
  const asks = { isWaiting: () => true, answer: (chatId, { answer }) => (answered.push(answer), true) };
  const { store, app, sent } = setup(asks);
  const main = store.createChat({ title: "t" });
  const res = await post(app, `/api/chats/${main.id}/messages`, { text: "بله، اعمال کن" });
  assert.deepEqual(await res.json(), { delivered: "answer" });
  assert.deepEqual(answered, ["بله، اعمال کن"]);
  assert.equal(sent.length, 0);
  assert.equal(store.eventsAfter(main.id).at(-1).data.intent, "steer");
  await post(app, `/api/chats/${main.id}/messages`, { text: "/compact" });
  assert.equal(sent.length, 1, "a slash command is not an answer");
});

test("a new owner chat starts on the default repo unless it names one or none", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "griffin-defrepo-"));
  const store = openStore(path.join(dir, "db.sqlite"));
  const runner = { isActive: () => false, activeCount: () => 0, send: async () => ({ delivered: "run" }) };
  const app = createApp({ store, runner, isValidRepo: (r) => ["infra", "handbook"].includes(r), defaultRepo: () => "infra" });
  const create = async (body) => (await (await post(app, "/api/chats", { text: "x", ...body })).json()).chat.repo;
  assert.equal(await create({}), "infra");
  assert.equal(await create({ repo: "handbook" }), "handbook");
  assert.equal(await create({ repo: "" }), null);
  assert.equal(await create({ sim: true }), null, "a simulation does not get a worktree");
  assert.equal((await post(app, "/api/chats", { text: "x", repo: "../etc" })).status, 400);
});
