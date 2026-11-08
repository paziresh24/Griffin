// One backup on its own thread (backup.mjs): an online copy of the live database with VACUUM INTO, one
// read snapshot that the server's writes never disturb, checked with quick_check, then gzipped. Not
// SQLite's backup API: every write from another connection restarts it, so on a busy server it rewrote
// the same file for half an hour and more and kept the disk from everything else (2026-11-04).
// Nothing here runs on the server's event loop.
import { parentPort, workerData } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";
import { createReadStream, createWriteStream, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";

// keep: where to leave the checked copy for the off-site run (backup-offsite.mjs); empty = drop it.
const { src, tmp, dest, keep } = workerData;
const dropTmp = () => { for (const f of [tmp, `${tmp}-wal`, `${tmp}-shm`, `${tmp}-journal`]) rmSync(f, { force: true }); };
try {
  const live = new DatabaseSync(src, { readOnly: true });
  live.exec("PRAGMA busy_timeout = 5000;");
  live.prepare("VACUUM INTO ?").run(tmp);
  live.close();

  const copy = new DatabaseSync(tmp);
  const check = copy.prepare("PRAGMA quick_check").get();
  const verdict = check ? Object.values(check)[0] : "no answer";
  const chats = copy.prepare("SELECT COUNT(*) AS n FROM chats").get().n;
  const events = copy.prepare("SELECT MAX(id) AS n FROM events").get().n || 0;
  copy.close();
  if (verdict !== "ok") throw new Error(`copy failed quick_check: ${verdict}`);

  await pipeline(createReadStream(tmp), createGzip({ level: 6 }), createWriteStream(dest, { mode: 0o600 }));
  const rawBytes = statSync(tmp).size;
  if (keep) {
    mkdirSync(dirname(keep), { recursive: true, mode: 0o700 });
    renameSync(tmp, keep);
  }
  dropTmp();
  parentPort.postMessage({ ok: true, bytes: statSync(dest).size, rawBytes, chats, events });
} catch (error) {
  dropTmp();
  rmSync(dest, { force: true });
  parentPort.postMessage({ ok: false, error: error.message });
}
