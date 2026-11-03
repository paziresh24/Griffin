import test from "node:test";
import assert from "node:assert/strict";
import { gitIdentityRefusal } from "../src/providers/git-identity-guard.mjs";

// 2026-10-29: pushes under a person's token whose commits said «Nova» / «Atlas» (Platform author watch).
test("Bash may not pick a commit's name; reading it stays allowed", () => {
  const refused = [
    `git -c user.name=Nova -c user.email=nova@example.com commit -m "fix"`,
    `cd /x && git -c user.name="Nova" commit -qm x && git push`,
    `git config user.name "Nova"`,
    `git config --global user.email atena@example.com`,
    `git config --local user.name Kian`,
    `git commit --author="Nova <nova@x>" -m x`,
    `git commit -m x --author "Nova <nova@x>"`,
    `GIT_AUTHOR_NAME=Nova GIT_AUTHOR_EMAIL=i@x git commit -m x`,
    `export GIT_COMMITTER_EMAIL=i@x; git commit -m x`,
    `git filter-branch --env-filter 'GIT_AUTHOR_NAME=x' HEAD`,
  ];
  for (const command of refused) assert.ok(gitIdentityRefusal("Bash", { command }), command);
  const allowed = [
    `git commit -m "fix: user.name in docs"`,
    `git config user.name`,
    `git config --get user.email`,
    `git config --list | grep user`,
    `git log --author=Nova --format=%an`,
    `git commit --amend --reset-author --no-edit`,
    `git push origin HEAD`,
    `echo $GIT_AUTHOR_NAME`,
    `ls -la`,
  ];
  for (const command of allowed) assert.equal(gitIdentityRefusal("Bash", { command }), null, command);
  assert.equal(gitIdentityRefusal("Write", { command: `git -c user.name=x commit` }), null);
});
