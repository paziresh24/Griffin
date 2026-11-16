import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openStore } from "../src/db.mjs";

// Owner 2026-11-14: «چتم نه تو لیست هست نه تو بایگانی». ~10k archived chats of one peer agent (the
// one bot, ~1000 a day) filled the one LIMIT of the list queries, so every owner chat archived more
// than two days earlier dropped out of the archive view and out of chat_list, though it was still
// in the database. Each caller now has its own cap.
test("a busy peer's archived chats do not push the owner's archived chats out of the lists", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "griffin-capcaller-"));
  const store = openStore(path.join(dir, "db.sqlite"));
  const mine = store.createChat({ title: "کندی آپتایم کوما" });
  store.updateChat(mine.id, { archived: true });
  store.db.prepare("UPDATE chats SET updated_at = '2026-11-01T00:00:00.000Z' WHERE id = ?").run(mine.id);
  const insert = store.db.prepare("UPDATE chats SET archived = 1, updated_at = ? WHERE id = ?");
  store.db.exec("BEGIN");
  for (let i = 0; i < 1200; i += 1) {
    const peer = store.createChat({ title: `peer ${i}`, caller: "peer:team-bot" });
    insert.run(`2026-11-13T00:00:${String(i % 60).padStart(2, "0")}.000Z`, peer.id);
  }
  store.db.exec("COMMIT");

  const archive = store.listChatsBySource({ archived: true });
  assert.ok(archive.some((c) => c.id === mine.id), "the archive view still lists the owner's chat");
  assert.ok(archive.filter((c) => c.caller === "peer:team-bot").length <= 800, "the peer keeps its own cap");
  assert.ok(store.listChats({ archived: true }).some((c) => c.id === mine.id), "chat_list's source still has it");
});
