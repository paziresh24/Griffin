import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openStore } from "../src/db.mjs";
import { archiveIdleChats } from "../src/idle-archive.mjs";

test("idle owner chats with a worktree are archived; pinned, busy, recent or tree-less ones are not", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "griffin-idle-"));
  const store = openStore(path.join(dir, "db.sqlite"));
  try {
    const make = (title, extra = {}) => {
      const chat = store.createChat({ title, ...extra });
      store.updateChat(chat.id, { repo: "r", worktreePath: `/wt/${title}` });
      return chat.id;
    };
    const idle = make("idle");
    const pinned = make("pinned");
    store.updateChat(pinned, { pinned: true });
    const busy = make("busy");
    const sideBusy = make("side-busy");
    const side = store.createChat({ title: "side", sideOf: sideBusy });
    const peer = make("peer", { caller: "peer:x" });
    const bare = store.createChat({ title: "bare" }).id;
    const later = Date.now() + 4 * 86_400_000;
    const archived = archiveIdleChats({ store, idleMs: 3 * 86_400_000, now: later, isBusy: (id) => id === busy || id === side.id });
    assert.deepEqual(archived, [idle]);
    assert.equal(store.getChat(idle).archived, 1);
    for (const id of [pinned, busy, sideBusy, peer, bare]) assert.equal(store.getChat(id).archived, 0, id);
    // Not idle long enough: nothing.
    assert.deepEqual(archiveIdleChats({ store, idleMs: 3 * 86_400_000, isBusy: () => false }), []);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
