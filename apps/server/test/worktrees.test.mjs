import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  cleanupChatWorktree, ensureChatWorktree, hasUnpushedCommits, isWorktreeClean, linkIgnoredFiles, listRepos,
  removeChatWorktree, repoLockKey, worktreeDir, worktreeIsDisposable,
} from "../src/worktrees.mjs";

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

// A bare "origin" plus a real clone under reposRoot/<repo> — the owner's own pre-existing
// checkout, standing in for a real GitLab-backed repo.
function setupRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "griffin-wt-"));
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

test("two chats get two different worktrees; the main checkout is untouched", async () => {
  const { root, reposRoot, repoDir } = setupRepo();
  try {
    const headBefore = git(["rev-parse", "HEAD"], repoDir);
    const branchBefore = git(["branch", "--show-current"], repoDir);

    const dir1 = await ensureChatWorktree({ reposRoot, repo: "myrepo", chatId: "chat-aaaaaaaa" });
    const dir2 = await ensureChatWorktree({ reposRoot, repo: "myrepo", chatId: "chat-bbbbbbbb" });

    assert.notEqual(dir1, dir2);
    assert.ok(fs.existsSync(path.join(dir1, "a.txt")));
    assert.ok(fs.existsSync(path.join(dir2, "a.txt")));
    assert.ok(dir1.startsWith(path.join(reposRoot, "_wt")));

    // the owner's own checkout never moved off its branch and gained no new files
    assert.equal(git(["rev-parse", "HEAD"], repoDir), headBefore);
    assert.equal(git(["branch", "--show-current"], repoDir), branchBefore);
    assert.deepEqual(fs.readdirSync(repoDir).filter((f) => f !== ".git").sort(), ["a.txt"]);

    // calling again for the same chat returns the same worktree, does not recreate it
    const again = await ensureChatWorktree({ reposRoot, repo: "myrepo", chatId: "chat-aaaaaaaa" });
    assert.equal(again, dir1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("ignored files of the main checkout are linked into a new worktree and do not make it dirty", async () => {
  const { root, reposRoot, repoDir } = setupRepo();
  try {
    fs.writeFileSync(path.join(repoDir, ".gitignore"), ".env\np24*.db\n");
    git(["add", ".gitignore"], repoDir);
    git(["commit", "-q", "-m", "ignore"], repoDir);
    git(["push", "-q", "origin", "main"], repoDir);
    fs.writeFileSync(path.join(repoDir, ".env"), "KEY=1\n");
    fs.writeFileSync(path.join(repoDir, "p24.db"), "db");
    fs.writeFileSync(path.join(repoDir, "notes.txt"), "untracked, not ignored");
    fs.writeFileSync(path.join(repoDir, ".worktreeinclude"), "# carried\np24.db\nnotes.txt\n../escape\n");
    const dir = await ensureChatWorktree({ reposRoot, repo: "myrepo", chatId: "chat-link0001", linkIgnored: ".env, missing.env, a.txt" });
    assert.equal(fs.readFileSync(path.join(dir, ".env"), "utf8"), "KEY=1\n");
    assert.equal(fs.readFileSync(path.join(dir, "p24.db"), "utf8"), "db");
    assert.ok(fs.lstatSync(path.join(dir, ".env")).isSymbolicLink());
    assert.ok(!fs.existsSync(path.join(dir, "notes.txt")), "a file git does not ignore is never linked");
    assert.ok(!fs.lstatSync(path.join(dir, "a.txt")).isSymbolicLink(), "a tracked file stays the checkout's own");
    assert.equal(await isWorktreeClean({ reposRoot, chatId: "chat-link0001" }), true);
    fs.writeFileSync(path.join(dir, "scratch.txt"), "wip");
    assert.equal(await isWorktreeClean({ reposRoot, chatId: "chat-link0001" }), false);
    // a second call never replaces what is there
    assert.deepEqual(await linkIgnoredFiles({ repoDir, wtDir: dir, extra: ".env" }), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a worktree made before the link list existed gets the missing carried files on its next start", async () => {
  const { root, reposRoot, repoDir } = setupRepo();
  try {
    fs.writeFileSync(path.join(repoDir, ".gitignore"), ".env\np24*.db\n");
    git(["add", ".gitignore"], repoDir);
    git(["commit", "-q", "-m", "ignore"], repoDir);
    git(["push", "-q", "origin", "main"], repoDir);
    fs.writeFileSync(path.join(repoDir, ".env"), "KEY=1\n");
    fs.writeFileSync(path.join(repoDir, "p24.db"), "real");
    const dir = await ensureChatWorktree({ reposRoot, repo: "myrepo", chatId: "chat-link0002" });
    assert.ok(!fs.existsSync(path.join(dir, ".env")), "no list yet: nothing carried");
    fs.writeFileSync(path.join(dir, "p24.db"), "own");
    const again = await ensureChatWorktree({ reposRoot, repo: "myrepo", chatId: "chat-link0002", linkIgnored: ".env,p24.db" });
    assert.equal(again, dir);
    assert.ok(fs.lstatSync(path.join(dir, ".env")).isSymbolicLink(), "the missing file is linked on the fast path");
    assert.equal(fs.readFileSync(path.join(dir, "p24.db"), "utf8"), "own", "a file the tree already has is never replaced");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a dirty worktree is kept on archive (not disposable)", async () => {
  const { root, reposRoot } = setupRepo();
  try {
    const dir = await ensureChatWorktree({ reposRoot, repo: "myrepo", chatId: "chat-dirty01" });
    assert.equal(await isWorktreeClean({ reposRoot, chatId: "chat-dirty01" }), true);
    fs.writeFileSync(path.join(dir, "scratch.txt"), "wip");
    assert.equal(await isWorktreeClean({ reposRoot, chatId: "chat-dirty01" }), false);
    assert.equal(await worktreeIsDisposable({ reposRoot, repo: "myrepo", chatId: "chat-dirty01" }), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a clean worktree with unpushed commits is kept; once pushed it is disposable", async () => {
  const { root, reposRoot, repoDir } = setupRepo();
  try {
    const dir = await ensureChatWorktree({ reposRoot, repo: "myrepo", chatId: "chat-cleanup1" });
    fs.writeFileSync(path.join(dir, "b.txt"), "2\n");
    git(["add", "b.txt"], dir);
    git(["commit", "-q", "-m", "wip"], dir);

    assert.equal(await isWorktreeClean({ reposRoot, chatId: "chat-cleanup1" }), true);
    assert.equal(await hasUnpushedCommits({ reposRoot, repo: "myrepo", chatId: "chat-cleanup1" }), true);
    assert.equal(await worktreeIsDisposable({ reposRoot, repo: "myrepo", chatId: "chat-cleanup1" }), false);

    git(["push", "-q", "origin", "griffin/chatclea"], dir);
    assert.equal(await hasUnpushedCommits({ reposRoot, repo: "myrepo", chatId: "chat-cleanup1" }), false);
    assert.equal(await worktreeIsDisposable({ reposRoot, repo: "myrepo", chatId: "chat-cleanup1" }), true);

    const removed = await removeChatWorktree({ reposRoot, repo: "myrepo", chatId: "chat-cleanup1" });
    assert.equal(removed, true);
    assert.equal(fs.existsSync(worktreeDir(reposRoot, "chat-cleanup1")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// Regression for the reported defect: hasUnpushedCommits() used to treat a missing
// origin/griffin/<id> as "unpushed" even when the branch carries zero commits of its own (cut
// straight from origin/<default>) — so a chat's worktree was never removed on archive. It must
// instead compare against every remote ref (`git rev-list <branch> --not --remotes`).
test("a clean, unmodified worktree (zero own commits) is removed on archive", async () => {
  const { root, reposRoot } = setupRepo();
  try {
    const dir = await ensureChatWorktree({ reposRoot, repo: "myrepo", chatId: "chat-freshone" });
    assert.ok(fs.existsSync(dir));
    // Nothing was ever committed on top of the base — no origin/griffin/<id> exists either.
    assert.equal(await hasUnpushedCommits({ reposRoot, repo: "myrepo", chatId: "chat-freshone" }), false);
    const outcome = await cleanupChatWorktree({ reposRoot, repo: "myrepo", chatId: "chat-freshone" });
    assert.equal(outcome.removed, true, "a pristine, never-pushed worktree with no commits of its own must be removable");
    assert.equal(fs.existsSync(dir), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a worktree with a local-only commit is kept even though origin/griffin/<id> never existed", async () => {
  const { root, reposRoot } = setupRepo();
  try {
    const dir = await ensureChatWorktree({ reposRoot, repo: "myrepo", chatId: "chat-localonly" });
    fs.writeFileSync(path.join(dir, "local.txt"), "wip\n");
    git(["add", "local.txt"], dir);
    git(["commit", "-q", "-m", "local work"], dir);

    assert.equal(await hasUnpushedCommits({ reposRoot, repo: "myrepo", chatId: "chat-localonly" }), true);
    const outcome = await cleanupChatWorktree({ reposRoot, repo: "myrepo", chatId: "chat-localonly" });
    assert.equal(outcome.removed, false, "a real local-only commit must never be silently dropped");
    assert.ok(fs.existsSync(dir));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// A hanging/timing-out git call must not block the event loop: a fake execFn that never
// resolves (simulating e.g. a stuck `git fetch`) must still let unrelated async work on the same
// process complete while it is pending, and the call itself must reject on our own timeout
// (never hang the caller forever).
test("a hanging git call times out and never blocks other async work on the process", async () => {
  const { root, reposRoot } = setupRepo();
  try {
    let otherWorkDone = false;
    setTimeout(() => {
      otherWorkDone = true;
    }, 5);

    const hangingExecFn = () => new Promise(() => {}); // never resolves/rejects — simulates a stuck git

    const promise = ensureChatWorktree({
      reposRoot,
      repo: "myrepo",
      chatId: "chat-hangs01",
      execFn: hangingExecFn,
      fetchTimeoutMs: 30,
      gitTimeoutMs: 30,
      // `worktree add` has no timeout of its own (it is never killed); the caller's deadline ends the wait.
      creationDeadlineMs: 300,
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    // While the fetch is still "hanging", other timers on this same process already fired —
    // proof the call is not blocking the event loop the way execFileSync would.
    assert.equal(otherWorkDone, true, "other async work must complete while a git call is pending");

    // ensureChatWorktree swallows a fetch failure/timeout (falls back to the local default
    // branch), so it should still resolve — but the underlying `worktree add` also uses the
    // same hanging execFn, and the caller's creation deadline must end the wait.
    await assert.rejects(promise);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("fetch timeout falls back to the local default branch and leaves a note", async () => {
  const { root, reposRoot } = setupRepo();
  try {
    const notes = [];
    const realExecFn = (cmd, args, opts) =>
      new Promise((resolve, reject) => {
        try {
          resolve(String(execFileSync(cmd, args, opts)));
        } catch (error) {
          reject(error);
        }
      });
    let calls = 0;
    const flakyFetchExecFn = (cmd, args, opts) => {
      if (args[0] === "fetch") {
        calls += 1;
        return new Promise(() => {}); // hangs forever -> times out
      }
      return realExecFn(cmd, args, opts);
    };

    const dir = await ensureChatWorktree({
      reposRoot,
      repo: "myrepo",
      chatId: "chat-flakyfetch",
      execFn: flakyFetchExecFn,
      fetchTimeoutMs: 20,
      onNote: (note) => notes.push(note),
    });

    assert.equal(calls, 1);
    assert.ok(fs.existsSync(path.join(dir, "a.txt")), "still built the worktree off the local default branch");
    assert.ok(notes.length >= 1, "a note is left when the fetch fails/times out");
    assert.match(notes[0], /fetch/i);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// If griffin/<id8> already exists (e.g. the worktree dir was removed manually, or `git worktree
// remove` ran but the branch survived) ensureChatWorktree must reuse it (`worktree add <path>
// <branch>`), not try `-b <branch>` again — which git refuses since the branch already exists.
test("ensureChatWorktree reuses an existing griffin/<id8> branch instead of failing on -b", async () => {
  const { root, reposRoot, repoDir } = setupRepo();
  try {
    const dir = await ensureChatWorktree({ reposRoot, repo: "myrepo", chatId: "chat-reuseme" });
    fs.writeFileSync(path.join(dir, "mine.txt"), "x\n");
    git(["add", "mine.txt"], dir);
    git(["commit", "-q", "-m", "mine"], dir);
    // Remove only the worktree entry, leaving the branch itself intact (git worktree remove
    // without --force would refuse here since the tree has commits, so we drop it via prune).
    git(["worktree", "remove", "--force", dir], repoDir);
    assert.ok(git(["branch", "--list", "griffin/chatreus"], repoDir).includes("griffin/chatreus"));

    const reused = await ensureChatWorktree({ reposRoot, repo: "myrepo", chatId: "chat-reuseme" });
    assert.ok(fs.existsSync(path.join(reused, "mine.txt")), "the branch's own commit is still there — it was reused, not recreated from origin/base");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("listRepos: only real git repos under reposRoot, never _wt itself", () => {
  const { root, reposRoot } = setupRepo();
  try {
    fs.mkdirSync(path.join(reposRoot, "_wt", "griffin-x"), { recursive: true });
    fs.mkdirSync(path.join(reposRoot, "not-a-repo"));
    assert.deepEqual(listRepos(reposRoot), ["myrepo"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("listRepos: a missing reposRoot returns an empty list rather than throwing", () => {
  assert.deepEqual(listRepos(path.join(os.tmpdir(), "griffin-does-not-exist-xyz")), []);
});

test("cleanupChatWorktree: a dirty worktree is kept, with a reason", async () => {
  const { root, reposRoot } = setupRepo();
  try {
    const dir = await ensureChatWorktree({ reposRoot, repo: "myrepo", chatId: "chat-cleanupA" });
    fs.writeFileSync(path.join(dir, "wip.txt"), "x");
    const outcome = await cleanupChatWorktree({ reposRoot, repo: "myrepo", chatId: "chat-cleanupA" });
    assert.equal(outcome.removed, false);
    assert.ok(outcome.reason);
    assert.ok(fs.existsSync(dir), "kept, not removed");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("cleanupChatWorktree: a clean, fully-pushed worktree is removed", async () => {
  const { root, reposRoot } = setupRepo();
  try {
    const dir = await ensureChatWorktree({ reposRoot, repo: "myrepo", chatId: "chat-cleanupB" });
    git(["push", "-q", "origin", "griffin/chatclea"], dir);
    const outcome = await cleanupChatWorktree({ reposRoot, repo: "myrepo", chatId: "chat-cleanupB" });
    assert.equal(outcome.removed, true);
    assert.equal(outcome.reason, null);
    assert.equal(fs.existsSync(dir), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// --- parallel chat starts (capsule 2026-09-28: 3 of 4 chats created within one second failed
// with "git worktree timed out" after five "cannot lock ref refs/remotes/origin/master") ---

const realExec = (cmd, args, opts) =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, opts, (error, stdout) => (error ? reject(error) : resolve(stdout)));
  });

test("five concurrent ensureChatWorktree calls on one repo all succeed and share one fetch", async () => {
  const { root, reposRoot } = setupRepo();
  try {
    let fetches = 0;
    let inFlight = 0;
    let maxInFlight = 0;
    const execFn = async (cmd, args, opts) => {
      if (args[0] === "fetch") fetches += 1;
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        return await realExec(cmd, args, opts);
      } finally {
        inFlight -= 1;
      }
    };
    const ids = ["par1aaaa-1", "par2bbbb-2", "par3cccc-3", "par4dddd-4", "par5eeee-5"];
    const settled = await Promise.allSettled(ids.map((chatId) => ensureChatWorktree({ reposRoot, repo: "myrepo", chatId, execFn })));
    const failed = settled.filter((s) => s.status === "rejected").map((s) => s.reason.message.split("\n").slice(0, 2).join(" | "));
    assert.deepEqual(failed, [], "every parallel start succeeds");
    const dirs = settled.map((s) => s.value);
    for (const dir of dirs) assert.ok(fs.existsSync(path.join(dir, "a.txt")));
    assert.equal(new Set(dirs).size, 5);
    assert.ok(fetches >= 1 && fetches <= 2, `fetched ${fetches} times`);
    assert.equal(maxInFlight, 1, "git calls on one repo never overlap");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a 'cannot lock ref' failure is retried once and the worktree is still created", async () => {
  const { root, reposRoot } = setupRepo();
  try {
    let adds = 0;
    const execFn = async (cmd, args, opts) => {
      if (args[0] === "worktree" && args[1] === "add" && (adds += 1) === 1) {
        throw new Error("Command failed: git worktree add\nerror: cannot lock ref 'refs/heads/griffin/chatlock': Unable to create '.git/refs/heads/griffin/chatlock.lock': File exists.");
      }
      return realExec(cmd, args, opts);
    };
    const dir = await ensureChatWorktree({ reposRoot, repo: "myrepo", chatId: "chat-lock0001", execFn, lockRetryDelayMs: 5 });
    assert.equal(adds, 2, "retried exactly once");
    assert.ok(fs.existsSync(path.join(dir, "a.txt")));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("archiving a chat while its worktree is still being created: cleanup waits, then removes it", async () => {
  const { root, reposRoot, repoDir } = setupRepo();
  try {
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const execFn = async (cmd, args, opts) => {
      if (args[0] === "worktree" && args[1] === "add") await gate;
      return realExec(cmd, args, opts);
    };
    const creating = ensureChatWorktree({ reposRoot, repo: "myrepo", chatId: "chat-arch0001", execFn });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const cleanup = cleanupChatWorktree({ reposRoot, repo: "myrepo", chatId: "chat-arch0001" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    release();
    await creating;
    const outcome = await cleanup;
    assert.equal(outcome.removed, true);
    assert.equal(fs.existsSync(worktreeDir(reposRoot, "chat-arch0001")), false, "no orphan worktree left behind");
    assert.equal(git(["branch", "--list", "griffin/chatarch"], repoDir), "", "its branch went with it");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("archive (worktree remove, branch -D) and a create on the same repo never run git at the same time", async () => {
  const { root, reposRoot, repoDir } = setupRepo();
  try {
    await ensureChatWorktree({ reposRoot, repo: "myrepo", chatId: "chat-old00001" });
    let inFlight = 0;
    let maxInFlight = 0;
    const order = [];
    const execFn = async (cmd, args, opts) => {
      const inRepo = path.resolve(opts.cwd).toLowerCase() === path.resolve(repoDir).toLowerCase();
      if (inRepo) {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
      }
      order.push(args.slice(0, 2).join(" "));
      try {
        // A slow removal widens the window a create would slip into without the lock.
        if (args[0] === "worktree" && args[1] === "remove") await new Promise((resolve) => setTimeout(resolve, 150));
        return await realExec(cmd, args, opts);
      } finally {
        if (inRepo) inFlight -= 1;
      }
    };
    const archiving = removeChatWorktree({ reposRoot, repo: "myrepo", chatId: "chat-old00001", execFn });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const creating = ensureChatWorktree({ reposRoot, repo: "myrepo", chatId: "chat-new00001", execFn });
    await Promise.all([archiving, creating]);
    assert.equal(maxInFlight, 1, `git calls overlapped: ${order.join(", ")}`);
    assert.ok(order.indexOf("branch -D") < order.indexOf("worktree add"), `archive finishes before the create: ${order.join(", ")}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("repo lock key: the real path, case-folded on Windows, so two spellings share one lock", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "griffin-key-"));
  try {
    assert.equal(repoLockKey(dir), repoLockKey(path.join(dir, ".", "")));
    if (process.platform === "win32") assert.equal(repoLockKey(dir.toUpperCase()), repoLockKey(dir.toLowerCase()));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("removeChatWorktree: a failed branch -D is logged, not swallowed", async () => {
  const warnings = [];
  const execFn = async (cmd, args) => {
    if (args[0] === "branch") throw new Error("error: branch 'griffin/chatlogd' is checked out elsewhere");
    return "";
  };
  await removeChatWorktree({ reposRoot: os.tmpdir(), repo: "nope", chatId: "chat-logd0001", execFn, existsSync: () => false, log: { warn: (m) => warnings.push(m) } });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /branch -D.*checked out elsewhere/);
});

const flush = async () => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
};
const flushLong = async () => {
  for (let i = 0; i < 200; i += 1) await Promise.resolve();
};

test("one worktree creation, retries included, gives up at 150 s with a clear timeout", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    // Like a real execFile: hangs until its AbortSignal fires, then exits.
    const hang = (cmd, args, opts) => new Promise((_, reject) => opts.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
    const creating = ensureChatWorktree({
      reposRoot: path.join(os.tmpdir(), "griffin-deadline"), repo: "deadline-repo", chatId: "chat-dead0001",
      execFn: hang, existsSync: () => false, mkdirSync: () => {}, fetchTimeoutMs: 10_000_000, gitTimeoutMs: 10_000_000,
      worktreeAddTimeoutMs: 10_000_000, onNote: () => {},
    });
    let error = null;
    creating.catch((e) => { error = e; });
    await flush();
    mock.timers.tick(149_000);
    await flush();
    assert.equal(error, null, "still running before 150 s");
    mock.timers.tick(1_001);
    await flush();
    assert.ok(error, "failed at 150 s");
    assert.match(error.message, /worktree creation timed out after 150000ms/);
    assert.equal(error.code, "WORKTREE");
  } finally {
    mock.timers.reset();
  }
});

test("a waiter for the repo lock gives up after 180 s with a clear error", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const hang = () => new Promise(() => {});
    const common = {
      reposRoot: path.join(os.tmpdir(), "griffin-lockwait"), repo: "lockwait-repo", execFn: hang,
      existsSync: () => false, mkdirSync: () => {}, fetchTimeoutMs: 10_000_000, gitTimeoutMs: 10_000_000,
      worktreeAddTimeoutMs: 10_000_000, onNote: () => {},
    };
    // The holder never finishes within the test (its own deadline is pushed far out).
    ensureChatWorktree({ ...common, chatId: "chat-hold0001", creationDeadlineMs: 10_000_000 }).catch(() => {});
    await flush();
    let error = null;
    ensureChatWorktree({ ...common, chatId: "chat-wait0001" }).catch((e) => { error = e; });
    await flush();
    mock.timers.tick(179_000);
    await flush();
    assert.equal(error, null, "still waiting before 180 s");
    mock.timers.tick(1_001);
    await flush();
    assert.ok(error, "gave up at 180 s");
    assert.match(error.message, /gave up after 180000ms waiting for the git lock/);
    assert.equal(error.code, "WORKTREE_LOCK");
  } finally {
    mock.timers.reset();
  }
});

test("the creation deadline aborts a hanging fetch and then starts no worktree add", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const calls = [];
    let fetchSignal = null;
    const execFn = (cmd, args, opts) => {
      calls.push(args.slice(0, 2).join(" "));
      if (args[0] === "fetch") {
        fetchSignal = opts.signal;
        return new Promise((_, reject) => opts.signal.addEventListener("abort", () => reject(new Error("aborted"))));
      }
      if (args[0] === "rev-parse") return Promise.reject(new Error("no branch"));
      return Promise.resolve("refs/remotes/origin/main");
    };
    let error = null;
    ensureChatWorktree({
      reposRoot: path.join(os.tmpdir(), "griffin-abortf"), repo: "abortf-repo", chatId: "chat-dlf1", execFn,
      existsSync: () => false, mkdirSync: () => {}, fetchTimeoutMs: 10_000_000, gitTimeoutMs: 10_000_000, fetchFreshMs: 0, onNote: () => {},
    }).catch((e) => { error = e; });
    await flushLong();
    mock.timers.tick(150_001);
    await flushLong();
    await flushLong();
    assert.equal(fetchSignal?.aborted, true, "the fetch is aborted at the deadline");
    assert.match(error?.message || "", /worktree creation timed out after 150000ms/);
    assert.ok(!calls.includes("worktree add"), `no add after the deadline: ${calls}`);
  } finally {
    mock.timers.reset();
  }
});

test("a running `worktree add` is never aborted or timed out; the next creation waits for it to exit", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const calls = [];
    let addOpts = null;
    let exitAdd = null;
    const execFn = (cmd, args, opts) => {
      calls.push(`${opts.cwd.includes("griffin-chatnext") ? "B " : ""}${args.slice(0, 2).join(" ")}`);
      if (args[0] === "worktree" && args[1] === "add" && !addOpts) {
        addOpts = opts;
        return new Promise((resolve) => { exitAdd = () => resolve(""); });
      }
      if (args[0] === "rev-parse") return Promise.reject(new Error("no branch"));
      return Promise.resolve("refs/remotes/origin/main");
    };
    const common = {
      reposRoot: path.join(os.tmpdir(), "griffin-abort"), repo: "abort-repo", execFn,
      existsSync: () => false, mkdirSync: () => {}, fetchTimeoutMs: 10_000_000, gitTimeoutMs: 10_000_000, fetchFreshMs: 0, onNote: () => {},
    };
    let error = null;
    ensureChatWorktree({ ...common, chatId: "chat-dl01" }).catch((e) => { error = e; });
    await flushLong();
    assert.ok(addOpts, "worktree add is running");
    assert.equal(addOpts.signal, undefined, "the add gets no abort signal");
    assert.equal(addOpts.timeout, 0, "the add gets no kill timeout");
    let second = null;
    ensureChatWorktree({ ...common, chatId: "chat-next1" }).then((d) => { second = d; }, () => {});
    await flushLong();
    mock.timers.tick(150_001);
    await flushLong();
    assert.match(error?.message || "", /worktree creation timed out after 150000ms/, "the caller stops waiting at the deadline");
    const before = calls.length;
    assert.equal(calls.at(-1), "worktree add", `no git runs after the add while it is still running: ${calls}`);
    assert.ok(!calls.includes("worktree remove"), `nothing removes the tree under a running add: ${calls}`);
    exitAdd();
    await flushLong();
    await flushLong();
    assert.ok(calls.length > before, "the next creation starts once the add exits");
    assert.ok(second, "and completes");
  } finally {
    mock.timers.reset();
  }
});

test("a chat whose worktree exists starts at once while another chat's fetch holds the repo lock", async () => {
  const { root, reposRoot } = setupRepo();
  try {
    const dirA = await ensureChatWorktree({ reposRoot, repo: "myrepo", chatId: "chat-fast0001", onNote: () => {} });
    let releaseFetch;
    const slowFetch = (cmd, args, opts) => {
      if (args[0] === "fetch") return new Promise((resolve) => { releaseFetch = () => resolve(""); });
      return new Promise((resolve, reject) => execFile(cmd, args, opts, (e, out) => (e ? reject(e) : resolve(out))));
    };
    const holder = ensureChatWorktree({ reposRoot, repo: "myrepo", chatId: "chat-slow0001", execFn: slowFetch, fetchFreshMs: 0, onNote: () => {} });
    await flushLong();
    const started = Date.now();
    const again = await Promise.race([
      ensureChatWorktree({ reposRoot, repo: "myrepo", chatId: "chat-fast0001", onNote: () => {} }),
      new Promise((resolve) => setTimeout(() => resolve("waited"), 2_000)),
    ]);
    assert.equal(again, dirA, "the existing worktree is returned without waiting for the lock");
    assert.ok(Date.now() - started < 1_000);
    releaseFetch?.();
    await holder;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
