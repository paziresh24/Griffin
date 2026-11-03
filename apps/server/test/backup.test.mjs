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

test("off-site: one restic snapshot per backup, repo made on first use, prune once a day, secrets kept out of errors", async () => {
  const { createOffsite } = await import("../src/backup-offsite.mjs");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "griffin-backup-"));
  const dbFile = path.join(dir, "griffin.sqlite");
  const store = openStore(dbFile);
  store.db.prepare("INSERT INTO chats (id, title, created_at, updated_at) VALUES ('c1', 'hello', 'x', 'x')").run();
  let vals = {};
  let url = "";
  const calls = [];
  let inited = false;
  let fail = null;
  let t = Date.parse("2026-10-29T00:00:00Z");
  const run = async (bin, args, { env }) => {
    calls.push({ args, env });
    if (fail) throw new Error(fail);
    if (args[0] === "init") inited = true;
    if (args[0] === "backup") {
      if (!inited) throw new Error("Fatal: unable to open config file: Stat: The specified key does not exist.\nIs there a repository at the following location?");
      const copy = args.at(-1) === dir ? path.join(dir, "backups", ".offsite", "griffin.sqlite") : args.at(-1);
      assert.ok(fs.existsSync(copy), "the checked copy is there while restic reads it");
      return `{"message_type":"status"}\n{"message_type":"summary","snapshot_id":"abcdef123456","data_added":1048576,"total_bytes_processed":2097152}\n`;
    }
    return "";
  };
  const offsite = createOffsite({ store, dataDir: dir, dbFile, url: () => url, secret: (n) => vals[n], run, now: () => t, log: {} });
  const backups = createBackups({ store, dbFile, dataDir: dir, offsite, now: () => t, log: {} });

  assert.match(backups.offsiteHealth().title, /فقط روی دیسک همین سرور/);
  await backups.run();
  await backups.idle();
  assert.equal(calls.length, 0, "not set up = nothing sent");

  vals = { "backup/s3-access-key": "AKIAEXAMPLE", "backup/s3-secret-key": "s3cr3t-value", "backup/password": "restic-pass-123" };
  assert.match(backups.offsiteHealth().title, /نیمه‌کاره/, "keys without a bucket address");
  url = "https://s3.west.example.org/example-bucket/griffin-backup/";
  await backups.run();
  await backups.idle();
  const verbs = calls.map((c) => c.args[0]);
  assert.deepEqual(verbs, ["unlock", "backup", "init", "backup", "forget"]);
  const backup = calls.find((c) => c.args[0] === "backup");
  assert.equal(backup.env.RESTIC_REPOSITORY, "s3:https://s3.west.example.org/example-bucket/griffin-backup");
  assert.equal(backup.env.AWS_SECRET_ACCESS_KEY, "s3cr3t-value");
  assert.match(backup.env.NO_PROXY, /s3\.west\.example\.org/);
  assert.ok(backup.args.includes(dbFile) && backup.args[backup.args.indexOf(dbFile) - 1] === "--exclude", "the live database is never read by restic");
  assert.ok(backup.args.includes(path.join(dir, "home", ".npm")));
  assert.ok(!fs.existsSync(path.join(dir, "backups", ".offsite", "griffin.sqlite")), "the copy is dropped after sending");
  const st = backups.status().offsite;
  assert.equal(st.configured, true);
  assert.equal(st.last.snapshot, "abcdef123456");
  assert.equal(backups.offsiteHealth(), null);

  calls.length = 0;
  t += 6 * 3600_000;
  await backups.run();
  await backups.idle();
  assert.deepEqual(calls.map((c) => c.args[0]), ["unlock", "backup"], "prune waits a day");

  fail = "restic backup failed (1): bad key s3cr3t-value";
  t += 6 * 3600_000;
  await backups.run();
  await backups.idle();
  const h = backups.offsiteHealth();
  assert.equal(h.level, "error");
  assert.ok(!h.detail.includes("s3cr3t-value"), "the secret never shows in the doctor");

  vals["backup/password"] = "";
  assert.match(backups.offsiteHealth().title, /نیمه‌کاره/);
});
