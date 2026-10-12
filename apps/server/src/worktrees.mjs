// Per-chat git worktrees: desktop parity for parallel chats. Today every owner chat shares the
// one checkout at <reposRoot>/<repo> — two chats running at once step on each other's files. Each
// chat instead gets its own worktree under <reposRoot>/_wt/griffin-<chatId8>, on its own branch
// griffin/<chatId8>, cut from the repo's own default branch at origin. The main checkout
// (<reposRoot>/<repo> itself) is never written to by any of this.
//
// Every git call here is async (execFile, never execFileSync) with a timeout, because
// ensureChatWorktree runs on the hot path of a live HTTP request (agentOptions) on a server that
// serves many chats at once — a blocking sync call would freeze every other request on the
// process while git runs.
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const FETCH_TIMEOUT_MS = 60_000;
const GIT_TIMEOUT_MS = 20_000;
// Chats created within this window share one `git fetch` of their repo.
const FETCH_FRESH_MS = 30_000;
const LOCK_RETRY_DELAY_MS = 1_000;
// A caller gives up on a creation after CREATION_DEADLINE_MS; the deadline aborts only `git fetch`
// (network). `git worktree add` is local and normally fast, and is never aborted or timed out: a
// killed add leaves a locked, half-made worktree behind. A caller waiting for the repo lock gives
// up after LOCK_WAIT_MS.
const CREATION_DEADLINE_MS = 150_000;
const LOCK_WAIT_MS = 180_000;
// A lock file older than this was left by a git that died (a killed fetch or add).
const STALE_LOCK_MS = 10 * 60_000;
// Another git process holds one of the repo's lock files (a ref, packed-refs, the index).
const LOCK_ERROR = /cannot lock ref|Unable to create '[^']*\.lock'|\.lock': File exists|another git process/i;

/// A chat's worktree could not be set up (git failed or timed out: code WORKTREE) or the repo lock
// could not be had in time (code WORKTREE_LOCK). The runner retries a start only for these.
export class WorktreeError extends Error {
  constructor(message, { cause, code = "WORKTREE" } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "WorktreeError";
    this.code = code;
  }
}
export const isWorktreeError = (error) => error instanceof WorktreeError || error?.code === "WORKTREE" || error?.code === "WORKTREE_LOCK";

// Per repo: one git operation chain at a time. Parallel `git fetch` runs in one repo collide on
// refs/remotes/origin/* ("cannot lock ref"), and so do parallel `worktree add -b` on packed-refs.
const repoQueues = new Map(); // repoDir -> tail promise
// The lock is keyed by the repo's real path (case-folded on Windows), so two spellings of one repo
// (D:\x vs d:\X, a short 8.3 name) share one lock.
export function repoLockKey(repoDir) {
  let real = path.resolve(repoDir);
  try {
    real = fs.realpathSync.native(real);
  } catch {
    try {
      real = fs.realpathSync(real);
    } catch {
      // not on disk: keep the resolved path
    }
  }
  return process.platform === "win32" ? real.toLowerCase() : real;
}
// A waiter that cannot get the lock within waitMs gives up with a WORKTREE_LOCK error (the chain
// behind it still waits for the holder, never for the waiter that left).
function withRepoLock(repoPath, fn, { waitMs = LOCK_WAIT_MS } = {}) {
  const repoDir = repoLockKey(repoPath);
  const previous = (repoQueues.get(repoDir) || Promise.resolve()).catch(() => {});
  const acquired = new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new WorktreeError(`gave up after ${waitMs}ms waiting for the git lock on ${repoDir}`, { code: "WORKTREE_LOCK" })),
      waitMs,
    );
    previous.then(() => {
      clearTimeout(timer);
      resolve();
    });
  });
  const run = acquired.then(fn);
  const tail = Promise.all([previous, run.catch(() => {})]).then(() => {});
  repoQueues.set(repoDir, tail);
  tail.then(() => {
    if (repoQueues.get(repoDir) === tail) repoQueues.delete(repoDir);
  });
  return run;
}

const lastFetch = new Map(); // repoDir -> time of the last successful fetch
// Worktree creations in flight, by worktree dir: a second call for the same chat, or an archive
// of that chat, waits for it instead of racing it.
const creating = new Map(); // dir -> promise

export function shortId(chatId) {
  return String(chatId || "").replace(/[^a-zA-Z0-9]/g, "").slice(0, 8) || "chat";
}

export function worktreeDir(reposRoot, chatId) {
  return path.join(reposRoot, "_wt", `griffin-${shortId(chatId)}`);
}

export function branchName(chatId) {
  return `griffin/${shortId(chatId)}`;
}

// Default execFn: a real async, non-blocking child process (never execFileSync — that would
// block the whole Node event loop, i.e. every other request this server is handling).
function defaultExecFn(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, opts, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => clearTimeout(timer));
}

// timeoutMs 0 = no timeout (only `git worktree add`, which must never be killed half-way).
async function git(args, cwd, execFn, timeoutMs = GIT_TIMEOUT_MS, extra = {}) {
  // execFile's own timeout kills the child too, so a timed-out git never keeps holding a lock.
  const run = execFn("git", args, { cwd, encoding: "utf8", timeout: timeoutMs, ...extra });
  const out = timeoutMs ? await withTimeout(run, timeoutMs, `git ${args[0]}`) : await run;
  return String(out).trim();
}

// A lock held by another git process is usually gone a moment later: retry once.
async function gitRetryingLock(args, cwd, execFn, timeoutMs, retryDelayMs, extra) {
  try {
    return await git(args, cwd, execFn, timeoutMs, extra);
  } catch (error) {
    if (!LOCK_ERROR.test(String(error?.message || "")) || extra?.signal?.aborted) throw error;
    await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    return git(args, cwd, execFn, timeoutMs, extra);
  }
}

async function defaultBranch(repoDir, execFn, gitTimeoutMs) {
  try {
    return (await git(["symbolic-ref", "refs/remotes/origin/HEAD"], repoDir, execFn, gitTimeoutMs)).replace("refs/remotes/origin/", "");
  } catch {
    try {
      return (await git(["symbolic-ref", "HEAD"], repoDir, execFn, gitTimeoutMs)).replace("refs/heads/", "");
    } catch {
      return "main";
    }
  }
}

async function branchExists(repoDir, branch, execFn, gitTimeoutMs) {
  try {
    await git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], repoDir, execFn, gitTimeoutMs);
    return true;
  } catch {
    return false;
  }
}

// The git repos that exist directly under reposRoot (the owner's own clones) — for a chat's repo
// picker. "_wt" (Griffin's own worktrees) is never offered as a pickable repo. fs-only, so this
// stays synchronous — no git spawned.
export function listRepos(reposRoot, { readdirSync = fs.readdirSync } = {}) {
  let entries;
  try {
    entries = readdirSync(reposRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && e.name !== "_wt" && fs.existsSync(path.join(reposRoot, e.name, ".git")))
    .map((e) => e.name)
    .sort();
}

// A repo name is only ever a bare directory name directly under reposRoot: no separators, no
// "..", and it must actually be one of the git repos listRepos() would offer. This is the same
// check used to guard chat creation/PATCH against a path-traversal repo value.
export function isValidRepoName(reposRoot, repo) {
  if (typeof repo !== "string" || !repo || repo.includes("/") || repo.includes("\\") || repo.includes("..")) {
    return false;
  }
  return listRepos(reposRoot).includes(repo);
}

// Git's own "HEAD does not resolve" answer: `rev-parse --verify --quiet` exits 1 and prints
// nothing. Anything else (a timeout, a spawn error, exit 128) says nothing about the tree.
const isNoSuchRef = (error) => error?.code === 1 && !error?.killed && !error?.signal;

// What state a chat's worktree is in:
//   null                         usable as is (an owner's `git worktree lock` does not stop use);
//   "missing"                    no worktree there yet;
//   { unusable: reason }         a killed `worktree add` (lock reason exactly "initializing" and no
//                                files checked out), or a HEAD that really does not resolve after
//                                a retry — the tree is left alone and the chat moves to a new one;
//   { unknown: reason }          a check itself failed (git error, timeout, unreadable folder) —
//                                nothing may be concluded, so nothing is touched.
export async function worktreeProblem(dir, { execFn = defaultExecFn, existsSync = fs.existsSync, gitTimeoutMs = GIT_TIMEOUT_MS } = {}) {
  const dotGit = path.join(dir, ".git");
  if (!existsSync(dotGit)) return "missing";
  let adminDir = dotGit;
  try {
    if (fs.statSync(dotGit).isFile()) {
      const gitdir = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotGit, "utf8"));
      if (gitdir) adminDir = path.resolve(dir, gitdir[1].trim());
    }
  } catch (error) {
    return { unknown: `.git unreadable (${error.code || error.message})` };
  }
  let lockReason = null;
  try {
    lockReason = fs.readFileSync(path.join(adminDir, "locked"), "utf8").trim();
  } catch (error) {
    if (error.code !== "ENOENT") return { unknown: `lock file unreadable (${error.code || error.message})` };
  }
  let entries;
  try {
    entries = fs.readdirSync(dir).filter((name) => name !== ".git");
  } catch (error) {
    return { unknown: `folder unreadable (${error.code || error.message})` };
  }
  if (lockReason === "initializing" && !entries.length) return { unusable: "an interrupted `git worktree add` (locked: initializing, no files)" };
  let lastError;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      await git(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], dir, execFn, gitTimeoutMs);
      return null;
    } catch (error) {
      lastError = error;
    }
  }
  if (isNoSuchRef(lastError)) return { unusable: "HEAD does not resolve" };
  const firstLine = String(lastError?.message || lastError).split(/\r?\n/)[0];
  return { unknown: `git rev-parse HEAD failed (${firstLine})` };
}

// The chat's worktrees in order: griffin-<id8>, then griffin-<id8>-2, -3, … Each one after the
// first was made because the one before it looked unusable; that one is kept for the owner.
const slotDir = (reposRoot, chatId, n) => (n === 1 ? worktreeDir(reposRoot, chatId) : `${worktreeDir(reposRoot, chatId)}-${n}`);
const slotBranch = (chatId, n) => (n === 1 ? branchName(chatId) : `${branchName(chatId)}-${n}`);

// The chat's current worktree: the last slot whose folder exists (or the first, if none does).
// A chat has at most two trees: its base tree and ONE replacement (-2). A -2 that is unusable too
// fails the start instead of piling up -3, -4, ...
export const MAX_SLOT = 2;
const slotAt = (reposRoot, chatId, n) => ({ n, dir: slotDir(reposRoot, chatId, n), branch: slotBranch(chatId, n) });
export const chatSlots = (reposRoot, chatId) => [1, 2].map((n) => slotAt(reposRoot, chatId, n));

// The chat's current tree. `currentDir` is the path stored on the chat (chats.worktree_path) and
// is resolved directly - a missing middle tree never shifts the chat to another one. Chats from
// before that column existed fall back to what is on disk (-2 if present, else the base tree).
export function currentWorktree(reposRoot, chatId, { existsSync = fs.existsSync, currentDir = null } = {}) {
  if (currentDir) {
    const stored = chatSlots(reposRoot, chatId).find((s) => samePath(s.dir, currentDir));
    if (stored) return stored;
  }
  return slotAt(reposRoot, chatId, existsSync(slotDir(reposRoot, chatId, 2)) ? 2 : 1);
}

// Lock files a killed fetch or add can leave behind, limited to this chat's own branch and
// worktree and to the remote refs a fetch writes. The repo's main index.lock is never among them:
// it may belong to the owner's own git in the main checkout. Called only while holding the repo lock.
function removeStaleLocks(repoDir, dir, branch, chatId, onNote, now = Date.now()) {
  const gitDir = path.join(repoDir, ".git");
  const candidates = [
    `${path.join(gitDir, "refs", "heads", ...branch.split("/"))}.lock`,
    path.join(gitDir, "worktrees", path.basename(dir), "index.lock"),
    path.join(gitDir, "packed-refs.lock"),
  ];
  const walk = (folder) => {
    let entries = [];
    try {
      entries = fs.readdirSync(folder, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(folder, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".lock")) candidates.push(full);
    }
  };
  walk(path.join(gitDir, "refs", "remotes", "origin"));
  for (const file of candidates) {
    try {
      if (now - fs.statSync(file).mtimeMs <= STALE_LOCK_MS) continue;
      fs.rmSync(file);
      onNote?.(`chat ${chatId}: removed stale git lock ${path.relative(gitDir, file)}`);
    } catch {
      // absent, or already gone
    }
  }
}

// Creates the chat's worktree on first run and returns its path on every call after. Only ever
// writes under reposRoot/_wt — the main checkout's files are never touched; in its .git only
// stale lock files of this chat and of the remote refs are removed (removeStaleLocks).
// A fetch that fails or times out is not fatal: we fall back to whatever origin/<base> the main
// checkout already has locally, and tell the caller so it can leave a note (e.g. on the chat
// timeline) instead of silently running on stale refs.
export async function ensureChatWorktree({
  reposRoot,
  repo,
  chatId,
  execFn = defaultExecFn,
  existsSync = fs.existsSync,
  mkdirSync = fs.mkdirSync,
  fetchTimeoutMs = FETCH_TIMEOUT_MS,
  gitTimeoutMs = GIT_TIMEOUT_MS,
  fetchFreshMs = FETCH_FRESH_MS,
  lockRetryDelayMs = LOCK_RETRY_DELAY_MS,
  creationDeadlineMs = CREATION_DEADLINE_MS,
  lockWaitMs = LOCK_WAIT_MS,
  onNote = (note) => console.warn(`[worktree] ${note}`),
  // The chat's stored current tree (chats.worktree_path) and the callback that stores a new one.
  currentDir = null,
  onCurrent = null,
  // Griffin: the app container has no git credentials, so the fetch goes through the broker
  // (fetchRepo(repo)); without it, a plain `git fetch origin`.
  fetchRepo = null,
} = {}) {
  const settle = (resolved) => {
    if (onCurrent && !(currentDir && samePath(currentDir, resolved))) onCurrent(resolved);
    return resolved;
  };
  const repoDir = path.join(reposRoot, repo);
  // In-flight creations are keyed by the chat's first slot, whatever slot it is on now.
  const dir = worktreeDir(reposRoot, chatId);
  const problemOf = (slotPath) => worktreeProblem(slotPath, { execFn, existsSync, gitTimeoutMs });
  // Fast path, before any lock: a chat whose worktree exists and is usable never waits behind
  // another chat's fetch or `worktree add` in the same repo.
  const current = currentWorktree(reposRoot, chatId, { existsSync, currentDir });
  if (existsSync(path.join(current.dir, ".git")) && !(await problemOf(current.dir))) return settle(current.dir);
  const inFlight = creating.get(dir);
  if (inFlight) return inFlight;
  // The deadline starts once the lock is held. It aborts only `git fetch`; a `worktree add`
  // already running is left to finish, and the lock stays held until it has.
  const controller = new AbortController();
  let timer;
  let rejectDeadline;
  const deadline = new Promise((_, reject) => {
    rejectDeadline = reject;
  });
  const locked = withRepoLock(
    repoDir,
    () => {
      timer = setTimeout(() => {
        controller.abort();
        rejectDeadline(new Error(`worktree creation timed out after ${creationDeadlineMs}ms`));
      }, creationDeadlineMs);
      return create();
    },
    { waitMs: lockWaitMs },
  ).finally(() => clearTimeout(timer));
  const work = Promise.race([locked, deadline]).catch((error) => {
    throw isWorktreeError(error) ? error : new WorktreeError(String(error?.message || error), { cause: error });
  });
  // Never deletes, unlocks or force-removes anything: an unusable tree is left for the owner and
  // the chat moves to a new slot; a check that cannot be answered fails the start instead.
  async function create() {
    let slot = currentWorktree(reposRoot, chatId, { existsSync, currentDir });
    let problem = await problemOf(slot.dir);
    if (problem?.unknown) problem = await problemOf(slot.dir);
    if (problem?.unknown) {
      throw new WorktreeError(`could not check the chat's worktree ${slot.dir}: ${problem.unknown} — nothing was changed`);
    }
    if (!problem) return settle(slot.dir);
    let from = null; // the branch the new slot starts from (null: the default branch at origin)
    if (problem === "missing") {
      // The chat's current tree is gone from disk. A tree the chat already had (a stored path, or
      // the -2) comes back on its own branch; with that branch gone too there is nothing to come
      // back to, so the start fails rather than silently starting the chat on fresh code.
      const hadTree = Boolean(currentDir) || slot.n > 1;
      if (await branchExists(repoDir, slot.branch, execFn, gitTimeoutMs)) {
        // git keeps a record of the vanished folder and refuses to add over it until it is pruned
        // (prune drops only records whose folder no longer exists; no file or branch is touched).
        await git(["worktree", "prune"], repoDir, execFn, gitTimeoutMs).catch(() => {});
        if (hadTree) onNote?.(`chat ${chatId}: worktree ${slot.dir} was missing - re-added on its branch ${slot.branch}`);
      } else if (hadTree) {
        throw new WorktreeError(`the chat's worktree ${slot.dir} is missing and its branch ${slot.branch} no longer exists - nothing was changed`);
      }
    }
    if (problem?.unusable && slot.n >= MAX_SLOT) {
      const base = slotAt(reposRoot, chatId, 1);
      throw new WorktreeError(
        `the chat's replacement worktree ${slot.dir} looks unusable too (${problem.unusable}); its first worktree ${base.dir} ` +
          `was already unusable. Both are left as is for you to inspect - no further worktree is made.`,
      );
    }
    if (problem?.unusable) {
      const old = slot;
      slot = { n: old.n + 1, dir: slotDir(reposRoot, chatId, old.n + 1), branch: slotBranch(chatId, old.n + 1) };
      if (await branchExists(repoDir, old.branch, execFn, gitTimeoutMs)) from = old.branch;
      onNote?.(
        `chat ${chatId}: worktree ${old.dir} looks unusable (${problem.unusable}) — left as is for you to inspect; ` +
          `the chat now works in ${slot.dir} on ${slot.branch}${from ? `, started from ${from}` : ""}`,
        { kind: "moved", oldDir: old.dir, newDir: slot.dir },
      );
    }
    removeStaleLocks(repoDir, slot.dir, slot.branch, chatId, onNote);
    mkdirSync(path.join(reposRoot, "_wt"), { recursive: true });
    const branch = slot.branch;
    const fetchedAt = lastFetch.get(repoDir);
    if (!(fetchedAt && Date.now() - fetchedAt < fetchFreshMs)) {
      try {
        if (fetchRepo) await withTimeout(fetchRepo(repo), fetchTimeoutMs, "fetch");
        else await gitRetryingLock(["fetch", "-q", "origin"], repoDir, execFn, fetchTimeoutMs, lockRetryDelayMs, { signal: controller.signal });
        lastFetch.set(repoDir, Date.now());
      } catch (error) {
        onNote?.(`chat ${chatId}: origin fetch failed/timed out (${error.message}) — using the local default branch`);
      }
    }
    // Nobody waits for a creation past its deadline: do not start the add.
    if (controller.signal.aborted) throw new Error("git worktree add not started: the creation deadline passed");
    let args;
    if (await branchExists(repoDir, branch, execFn, gitTimeoutMs)) args = ["worktree", "add", slot.dir, branch];
    else if (from) args = ["worktree", "add", slot.dir, from, "-b", branch];
    else {
      // Griffin: a clone without origin (or never fetched) starts from its local default branch.
      const base = await defaultBranch(repoDir, execFn, gitTimeoutMs);
      const remote = await git(["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${base}`], repoDir, execFn, gitTimeoutMs).then(() => true, () => false);
      args = ["worktree", "add", slot.dir, remote ? `origin/${base}` : base, "-b", branch];
    }
    // No timeout and no abort: a killed add leaves a locked, half-made worktree.
    await gitRetryingLock(args, repoDir, execFn, 0, lockRetryDelayMs);
    return settle(slot.dir);
  }
  creating.set(dir, work);
  const clear = () => {
    if (creating.get(dir) === work) creating.delete(dir);
  };
  work.then(clear, clear);
  return work;
}

// Resolves once no creation of this chat's worktree is in flight (whatever its outcome).
export async function worktreeCreationSettled(reposRoot, chatId) {
  const pending = creating.get(worktreeDir(reposRoot, chatId));
  if (pending) await pending.catch(() => {});
}

// Folders whose ignored content is regenerated by an install or a build; a *.pyc file anywhere.
const DISPOSABLE_DIRS = ["node_modules", "dist", "build", ".next", "out", "coverage", "__pycache__", ".pytest_cache", ".venv", ".cache"];
const DISPOSABLE_DIR_RE = new RegExp(`(^|/)(${DISPOSABLE_DIRS.map((d) => d.replace(/\./g, "\\.")).join("|")})(/|$)`);
export const isDisposableIgnored = (p) => DISPOSABLE_DIR_RE.test(p) || /\.pyc$/.test(p);

// Clean == no modified, untracked OR ignored files, except ignored files under a generated folder
// (DISPOSABLE_DIRS, *.pyc — reinstallable or rebuildable). Any other ignored file (.env,
// exports/, a local database) is real work that a removal would silently destroy. A worktree that
// was never created counts as clean. --ignored=matching lists each ignored path by the pattern
// that matched it, so an otherwise-empty folder holding only build output is not reported as a
// whole untracked folder.
export async function isWorktreeClean({ reposRoot, chatId, dir = worktreeDir(reposRoot, chatId), execFn = defaultExecFn, existsSync = fs.existsSync, gitTimeoutMs = GIT_TIMEOUT_MS } = {}) {
  if (!existsSync(path.join(dir, ".git"))) return true;
  const out = await git(["status", "--porcelain", "--ignored=matching", "--untracked-files=all"], dir, execFn, gitTimeoutMs);
  return out
    .split("\n")
    .filter(Boolean)
    .every((line) => line.startsWith("!! ") && isDisposableIgnored(line.slice(3).replace(/^"|"$/g, "")));
}

// True when the branch carries a commit that exists on neither the remote default branch nor any
// remote branch — i.e. dropping it would lose work. A missing origin/griffin/<id> (the chat's own
// branch was never pushed under its own name) is NOT by itself unpushed: if every commit on the
// branch is already reachable from some other remote ref (e.g. it was cut from origin/<default>
// and nothing was ever committed on top), there is nothing to lose.
export async function hasUnpushedCommits({ reposRoot, repo, chatId, branch = branchName(chatId), execFn = defaultExecFn, gitTimeoutMs = GIT_TIMEOUT_MS } = {}) {
  const repoDir = path.join(reposRoot, repo);
  try {
    await git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], repoDir, execFn, gitTimeoutMs);
  } catch {
    return false; // branch does not exist (locally) — nothing to lose
  }
  const stray = await git(["rev-list", branch, "--not", "--remotes"], repoDir, execFn, gitTimeoutMs);
  return stray !== "";
}

// Safe to remove without losing work: clean working tree AND nothing unpushed.
export async function worktreeIsDisposable(opts) {
  return (await isWorktreeClean(opts)) && !(await hasUnpushedCommits(opts));
}

// Archiving/deleting a chat: remove its worktree, but only when nothing would be lost by doing
// so. Otherwise leave it in place and say why, so the caller can note it on the chat.
// Every tree the chat has used (base and -2) is evaluated on its own under the same rule; each
// comes back as { dir, branch, action: "removed" | "kept", reason }. A tree whose folder and
// branch are both absent was never used and is not listed. `reason` sums up what was kept and why.
export async function cleanupChatWorktree(opts) {
  if (!opts?.reposRoot || !opts?.repo || !opts?.chatId) return { removed: false, reason: null, trees: [] };
  // A chat archived while its worktree is still being created: let the creation finish first,
  // or the removal below would see nothing and the new worktree would be left behind.
  await worktreeCreationSettled(opts.reposRoot, opts.chatId);
  const trees = [];
  for (const slot of chatSlots(opts.reposRoot, opts.chatId)) {
    const outcome = await cleanupWorktreeSlot({ ...opts, slot });
    if (outcome) trees.push(outcome);
  }
  const kept = trees.filter((t) => t.action !== "removed");
  return {
    removed: trees.length > 0 && kept.length === 0,
    reason: kept.length ? kept.map((t) => `${t.dir} kept: ${t.reason}`).join("; ") : null,
    trees,
  };
}

// One tree of a chat: removed (with its branch when it has no commits of its own) only when
// nothing would be lost; otherwise kept with the reason. null when the chat never used it.
export async function cleanupWorktreeSlot({ reposRoot, repo, chatId, slot, execFn = defaultExecFn, existsSync = fs.existsSync, gitTimeoutMs = GIT_TIMEOUT_MS, log = console }) {
  const repoDir = path.join(reposRoot, repo);
  const { dir, branch } = slot;
  const out = { dir, branch, action: "kept", reason: null };
  const present = existsSync(path.join(dir, ".git"));
  try {
    if (!present && !(await branchExists(repoDir, branch, execFn, gitTimeoutMs))) return null;
    if (!(await isWorktreeClean({ reposRoot, chatId, dir, execFn, existsSync, gitTimeoutMs }))) {
      out.reason = "uncommitted, untracked or ignored files in the tree";
      return out;
    }
    if (await hasUnpushedCommits({ reposRoot, repo, chatId, branch, execFn, gitTimeoutMs })) {
      out.reason = `unpushed commits on ${branch}`;
      return out;
    }
    await removeChatWorktree({ reposRoot, repo, chatId, dir, branch, execFn, existsSync, gitTimeoutMs, log });
    out.action = "removed";
    out.reason = present ? "clean, nothing unpushed" : "folder already gone; stale record dropped";
  } catch (error) {
    out.reason = `could not check (${String(error?.message || error).split(/\r?\n/)[0]})`;
  }
  return out;
}

// Removes the worktree (and its branch, once it is no longer checked out anywhere). Caller must
// have already checked worktreeIsDisposable — this function does not re-check.
export async function removeChatWorktree({ reposRoot, repo, chatId, dir = worktreeDir(reposRoot, chatId), branch = branchName(chatId), execFn = defaultExecFn, existsSync = fs.existsSync, gitTimeoutMs = GIT_TIMEOUT_MS, log = console } = {}) {
  const repoDir = path.join(reposRoot, repo);
  // Same per-repo lock as creation: a removal, prune or branch -D never runs beside a fetch or a
  // `worktree add` in the same repo.
  return withRepoLock(repoDir, async () => {
    const present = existsSync(path.join(dir, ".git"));
    if (present) {
      // Never --force: if git itself sees anything to lose, the removal fails and the tree is kept.
      await git(["worktree", "remove", dir], repoDir, execFn, gitTimeoutMs);
    } else {
      // The directory is already gone (deleted by hand, or never created): drop git's stale record
      // of it so the branch below is no longer "checked out" anywhere.
      try {
        await git(["worktree", "prune"], repoDir, execFn, gitTimeoutMs);
      } catch {
        // not a repo / nothing to prune
      }
    }
    // The chat's local branch goes with its worktree only when it has zero commits of its own
    // (every commit is on the default branch at origin). A branch whose commits were pushed
    // elsewhere is kept; so is one that cannot be checked.
    let branchDeleted = false;
    try {
      const base = await defaultBranch(repoDir, execFn, gitTimeoutMs);
      const own = await git(["rev-list", branch, "--not", `refs/remotes/origin/${base}`], repoDir, execFn, gitTimeoutMs);
      if (own) throw new Error(`kept: it has ${own.split(/\r?\n/).length} commit(s) not on origin/${base}`);
      await git(["branch", "-D", branch], repoDir, execFn, gitTimeoutMs);
      branchDeleted = true;
    } catch (error) {
      // Already gone, or still checked out elsewhere: the removal still stands, but say so.
      log?.warn?.(`[worktree] chat ${shortId(chatId)}: git branch -D ${branch} failed (${String(error?.message || error).split("\n")[0]})`);
    }
    return present || branchDeleted;
  });
}

// Same directory on disk? (Windows: 8.3 short names vs long names, and case.)
function samePath(a, b) {
  const norm = (p) => {
    let out = path.resolve(p);
    try {
      out = fs.realpathSync.native(out);
    } catch {
      // keep the resolved path
    }
    return process.platform === "win32" ? out.toLowerCase() : out;
  };
  return norm(a) === norm(b);
}

// griffin-<id8> (the base tree) and griffin-<id8>-2 (its one replacement).
const SWEEP_NAME = /^griffin-([A-Za-z0-9]{8})(?:-(2))?$/;

// Startup sweep: worktrees under <reposRoot>/_wt that belong to chats that are archived or no
// longer exist are removed (with their local griffin/<id8> branch) when nothing would be lost —
// clean tree and `git rev-list <branch> --not --remotes` empty. Everything else is kept:
//  - a directory that is not exactly griffin-<id8>, or whose HEAD is not griffin/<id8> (the
//    owner's own worktrees, e.g. griffin-int2, live in the same folder),
//  - a worktree whose repo is not a clone directly under reposRoot,
//  - a live (non-archived) chat's worktree,
//  - one with uncommitted changes or its own commits.
// chatState(id8) -> "active" | "archived" | "deleted". Returns one entry per candidate directory.
export async function sweepChatWorktrees({
  reposRoot,
  chatState,
  execFn = defaultExecFn,
  existsSync = fs.existsSync,
  readdirSync = fs.readdirSync,
  gitTimeoutMs = GIT_TIMEOUT_MS,
} = {}) {
  const results = [];
  let entries;
  try {
    entries = readdirSync(path.join(reposRoot, "_wt"), { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    const match = entry.isDirectory() ? SWEEP_NAME.exec(entry.name) : null;
    if (!match) continue;
    const id8 = match[1];
    const slot = slotAt(reposRoot, id8, match[2] ? 2 : 1);
    const dir = path.join(reposRoot, "_wt", entry.name);
    const result = { id8, dir, repo: null, action: "kept", reason: null };
    results.push(result);
    try {
      if (!existsSync(path.join(dir, ".git"))) {
        result.reason = "not a git worktree";
        continue;
      }
      const head = await git(["rev-parse", "--abbrev-ref", "HEAD"], dir, execFn, gitTimeoutMs);
      if (head !== slot.branch) {
        result.reason = `not a chat worktree (HEAD ${head})`;
        continue;
      }
      const common = await git(["rev-parse", "--path-format=absolute", "--git-common-dir"], dir, execFn, gitTimeoutMs);
      const repoDir = path.dirname(path.resolve(dir, common));
      const repo = path.basename(repoDir);
      if (samePath(path.dirname(repoDir), reposRoot) === false || repo === "_wt") {
        result.reason = "repo is not a clone under reposRoot";
        continue;
      }
      result.repo = repo;
      const state = chatState(id8);
      if (state !== "archived" && state !== "deleted") {
        result.reason = "chat is live";
        continue;
      }
      await worktreeCreationSettled(reposRoot, id8);
      const outcome = (await cleanupWorktreeSlot({ reposRoot, repo, chatId: id8, slot, execFn, existsSync, gitTimeoutMs })) || { action: "kept", reason: "not a git worktree" };
      if (outcome.action === "removed") {
        result.action = "removed";
        result.reason = state;
      } else {
        result.reason = outcome.reason;
      }
    } catch (error) {
      result.reason = `error: ${error.message}`;
    }
  }
  return results;
}
