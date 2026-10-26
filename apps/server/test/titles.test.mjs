import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openStore } from "../src/db.mjs";
import { cleanTitle, createTitler, isPeerAutoTitle, peerAutoTitle } from "../src/titles.mjs";
import { peerRequestMessage } from "../src/peer-tasks.mjs";

function chatWithRun(store, question, answer) {
  const chat = store.createChat({ title: question.split("\n")[0], mode: "agent" });
  store.appendEvent(chat.id, null, "user", { text: question });
  const runId = store.startRun(chat.id);
  store.appendEvent(chat.id, runId, "run.started", {});
  store.appendEvent(chat.id, runId, "text", { text: answer });
  store.appendEvent(chat.id, runId, "run.finished", { status: "finished" });
  return chat;
}

test("first finished run gets a short generated title; renamed and titled chats are left alone", async () => {
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

// A title call that failed (429 from the title provider, 2026-10-22) is tried again after the next run.
test("a chat whose title call failed is named after a later run", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "titles-"));
  const store = openStore(path.join(dir, "db.sqlite"));
  let fail = true;
  const titler = createTitler({ store, log: {}, generate: async () => { if (fail) throw new Error("title http 429"); return "دیسک شرق"; } });
  try {
    const chat = chatWithRun(store, "وضعیت شرق خیلی وخیمه به نظر، هیچ دیسک و جایی نداره", "جواب");
    assert.equal(await titler(chat.id), null);
    const runId = store.startRun(chat.id);
    store.appendEvent(chat.id, null, "user", { text: "ادامه" });
    store.appendEvent(chat.id, runId, "run.started", {});
    store.appendEvent(chat.id, runId, "text", { text: "جواب دوم" });
    store.appendEvent(chat.id, runId, "run.finished", { status: "finished" });
    fail = false;
    assert.equal(await titler(chat.id), "دیسک شرق");
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

// A keyless install wrote «گفتگو» as every chat's title: renamed later.
test("a chat stuck on «گفتگو» gets its real title", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "titles-"));
  const store = openStore(path.join(dir, "db.sqlite"));
  const titler = createTitler({ store, log: {}, generate: async () => "عنوان خلاصه گفتگوها" });
  try {
    const chat = chatWithRun(store, "چرا عنوان‌ها خلاصه نمی‌شوند؟", "جواب");
    store.updateChat(chat.id, { title: "گفتگو" });
    assert.equal(await titler(chat.id), "عنوان خلاصه گفتگوها");
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Colleagues' agents' chats (owner 2026-10-20: «اول هر چت اسم اون ایجنت نوشته… چتا اسم خلاصه شده ندارن»):
// the old «<name>: <request>» and the new «<request>» titles are both the automatic one, and get named
// from the request, not from the rules it is wrapped in.
test("a colleague's agent's chat is named from its request, old «name: …» titles too", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "titles-"));
  const store = openStore(path.join(dir, "db.sqlite"));
  const prompts = [];
  const titler = createTitler({ store, log: {}, generate: async (p) => { prompts.push(p); return "دیپلوی سرویس tambo"; } });
  try {
    const request = "سلام. لطفاً وضعیت دیپلوی سرویس tambo (owner: sara-jafari) را بررسی کن و بگو چرا بالا نیامده";
    const wrapped = peerRequestMessage({ label: "آیدا جعفری", userId: "sara-jafari", text: request });
    for (const title of [`آیدا جعفری: ${request.slice(0, 60).replace(/\s+\S*$/, "")}…`, peerAutoTitle(request)]) {
      const chat = store.createChat({ title, mode: "agent", caller: "peer:sara-jafari" });
      store.appendEvent(chat.id, null, "user", { text: wrapped });
      const runId = store.startRun(chat.id);
      store.appendEvent(chat.id, runId, "run.started", {});
      store.appendEvent(chat.id, runId, "text", { text: "پاد در CrashLoop است" });
      store.appendEvent(chat.id, runId, "run.finished", { status: "finished" });
      assert.equal(await titler(chat.id), "دیپلوی سرویس tambo");
    }
    assert.match(prompts[0], /Question:\nسلام\. لطفاً وضعیت دیپلوی/, "the request, not the rules around it");
    assert.ok(!prompts[0].includes("درخواست ایجنتِ همکار"));
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a colleague chat the owner renamed is not the automatic title", () => {
  const wrapped = peerRequestMessage({ label: "یارا (علیرضا کاظمی)", userId: "net-x", text: "سلام، یارا هستم. آقای کاظمی موافقت کردند." });
  assert.equal(isPeerAutoTitle("یارا (علیرضا کاظمی): سلام، یارا هستم. آقای کاظمی…", wrapped), true);
  assert.equal(isPeerAutoTitle("سلام، یارا هستم. آقای کاظمی موافقت کردند.", wrapped), true);
  assert.equal(isPeerAutoTitle("موافقت آقای کاظمی", wrapped), false);
  assert.equal(peerAutoTitle("\n  خط اول\nخط دوم"), "خط اول");
});
