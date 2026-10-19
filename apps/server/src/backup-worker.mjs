// One backup on its own thread (backup.mjs): an online copy of the live database with SQLite's own
// backup API (consistent while the server keeps writing — WAL readers do not block writers), checked
// with quick_check, then gzipped. Nothing here runs on the server's event loop.
import { parentPort, workerData } from "node:worker_threads";
import { DatabaseSync, backup } from "node:sqlite";
import { createReadStream, createWriteStream, rmSync, statSync } from "node:fs";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";

const { src, tmp, dest } = workerData;
const dropTmp = () => { for (const f of [tmp, `${tmp}-wal`, `${tmp}-shm`, `${tmp}-journal`]) rmSync(f, { force: true }); };
try {
  const live = new DatabaseSync(src, { readOnly: true });
  live.exec("PRAGMA busy_timeout = 5000;");
  await backup(live, tmp, { rate: 512 });
  live.close();

  // The copy carries the live file's WAL mode: fold it into one file (no -wal/-shm beside it) so the
  // gzip holds every page.
  const copy = new DatabaseSync(tmp);
  copy.exec("PRAGMA journal_mode = DELETE;");
  const check = copy.prepare("PRAGMA quick_check").get();
  const verdict = check ? Object.values(check)[0] : "no answer";
  const chats = copy.prepare("SELECT COUNT(*) AS n FROM chats").get().n;
  const events = copy.prepare("SELECT MAX(id) AS n FROM events").get().n || 0;
  copy.close();
  if (verdict !== "ok") throw new Error(`copy failed quick_check: ${verdict}`);

  await pipeline(createReadStream(tmp), createGzip({ level: 6 }), createWriteStream(dest, { mode: 0o600 }));
  const rawBytes = statSync(tmp).size;
  dropTmp();
  parentPort.postMessage({ ok: true, bytes: statSync(dest).size, rawBytes, chats, events });
} catch (error) {
  dropTmp();
  rmSync(dest, { force: true });
  parentPort.postMessage({ ok: false, error: error.message });
}
