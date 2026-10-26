import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openStore } from "../src/db.mjs";
import { CONFIG_SCHEMA } from "../src/config.mjs";
import { createAccountTools } from "../src/integrations/telegram-account.mjs";
import { LEDGER_TOOL, TELEGRAM_LEDGER_CONFIG, ledgerRecorder, ledgerTools } from "../src/telegram-ledger.mjs";

const parse = (r) => JSON.parse(r.content[0].text);

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "griffin-ledger-"));
  const store = openStore(path.join(dir, "t.sqlite"));
  let nextId = 100;
  const client = {
    getEntity: async (id) => ({ id: typeof id === "bigint" ? id : 777n, firstName: "مریم" }),
    getDialogs: async () => [],
    getPeerId: async (entity) => String(entity.id),
    sendMessage: async () => ({ id: (nextId += 1) }),
  };
  return { dir, store, client };
}

test("ledger on: a telegram_send is written under the chat that sent it, and an owner chat reads it back", async () => {
  const { dir, store, client } = setup();
  try {
    const asker = store.createChat({ title: "قرارداد مریم" });
    const other = store.createChat({ title: "چت دیگر" });
    const send = (chatId) => createAccountTools({ getClient: () => client, record: ledgerRecorder({ store, chatId, enabled: true }) }).telegram_send;
    assert.equal(parse(await send(asker.id).execute({ chat: "777", text: "قرارداد را دیدی؟" })).sent, true);
    await send(other.id).execute({ chat: "777", text: "سلام" });
    await send(other.id).execute({ chat: "888", text: "به کس دیگر" });

    const tools = ledgerTools({ store, chat: store.getChat(asker.id), enabled: true });
    assert.ok(tools[LEDGER_TOOL], "an owner chat gets telegram_ledger");
    const out = parse(await tools[LEDGER_TOOL].execute({ peerId: "777" }));
    assert.deepEqual(
      out.sends.map((s) => [s.chatId, s.title, s.messageId]),
      [
        [other.id, "چت دیگر", 102],
        [asker.id, "قرارداد مریم", 101],
      ],
      "newest first, only that peer, with the sending chat's title and the Telegram message id",
    );
    assert.match(parse(await tools[LEDGER_TOOL].execute({ peerId: "abc" })).error, /numeric/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("ledger off (the default): nothing is written and no chat has the tool", async () => {
  const { dir, store, client } = setup();
  try {
    const chat = store.createChat({ title: "x" });
    assert.equal(ledgerRecorder({ store, chatId: chat.id, enabled: false }), null);
    const tools = createAccountTools({ getClient: () => client, record: ledgerRecorder({ store, chatId: chat.id, enabled: false }) });
    await tools.telegram_send.execute({ chat: "777", text: "hi" });
    assert.deepEqual(store.listTelegramSends({ peerId: "777" }), []);
    assert.deepEqual(ledgerTools({ store, chat, enabled: false }), {});
    // The switch is a Settings entry, on unless set (owner 2026-10-20: Karsara's defaults).
    const entry = CONFIG_SCHEMA.find((c) => c.key === TELEGRAM_LEDGER_CONFIG);
    assert.deepEqual(entry?.options, ["on", "off"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("ledger on: a colleague's, a job's or a delegated chat does not read it", () => {
  const { dir, store } = setup();
  try {
    const owner = store.createChat({ title: "owner" });
    const team = store.createChat({ title: "team", caller: "team" });
    const child = store.createChat({ title: "child", parentChatId: owner.id });
    const job = store.createChat({ title: "job", caller: "scheduler" });
    for (const chat of [team, child, job]) assert.deepEqual(ledgerTools({ store, chat: store.getChat(chat.id), enabled: true }), {}, chat.title);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a ledger write that fails never turns a sent message into an error", async () => {
  const { dir, client } = setup();
  try {
    const tools = createAccountTools({ getClient: () => client, record: () => { throw new Error("disk full"); } });
    assert.equal(parse(await tools.telegram_send.execute({ chat: "777", text: "hi" })).sent, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
