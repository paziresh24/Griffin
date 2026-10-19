import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { Worker } from "node:worker_threads";

// Setup wizard → «انتقال از ابزار قبلی». Claude Code / Claude desktop history comes
// in from a folder on this server or an uploaded tar of ~/.claude/projects, through the same importer
// as scripts/from-claude-desktop.mjs: each session becomes a Griffin chat that resumes the same Claude
// session. Owner-only (/api/*). Only counts and titles go back, never transcript text.

const run = promisify(execFile);
const WORKER = new URL("../scripts/import-worker.mjs", import.meta.url);
export const MAX_UPLOAD = 1024 ** 3; // 1 GB compressed
export const MAX_UNPACKED = 4 * 1024 ** 3;
const UPLOAD_ID = /^[a-f0-9]{16}$/;

const inside = (root, p) => p === root || p.startsWith(root + path.sep);

/**
 * The projects folder a typed path points at: the path itself, or its projects/ or .claude/projects/.
 * Only inside `roots` (after symlinks are resolved); anything else is an error, not a guess.
 */
export function resolveSource(input, roots) {
  const raw = String(input || "").trim().replace(/^~(?=$|\/)/, roots[0] || "~");
  if (!raw || !path.isAbsolute(raw)) throw new Error("مسیر باید کامل باشد (با / شروع شود)");
  let real;
  try {
    real = fs.realpathSync(raw);
  } catch {
    throw new Error("چنین پوشه‌ای روی سرور نیست");
  }
  const allowed = roots.filter(Boolean).map((r) => {
    try {
      return fs.realpathSync(r);
    } catch {
      return path.resolve(r);
    }
  });
  if (!allowed.some((r) => inside(r, real))) throw new Error(`فقط داخل این پوشه‌ها: ${allowed.join("، ")}`);
  for (const sub of ["projects", path.join(".claude", "projects")]) {
    const p = path.join(real, sub);
    if (fs.existsSync(p) && fs.statSync(p).isDirectory()) return fs.realpathSync(p);
  }
  if (!fs.statSync(real).isDirectory()) throw new Error("این یک پوشه نیست");
  return real;
}

// An uploaded archive may hold links to anywhere: none survive unpacking.
function dropLinks(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isSymbolicLink()) fs.rmSync(p, { force: true });
    else if (e.isDirectory()) dropLinks(p);
  }
}

export function summarizeRows(rows) {
  const count = (re) => rows.filter((r) => re.test(r.action || "")).length;
  return {
    sessions: rows.length,
    projects: new Set(rows.map((r) => r.cwd)).size,
    toImport: count(/^(would move|moved)$/),
    imported: count(/^moved$/),
    already: count(/^skipped/),
    missing: count(/missing/),
    titles: rows.filter((r) => /move/.test(r.action || "")).slice(0, 8).map((r) => r.title),
  };
}

function inWorker(data) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER, { workerData: data });
    worker.once("message", resolve);
    worker.once("error", reject);
    worker.once("exit", (code) => code && reject(new Error(`import stopped (${code})`)));
  });
}

export function historyImportRoutes(api, { dataDir, roots, dbFile, claudeHome, workspace = "/workspace", onImported = () => {} }) {
  const uploads = path.join(dataDir, "import-upload");
  const source = (body) => {
    if (body.upload) {
      if (!UPLOAD_ID.test(String(body.upload))) throw new Error("bad upload id");
      const dir = path.join(uploads, body.upload, "files");
      if (!fs.existsSync(dir)) throw new Error("فایل بارگذاری‌شده دیگر نیست؛ دوباره بفرست");
      return resolveSource(dir, [dir]);
    }
    return resolveSource(body.path, roots);
  };

  // Where an import would read by default, and whether anything is there.
  api.get("/api/setup/import", (c) => {
    let found = null;
    try {
      found = resolveSource(claudeHome, roots);
    } catch {
      found = null;
    }
    return c.json({ defaultPath: claudeHome, found: Boolean(found), roots, maxUpload: MAX_UPLOAD });
  });

  api.post("/api/setup/import/upload", async (c) => {
    const size = Number(c.req.header("content-length") || 0);
    if (size > MAX_UPLOAD) return c.json({ error: "فایل بزرگ‌تر از ۱ گیگابایت است" }, 413);
    if (!c.req.raw.body) return c.json({ error: "فایلی نرسید" }, 400);
    fs.mkdirSync(uploads, { recursive: true });
    for (const old of fs.readdirSync(uploads)) {
      const p = path.join(uploads, old);
      if (Date.now() - fs.statSync(p).mtimeMs > 86_400_000) fs.rmSync(p, { recursive: true, force: true });
    }
    const id = randomBytes(8).toString("hex");
    const dir = path.join(uploads, id);
    const file = path.join(dir, "upload");
    fs.mkdirSync(path.join(dir, "files"), { recursive: true });
    let seen = 0;
    try {
      await pipeline(
        Readable.fromWeb(c.req.raw.body),
        new Transform({
          transform(chunk, _enc, cb) {
            seen += chunk.length;
            cb(seen > MAX_UPLOAD ? new Error("فایل بزرگ‌تر از ۱ گیگابایت است") : null, chunk);
          },
        }),
        fs.createWriteStream(file, { mode: 0o600 }),
      );
      const head = Buffer.alloc(2);
      const fd = fs.openSync(file, "r");
      fs.readSync(fd, head, 0, 2, 0);
      fs.closeSync(fd);
      if (head.toString("latin1") === "PK") throw new Error("فایل zip پشتیبانی نمی‌شود؛ همان پوشه را با tar.gz بفرست (دستورش بالای همین صفحه است)");
      // The listing first: refuse an archive that would unpack into more than MAX_UNPACKED.
      const { stdout } = await run("tar", ["-tvf", file], { maxBuffer: 256 * 1024 ** 2 });
      const total = stdout.split("\n").reduce((n, line) => n + (Number(line.trim().split(/\s+/)[2]) || 0), 0);
      if (total > MAX_UNPACKED) throw new Error("محتوای فایل بیش از ۴ گیگابایت است");
      // GNU tar strips leading «/» and refuses «..» members; links are dropped right after.
      await run("tar", ["-xf", file, "-C", path.join(dir, "files"), "--no-same-owner", "--no-same-permissions"], { maxBuffer: 16 * 1024 ** 2 });
      fs.rmSync(file, { force: true });
      dropLinks(path.join(dir, "files"));
      return c.json({ upload: id });
    } catch (error) {
      fs.rmSync(dir, { recursive: true, force: true });
      const message = /tar/.test(String(error.message)) && !/[؀-ۿ]/.test(error.message) ? "این فایل tar یا tar.gz سالم نیست" : error.message;
      return c.json({ error: message }, 400);
    }
  });

  // dryRun: true = what would come in (counts only); false = bring it in.
  api.post("/api/setup/import", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    let projects;
    try {
      projects = source(body);
    } catch (error) {
      return c.json({ error: error.message }, 400);
    }
    const dryRun = body.dryRun !== false;
    try {
      const rows = await inWorker({ projects, db: dbFile, claudeHome, workspace, dryRun });
      if (!dryRun) {
        onImported(rows);
        if (body.upload) fs.rmSync(path.join(uploads, body.upload), { recursive: true, force: true });
      }
      return c.json({ dryRun, ...summarizeRows(rows) });
    } catch (error) {
      return c.json({ error: `خواندن تاریخچه نشد: ${error.message}` }, 400);
    }
  });
}
