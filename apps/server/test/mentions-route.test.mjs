// «@» in the owner's message (owner 2026-10-20): the tagged colleagues' agents reach the chat's agent
// as a note riding on the message; the thread keeps what the owner wrote.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findMentions, mentionNote } from "@griffin/timeline";
import { createApp } from "../src/app.mjs";
import { openStore } from "../src/db.mjs";

const agents = [
  { id: "karsara-kazemi-example-org", name: "یارا", owner: "علیرضا کاظمی", connected: true },
  { id: "griffin-hosseini-example-org", name: "نوا", owner: "ابوالفضل حسینی", connected: true },
];

test("a new chat and a message: the tagged agents go to the agent as a note, untagged text has none", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "griffin-mention-"));
  const store = openStore(path.join(dir, "db.sqlite"));
  t.after(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const calls = [];
  const runner = { isActive: () => false, activeCount: () => 0, send: async (chatId, input) => (calls.push(input), { delivered: "run" }) };
  const app = createApp({ store, runner, mentionNote: (text) => mentionNote(findMentions(text, agents), agents) });
  const json = (body) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  const created = await app.request("/api/chats", json({ text: "@یارا وضعیت دیتابیس کلینیک را بپرس" }));
  assert.equal(created.status, 201);
  const { chat } = await created.json();
  assert.equal(calls[0].text, "@یارا وضعیت دیتابیس کلینیک را بپرس", "the thread keeps the owner's words");
  assert.match(calls[0].note, /network_ask \{agent: "karsara-kazemi-example-org"\}/);
  assert.doesNotMatch(calls[0].note, /griffin-hosseini/);

  assert.equal((await app.request(`/api/chats/${chat.id}/messages`, json({ text: "ممنون، ادامه بده" }))).status, 202);
  assert.equal(calls[1].note, "");
  assert.equal((await app.request(`/api/chats/${chat.id}/messages`, json({ text: "از @نوا هم بپرس" }))).status, 202);
  assert.match(calls[2].note, /griffin-hosseini-example-org/);
});
