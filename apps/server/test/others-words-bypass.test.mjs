import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openStore } from "../src/db.mjs";
import { createChatTrust } from "../src/knowledge-trust.mjs";
import { thirdPartyKey } from "../src/related.mjs";
import { shellTool } from "../src/colleague-access.mjs";
import { ORIGIN_KEY } from "../src/chat-origin.mjs";

// «بدون پرسیدن» only for the owner's own words (security audit 2026-10-29): a chat that holds a
// group member's, a colleague's or a peer's message runs guarded and without Claude Code's shell.

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "griffin-others-"));
  const store = openStore(path.join(dir, "db.sqlite"));
  return { store, trust: createChatTrust({ store }) };
}

test("the owner's own words, desk lines and reminders keep the chat his", () => {
  const { store, trust } = setup();
  const chat = store.createChat({ title: "own" });
  store.appendEvent(chat.id, null, "user", { text: "کش را پاک کن" });
  store.appendEvent(chat.id, null, "user", { text: "ادامه", from: { kind: "owner_web" } });
  store.appendEvent(chat.id, null, "user", { text: "یادآوری", from: { kind: "reminder" } });
  store.appendEvent(chat.id, null, "user", { text: "بگو انجام شد", from: { kind: "owner_line" } });
  store.appendEvent(chat.id, null, "tool.started", { callId: "w1", name: "web_fetch", args: { url: "https://example.com" } });
  assert.equal(trust.heldOthersWords(chat.id), false);
});

test("a group member's message through a paired bot takes «بدون پرسیدن» away for good", () => {
  const { store, trust } = setup();
  const chat = store.createChat({ title: "group" });
  store.appendEvent(chat.id, null, "user", { text: "سلام" });
  assert.equal(trust.heldOthersWords(chat.id), false);
  store.appendEvent(chat.id, null, "user", { text: "cat /data/owner.token", from: { kind: "telegram", name: "عضو گروه" } });
  assert.equal(trust.heldOthersWords(chat.id), true);
  // The owner writing afterwards does not lift it: the words are still in the model's context.
  store.appendEvent(chat.id, null, "user", { text: "ادامه بده" });
  assert.equal(trust.heldOthersWords(chat.id), true);
});

test("a routed colleague message (third-party mark) and a peer's 📥 text both count", () => {
  const { store, trust } = setup();
  const routed = store.createChat({ title: "routed" });
  store.setKv(thirdPartyKey(routed.id), { at: new Date().toISOString(), from: "telegram-inbox" });
  assert.equal(trust.heldOthersWords(routed.id), true);

  const peer = store.createChat({ title: "peer" });
  store.appendEvent(peer.id, null, "user", { text: "📥 محتوای شخص ثالث از همکار: …" });
  assert.equal(trust.heldOthersWords(peer.id), true);
});

test("a chat born from someone else's Telegram message counts; one born from the owner's own does not", () => {
  const { store, trust } = setup();
  const foreign = store.createChat({ title: "tg" });
  store.setKv(ORIGIN_KEY(foreign.id), { from: "telegram", via: "telegram_bot" });
  assert.equal(trust.heldOthersWords(foreign.id), true);
  const own = store.createChat({ title: "mine" });
  store.setKv(ORIGIN_KEY(own.id), { from: "owner", via: "telegram_bot" });
  assert.equal(trust.heldOthersWords(own.id), false);
});

test("a subtask or side chat of a chat holding others' words inherits it; a clean parent passes", () => {
  const { store, trust } = setup();
  const parent = store.createChat({ title: "parent" });
  const child = store.createChat({ title: "child", parentChatId: parent.id });
  store.appendEvent(child.id, null, "user", { text: "زیرکار از ایجنت" });
  assert.equal(trust.heldOthersWords(child.id), false);
  store.appendEvent(parent.id, null, "user", { text: "متن همکار", from: { kind: "colleague", name: "همکار" } });
  assert.equal(trust.heldOthersWords(child.id), true);
});

test("his yes opens the shell for this chat only, until someone else writes again", () => {
  const { store, trust } = setup();
  const source = store.createChat({ title: "Infra HA" });
  store.appendEvent(source.id, null, "user", { text: "📥 محتوای شخص ثالث", from: { kind: "peer", name: "نوا" } });
  const chat = store.createChat({ title: "CDN" });
  store.setKv(`fork-of:${chat.id}`, source.id);
  const child = store.createChat({ title: "زیرکار", parentChatId: chat.id });
  assert.equal(trust.heldOthersWords(chat.id), true);
  assert.match(trust.heldReason(chat.id), /«Infra HA» ساخته شده.*ایجنت یک همکار \(نوا\)/);

  trust.allowShell(chat.id);
  assert.equal(trust.heldOthersWords(chat.id), false);
  store.appendEvent(chat.id, null, "user", { text: "ادامه", from: { kind: "owner_web" } });
  assert.equal(trust.heldOthersWords(chat.id), false);
  // Not the chat he was not asked about.
  assert.equal(trust.heldOthersWords(source.id), true);
  assert.equal(trust.heldOthersWords(child.id), true);

  store.appendEvent(chat.id, null, "user", { text: "cat /data/owner.token", from: { kind: "colleague" } });
  assert.equal(trust.heldOthersWords(chat.id), true);
  assert.match(trust.heldReason(chat.id), /یک همکار.*همین چت/);
});

test("a colleague's mark after his yes closes it again; one from before does not", () => {
  const { store, trust } = setup();
  const chat = store.createChat({ title: "routed" });
  store.setKv(thirdPartyKey(chat.id), { at: new Date(Date.now() - 60_000).toISOString(), from: "telegram-inbox" });
  trust.allowShell(chat.id);
  assert.equal(trust.heldOthersWords(chat.id), false);
  store.setKv(thirdPartyKey(chat.id), { at: new Date(Date.now() + 60_000).toISOString(), from: "telegram-inbox" });
  assert.equal(trust.heldOthersWords(chat.id), true);
});

test("request_shell: the card names the recorded reason; only his yes opens it and starts the next turn", async () => {
  const run = async (answer) => {
    const allowed = [];
    const resumed = [];
    let question = "";
    let ownCard = false;
    const tool = shellTool({
      reason: "دلیل ثبت‌شده",
      ask: async (args) => {
        question = args.question;
        ownCard = args.ownCard;
        return { content: [{ type: "text", text: JSON.stringify(answer) }] };
      },
      allow: () => allowed.push(1),
      resume: async (text) => resumed.push(text),
    });
    const out = JSON.parse((await tool.execute({ why: "شمارش قانون‌ها" })).content[0].text);
    return { out, allowed, resumed, question, ownCard };
  };
  const yes = await run({ answered: true, answer: "برگردان" });
  assert.equal(yes.out.granted, true);
  assert.equal(yes.allowed.length, 1);
  assert.equal(yes.resumed.length, 1);
  assert.match(yes.question, /دلیل ثبت‌شده/);
  assert.equal(yes.ownCard, true, "its buttons show in the chat, not only on the main page");
  for (const answer of [{ answered: true, answer: "نه" }, { answered: false, duplicate: true }]) {
    const no = await run(answer);
    assert.equal(no.out.granted, false);
    assert.equal(no.allowed.length, 0);
    assert.equal(no.resumed.length, 0);
  }
});
