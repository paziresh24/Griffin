// The sidebar list reads each per-chat fact once for the whole list (app.mjs listReads): ~10 queries
// per chat took ~0.4 s for 745 chats on 2026-10-28, on every list reload. The list must still say
// exactly what each chat's own read says.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp } from "../src/app.mjs";
import { openStore } from "../src/db.mjs";

test("the chat list says of each chat what the chat's own read says", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "griffin-listreads-"));
  const store = openStore(path.join(dir, "db.sqlite"));
  try {
    const app = createApp({ store, runner: { isActive: () => false } });
    const plain = store.createChat({ title: "ساده", mode: "agent" });
    const kept = store.createChat({ title: "پیام مانده", mode: "agent" });
    const fast = store.createChat({ title: "سریع", mode: "agent" });
    const failed = store.createChat({ title: "خطا", mode: "agent" });
    const reminded = store.createChat({ title: "یادآوری", mode: "agent" });
    store.setKv(`kept:${kept.id}`, [{ id: "k1", message: "x", ids: [] }, { id: "k2", message: "y", ids: [] }]);
    store.setKv(`fast:${fast.id}`, true);
    const runId = store.startRun(failed.id);
    store.finishRun(failed.id, runId, "error", "boom");
    store.setKv(`resolved:${failed.id}`, "2999-01-01T00:00:00.000Z");
    store.createNote({ text: "بعداً", chatId: reminded.id, runAt: "2999-01-02T00:00:00.000Z" });
    store.createNote({ text: "زودتر", chatId: reminded.id, runAt: "2999-01-01T00:00:00.000Z" });

    const { chats } = await (await app.request("/api/chats")).json();
    for (const chat of [plain, kept, fast, failed, reminded]) {
      const listed = chats.find((c) => c.id === chat.id);
      const own = (await (await app.request(`/api/chats/${chat.id}`)).json()).chat;
      // The list query alone knows where a chat came from (source, owner); the rest must match.
      const { usage, usageBilled, source, ownerKey, ownerLabel, ...ownFields } = own;
      const { source: s, ownerKey: k, ownerLabel: l, ...listedFields } = listed;
      assert.deepEqual(listedFields, ownFields, chat.title);
    }
    const byId = Object.fromEntries(chats.map((c) => [c.id, c]));
    assert.deepEqual(byId[kept.id].kept, ["k1", "k2"]);
    assert.equal(byId[fast.id].fast, true);
    assert.equal(byId[reminded.id].reminderAt, "2999-01-01T00:00:00.000Z");
    assert.equal(byId[plain.id].reminderAt, null);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
