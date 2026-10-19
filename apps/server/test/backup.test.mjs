import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { DatabaseSync } from "node:sqlite";
import { openStore } from "../src/db.mjs";
import { createBackups, toPrune } from "../src/backup.mjs";

test("prune keeps the newest few and one per day for a week", () => {
  const names = [];
  for (let d = 1; d <= 12; d++) for (const h of ["00", "06", "12", "18"]) names.push(`griffin-202610${String(d).padStart(2, "0")}T${h}0000Z.sqlite.gz`);
  const gone = new Set(toPrune([...names, "other.txt"], { keep: 3, days: 7 }));
  const kept = names.filter((n) => !gone.has(n));
  assert.ok(kept.includes("griffin-20261012T180000Z.sqlite.gz"));
  assert.ok(kept.includes("griffin-20261012T120000Z.sqlite.gz"));
  assert.ok(kept.includes("griffin-20261006T180000Z.sqlite.gz"));
  assert.ok(!kept.includes("griffin-20261005T180000Z.sqlite.gz"));
  assert.equal(kept.length, 3 + 6);
  assert.ok(!gone.has("other.txt"));
});

test("a backup is a gzipped, checked copy that reopens with the chats", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "griffin-backup-"));
  const dbFile = path.join(dir, "griffin.sqlite");
  const store = openStore(dbFile);
  store.db.prepare("INSERT INTO chats (id, title, created_at, updated_at) VALUES ('c1', 'hello', 'x', 'x')").run();
  const backups = createBackups({ store, dbFile, dataDir: dir, log: {} });
  assert.equal(backups.due(), true);
  const [a, b] = [backups.run(), backups.run()];
  assert.equal(a, b, "a second call joins the running one");
  const r = await a;
  assert.equal(r.ok, true, r.error);
  assert.equal(r.chats, 1);
  const files = backups.list();
  assert.equal(files.length, 1);
  assert.equal(backups.due(), false);
  assert.equal(backups.health(), null);
  const out = path.join(dir, "restored.sqlite");
  fs.writeFileSync(out, gunzipSync(fs.readFileSync(path.join(dir, "backups", files[0].name))));
  const copy = new DatabaseSync(out, { readOnly: true });
  assert.equal(copy.prepare("SELECT title FROM chats WHERE id = 'c1'").get().title, "hello");
  copy.close();
  assert.equal(fs.readdirSync(path.join(dir, "backups")).length, 1, "no .part or temp left");
});

test("off and failures show up in the doctor", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "griffin-backup-"));
  const store = openStore(path.join(dir, "griffin.sqlite"));
  const off = createBackups({ store, dbFile: path.join(dir, "griffin.sqlite"), dataDir: dir, config: () => ({ every: 0 }), log: {} });
  assert.equal(off.due(), false);
  assert.equal(off.health().level, "warn");
  const broken = createBackups({ store, dbFile: path.join(dir, "missing.sqlite"), dataDir: dir, log: {} });
  const r = await broken.run();
  assert.equal(r.ok, false);
  assert.equal(broken.health().level, "error");
  assert.equal(broken.due(), false, "a failed try waits before the next");
});
