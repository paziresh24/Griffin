// Real git in temp repos: an interrupted `git worktree add` and stale lock files left by a killed
// git. The earlier tests mocked git and missed what git really leaves behind.
import test from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cleanupChatWorktree, ensureChatWorktree, worktreeDir } from "../src/worktrees.mjs";

const git = (args, cwd) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

function setupRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "griffin-rec-"));
  const bare = path.join(root, "origin.git");
  fs.mkdirSync(bare);
  git(["init", "-q", "--bare", "-b", "main", bare]);
  const reposRoot = path.join(root, "repos");
  fs.mkdirSync(reposRoot);
  const repoDir = path.join(reposRoot, "myrepo");
  git(["clone", "-q", bare, repoDir]);
  git(["config", "user.email", "t@t.test"], repoDir);
  git(["config", "user.name", "t"], repoDir);
  fs.writeFileSync(path.join(repoDir, "a.txt"), "1\n");
  git(["add", "a.txt"], repoDir);
  git(["commit", "-q", "-m", "init"], repoDir);
  git(["push", "-q", "origin", "main"], repoDir);
  return { root, reposRoot, repoDir };
}

const adminDir = (repoDir, dir) => path.join(repoDir, ".git", "worktrees", path.basename(dir));
const lockedWorktrees = (repoDir) => git(["worktree", "list", "--porcelain"], repoDir).split("\n").filter((l) => l.startsWith("locked"));
const opts = (reposRoot, chatId) => ({ reposRoot, repo: "myrepo", chatId, onNote: () => {}, fetchFreshMs: 0 });

function assertFreshValid(dir, repoDir) {
  assert.deepEqual(lockedWorktrees(repoDir), [], "no worktree is left locked");
  assert.ok(fs.existsSync(path.join(dir, "a.txt")), "the files are checked out");
  assert.match(git(["rev-parse", "--verify", "HEAD"], dir), /^[0-9a-f]{40}$/);
  assert.equal(git(["rev-parse", "--abbrev-ref", "HEAD"], dir), `griffin/${path.basename(dir).slice(8)}`);
}

// Review 7: an interrupted add or an unresolvable HEAD is never removed — see the tests at the end.

test("a worktree with no checked-out files but no `initializing` lock is reused as is (the deletions may be the owner's work)", async () => {
  const { root, reposRoot, repoDir } = setupRepo();
  try {
    const dir = await ensureChatWorktree(opts(reposRoot, "empty001"));
    fs.rmSync(path.join(dir, "a.txt"));
    assert.equal(await ensureChatWorktree(opts(reposRoot, "empty001")), dir);
    assert.equal(fs.existsSync(path.join(dir, "a.txt")), false, "the deletion is kept");
    assert.deepEqual(lockedWorktrees(repoDir), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a valid worktree with the chat's own commit is reused as is", async () => {
  const { root, reposRoot } = setupRepo();
  try {
    const dir = await ensureChatWorktree(opts(reposRoot, "keepw001"));
    fs.writeFileSync(path.join(dir, "mine.txt"), "x\n");
    git(["add", "mine.txt"], dir);
    git(["-c", "user.email=t@t.test", "-c", "user.name=t", "commit", "-q", "-m", "mine"], dir);
    fs.writeFileSync(path.join(dir, "wip.txt"), "uncommitted\n");
    assert.equal(await ensureChatWorktree(opts(reposRoot, "keepw001")), dir);
    assert.ok(fs.existsSync(path.join(dir, "wip.txt")), "uncommitted work untouched");
    assert.ok(fs.existsSync(path.join(dir, "mine.txt")));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function plant(file, ageMs) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "");
  const t = new Date(Date.now() - ageMs);
  fs.utimesSync(file, t, t);
}

test("stale lock files of this chat and of the fetched remote refs are removed; the main index.lock and fresh locks are not", async () => {
  const { root, reposRoot, repoDir } = setupRepo();
  try {
    const gitDir = path.join(repoDir, ".git");
    const old = 11 * 60_000;
    const stale = [
      path.join(gitDir, "refs", "heads", "griffin", "stale001.lock"),
      path.join(gitDir, "packed-refs.lock"),
      path.join(gitDir, "refs", "remotes", "origin", "main.lock"),
      path.join(gitDir, "worktrees", "griffin-stale001", "index.lock"),
    ];
    for (const f of stale) plant(f, old);
    const mainIndexLock = path.join(gitDir, "index.lock");
    plant(mainIndexLock, old);
    const otherChat = path.join(gitDir, "refs", "heads", "griffin", "other001.lock");
    plant(otherChat, old);
    const young = path.join(gitDir, "refs", "remotes", "origin", "young.lock");
    plant(young, 60_000);

    const dir = await ensureChatWorktree(opts(reposRoot, "stale001"));
    assert.equal(dir, worktreeDir(reposRoot, "stale001"));
    assertFreshValid(dir, repoDir);
    for (const f of stale) assert.equal(fs.existsSync(f), false, `stale ${f} removed`);
    assert.ok(fs.existsSync(mainIndexLock), "the repo's main index.lock is never touched");
    assert.ok(fs.existsSync(otherChat), "another chat's lock is not touched");
    assert.ok(fs.existsSync(young), "a lock younger than 10 minutes is kept");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---- Review 7: recovery never deletes. Real git. ----

const realExec = (cmd, args, o) =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, o, (error, stdout) => (error ? reject(error) : resolve(stdout)));
  });

test("an intentionally locked healthy tree keeps its uncommitted WORK.txt and the chat starts in the same tree", async () => {
  const { root, reposRoot, repoDir } = setupRepo();
  try {
    const dir = await ensureChatWorktree(opts(reposRoot, "ulock001"));
    fs.writeFileSync(path.join(dir, "WORK.txt"), "owner's uncommitted work\n");
    git(["worktree", "lock", "--reason", "owner keeps this", dir], repoDir);
    const again = await ensureChatWorktree(opts(reposRoot, "ulock001"));
    assert.equal(again, dir, "same tree");
    assert.equal(fs.readFileSync(path.join(dir, "WORK.txt"), "utf8"), "owner's uncommitted work\n");
    assert.equal(lockedWorktrees(repoDir).length, 1, "the owner's lock is kept");
    assert.equal(fs.existsSync(`${dir}-2`), false, "no second tree");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a rev-parse failure injected twice leaves the tree and its edits intact and fails the start visibly", async () => {
  const { root, reposRoot } = setupRepo();
  try {
    const dir = await ensureChatWorktree(opts(reposRoot, "revpf001"));
    fs.writeFileSync(path.join(dir, "a.txt"), "edited\n");
    fs.writeFileSync(path.join(dir, "WORK.txt"), "new\n");
    let injected = 0;
    const calls = [];
    const execFn = (cmd, args, o) => {
      calls.push(args.join(" "));
      if (args[0] === "rev-parse" && args.includes("HEAD^{commit}")) {
        injected += 1;
        return Promise.reject(Object.assign(new Error("fatal: transient failure"), { code: 128 }));
      }
      return realExec(cmd, args, o);
    };
    await assert.rejects(ensureChatWorktree({ ...opts(reposRoot, "revpf001"), execFn }), (e) => {
      assert.equal(e.name, "WorktreeError");
      assert.match(e.message, /nothing was changed/);
      return true;
    });
    assert.ok(injected >= 2, "checked twice before giving up");
    assert.equal(fs.readFileSync(path.join(dir, "a.txt"), "utf8"), "edited\n");
    assert.equal(fs.readFileSync(path.join(dir, "WORK.txt"), "utf8"), "new\n");
    assert.equal(fs.existsSync(`${dir}-2`), false);
    assert.equal(calls.some((c) => /worktree (remove|unlock|add)|branch -D/.test(c)), false, `no destructive call: ${calls.join(" | ")}`);
    assert.equal(git(["rev-parse", "--abbrev-ref", "HEAD"], dir), "griffin/revpf001");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("an `initializing` lock plus an empty tree gives a new -2 worktree; the old one is untouched", async () => {
  const { root, reposRoot, repoDir } = setupRepo();
  try {
    const dir = await ensureChatWorktree(opts(reposRoot, "initl001"));
    fs.writeFileSync(path.join(adminDir(repoDir, dir), "locked"), "initializing");
    fs.rmSync(path.join(dir, "a.txt"));
    const notes = [];
    const again = await ensureChatWorktree({ ...opts(reposRoot, "initl001"), onNote: (n) => notes.push(n) });
    assert.equal(again, `${dir}-2`);
    assert.ok(fs.existsSync(path.join(again, "a.txt")));
    assert.equal(git(["rev-parse", "--abbrev-ref", "HEAD"], again), "griffin/initl001-2");
    assert.ok(fs.existsSync(path.join(dir, ".git")), "old tree still there");
    assert.equal(fs.readFileSync(path.join(adminDir(repoDir, dir), "locked"), "utf8"), "initializing", "old lock untouched");
    assert.match(git(["branch", "--list", "griffin/initl001"], repoDir), /griffin\/initl001/, "old branch kept");
    assert.ok(notes.some((n) => n.includes(dir)), "the note names the old path");
    // The chat keeps using the new tree from now on.
    assert.equal(await ensureChatWorktree(opts(reposRoot, "initl001")), again);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a HEAD that does not resolve keeps the pushed-commits branch and the new tree starts from it", async () => {
  const { root, reposRoot, repoDir } = setupRepo();
  try {
    const dir = await ensureChatWorktree(opts(reposRoot, "pushd001"));
    fs.writeFileSync(path.join(dir, "mine.txt"), "x\n");
    git(["add", "mine.txt"], dir);
    git(["-c", "user.email=t@t.test", "-c", "user.name=t", "commit", "-q", "-m", "mine"], dir);
    git(["push", "-q", "origin", "griffin/pushd001"], dir);
    const pushed = git(["rev-parse", "griffin/pushd001"], repoDir);
    fs.writeFileSync(path.join(dir, "WORK.txt"), "uncommitted\n");
    fs.writeFileSync(path.join(adminDir(repoDir, dir), "HEAD"), "ref: refs/heads/griffin/nowhere\n");
    const again = await ensureChatWorktree(opts(reposRoot, "pushd001"));
    assert.equal(again, `${dir}-2`);
    assert.equal(git(["rev-parse", "griffin/pushd001"], repoDir), pushed, "branch kept");
    assert.equal(git(["rev-parse", "HEAD"], again), pushed, "new tree starts from the kept branch");
    assert.ok(fs.existsSync(path.join(again, "mine.txt")));
    assert.equal(fs.readFileSync(path.join(dir, "WORK.txt"), "utf8"), "uncommitted\n", "old tree untouched");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("archive path: a clean tree whose branch has pushed commits is removed but its branch is kept (branch -D only with zero own commits)", async () => {
  const { root, reposRoot, repoDir } = setupRepo();
  try {
    const dir = await ensureChatWorktree(opts(reposRoot, "archp001"));
    fs.writeFileSync(path.join(dir, "mine.txt"), "x\n");
    git(["add", "mine.txt"], dir);
    git(["-c", "user.email=t@t.test", "-c", "user.name=t", "commit", "-q", "-m", "mine"], dir);
    git(["push", "-q", "origin", "griffin/archp001"], dir);
    const out = await cleanupChatWorktree({ reposRoot, repo: "myrepo", chatId: "archp001", log: { warn: () => {} } });
    assert.equal(out.removed, true);
    assert.match(git(["branch", "--list", "griffin/archp001"], repoDir), /griffin\/archp001/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
