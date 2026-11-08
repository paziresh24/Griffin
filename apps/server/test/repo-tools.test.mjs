import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRepoChatTools, plantedGitConfig } from "../src/repo-tools.mjs";

function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "griffin-repotools-"));
  const git = (...args) => execFileSync("git", args, { cwd: dir, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  git("init", "-q", "-b", "griffin/ab12cd34");
  fs.writeFileSync(path.join(dir, "a.txt"), "one\ntwo\n");
  git("add", ".");
  git("commit", "-qm", "init");
  return dir;
}

test("repo tools read, edit, search and commit inside the worktree, and nothing outside it", async () => {
  const dir = repo();
  const pushed = [];
  const t = createRepoChatTools({ dir, repo: "app", branch: "griffin/ab12cd34", push: async (x) => (pushed.push(x), { pushed: true }) });

  assert.match((await t.repo_read.execute({ path: "a.txt" })).text, /1  one/);
  await t.repo_edit.execute({ path: "a.txt", old: "two", new: "دو" });
  await t.repo_write.execute({ path: "src/new.js", content: "export const x = 1;\n" });
  assert.deepEqual((await t.repo_list.execute({})).files.sort(), ["a.txt", "src/new.js"]);
  assert.match((await t.repo_search.execute({ pattern: "دو" })).matches[0], /^a\.txt:2:دو/);
  await t.repo_git.execute({ args: ["add", "-A"] });
  await t.repo_git.execute({ args: ["commit", "-m", "change"] });
  assert.match((await t.repo_git.execute({ args: ["log", "--oneline"] })).output, /change/);
  assert.deepEqual(await t.repo_push.execute(), { pushed: true });
  assert.deepEqual(pushed, [{ repo: "app", branch: "griffin/ab12cd34" }]);

  await assert.rejects(t.repo_read.execute({ path: "../../etc/passwd" }), /outside/);
  await assert.rejects(t.repo_write.execute({ path: ".git/config", content: "x" }), /\.git/);
  await assert.rejects(t.repo_git.execute({ args: ["checkout", "main"] }), /not allowed/);
  await assert.rejects(t.repo_git.execute({ args: ["-C", "/", "status"] }), /not allowed/);
  await assert.rejects(t.repo_git.execute({ args: ["log", "--output=/tmp/x"] }), /not allowed/);
  fs.symlinkSync("/etc", path.join(dir, "out"));
  await assert.rejects(t.repo_read.execute({ path: "out/hostname" }), /symlink/);
});

// 2026-10-29: Kaveh's commits went out under a person's token with the persona's name.
test("repo_git commits as the GitLab user the pushes go out as; --author is refused", async () => {
  const dir = repo();
  const t = createRepoChatTools({ dir, repo: "app", branch: "griffin/ab12cd34", push: async () => ({}), author: async () => ({ name: "SM Hossein Nouri", email: "nouri@x.ir" }) });
  fs.writeFileSync(path.join(dir, "b.txt"), "b\n");
  await t.repo_git.execute({ args: ["add", "b.txt"] });
  await t.repo_git.execute({ args: ["commit", "-m", "b"] });
  const who = String(execFileSync("git", ["log", "-1", "--format=%an|%ae|%cn|%ce"], { cwd: dir })).trim();
  assert.equal(who, "SM Hossein Nouri|nouri@x.ir|SM Hossein Nouri|nouri@x.ir");
  await assert.rejects(t.repo_git.execute({ args: ["commit", "--allow-empty", "--author=Kaveh <k@k>", "-m", "x"] }), /--author is not allowed/);
  // No GitLab user known: the old identity, the commit still goes through.
  const blind = createRepoChatTools({ dir, repo: "app", branch: "griffin/ab12cd34", push: async () => ({}), author: async () => null });
  await blind.repo_git.execute({ args: ["commit", "--allow-empty", "-m", "c"] });
  assert.notEqual(String(execFileSync("git", ["log", "-1", "--format=%ae"], { cwd: dir })).trim(), "nouri@x.ir");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a planted core.fsmonitor (or any program-running key) in the repo's config stops git before it runs", async () => {
  const dir = repo();
  const marker = path.join(dir, "..", `pwned-${path.basename(dir)}`);
  const t = createRepoChatTools({ dir, repo: "app", branch: "griffin/ab12cd34", push: async () => ({ pushed: true }) });
  assert.match((await t.repo_git.execute({ args: ["status"] })).output, /griffin\/ab12cd34|nothing to commit/);
  execFileSync("git", ["config", "core.fsmonitor", `touch ${marker}; false`], { cwd: dir });
  await assert.rejects(t.repo_git.execute({ args: ["status"] }), /core\.fsmonitor/);
  assert.equal(fs.existsSync(marker), false, "the planted program never ran");
});

test("plantedGitConfig: only local/worktree program-running keys; a local hooksPath (husky) is fine", () => {
  const listing = [
    "local\tcore.repositoryformatversion", "local\tcore.hookspath", "local\tremote.origin.url",
    "global\tfilter.lfs.clean", "local\tfilter.x.smudge", "worktree\tdiff.foo.textconv",
    "local\tgpg.program", "local\tgpg.ssh.program", "local\tcredential.helper", "local\tinclude.path",
    "local\turl.https://evil/.insteadof", "command\tcore.fsmonitor",
  ].join("\n");
  assert.deepEqual(plantedGitConfig(listing), ["filter.x.smudge", "diff.foo.textconv", "gpg.program", "gpg.ssh.program", "credential.helper", "include.path", "url.https://evil/.insteadof"]);
});
