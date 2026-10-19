import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openStore } from "../src/db.mjs";
import { WATCH_LIST_TOOL, watchListTools } from "../src/integrations/telegram-watch-list.mjs";

test("telegram_watch_list returns only the chats the watcher is on, with no secrets", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "griffin-watchlist-"));
  try {
    const store = openStore(path.join(dir, "t.sqlite"));
    const mk = (externalId, name, access, category) => {
      const p = store.upsertPerson({ integrationId: "i1", externalId, name, category });
      if (access) store.updatePerson(p.id, { access });
      return p;
    };
    mk("111", "علی", { watch: true });
    mk("-222", "گروه کار", { watch: true });
    mk("333", "خاموش", { watch: false });
    mk("444", "تیمی", null, "team");
    mk("555", "عادی", null);
    const tool = watchListTools({ store })[WATCH_LIST_TOOL];
    const out = JSON.parse((await tool.execute({})).content[0].text);
    const ids = out.chats.map((c) => c.id).sort();
    assert.deepEqual(ids, ["-222", "111", "444"]);
    assert.equal(out.count, 3);
    assert.equal(out.chats.find((c) => c.id === "-222").type, "group");
    assert.equal(out.chats.find((c) => c.id === "111").title, "علی");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
