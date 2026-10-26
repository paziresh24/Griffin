// The server side of «@» (mentions.mjs): own agents, colleagues' agents and the owner's chats tagged in
// a message become one note for the chat's agent — never the chat itself, its own agent or a chat
// that is not the owner's.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openStore } from "../src/db.mjs";
import { createMentionNote } from "../src/mentions.mjs";

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "griffin-mention-note-"));
  const store = openStore(path.join(dir, "db.sqlite"));
  t.after(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const network = { list: () => [{ id: "karsara-kazemi-example-org", name: "یارا", owner: "علیرضا کاظمی", connected: true }, { id: "off-agent", name: "خاموش", connected: false }] };
  return { store, note: createMentionNote({ store, network }) };
}

test("a tagged chat is named by id; the chat itself and a colleague's chat are not", (t) => {
  const { store, note } = setup(t);
  const here = store.createChat({ title: "گفتگوی فعلی" });
  const disk = store.createChat({ title: "بررسی دیسک نود east3" });
  store.createChat({ title: "کار همکار", caller: "peer:acme" });
  const out = note("طبق @«بررسی دیسک نود east3» ادامه بده و @«کار همکار» و @«گفتگوی فعلی»", here);
  assert.match(out, new RegExp(`chatId "${disk.id}"`));
  assert.match(out, /chat_read/);
  assert.doesNotMatch(out, /کار همکار|گفتگوی فعلی/);
  assert.equal(note("بدون تگ", here), "");
  assert.equal(note("@«چتی که نیست»", here), "");
});

test("own agents go to delegate, except the chat's own agent; only connected network agents count", (t) => {
  const { store, note } = setup(t);
  for (const [id, label] of [["platform", "پلتفرم‌بان"], ["cdn-desk", "میز CDN"]]) store.upsertAgentProfile({ id, label, tools: [] });
  const profiles = store.listAgentProfiles().filter((p) => p.id !== "griffin");
  assert.ok(profiles.length >= 2, "two agents of this install");
  const [a, b] = profiles;
  const chat = store.createChat({ title: "x", agent: a.id });
  const out = note(`@${a.label.replace(/\s+/g, "_")} و @${b.label.replace(/\s+/g, "_")} و @یارا و @خاموش`, store.getChat(chat.id));
  assert.match(out, new RegExp(`delegate \\{agent: "${b.id}"\\}`));
  assert.doesNotMatch(out, new RegExp(`agent: "${a.id}"`));
  assert.match(out, /network_ask \{agent: "karsara-kazemi-example-org"\}/);
  assert.doesNotMatch(out, /off-agent/);
});
