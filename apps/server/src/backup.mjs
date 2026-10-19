// Periodic backups of the database (every chat, run, event, job, setting) so a broken disk, a bad
// migration or a wrong delete never costs the chats (owner 2026-10-18: «تا چتا نپرن»).
// Every BACKUP_EVERY_HOURS (default 6; 0 = off) a worker thread (backup-worker.mjs) takes an online
// copy with SQLite's backup API, checks it, and writes <dir>/griffin-<UTC stamp>.sqlite.gz (0600).
// <dir> = BACKUP_DIR, default <data>/backups — point it at another disk/mount to survive this one.
// Kept: the newest BACKUP_KEEP (default 8) plus the newest of each of the last 7 days.
// Restore: stop the app, keep the old file aside, `gunzip -c <backup> > <data>/griffin.sqlite`
// (remove any griffin.sqlite-wal/-shm next to it), start the app.
import fs from "node:fs";
import path from "node:path";
import { Worker } from "node:worker_threads";

const WORKER = new URL("./backup-worker.mjs", import.meta.url);
const NAME = /^griffin-(\d{8}T\d{6}Z)\.sqlite\.gz$/;

const stampOf = (date) => date.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
const dateOf = (stamp) => new Date(`${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T${stamp.slice(9, 11)}:${stamp.slice(11, 13)}:${stamp.slice(13, 15)}Z`);

// Which backup files to delete: all but the newest `keep` and the newest of each of the last `days` days.
export function toPrune(names, { keep = 8, days = 7 } = {}) {
  const sorted = names.filter((n) => NAME.test(n)).sort().reverse();
  const kept = new Set(sorted.slice(0, keep));
  const seenDays = new Set();
  for (const name of sorted) {
    const day = name.match(NAME)[1].slice(0, 8);
    if (seenDays.has(day)) continue;
    if (seenDays.size >= days) break;
    seenDays.add(day);
    kept.add(name);
  }
  return sorted.filter((n) => !kept.has(n));
}

export function createBackups({ store, dbFile, dataDir, config = () => ({}), now = () => Date.now(), log = console }) {
  let running = null;
  const settings = () => {
    const c = config();
    const hours = Number(c.every ?? 6);
    return {
      everyMs: Number.isFinite(hours) && hours > 0 ? hours * 3600_000 : 0,
      keep: Math.max(1, Number(c.keep) || 8),
      dir: c.dir || path.join(dataDir, "backups"),
    };
  };

  function list() {
    const { dir } = settings();
    let names = [];
    try {
      names = fs.readdirSync(dir).filter((n) => NAME.test(n));
    } catch {}
    return names.sort().reverse().map((name) => {
      let bytes = null;
      try {
        bytes = fs.statSync(path.join(dir, name)).size;
      } catch {}
      return { name, at: dateOf(name.match(NAME)[1]).toISOString(), bytes };
    });
  }

  function status() {
    const { everyMs, dir, keep } = settings();
    let last = null;
    try {
      last = JSON.parse(store.getKv("backup:last") || "null");
    } catch {}
    const files = list();
    return { enabled: everyMs > 0, everyHours: everyMs / 3600_000, keep, dir, running: Boolean(running), last, newest: files[0] || null, files };
  }

  function dbBytes() {
    let total = 0;
    for (const f of [dbFile, `${dbFile}-wal`]) {
      try {
        total += fs.statSync(f).size;
      } catch {}
    }
    return total;
  }

  async function once() {
    const { dir, keep } = settings();
    const started = now();
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const free = (() => {
      try {
        const s = fs.statfsSync(dir);
        return s.bavail * s.bsize;
      } catch {
        return null;
      }
    })();
    const need = dbBytes() * 1.5;
    if (free != null && free < need) throw new Error(`not enough disk for a backup in ${dir}: ${Math.round(free / 1024 ** 2)} MB free, ~${Math.round(need / 1024 ** 2)} MB needed`);

    const name = `griffin-${stampOf(new Date(started))}.sqlite.gz`;
    const final = path.join(dir, name);
    const part = `${final}.part`;
    const result = await new Promise((resolve, reject) => {
      const worker = new Worker(WORKER, { workerData: { src: dbFile, tmp: path.join(dir, `.${name}.tmp`), dest: part } });
      worker.once("message", resolve);
      worker.once("error", reject);
      worker.once("exit", (code) => code && reject(new Error(`backup worker stopped (${code})`)));
    });
    if (!result.ok) throw new Error(result.error);
    fs.renameSync(part, final);
    for (const old of toPrune(fs.readdirSync(dir), { keep })) fs.rmSync(path.join(dir, old), { force: true });
    return { ...result, file: name, ms: now() - started };
  }

  // One backup now; a second call while one runs joins it.
  function run(reason = "manual") {
    if (running) return running;
    running = once()
      .then((r) => {
        const last = { at: new Date(now()).toISOString(), ok: true, reason, ...r };
        store.setKv("backup:last", JSON.stringify(last));
        log.log?.(`[backup] ${r.file} ${Math.round(r.bytes / 1024 ** 2)} MB (${r.chats} chats) in ${Math.round(r.ms / 1000)}s`);
        return last;
      })
      .catch((error) => {
        const last = { at: new Date(now()).toISOString(), ok: false, reason, error: error.message };
        store.setKv("backup:last", JSON.stringify(last));
        log.error?.(`[backup] failed: ${error.message}`);
        return last;
      })
      .finally(() => {
        running = null;
      });
    return running;
  }

  // Due when no backup file is newer than the interval (the files survive a restart; kv may not).
  function due() {
    const { everyMs } = settings();
    if (!everyMs || running) return false;
    const newest = list()[0];
    const lastTry = (() => {
      try {
        return Date.parse(JSON.parse(store.getKv("backup:last") || "null")?.at) || 0;
      } catch {
        return 0;
      }
    })();
    // A failed try waits an hour before the next one, not the next tick.
    if (now() - lastTry < Math.min(everyMs, 3600_000)) return false;
    return !newest || now() - Date.parse(newest.at) >= everyMs;
  }

  function start({ firstAfterMs = 5 * 60_000, tickMs = 10 * 60_000 } = {}) {
    const tick = () => {
      if (due()) run("schedule");
    };
    setTimeout(tick, firstAfterMs).unref?.();
    setInterval(tick, tickMs).unref?.();
  }

  // For the doctor: a warning when the newest good backup is older than two intervals.
  function health() {
    const s = status();
    if (!s.enabled) return { level: "warn", title: "بکاپ خودکار گفتگوها خاموش است" };
    const ageH = s.newest ? (now() - Date.parse(s.newest.at)) / 3600_000 : null;
    if (s.last && !s.last.ok && (ageH == null || ageH > s.everyHours)) return { level: "error", title: "آخرین بکاپ گفتگوها ناموفق بود", detail: s.last.error };
    if (ageH == null) return s.running ? null : { level: "warn", title: "هنوز هیچ بکاپی از گفتگوها گرفته نشده" };
    if (ageH > s.everyHours * 2) return { level: "warn", title: "آخرین بکاپ گفتگوها {h} ساعت پیش است", vars: { h: Math.round(ageH) } };
    return null;
  }

  return { run, list, status, due, start, health };
}
