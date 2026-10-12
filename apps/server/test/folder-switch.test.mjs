import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chatTreeState, cleanupChatWorktree, ensureChatWorktree, parkedDir, parkedTrees, switchChatWorktree, worktreeDir } from "../src/worktrees.mjs";

const git = (args, cwd) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();

// Two clones (alpha, beta) under one reposRoot, each with its own bare origin.
function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "griffin-fs-"));
  const reposRoot = path.join(root, "repos");
  fs.mkdirSync(reposRoot);
  for (const name of ["alpha", "beta"]) {
    const bare = path.join(root, `${name}.git`);
    git(["init", "-q", "--bare", "-b", "main", bare]);
    const dir = path.join(reposRoot, name);
    git(["clone", "-q", bare, dir]);
    git(["config", "user.email", "t@t.test"], dir);
    git(["config", "user.name", "t"], dir);
    fs.writeFileSync(path.join(dir, `${name}.txt`), "1\n");
    git(["add", "."], dir);
    git(["commit", "-q", "-m", "init"], dir);
    git(["push", "-q", "origin", "main"], dir);
  }
  return { root, reposRoot };
}

test("folder switch: the old tree is set aside whole, the new repo's tree takes the folder, a return brings the old one back", async () => {
  const { root, reposRoot } = setup();
  const chatId = "chat-switch01";
  try {
    const dir = await ensureChatWorktree({ reposRoot, repo: "alpha", chatId });
    fs.writeFileSync(path.join(dir, "wip.txt"), "unsaved");
    const preview = await chatTreeState({ reposRoot, repo: "alpha", toRepo: "beta", chatId, currentDir: dir });
    assert.equal(preview.changed, 1);
    assert.equal(preview.returning, false);
    assert.equal(preview.parked, parkedDir(dir, "alpha"));

    const switched = [];
    const { parked } = await switchChatWorktree({ reposRoot, chatId, fromRepo: "alpha", currentDir: dir, onSwitched: (r) => switched.push(r) });
    assert.equal(parked, parkedDir(dir, "alpha"));
    assert.deepEqual(switched, [{ parked }]);
    assert.equal(fs.readFileSync(path.join(parked, "wip.txt"), "utf8"), "unsaved");
    assert.equal(fs.existsSync(dir), false);

    // The next run in beta makes beta's tree in the same folder.
    const betaDir = await ensureChatWorktree({ reposRoot, repo: "beta", chatId });
    assert.equal(betaDir, dir);
    assert.ok(fs.existsSync(path.join(betaDir, "beta.txt")));
    assert.equal(fs.existsSync(path.join(betaDir, "alpha.txt")), false);

    // Back to alpha: beta's (clean) tree is set aside, alpha's comes back with its unsaved file.
    assert.equal((await chatTreeState({ reposRoot, repo: "beta", toRepo: "alpha", chatId, currentDir: betaDir })).returning, true);
    await switchChatWorktree({ reposRoot, chatId, fromRepo: "beta", currentDir: betaDir });
    const back = await ensureChatWorktree({ reposRoot, repo: "alpha", chatId });
    assert.equal(back, dir);
    assert.equal(fs.readFileSync(path.join(back, "wip.txt"), "utf8"), "unsaved");
    assert.equal(fs.existsSync(parked), false);
    assert.deepEqual(parkedTrees(reposRoot, chatId).map((t) => t.repo), ["beta"]);

    // Archive: the clean set-aside beta tree goes, the dirty alpha tree stays.
    const outcome = await cleanupChatWorktree({ reposRoot, repo: "alpha", chatId });
    assert.equal(outcome.removed, false);
    assert.equal(fs.existsSync(parkedDir(dir, "beta")), false);
    assert.ok(fs.existsSync(path.join(dir, "wip.txt")));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("folder switch: refused while busy, and a chat without a tree yet only moves its repo", async () => {
  const { root, reposRoot } = setup();
  try {
    const dir = await ensureChatWorktree({ reposRoot, repo: "alpha", chatId: "chat-busy0001" });
    await assert.rejects(switchChatWorktree({ reposRoot, chatId: "chat-busy0001", fromRepo: "alpha", currentDir: dir, canMove: () => false }), (e) => e.code === "WORKTREE_BUSY");
    assert.ok(fs.existsSync(path.join(dir, ".git")), "nothing moved");

    const none = await switchChatWorktree({ reposRoot, chatId: "chat-fresh001", fromRepo: "alpha" });
    assert.deepEqual(none, { parked: null });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("folder switch: a cut switch (tree set aside, repo not yet changed) is taken back by the next run", async () => {
  const { root, reposRoot } = setup();
  const chatId = "chat-cutsw001";
  try {
    const dir = await ensureChatWorktree({ reposRoot, repo: "alpha", chatId });
    fs.writeFileSync(path.join(dir, "wip.txt"), "x");
    await switchChatWorktree({ reposRoot, chatId, fromRepo: "alpha", currentDir: dir });
    // The store still says alpha with the old path (a restart before onSwitched stored the move).
    const again = await ensureChatWorktree({ reposRoot, repo: "alpha", chatId, currentDir: dir });
    assert.equal(again, dir);
    assert.ok(fs.existsSync(path.join(again, "wip.txt")));
    assert.equal(worktreeDir(reposRoot, chatId), dir);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("/folder route: owner chats on a repo only, a known other repo, 409 while busy", async () => {
  const { createApp } = await import("../src/app.mjs");
  const { openStore } = await import("../src/db.mjs");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "griffin-fsr-"));
  const store = openStore(path.join(dir, "db.sqlite"));
  try {
    const calls = [];
    let busy = true;
    const folderSwitch = {
      preview: async (chat, repo) => ({ from: chat.repo, to: repo, busy }),
      apply: async (chat, repo) => {
        calls.push(repo);
        if (busy) return { error: "busy" };
        store.updateChat(chat.id, { repo, worktreePath: null });
        return { parked: "/x" };
      },
    };
    const app = createApp({ store, runner: { isActive: () => false }, isValidRepo: (r) => ["alpha", "beta"].includes(r), folderSwitch });
    const chat = store.createChat({ title: "t" });
    store.updateChat(chat.id, { repo: "alpha", worktreePath: "/wt" });
    const post = (body) => app.request(`/api/chats/${chat.id}/folder`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    assert.equal((await app.request(`/api/chats/${chat.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ repo: "beta" }) })).status, 409);
    assert.equal((await post({ repo: "alpha" })).status, 400);
    assert.equal((await post({ repo: "../etc" })).status, 400);
    assert.deepEqual(await (await app.request(`/api/chats/${chat.id}/folder?repo=beta`)).json(), { from: "alpha", to: "beta", busy: true });
    assert.equal((await post({ repo: "beta" })).status, 409);
    busy = false;
    const ok = await post({ repo: "beta" });
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).chat.repo, "beta");
    const peer = store.createChat({ title: "p", caller: "peer:x" });
    store.updateChat(peer.id, { repo: "alpha" });
    assert.equal((await app.request(`/api/chats/${peer.id}/folder`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ repo: "beta" }) })).status, 400);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
