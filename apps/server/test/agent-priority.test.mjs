import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AGENT_OOM_SCORE_ADJ, agentNice, lowPriorityExecutable } from "../src/providers/agent-priority.mjs";
import { claudeExecutableOption } from "../src/providers/claude.mjs";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "agent-priority-"));

test("GRIFFIN_AGENT_NICE: 10 by default, 0/off turns the wrapper off, clamped to 0..19", () => {
  assert.equal(agentNice({}), 10);
  assert.equal(agentNice({ GRIFFIN_AGENT_NICE: "off" }), 0);
  assert.equal(agentNice({ GRIFFIN_AGENT_NICE: "0" }), 0);
  assert.equal(agentNice({ GRIFFIN_AGENT_NICE: "40" }), 19);
  assert.equal(lowPriorityExecutable("/bin/true", { env: { GRIFFIN_AGENT_NICE: "off" }, dir: tmp() }), null);
  assert.equal(lowPriorityExecutable("/bin/true", { env: {}, dir: tmp(), platform: "darwin" }), null);
  assert.equal(lowPriorityExecutable("", { env: {}, dir: tmp() }), null);
});

test("Claude Code and what it starts run below the app: lower CPU priority, first for the OOM killer (a colleague, Mohammadi 2026-11-24)", { skip: process.platform !== "linux" }, () => {
  const dir = tmp();
  // A stand-in for the binary: a shell that starts a child (like a build) and reports the child's priority.
  const real = path.join(dir, "fake claude's bin");
  fs.writeFileSync(real, '#!/bin/sh\nsh -c \'echo "$(nice) $(cat /proc/self/oom_score_adj) $*"\' child "$@"\n', { mode: 0o755 });
  const wrapper = lowPriorityExecutable(real, { env: {}, dir });
  assert.ok(wrapper && fs.statSync(wrapper).mode & 0o100);
  const [nice, adj, ...args] = execFileSync(wrapper, ["--print", "a b"], { encoding: "utf8" }).trim().split(" ");
  assert.equal(Number(nice), Math.min(19, os.getPriority() + 10));
  assert.ok(Number(adj) >= AGENT_OOM_SCORE_ADJ);
  assert.deepEqual(args, ["--print", "a", "b"]);
  // Written once: the same binary gets the same file back.
  assert.equal(lowPriorityExecutable(real, { env: {}, dir }), wrapper);
});

test("claudeExecutableOption hands the SDK the wrapper, or the plain binary when there is none", () => {
  const wrap = (real) => (real ? `/w/${path.basename(real)}` : null);
  assert.deepEqual(claudeExecutableOption({}, { real: "/sdk/claude", wrap }), { pathToClaudeCodeExecutable: "/w/claude" });
  assert.deepEqual(claudeExecutableOption({ GRIFFIN_CLAUDE_BIN: "/host/claude" }, { real: "/sdk/claude", wrap }), { pathToClaudeCodeExecutable: "/w/claude" });
  assert.deepEqual(claudeExecutableOption({ GRIFFIN_CLAUDE_BIN: "/host/claude" }, { real: null, wrap: () => null }), { pathToClaudeCodeExecutable: "/host/claude" });
  assert.deepEqual(claudeExecutableOption({}, { real: null, wrap: () => null }), {});
});
