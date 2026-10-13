import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openStore } from "../src/db.mjs";
import { allMothers, createMotherTools, ensureMother, motherContext, motherInfo, openThreads, watchJoinedThreads } from "../src/integrations/mother.mjs";

// A colleague's standing mother chat orchestrates their requests, like a watcher answering the team.

test("one standing mother chat per person; threads are its subtasks; another mother can join one", async () => {
  const store = openStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "griffin-mother2-")), "db.sqlite"));
  const sent = [];
  const runner = { isActive: () => false, send: async (chatId, input) => sent.push([chatId, input.text]) };
  const rezaei = store.upsertPerson({ externalId: "1001", name: "رضایی", data: { platform: "telegram" } });
  const a = ensureMother(store, { integrationId: "acc", key: "1001", person: rezaei, name: "رضایی", agent: "griffin" });
  assert.equal(ensureMother(store, { integrationId: "acc", key: "1001", person: rezaei, name: "رضایی", agent: "griffin" }), a, "reused");
  store.updateChat(a, { archived: true });
  assert.equal(ensureMother(store, { integrationId: "acc", key: "1001", name: "رضایی", agent: "griffin" }), a);
  assert.equal(store.getChat(a).archived, 0, "a new message brings an archived mother back");
  assert.equal(store.getChat(a).caller, "team");
  assert.equal(motherInfo(store, a).name, "رضایی");
  const b = ensureMother(store, { integrationId: "acc", key: "1002", name: "کریمی", agent: "griffin" });
  assert.equal(allMothers(store).length, 2);

  const thread = store.createChat({ title: "پایپ‌لاین اپ", mode: "agent", caller: "griffin", agent: "platform", parentChatId: a });
  store.setKv(`delegate:${thread.id}`, { parent: a, agent: "platform", state: "running" });
  assert.deepEqual(openThreads(store).map((t) => [t.thread, t.person]), [[thread.id, "رضایی"]]);

  const tools = createMotherTools({ store, runner, chatId: b, name: "کریمی" });
  const seen = JSON.parse((await tools.team_threads.execute({})).content[0].text);
  assert.equal(seen.threads[0].thread, thread.id, "another mother sees the open thread");
  JSON.parse((await tools.thread_join.execute({ thread: thread.id, note: "منم همین" })).content[0].text);
  assert.match(sent.at(-1)[1], /«کریمی» هم همین مسئله/);

  watchJoinedThreads({ store, runner, finalTextOf: async () => "درست شد" });
  store.bus.emit("event", thread.id, { type: "run.finished", data: { status: "finished" } });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(sent.at(-1)[0], b, "the joined mother hears the result");
  assert.match(sent.at(-1)[1], /درست شد/);
  assert.match(motherContext("رضایی"), /never\s+closes/);
});
