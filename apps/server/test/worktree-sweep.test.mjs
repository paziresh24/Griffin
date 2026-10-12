// Startup sweep of chat worktrees (glue: worktree removal logic × chat archive/delete) and the
// local griffin/<id8> branch going with every worktree removed on archive. Real temp git repos.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cleanupChatWorktree, ensureChatWorktree, sweepChatWorktrees, worktreeDir } from "../src/worktrees.mjs";

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function setupRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "griffin-sweep-"));
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

const branches = (repoDir) => git(["branch", "--format=%(refname:short)"], repoDir).split("\n").filter(Boolean);

test("startup sweep: archived/deleted + clean + no own commits are removed with their branch; the rest are kept", async () => {
  const { root, reposRoot, repoDir } = setupRepo();
  try {
    const ids = {
      archivedClean: "aaaa1111",
      deletedClean: "bbbb2222",
      archivedDirty: "cccc3333",
      deletedOwnCommit: "dddd4444",
      live: "eeee5555",
    };
    for (const id of Object.values(ids)) await ensureChatWorktree({ reposRoot, repo: "myrepo", chatId: id, onNote: () => {} });
    fs.writeFileSync(path.join(worktreeDir(reposRoot, ids.archivedDirty), "wip.txt"), "wip\n");
    const own = worktreeDir(reposRoot, ids.deletedOwnCommit);
    git(["config", "user.email", "t@t.test"], own);
    git(["config", "user.name", "t"], own);
    fs.writeFileSync(path.join(own, "b.txt"), "local only\n");
    git(["add", "b.txt"], own);
    git(["commit", "-q", "-m", "local"], own);
    // The owner's own worktrees share _wt: one matches the 8-char name but is on another branch,
    // one does not match the name pattern at all. Neither may ever be touched.
    const ownerLookalike = path.join(reposRoot, "_wt", "griffin-ffff6666");
    git(["worktree", "add", "-q", ownerLookalike, "origin/main", "-b", "integration-x"], repoDir);
    const ownerOther = path.join(reposRoot, "_wt", "griffin-int2");
    git(["worktree", "add", "-q", ownerOther, "origin/main", "-b", "integration-night2"], repoDir);

    const states = {
      [ids.archivedClean]: "archived",
      [ids.deletedClean]: "deleted",
      [ids.archivedDirty]: "archived",
      [ids.deletedOwnCommit]: "deleted",
      [ids.live]: "active",
      ffff6666: "deleted",
    };
    const results = await sweepChatWorktrees({ reposRoot, chatState: (id8) => states[id8] ?? "deleted" });
    const byId = Object.fromEntries(results.map((r) => [r.id8, r]));

    assert.equal(byId[ids.archivedClean].action, "removed");
    assert.equal(byId[ids.deletedClean].action, "removed");
    assert.equal(fs.existsSync(worktreeDir(reposRoot, ids.archivedClean)), false);
    assert.equal(fs.existsSync(worktreeDir(reposRoot, ids.deletedClean)), false);

    assert.equal(byId[ids.archivedDirty].action, "kept");
    assert.equal(byId[ids.deletedOwnCommit].action, "kept");
    assert.equal(byId[ids.live].action, "kept");
    assert.equal(byId.ffff6666.action, "kept");
    assert.equal(results.some((r) => r.dir === ownerOther), false, "a non griffin-<id8> name is not even a candidate");
    for (const id of [ids.archivedDirty, ids.deletedOwnCommit, ids.live]) assert.ok(fs.existsSync(worktreeDir(reposRoot, id)));
    assert.ok(fs.existsSync(ownerLookalike) && fs.existsSync(ownerOther));

    const left = branches(repoDir);
    assert.ok(!left.includes(`griffin/${ids.archivedClean}`), "removed worktree's local branch is deleted");
    assert.ok(!left.includes(`griffin/${ids.deletedClean}`));
    for (const b of [`griffin/${ids.archivedDirty}`, `griffin/${ids.deletedOwnCommit}`, `griffin/${ids.live}`, "integration-x", "integration-night2"]) {
      assert.ok(left.includes(b), `${b} kept`);
    }

    // Idempotent: a second sweep removes nothing more.
    const again = await sweepChatWorktrees({ reposRoot, chatState: (id8) => states[id8] ?? "deleted" });
    assert.equal(again.filter((r) => r.action === "removed").length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("archive: removing a worktree always deletes its local branch, even when the directory is already gone", async () => {
  const { root, reposRoot, repoDir } = setupRepo();
  try {
    const dir = await ensureChatWorktree({ reposRoot, repo: "myrepo", chatId: "gggg7777", onNote: () => {} });
    const outcome = await cleanupChatWorktree({ reposRoot, repo: "myrepo", chatId: "gggg7777" });
    assert.equal(outcome.removed, true);
    assert.equal(fs.existsSync(dir), false);
    assert.ok(!branches(repoDir).includes("griffin/gggg7777"));

    const dir2 = await ensureChatWorktree({ reposRoot, repo: "myrepo", chatId: "hhhh8888", onNote: () => {} });
    fs.rmSync(dir2, { recursive: true, force: true }); // deleted by hand; git still records it
    const outcome2 = await cleanupChatWorktree({ reposRoot, repo: "myrepo", chatId: "hhhh8888" });
    assert.equal(outcome2.removed, true);
    assert.ok(!branches(repoDir).includes("griffin/hhhh8888"), "stale worktree pruned and its branch deleted");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
