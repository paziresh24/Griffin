// A message resent under the page's client id (its answer was lost to a restart or a 502) is
// stored once.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp } from "../src/app.mjs";
import { openStore } from "../src/db.mjs";
import { foldEvents } from "@griffin/timeline";

function setup(send) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "griffin-cid-"));
  const store = openStore(path.join(dir, "db.sqlite"));
  const calls = [];
  const runner = {
    isActive: () => false,
    activeCount: () => 0,
    send: async (chatId, input) => {
      calls.push(input);
      return send ? send(chatId, input, store) : (store.appendEvent(chatId, null, "user", { text: input.text, clientId: input.clientId }), { delivered: "run" });
    },
  };
  return { store, app: createApp({ store, runner }), calls };
}
const post = (app, url, body) => app.request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

test("a resend with the same client id is answered without storing the message again", async () => {
  const { store, app, calls } = setup();
  const chat = store.createChat({ title: "t" });
  const first = await post(app, `/api/chats/${chat.id}/messages`, { text: "سلام", clientId: "abc-1" });
  assert.equal(first.status, 202);
  const again = await post(app, `/api/chats/${chat.id}/messages`, { text: "سلام", clientId: "abc-1" });
  assert.deepEqual(await again.json(), { delivered: "duplicate" });
  assert.equal(calls.length, 1);
  const { messages } = foldEvents(store.eventsAfter(chat.id));
  assert.deepEqual(messages.map((m) => m.clientId), ["abc-1"], "the timeline carries the id, so the page's bubble gives way");
  await post(app, `/api/chats/${chat.id}/messages`, { text: "دیگری", clientId: "abc-2" });
  assert.equal(calls.length, 2);
  assert.equal((await post(app, `/api/chats/${chat.id}/messages`, { text: "x", clientId: "bad id!" })).status, 202, "a malformed id is ignored, not refused");
});

test("a copy arriving while the first is in flight shares its answer", async () => {
  let release;
  const { store, app, calls } = setup(() => new Promise((resolve) => (release = () => resolve({ delivered: "run" }))));
  const chat = store.createChat({ title: "t" });
  const a = post(app, `/api/chats/${chat.id}/messages`, { text: "x", clientId: "same" });
  while (!release) await new Promise((r) => setTimeout(r, 2));
  const b = post(app, `/api/chats/${chat.id}/messages`, { text: "x", clientId: "same" });
  await new Promise((r) => setTimeout(r, 5));
  release();
  assert.equal((await a).status, 202);
  assert.deepEqual(await (await b).json(), { delivered: "duplicate" });
  assert.equal(calls.length, 1);
});
