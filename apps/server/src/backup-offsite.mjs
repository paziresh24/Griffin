// Off-machine copy of every backup (owner 2026-10-29: «گریفین‌ها اکثراً روی nvme هستند… بکاپا رو بفرستیم
// روی s3» → «هر کسی باکت خودش، توی S3 آسیا»). The local backups in backup.mjs sit on the same disk as
// the database, so a dead disk takes both. After each local backup, restic sends one encrypted,
// deduplicated snapshot to the person's own bucket: the checked database copy plus the rest of the data
// folder (secrets box and key, Claude logins and transcripts, brand, VPN config), minus caches.
//
// Setup (Settings): config BACKUP_S3_URL = https://s3.west.example.org/<bucket>/griffin-backup, and app
// secrets backup/s3-access-key, backup/s3-secret-key, backup/password (restic's repository password —
// keep a copy outside this machine too, e.g. the person's Infisical: without it the snapshots cannot
// be read). Nothing set = off.
//
// Restore on a fresh machine (restic installed; same four values in the environment):
//   export RESTIC_REPOSITORY=s3:<BACKUP_S3_URL> AWS_ACCESS_KEY_ID=… AWS_SECRET_ACCESS_KEY=… RESTIC_PASSWORD=…
//   restic snapshots                       # pick one, or use "latest"
//   restic restore latest --target /tmp/r  # → /tmp/r/data/… (the container's /data)
//   cp -a /tmp/r/data/. <data dir>/ && mv <data dir>/backups/.offsite/griffin.sqlite <data dir>/griffin.sqlite
//   (app stopped; no griffin.sqlite-wal/-shm left beside it), then start the app.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const OFFSITE_SECRETS = { accessKey: "backup/s3-access-key", secretKey: "backup/s3-secret-key", password: "backup/password" };
const DAY = 24 * 3600_000;

// What never goes off the machine: the live database (the checked copy goes instead), the local
// backups (the copy is in there), caches and leftovers that rebuild themselves.
export function excludes({ dataDir, dbFile, backupDir }) {
  return [
    dbFile, `${dbFile}-wal`, `${dbFile}-shm`, `${dbFile}-journal`,
    path.join(backupDir, "griffin-*"), path.join(backupDir, ".griffin-*"),
    path.join(dataDir, "home", ".npm"), path.join(dataDir, "home", ".cache"),
    path.join(dataDir, "import-upload"), path.join(dataDir, "update"), path.join(dataDir, "uploads"),
  ];
}

export function createOffsite({ dataDir, dbFile, backupDir = path.join(dataDir, "backups"), url = () => "", secret = () => "", host = () => "griffin", store, now = () => Date.now(), restic = "restic", run = runRestic, log = console }) {
  const settings = () => {
    const u = String(url() || "").trim().replace(/\/+$/, "");
    const creds = { accessKey: secret(OFFSITE_SECRETS.accessKey), secretKey: secret(OFFSITE_SECRETS.secretKey), password: secret(OFFSITE_SECRETS.password) };
    const missing = [!u && "BACKUP_S3_URL", ...Object.entries(OFFSITE_SECRETS).filter(([k]) => !creds[k]).map(([, name]) => name)].filter(Boolean);
    return { url: u, creds, missing, configured: Boolean(u) && missing.length === 0, partly: missing.length < 4 };
  };

  const env = ({ url: u, creds }) => {
    const target = (() => {
      try {
        return new URL(u).hostname;
      } catch {
        return "";
      }
    })();
    return {
      ...process.env,
      RESTIC_REPOSITORY: `s3:${u}`,
      AWS_ACCESS_KEY_ID: creds.accessKey,
      AWS_SECRET_ACCESS_KEY: creds.secretKey,
      AWS_DEFAULT_REGION: process.env.AWS_DEFAULT_REGION || "us-east-1",
      RESTIC_PASSWORD: creds.password,
      RESTIC_CACHE_DIR: path.join(dataDir, "home", ".cache", "restic"),
      // Our own S3 is inside Iran: never through the VPN proxy the app's other traffic may use.
      NO_PROXY: [process.env.NO_PROXY, target].filter(Boolean).join(","),
      no_proxy: [process.env.no_proxy || process.env.NO_PROXY, target].filter(Boolean).join(","),
    };
  };

  const last = () => {
    try {
      return JSON.parse(store.getKv("backup:offsite") || "null");
    } catch {
      return null;
    }
  };

  // One snapshot of the data folder plus the checked database copy at dbCopy (in backup dir `dir`).
  async function send(dbCopy, dir = backupDir) {
    const s = settings();
    if (!s.configured) return null;
    const started = now();
    const e = env(s);
    const r = (args, opts) => run(restic, args, { env: e, ...opts });
    try {
      await r(["unlock"]).catch(() => {}); // stale locks of a run that died; live ones stay
      const paths = [dataDir];
      if (dbCopy && !path.resolve(dbCopy).startsWith(path.resolve(dataDir) + path.sep)) paths.push(dbCopy);
      const args = ["backup", "--json", "--host", host() || "griffin", "--tag", "griffin", ...excludes({ dataDir, dbFile, backupDir: dir }).flatMap((x) => ["--exclude", x]), ...paths];
      let out;
      try {
        out = await r(args);
      } catch (error) {
        if (!/does not exist|Is there a repository/i.test(error.message)) throw error;
        await r(["init"]);
        out = await r(args);
      }
      const summary = out.split("\n").map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      }).find((m) => m?.message_type === "summary") || {};
      let pruned = last()?.prunedAt || null;
      if (!pruned || now() - Date.parse(pruned) >= DAY) {
        await r(["forget", "--host", host() || "griffin", "--keep-last", "8", "--keep-daily", "7", "--keep-weekly", "4", "--keep-monthly", "6", "--prune"]);
        pruned = new Date(now()).toISOString();
      }
      const result = { at: new Date(now()).toISOString(), ok: true, snapshot: summary.snapshot_id || null, added: summary.data_added ?? null, total: summary.total_bytes_processed ?? null, ms: now() - started, prunedAt: pruned };
      store.setKv("backup:offsite", JSON.stringify(result));
      log.log?.(`[backup] off-site snapshot ${String(result.snapshot || "").slice(0, 8)} (+${Math.round((result.added || 0) / 1024 ** 2)} MB) in ${Math.round(result.ms / 1000)}s`);
      return result;
    } catch (error) {
      const result = { at: new Date(now()).toISOString(), ok: false, error: redact(error.message, s.creds), prunedAt: last()?.prunedAt || null };
      store.setKv("backup:offsite", JSON.stringify(result));
      log.error?.(`[backup] off-site failed: ${result.error}`);
      return result;
    }
  }

  function status() {
    const s = settings();
    return { configured: s.configured, url: s.url || null, missing: s.missing, last: last() };
  }

  // For the doctor: off-site missing, failing, or behind.
  function health(everyHours) {
    const s = settings();
    if (!s.configured) {
      return s.partly
        ? { level: "warn", title: "بکاپ بیرون از سرور نیمه‌کاره تنظیم شده؛ کم است: {missing}", vars: { missing: s.missing.join("، ") } }
        : { level: "warn", title: "بکاپ گفتگوها فقط روی دیسک همین سرور است؛ اگر دیسک خراب شود، بکاپ هم از دست می‌رود", detail: "BACKUP_S3_URL و سه سکرت backup/s3-access-key، backup/s3-secret-key و backup/password را در تنظیمات بگذارید" };
    }
    const l = last();
    if (l && !l.ok) return { level: "error", title: "بکاپ بیرون از سرور ناموفق بود", detail: l.error };
    const okAt = l?.ok ? Date.parse(l.at) : null;
    if (okAt && everyHours && now() - okAt > everyHours * 2 * 3600_000) return { level: "warn", title: "آخرین بکاپ بیرون از سرور {h} ساعت پیش است", vars: { h: Math.round((now() - okAt) / 3600_000) } };
    return null;
  }

  return { send, status, health, settings };
}

const redact = (text, creds) => Object.values(creds).filter((v) => v && v.length >= 6).reduce((t, v) => t.split(v).join("***"), String(text || "")).slice(0, 600);

// restic as a child process: stdout back, stderr's tail in the error. Six hours at most (a first
// upload of a big data folder over a slow link), then it is stopped.
export function runRestic(bin, args, { env, timeoutMs = 6 * 3600_000 } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(bin, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      return reject(error);
    }
    // Lowest CPU priority: an upload took 1-1.4 cores of a 6-core install next to its live chats
    // (2026-10-29); a backup may take longer, the pages must not wait for it.
    try {
      if (child.pid) os.setPriority(child.pid, 19);
    } catch {}
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => {
      out += d;
      if (out.length > 4 * 1024 ** 2) out = out.slice(-(1024 ** 2));
    });
    child.stderr.on("data", (d) => {
      err = (err + d).slice(-4000);
    });
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    timer.unref?.();
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error.code === "ENOENT" ? new Error(`${bin} is not installed in this image`) : error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      // 3 = snapshot made but some files could not be read (a file vanished mid-run): still a backup.
      if (code === 0 || (args[0] === "backup" && code === 3)) resolve(out);
      else reject(new Error(`restic ${args[0]} failed (${signal || code}): ${err.trim().split("\n").slice(-3).join(" | ")}`));
    });
  });
}

// The worker's checked copy, kept until restic has read it (backup.mjs).
export function offsiteCopyPath(backupDir) {
  return path.join(backupDir, ".offsite", "griffin.sqlite");
}

export function dropCopy(file) {
  for (const f of [file, `${file}-journal`]) fs.rmSync(f, { force: true });
}
