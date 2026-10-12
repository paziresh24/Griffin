// Real git: the chain of replacement worktrees (A1 at most one replacement, A2 archive/sweep look
// at every tree the chat used, A3 a missing current tree is re-added from its branch).
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cleanupChatWorktree, ensureChatWorktree, sweepChatWorktrees } from "../src/worktrees.mjs";

const git = (args, cwd) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

function setupRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "griffin-chain-"));
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
// A chat whose stored current tree lives in `db.current`, as the server keeps it.
function chat(reposRoot, chatId) {
  const db = { current: null };
  const notes = [];
  const opts = () => ({
    reposRoot,
    repo: "myrepo",
    chatId,
    fetchFreshMs: 0,
    currentDir: db.current,
    onCurrent: (dir) => {
      db.current = dir;
    },
    onNote: (n) => notes.push(n),
  });
  return { db, notes, ensure: () => ensureChatWorktree(opts()) };
}
function breakTree(repoDir, dir) {
  // What an interrupted `git worktree add` leaves: locked "initializing", no files.
  fs.writeFileSync(path.join(adminDir(repoDir, dir), "locked"), "initializing");
  for (const f of fs.readdirSync(dir)) if (f !== ".git") fs.rmSync(path.join(dir, f), { recursive: true, force: true });
}
const commitIn = (dir, name) => {
  fs.writeFileSync(path.join(dir, name), "x\n");
  git(["add", name], dir);
  git(["-c", "user.email=t@t.test", "-c", "user.name=t", "commit", "-q", "-m", name], dir);
};

test("A1: when the -2 tree is unusable too, the start fails visibly naming both paths; no -3 is ever made", async () => {
  const { root, reposRoot, repoDir } = setupRepo();
  try {
    const c = chat(reposRoot, "pile0001");
    const first = await c.ensure();
    breakTree(repoDir, first);
    const second = await c.ensure();
    assert.equal(second, `${first}-2`);
    assert.equal(c.db.current, second, "the chat's current tree is stored");
    breakTree(repoDir, second);
    await assert.rejects(c.ensure(), (error) => {
      assert.ok(error.message.includes(first) && error.message.includes(second), error.message);
      return true;
    });
    assert.equal(fs.existsSync(`${first}-3`), false, "no -3 tree");
    assert.equal(git(["branch", "--list", "griffin/pile0001-3"], repoDir), "", "no -3 branch");
    assert.equal(c.db.current, second, "the stored tree is unchanged");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("A2: archiving a chat on -2 with an unpushed commit evaluates both trees; -2 is kept with a note, nothing is orphaned", async () => {
  const { root, reposRoot, repoDir } = setupRepo();
  try {
    const c = chat(reposRoot, "arch0002");
    const first = await c.ensure();
    breakTree(repoDir, first);
    const second = await c.ensure();
    commitIn(second, "mine.txt");
    const out = await cleanupChatWorktree({ reposRoot, repo: "myrepo", chatId: "arch0002", currentDir: c.db.current, log: { warn: () => {} } });
    assert.equal(out.removed, false);
    const byDir = Object.fromEntries(out.trees.map((t) => [t.dir, t]));
    assert.deepEqual(Object.keys(byDir).sort(), [first, second].sort(), "both trees evaluated");
    assert.equal(byDir[second].action, "kept");
    assert.match(byDir[second].reason, /unpushed/);
    assert.ok(byDir[first].reason, "the base tree's outcome is stated");
    assert.ok(fs.existsSync(path.join(second, "mine.txt")), "the -2 work is still there");
    assert.match(git(["branch", "--list", "griffin/arch0002-2"], repoDir), /arch0002-2/, "its branch is kept");
    assert.ok(out.reason.includes(second), `the summary names the kept tree: ${out.reason}`);

    // The startup sweep sees the -2 tree too, under the same rules.
    const swept = await sweepChatWorktrees({ reposRoot, chatState: () => "archived" });
    const s2 = swept.find((r) => r.dir === second);
    assert.ok(s2, "the sweep matches griffin-<id8>-2");
    assert.equal(s2.action, "kept");
    assert.match(s2.reason, /unpushed/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("A2: a clean -2 tree of an archived chat is removed by the sweep with its branch", async () => {
  const { root, reposRoot, repoDir } = setupRepo();
  try {
    const c = chat(reposRoot, "swep0002");
    const first = await c.ensure();
    breakTree(repoDir, first);
    const second = await c.ensure();
    const swept = await sweepChatWorktrees({ reposRoot, chatState: () => "archived" });
    const s2 = swept.find((r) => r.dir === second);
    assert.equal(s2?.action, "removed", JSON.stringify(swept));
    assert.equal(fs.existsSync(second), false);
    assert.equal(git(["branch", "--list", "griffin/swep0002-2"], repoDir), "");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("A3: a missing current tree is re-added from its branch; the chat does not fall back to the base tree", async () => {
  const { root, reposRoot, repoDir } = setupRepo();
  try {
    const c = chat(reposRoot, "miss0003");
    const first = await c.ensure();
    breakTree(repoDir, first);
    const second = await c.ensure();
    commitIn(second, "mine.txt");
    fs.rmSync(second, { recursive: true, force: true });
    const again = await c.ensure();
    assert.equal(again, second);
    assert.equal(git(["rev-parse", "--abbrev-ref", "HEAD"], again), "griffin/miss0003-2");
    assert.ok(fs.existsSync(path.join(again, "mine.txt")), "the branch's commit is back");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("A3: a missing current tree whose branch is gone fails visibly", async () => {
  const { root, reposRoot, repoDir } = setupRepo();
  try {
    const c = chat(reposRoot, "gone0003");
    const first = await c.ensure();
    breakTree(repoDir, first);
    const second = await c.ensure();
    fs.rmSync(second, { recursive: true, force: true });
    git(["worktree", "prune"], repoDir);
    git(["branch", "-D", "griffin/gone0003-2"], repoDir);
    await assert.rejects(c.ensure(), (error) => {
      assert.ok(error.message.includes(second) && error.message.includes("griffin/gone0003-2"), error.message);
      return true;
    });
    assert.equal(fs.existsSync(second), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
