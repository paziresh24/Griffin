// A fork or side chat works in its main chat's worktree: an archived main keeps its tree while one of
// them is open (2026-10-24, a fork of an archived chat lost its folder before every run).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openStore } from "../src/db.mjs";
import { hasLiveBorrower, treeBorrowers, treeOwnerId, treeToRelease } from "../src/tree-borrowers.mjs";

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "griffin-borrow-"));
  const store = openStore(path.join(dir, "db.sqlite"));
  const repoChat = () => {
    const chat = store.createChat({ title: "t" });
    store.updateChat(chat.id, { repo: "myrepo" });
    return chat;
  };
  return { dir, store, repoChat };
}

test("a fork works in its source's tree, a fork of a fork in the first source's", () => {
  const { dir, store, repoChat } = setup();
  try {
    const main = repoChat();
    const fork = repoChat();
    const fork2 = repoChat();
    store.setKv(`fork-of:${fork.id}`, main.id);
    store.setKv(`fork-of:${fork2.id}`, fork.id);
    assert.equal(treeOwnerId(store, main.id), main.id);
    assert.equal(treeOwnerId(store, fork.id), main.id);
    assert.equal(treeOwnerId(store, fork2.id), main.id);
    assert.deepEqual(treeBorrowers(store, main.id).map((r) => r.id).sort(), [fork.id, fork2.id].sort());
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("an archived main keeps its tree while its fork is open, and gives it back once the fork is archived", () => {
  const { dir, store, repoChat } = setup();
  try {
    const main = repoChat();
    const fork = repoChat();
    store.setKv(`fork-of:${fork.id}`, main.id);
    store.updateChat(main.id, { archived: true });
    assert.equal(hasLiveBorrower(store, main.id), true);
    assert.equal(treeToRelease(store, main.id), null, "the main's own archive does not free the tree");
    assert.equal(treeToRelease(store, fork.id), null, "storing the tree's path while the fork runs does not free it");
    store.updateChat(fork.id, { archived: true });
    assert.equal(treeToRelease(store, fork.id), main.id, "the fork's archive frees the main's tree");
    assert.equal(treeToRelease(store, main.id), main.id);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a side chat holds its archived main's tree the same way; a live main is never released", () => {
  const { dir, store, repoChat } = setup();
  try {
    const main = repoChat();
    const side = store.createChat({ title: "side", sideOf: main.id });
    assert.equal(treeToRelease(store, main.id), null, "live main");
    store.updateChat(main.id, { archived: true });
    assert.equal(treeToRelease(store, main.id), null, "open side chat");
    store.updateChat(side.id, { archived: true });
    assert.equal(treeToRelease(store, side.id), main.id);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a fork loop does not hang", () => {
  const { dir, store, repoChat } = setup();
  try {
    const a = repoChat();
    const b = repoChat();
    store.setKv(`fork-of:${a.id}`, b.id);
    store.setKv(`fork-of:${b.id}`, a.id);
    assert.ok([a.id, b.id].includes(treeOwnerId(store, a.id)));
    assert.equal(treeBorrowers(store, a.id).length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
