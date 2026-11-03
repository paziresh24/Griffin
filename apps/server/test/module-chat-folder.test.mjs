// A module's page may name a folder for the chats it opens (openChat.folder): found by name or made
// once, so the module's chats sit together and do not fill the recent list (helpdesk: «میز کمک»).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp } from "../src/app.mjs";
import { openStore } from "../src/db.mjs";

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "griffin-modfolder-"));
  const store = openStore(path.join(dir, "db.sqlite"));
  const app = createApp({ store, runner: { isActive: () => false, activeCount: () => 0, send: async () => ({}) } });
  const post = async (body) => (await app.request("/api/chats", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "سلام", repo: "", ...body }) })).json();
  return { store, post, done: () => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

test("a module chat with a folder name lands in that folder, made once and shared by the next chats", async () => {
  const { store, post, done } = setup();
  try {
    const a = await post({ title: "درخواست ۱", module: "helpdesk", folder: "میز کمک" });
    const b = await post({ title: "درخواست ۲", module: "helpdesk", folder: "میز کمک" });
    const groups = store.listGroups().filter((g) => g.name === "میز کمک");
    assert.equal(groups.length, 1);
    assert.equal(store.getChat(a.chat.id).group_id, groups[0].id);
    assert.equal(store.getChat(b.chat.id).group_id, groups[0].id);
    assert.equal(store.getChat(a.chat.id).module, "helpdesk");
  } finally {
    done();
  }
});

test("a folder name is honoured only for a module's chat; an explicit group wins; no folder = no group", async () => {
  const { store, post, done } = setup();
  try {
    const plain = await post({ title: "بی‌ماژول", folder: "میز کمک" }); // not a module chat: the name means nothing
    assert.equal(store.getChat(plain.chat.id).group_id, null);
    assert.equal(store.listGroups().length, 0);
    const mine = store.createGroup("من");
    const own = await post({ title: "x", module: "helpdesk", folder: "میز کمک", groupId: mine.id });
    assert.equal(store.getChat(own.chat.id).group_id, mine.id);
    const none = await post({ title: "y", module: "helpdesk" });
    assert.equal(store.getChat(none.chat.id).group_id, null);
    const odd = await post({ title: "z", module: "helpdesk", folder: "   " });
    assert.equal(store.getChat(odd.chat.id).group_id, null);
  } finally {
    done();
  }
});
