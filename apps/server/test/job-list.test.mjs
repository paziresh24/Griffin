import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openStore } from "../src/db.mjs";

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "griffin-joblist-"));
  const store = openStore(path.join(dir, "db.sqlite"));
  const job = store.createJob({ name: "ساعتی", prompt: "x", triggerType: "manual" });
  const runs = [];
  const fire = () => {
    const chat = store.createChat({ title: `run ${runs.length}`, jobId: job.id, caller: "scheduler" });
    const jobRun = store.startJobRun({ jobId: job.id, chatId: chat.id, trigger: "schedule" });
    store.finishJobRun(jobRun, { status: "finished" });
    runs.push(chat.id);
    return chat.id;
  };
  const listed = () => store.listChatsBySource({ archived: false }).filter((c) => c.job_id).map((c) => c.id);
  return { store, job, runs, fire, listed };
}

test("job list: one entry per job — its newest run; the archive view still has every run", () => {
  const { store, fire, listed } = setup();
  const owner = store.createChat({ title: "گفتگوی خودم" });
  fire();
  fire();
  const newest = fire();
  assert.deepEqual(listed(), [newest]);
  assert.ok(store.listChatsBySource({ archived: false }).some((c) => c.id === owner.id), "owner chats are untouched");

  store.updateChat(newest, { archived: true });
  assert.deepEqual(listed(), [], "archiving the newest run clears the job until it runs again");
  assert.equal(store.listChatsBySource({ archived: true }).filter((c) => c.job_id).length, 1);
  const next = fire();
  assert.deepEqual(listed(), [next]);
});

test("job list: a run the owner wrote in, answered, pinned or unarchived stays listed until archived", () => {
  const { store, fire, listed } = setup();
  const wroteIn = fire();
  const pinned = fire();
  const unarchived = fire();
  const running = fire();
  const newest = fire();
  store.keepJobChat(wroteIn);
  store.updateChat(pinned, { pinned: true });
  store.updateChat(pinned, { pinned: false });
  store.updateChat(unarchived, { archived: true });
  store.updateChat(unarchived, { archived: false });
  store.startRun(running); // a parked or still-working older run stays visible
  assert.deepEqual(new Set(listed()), new Set([wroteIn, pinned, unarchived, running, newest]));

  store.updateChat(wroteIn, { archived: true });
  assert.ok(!listed().includes(wroteIn), "archiving lets it go");
  store.updateChat(wroteIn, { archived: false });
  assert.ok(listed().includes(wroteIn), "bringing it back keeps it again");
});

test("job list: clean-up of old runs leaves a kept or pinned run whole until the owner lets it go", () => {
  const { store, job, fire } = setup();
  const kept = fire();
  const pinned = fire();
  const plain = fire();
  fire();
  store.keepJobChat(kept);
  store.updateChat(pinned, { pinned: true });

  store.pruneJobRuns(job.id, 1);
  assert.ok(store.getChat(kept), "kept run survives");
  assert.ok(store.getChat(pinned), "pinned run survives");
  assert.equal(store.getChat(plain), null, "an untouched old run goes");
  const runChats = store.listJobRuns(job.id, 10).map((r) => r.chatId);
  assert.ok(runChats.includes(kept) && runChats.includes(pinned), "their run records stay too");

  store.updateChat(kept, { archived: true });
  store.updateChat(pinned, { pinned: false, archived: true });
  store.pruneJobRuns(job.id, 1);
  assert.equal(store.getChat(kept), null);
  assert.equal(store.getChat(pinned), null);
});
