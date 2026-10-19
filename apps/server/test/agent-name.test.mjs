import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Owner 2026-10-17: «پوش و کامیت و امثالهم نباید دیگه با نام گریفین در هیچکدام از ایجنت‌ها تکرار بشه» —
// each install's agent goes by its own name in branches, the MCP server and its prompt.
test("branches, trees and the prompt carry the assistant's own name; older griffin trees keep theirs", async () => {
  process.env.GRIFFIN_ASSISTANT_NAME = "آیدین";
  process.env.GRIFFIN_ASSISTANT_LATIN = "Aydin";
  try {
    const { agentSlug } = await import("../src/persona.mjs");
    const wt = await import("../src/worktrees.mjs");
    assert.equal(agentSlug(), "aydin");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "names-"));
    fs.mkdirSync(path.join(root, "_wt", "griffin-oldchat1"), { recursive: true });
    assert.equal(wt.worktreeDir(root, "newchat2-xxxx"), path.join(root, "_wt", "aydin-newchat2"));
    assert.equal(wt.worktreeDir(root, "oldchat1-xxxx"), path.join(root, "_wt", "griffin-oldchat1"));
    assert.equal(wt.branchName("newchat2-xxxx"), "aydin/newchat2");
    assert.equal(wt.branchOfTree(path.join(root, "_wt", "griffin-oldchat1-2")), "griffin/oldchat1-2");
    const { identity } = await import("../src/prompt.mjs");
    const who = identity("griffin");
    assert.match(who, /You are Aydin \(آیدین\)/);
    assert.match(who, /Never call yourself, sign, or name a git branch/);
    assert.doesNotMatch(who, /platform under it/);
  } finally {
    delete process.env.GRIFFIN_ASSISTANT_NAME;
    delete process.env.GRIFFIN_ASSISTANT_LATIN;
  }
});

// Owner 2026-10-19: «از هویت من استفاده کن همه جا» — GIT_NAME/GIT_EMAIL/GIT_BRANCH_PREFIX put commits and
// new chat branches under the owner's name; unset, the assistant's own name stays.
test("commits and new chat branches carry the owner's git identity when it is set", async () => {
  process.env.GRIFFIN_ASSISTANT_LATIN = "Aydin";
  try {
    const { gitIdentity, gitPrefix } = await import("../src/persona.mjs");
    const wt = await import("../src/worktrees.mjs");
    assert.deepEqual(gitIdentity(), { name: "Aydin", email: "aydin@agents.griffin.invalid" });
    assert.equal(gitPrefix(), "aydin");
    process.env.GRIFFIN_GIT_NAME = "Sara Example";
    process.env.GRIFFIN_GIT_EMAIL = "sara@example.com";
    process.env.GRIFFIN_GIT_BRANCH_PREFIX = "Sara";
    assert.deepEqual(gitIdentity(), { name: "Sara Example", email: "sara@example.com" });
    assert.equal(wt.branchName("newchat3-xxxx"), "sara/newchat3");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "names-"));
    fs.mkdirSync(path.join(root, "_wt", "aydin-oldchat2"), { recursive: true });
    assert.equal(wt.worktreeDir(root, "oldchat2-xxxx"), path.join(root, "_wt", "aydin-oldchat2"));
    assert.equal(wt.worktreeDir(root, "newchat3-xxxx"), path.join(root, "_wt", "sara-newchat3"));
  } finally {
    for (const k of ["GRIFFIN_ASSISTANT_LATIN", "GRIFFIN_GIT_NAME", "GRIFFIN_GIT_EMAIL", "GRIFFIN_GIT_BRANCH_PREFIX"]) delete process.env[k];
  }
});
