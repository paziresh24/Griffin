import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openStore } from "../src/db.mjs";
import { cleanTitle, createTitler } from "../src/titles.mjs";

function chatWithRun(store, question, answer) {
  const chat = store.createChat({ title: question.split("\n")[0], mode: "agent" });
  store.appendEvent(chat.id, null, "user", { text: question });
  const runId = store.startRun(chat.id);
  store.appendEvent(chat.id, runId, "run.started", {});
  store.appendEvent(chat.id, runId, "text", { text: answer });
  store.appendEvent(chat.id, runId, "run.finished", { status: "finished" });
  return chat;
}

test("first finished run gets a short generated title; renamed chats and later runs are left alone", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "titles-"));
  const store = openStore(path.join(dir, "db.sqlite"));
  const prompts = [];
  const titler = createTitler({ store, log: {}, generate: async (p) => { prompts.push(p); return "«فروش ویزیت آنلاین امروز».\n"; } });
  try {
    const chat = chatWithRun(store, "آخرین میزان فروش ویزیت آنلاین امروزمون چقدر بوده ؟\nراهنمایی: تو داشبورد های گرافاناس", "۱۶۹");
    assert.equal(await titler(chat.id), "فروش ویزیت آنلاین امروز");
    assert.equal(store.getChat(chat.id).title, "فروش ویزیت آنلاین امروز");
    assert.match(prompts[0], /Question:\nآخرین میزان فروش/);
    assert.equal(await titler(chat.id), null, "already titled");

    const renamed = chatWithRun(store, "سؤال دیگر", "جواب");
    store.updateChat(renamed.id, { title: "اسم خودم" });
    assert.equal(await titler(renamed.id), null);
    assert.equal(store.getChat(renamed.id).title, "اسم خودم");
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("title cleanup", () => {
  assert.equal(cleanTitle('"دیسک S3 پروداکشن"'), "دیسک S3 پروداکشن");
  assert.equal(cleanTitle(""), null);
  assert.equal(cleanTitle("این یک جملهٔ خیلی طولانی است که اصلاً عنوان نیست و باید رد شود"), null);
});
