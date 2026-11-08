// «تغییرات» and «ترمینال» beside a chat: what the chat's own worktree changed against the branch it
// came from (committed or not), and one command at a time run in that folder.

import { execFile } from "node:child_process";
import path from "node:path";

const GIT_TIMEOUT_MS = 20_000;
const MAX_DIFF = 300 * 1024;
const MAX_UNTRACKED = 200;
const TERMINAL_TIMEOUT_MS = 120_000;
const MAX_OUTPUT = 512 * 1024;

const run = (cmd, args, opts) =>
  new Promise((resolve) => {
    execFile(cmd, args, { maxBuffer: MAX_OUTPUT * 4, ...opts }, (error, stdout, stderr) => resolve({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, stdout: String(stdout || ""), stderr: String(stderr || ""), timedOut: Boolean(error?.killed) }));
  });
const git = (args, dir) => run("git", args, { cwd: dir, timeout: GIT_TIMEOUT_MS });
const out = async (args, dir) => {
  const result = await git(args, dir);
  return result.code === 0 ? result.stdout.trim() : null;
};

async function baseOf(dir) {
  for (const ref of ["origin/HEAD", "origin/main", "origin/master", "main", "master"]) {
    const base = await out(["merge-base", "HEAD", ref], dir);
    if (base) return base;
  }
  return "HEAD";
}

/** -> { branch, files: [{ path, add, del, status }], add, del }, or null when the folder is no repo. */
export async function chatChanges(dir) {
  const branch = await out(["rev-parse", "--abbrev-ref", "HEAD"], dir);
  if (branch == null) return null;
  const base = await baseOf(dir);
  const numstat = await git(["diff", "--numstat", "--no-renames", "-z", base], dir);
  const files = [];
  for (const row of numstat.stdout.split("\0").filter(Boolean)) {
    const [add, del, ...rest] = row.split("\t");
    files.push({ path: rest.join("\t"), add: Number(add) || 0, del: Number(del) || 0, status: "modified", binary: add === "-" });
  }
  const untracked = await git(["ls-files", "--others", "--exclude-standard", "-z"], dir);
  for (const file of untracked.stdout.split("\0").filter(Boolean).slice(0, MAX_UNTRACKED)) files.push({ path: file, add: 0, del: 0, status: "new" });
  return { branch, files, add: files.reduce((sum, f) => sum + f.add, 0), del: files.reduce((sum, f) => sum + f.del, 0) };
}

/** One file of chatChanges; any other path is refused, so a request cannot read outside the list. */
export async function chatFileDiff(dir, file) {
  const changes = await chatChanges(dir);
  const entry = changes?.files.find((f) => f.path === file);
  if (!entry) return null;
  const result = entry.status === "new"
    // Exit 1 is how --no-index says «they differ».
    ? await git(["diff", "--no-index", "--", "/dev/null", file], dir)
    : await git(["diff", "--no-renames", await baseOf(dir), "--", file], dir);
  const truncated = result.stdout.length > MAX_DIFF;
  return { path: file, diff: truncated ? result.stdout.slice(0, MAX_DIFF) : result.stdout, truncated };
}

// ponytail: one command at a time with a timeout, no PTY; a server that must keep running goes through
// preview_start, an interactive program does not work here. Add node-pty if a real terminal is wanted.
// The env carries nothing of the app's: its secrets stay out of a shell the page can drive.
export async function chatTerminalRun(dir, { command, cwd }) {
  const inside = cwd && (path.resolve(cwd) === dir || path.resolve(cwd).startsWith(`${dir}${path.sep}`));
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, LANG: process.env.LANG || "C.UTF-8", TERM: "dumb" };
  const result = await run("bash", ["-c", command], { cwd: inside ? path.resolve(cwd) : dir, env, timeout: TERMINAL_TIMEOUT_MS, maxBuffer: MAX_OUTPUT });
  return { stdout: result.stdout, stderr: result.timedOut ? `${result.stderr}\n[متوقف شد: بیشتر از ${TERMINAL_TIMEOUT_MS / 1000} ثانیه طول کشید]` : result.stderr, code: result.code };
}
