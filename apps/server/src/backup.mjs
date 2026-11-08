// Periodic backups of the database (every chat, run, event, job, setting) so a broken disk, a bad
// migration or a wrong delete never costs the chats (owner 2026-10-18: «تا چتا نپرن»).
// Every night at BACKUP_HOUR, in the owner's zone (GRIFFIN_TZ, else the server's; default 5, the quietest hour; off = no backups; owner
// 2026-11-04: «بکاپا رو کلا ببر شبا») a worker thread (backup-worker.mjs) takes an online copy with
// VACUUM INTO, checks it, and writes <dir>/griffin-<UTC stamp>.sqlite.gz (0600).
// <dir> = BACKUP_DIR, default <data>/backups — point it at another disk/mount to survive this one.
// Kept: the newest BACKUP_KEEP (default 8) plus the newest of each of the last 7 days.
// Restore: stop the app, keep the old file aside, `gunzip -c <backup> > <data>/griffin.sqlite`
// (remove any griffin.sqlite-wal/-shm next to it), start the app.
// Off the machine: with `offsite` (backup-offsite.mjs) set up, each backup is also sent to S3.
import { DEFAULT_TZ } from "./jobs/cron.mjs";
import fs from "node:fs";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { dropCopy, offsiteCopyPath } from "./backup-offsite.mjs";

const WORKER = new URL("./backup-worker.mjs", import.meta.url);
const NAME = /^griffin-(\d{8}T\d{6}Z)\.sqlite\.gz$/;
const LEFTOVER = /^(?:\.griffin-.*\.tmp(?:-\w+)?|griffin-.*\.part)$/;
const DEFAULT_HOUR = 5;
const EVERY_HOURS = 24;

const stampOf = (date) => date.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
const localHour = (ms) => Number(new Intl.DateTimeFormat("en-US", { timeZone: DEFAULT_TZ, hour: "2-digit", hourCycle: "h23" }).format(ms));
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

export function createBackups({ store, dbFile, dataDir, config = () => ({}), offsite = null, now = () => Date.now(), log = console }) {
  let running = null;
  let sending = null;
  const settings = () => {
    const c = config();
    const raw = String(c.hour ?? "").trim();
    const hour = Number(raw);
    return {
      hour: raw === "off" ? null : raw && Number.isInteger(hour) && hour >= 0 && hour < 24 ? hour : DEFAULT_HOUR,
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
    const { hour, dir, keep } = settings();
    let last = null;
    try {
      last = JSON.parse(store.getKv("backup:last") || "null");
    } catch {}
    const files = list();
    return { enabled: hour != null, hour, everyHours: hour != null ? EVERY_HOURS : 0, keep, dir, running: Boolean(running), last, newest: files[0] || null, files, offsite: offsite ? { ...offsite.status(), sending: Boolean(sending) } : null };
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

  // Off-site in the background: the local backup is done and answered; a slow upload never holds it.
  function sendOff(copy, dir) {
    sending = offsite
      .send(copy, dir)
      .catch((error) => log.error?.(`[backup] off-site: ${error.message}`))
      .finally(() => {
        dropCopy(copy);
        sending = null;
      });
    return sending;
  }

  async function once() {
    const { dir, keep: keepN } = settings();
    const started = now();
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    // A restart in the middle of a backup leaves its copy behind (nearly the database's whole size).
    for (const name of fs.readdirSync(dir)) if (LEFTOVER.test(name)) fs.rmSync(path.join(dir, name), { force: true });
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
    // The checked copy stays for the off-site run, unless one is still sending (it takes the next).
    const keep = offsite?.settings().configured && !sending ? offsiteCopyPath(dir) : "";
    const result = await new Promise((resolve, reject) => {
      const worker = new Worker(WORKER, { workerData: { src: dbFile, tmp: path.join(dir, `.${name}.tmp`), dest: part, keep } });
      worker.once("message", resolve);
      worker.once("error", reject);
      worker.once("exit", (code) => code && reject(new Error(`backup worker stopped (${code})`)));
    });
    if (!result.ok) throw new Error(result.error);
    fs.renameSync(part, final);
    for (const old of toPrune(fs.readdirSync(dir), { keep: keepN })) fs.rmSync(path.join(dir, old), { force: true });
    if (keep) sendOff(keep, dir);
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

  // Due in the night's hour when no backup file is from tonight (the files survive a restart; kv may
  // not). A new install does not wait for its first night, and a failed night does not wait for the next.
  function due() {
    const { hour } = settings();
    if (hour == null || running) return false;
    const newest = list()[0];
    const last = (() => {
      try {
        return JSON.parse(store.getKv("backup:last") || "null");
      } catch {
        return null;
      }
    })();
    // A failed try waits an hour before the next one, not the next tick.
    if (now() - (Date.parse(last?.at) || 0) < 3600_000) return false;
    if (!newest) return true;
    if (localHour(now()) !== hour && last?.ok !== false) return false;
    return now() - Date.parse(newest.at) >= 12 * 3600_000;
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

  // The off-site copy's own doctor line (missing, failing, behind).
  const offsiteHealth = () => {
    return offsite && settings().hour != null ? offsite.health(EVERY_HOURS) : null;
  };

  // Tests and shutdown: wait for an off-site send in flight.
  const idle = () => sending || Promise.resolve();

  return { run, list, status, due, start, health, offsiteHealth, idle };
}
