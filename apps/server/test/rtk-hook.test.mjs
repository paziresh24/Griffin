import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RTK_ENV, RTK_NOTE, hasBashRules, rtkBinary, rtkEnabled, rtkFor, rtkHook, rtkMayRewrite, withRtk, withRtkPath } from "../src/providers/rtk.mjs";
import { CONFIG_SCHEMA } from "../src/config.mjs";
import { setConfigOverrides } from "../src/env.mjs";

// A stand-in for `rtk hook claude`: reads the PreToolUse JSON from stdin and answers like rtk 1.2 does
// (checked against the real v1.2.1 binary): `git …` becomes `rtk git …`, everything else prints nothing.
function fakeRtk(dir, body) {
  const file = path.join(dir, "rtk");
  fs.writeFileSync(file, `#!/usr/bin/env node\nlet s = ""; process.stdin.on("data", (c) => (s += c)); process.stdin.on("end", () => {\n${body}\n});\n`, { mode: 0o755 });
  return file;
}
const REWRITE_ANY = `
const c = JSON.parse(s).tool_input.command;
console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", permissionDecisionReason: "RTK auto-rewrite", updatedInput: { command: "rtk " + c } } }));
`;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "rtk-test-"));
const noRules = () => false;

test("a rewritten Bash command keeps its other fields and carries no permission decision", async () => {
  const hook = rtkHook({ bin: fakeRtk(tmp(), REWRITE_ANY), rules: noRules });
  const out = await hook({ tool_name: "Bash", tool_input: { command: "git status", description: "status", timeout: 5000, run_in_background: false } });
  assert.deepEqual(out, { hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput: { command: "rtk git status", description: "status", timeout: 5000, run_in_background: false } } });
  assert.equal(out.hookSpecificOutput.permissionDecision, undefined);
});

test("nothing to rewrite, other tools, empty or odd input: the command runs as written", async () => {
  const hook = rtkHook({ bin: fakeRtk(tmp(), `process.exit(0);`), rules: noRules });
  assert.deepEqual(await hook({ tool_name: "Bash", tool_input: { command: "git status" } }), {});
  const any = rtkHook({ bin: fakeRtk(tmp(), REWRITE_ANY), rules: noRules });
  assert.deepEqual(await any({ tool_name: "Read", tool_input: { command: "git status" } }), {});
  assert.deepEqual(await any({ tool_name: "Bash", tool_input: { command: "" } }), {});
  assert.deepEqual(await any({ tool_name: "Bash", tool_input: {} }), {});
  assert.deepEqual(await any({}), {});
  assert.deepEqual(await any(undefined), {});
});

test("a broken, slow or missing rtk never blocks or changes the command", async () => {
  const call = (hook) => hook({ tool_name: "Bash", tool_input: { command: "git status" } });
  assert.deepEqual(await call(rtkHook({ bin: fakeRtk(tmp(), `console.log("not json");`), rules: noRules })), {});
  assert.deepEqual(await call(rtkHook({ bin: fakeRtk(tmp(), `process.exit(3);`), rules: noRules })), {});
  const began = Date.now();
  assert.deepEqual(await call(rtkHook({ bin: fakeRtk(tmp(), `setTimeout(() => {}, 60000);`), timeoutMs: 150, rules: noRules })), {});
  assert.ok(Date.now() - began < 5000, "gave up at the timeout");
  assert.deepEqual(await call(rtkHook({ bin: path.join(tmp(), "no-such-rtk"), rules: noRules })), {});
  assert.deepEqual(await call(rtkHook({ bin: fakeRtk(tmp(), `console.log(JSON.stringify({ hookSpecificOutput: { updatedInput: { command: JSON.parse(s).tool_input.command } } }));`), rules: noRules })), {}, "same command");
  assert.deepEqual(await call(rtkHook({ bin: fakeRtk(tmp(), `console.log(JSON.stringify({ hookSpecificOutput: { updatedInput: { command: 5 } } }));`), rules: noRules })), {}, "not a string");
});

// 2026-11-22, live against the SDK's own CLI and a mock Anthropic server: Claude Code runs the rewritten
// command and runs its permission step (approval card, allow/deny rules) on the REWRITTEN text. So the
// hook must stay out wherever that step could differ.
test("only in a chat that asks for nothing, and only without a Bash rule of the owner", async () => {
  const bin = fakeRtk(tmp(), REWRITE_ANY);
  let mode = "agent";
  let rules = false;
  const hook = rtkHook({ bin, active: () => ["agent", "auto"].includes(mode), rules: () => rules });
  const rewrite = () => hook({ tool_name: "Bash", tool_input: { command: "git status" } });
  assert.equal((await rewrite()).hookSpecificOutput.updatedInput.command, "rtk git status");
  mode = "ask";
  assert.deepEqual(await rewrite(), {}, "in ask mode a read-only command would become an approval card");
  mode = "plan";
  assert.deepEqual(await rewrite(), {});
  mode = "auto";
  assert.ok((await rewrite()).hookSpecificOutput, "the mode is read on every call");
  rules = true;
  assert.deepEqual(await rewrite(), {}, "a deny rule written for `git status` would not match `rtk git status`");
});

test("the settings read are the chat's folder's, not wherever an earlier cd left the shell", async () => {
  const chat = tmp();
  const elsewhere = tmp();
  const seen = [];
  const hook = rtkHook({ bin: fakeRtk(tmp(), REWRITE_ANY), cwd: chat, configDirs: ["/x"], rules: (args) => (seen.push(args), false) });
  await hook({ tool_name: "Bash", cwd: elsewhere, tool_input: { command: "git status" } });
  assert.deepEqual(seen, [{ cwd: chat, configDirs: ["/x"] }]);
});

test("the owner's own Bash deny/ask rules are found in user, project and local settings", () => {
  const home = tmp();
  const cwd = tmp();
  const env = { HOME: home };
  assert.equal(hasBashRules({ cwd, env }), false);
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(home, ".claude", "settings.json"), JSON.stringify({ hooks: {}, permissions: { allow: ["Bash(git status:*)"], deny: ["Read(./.env)"] } }));
  assert.equal(hasBashRules({ cwd, env }), false, "allow rules and non-Bash rules do not matter");
  fs.writeFileSync(path.join(home, ".claude", "settings.json"), JSON.stringify({ permissions: { deny: ["Bash(git push --force:*)"] } }));
  assert.equal(hasBashRules({ cwd, env }), true, "user settings");
  fs.writeFileSync(path.join(home, ".claude", "settings.json"), "{}");
  fs.mkdirSync(path.join(cwd, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(cwd, ".claude", "settings.local.json"), JSON.stringify({ permissions: { ask: ["Bash"] } }));
  assert.equal(hasBashRules({ cwd, env }), true, "project-local settings");
  fs.writeFileSync(path.join(cwd, ".claude", "settings.local.json"), "{ not json");
  assert.equal(hasBashRules({ cwd, env }), true, "a file we cannot read may hold rules: stay out");
  fs.writeFileSync(path.join(cwd, ".claude", "settings.local.json"), "{}");
  assert.equal(hasBashRules({ cwd, env }), false);
  const other = tmp();
  fs.writeFileSync(path.join(other, "settings.json"), JSON.stringify({ permissions: { deny: ["Bash(rm:*)"] } }));
  assert.equal(hasBashRules({ cwd, env, configDirs: [other] }), true, "another account folder the run may read (claude-account-dir)");
  assert.equal(hasBashRules({ cwd, env: { HOME: home, CLAUDE_CONFIG_DIR: other } }), true, "CLAUDE_CONFIG_DIR of the server");
});

test("only plain chains of read-only git and grep are rewritten", () => {
  const yes = [
    "git status",
    "git log --oneline -20",
    "git diff HEAD~1",
    "git -C /repo log -5",
    "git --no-pager diff --stat",
    "git branch",
    "git branch -a",
    "git branch -vv",
    "git tag -l",
    "git remote -v",
    "cd /repo && git status && git diff",
    "grep -rn foo apps",
    'grep -rn "foo bar" apps',
    "rg foo",
  ];
  for (const command of yes) assert.equal(rtkMayRewrite(command), true, command);
  const no = [
    // not worth it or lossy (measured with the real binary): find regroups paths, ls/tree/wc save nothing
    "ls",
    "ls -a apps",
    "ls -la",
    "find . -name '*.mjs'",
    "tree -L 2",
    "wc apps/a.js",
    "vitest run",
    "cat file",
    // mutating or not a plain listing
    "git commit -m x",
    "git push --force",
    "git checkout main",
    "git branch -D old",
    "git branch -f x HEAD",
    "git branch newname",
    "git branch --unset-upstream",
    "git branch -u origin/x",
    "git tag v1",
    "git tag -a v1",
    "git remote add x y",
    "git remote set-head origin main",
    // machine formats
    "git log --format=%H",
    "git diff --name-only",
    "git status --porcelain",
    "git status -z",
    "git status -sz",
    "grep -c foo file",
    "grep -l foo .",
    "grep -o foo f",
    "grep -rc foo .",
    // other tools whose output is the evidence
    "kubectl get pods",
    "psql -c 'select 1'",
    "docker logs x",
    "env",
    "curl -s http://x",
    "npm test",
    // shapes
    "git log | head",
    "git diff | wc -l",
    "git status > out.txt",
    "git status 2>&1",
    "git status &",
    "git log $(echo HEAD)",
    "git log `echo HEAD`",
    "git log $REV",
    "git status || true",
    "FOO=1 git status",
    "RTK_DISABLED=1 git status",
    "git status\ngit log",
    "cd /a /b && git status",
    "echo hi && git status",
    // quotes hide a separator from the naive split (review of !508)
    "grep 'a;b' f",
    "grep -e 'x; ls ' -e y f && git status",
    "git log --grep='a&&b'",
    "",
    "   ",
    undefined,
    5,
  ];
  for (const command of no) assert.equal(rtkMayRewrite(command), false, String(command));
});

test("the binary is the image's copy or GRIFFIN_RTK_BIN — not ~/.local/bin (inside the writable data folder) and not PATH", () => {
  const home = tmp();
  assert.equal(rtkBinary({ HOME: home, PATH: "" }, null), null);
  const local = path.join(home, ".local", "bin");
  fs.mkdirSync(local, { recursive: true });
  fakeRtk(local, "");
  assert.equal(rtkBinary({ HOME: home, PATH: "" }, null), null, "a chat could have written it");
  const onPath = tmp();
  fakeRtk(onPath, "");
  assert.equal(rtkBinary({ HOME: tmp(), PATH: onPath }, null), null, "a look-alike on PATH is not used");
  const system = fakeRtk(tmp(), "");
  assert.equal(rtkBinary({ HOME: home, PATH: "" }, system), system);
  const explicit = fakeRtk(tmp(), "");
  assert.equal(rtkBinary({ HOME: home, PATH: "", GRIFFIN_RTK_BIN: explicit }, system), explicit, "GRIFFIN_RTK_BIN wins");
  fs.chmodSync(explicit, 0o644);
  assert.equal(rtkBinary({ HOME: tmp(), PATH: "", GRIFFIN_RTK_BIN: explicit }, null), null, "a file without the x bit is skipped");
});

test("rtkFor: only full Claude Code, never an owner's job, host needs RTK_HOST, no binary = nothing; the RTK switch is read per call", () => {
  const bin = fakeRtk(tmp(), "");
  const env = { GRIFFIN_RTK_BIN: bin, HOME: tmp(), PATH: "" };
  assert.deepEqual(rtkFor({ full: true, env }), { bin });
  assert.equal(rtkFor({ full: false, env }), null, "a chain without Bash gets nothing");
  assert.equal(rtkFor({ full: true, ownerJob: true, env }), null, "nobody reads a job's output and it may parse it");
  assert.deepEqual(rtkFor({ full: true, env: { ...env, GRIFFIN_RTK: "off" } }), { bin }, "the hook stays registered; active() turns it off, so turning it on again works in an open chat");
  assert.equal(rtkEnabled({ GRIFFIN_RTK: "off" }), false);
  assert.equal(rtkEnabled({}), true);
  assert.equal(rtkFor({ full: true, host: true, env }), null, "the host has no rtk until the owner says so");
  assert.deepEqual(rtkFor({ full: true, host: true, env: { ...env, GRIFFIN_RTK_HOST: "on" } }), { bin });
  assert.equal(rtkFor({ full: true, env: { HOME: tmp(), PATH: "" }, system: null }), null);
});

test("withRtk adds one Bash PreToolUse entry after the existing ones; withRtkPath adds the folder and storage switches", () => {
  const guard = { hooks: [async () => ({})] };
  const rtk = { bin: "/opt/x/rtk" };
  const hooks = withRtk({ PreToolUse: [guard], Stop: [{ hooks: [] }] }, rtk);
  assert.equal(hooks.PreToolUse.length, 2);
  assert.equal(hooks.PreToolUse[0], guard);
  assert.equal(hooks.PreToolUse[1].matcher, "Bash");
  assert.equal(hooks.Stop.length, 1);
  assert.equal(withRtk(null, rtk).PreToolUse.length, 1);
  const same = { PreToolUse: [] };
  assert.equal(withRtk(same, null), same);
  assert.equal(withRtk(null, null), null);
  const env = withRtkPath({ PATH: "/usr/bin", HOME: "/h" }, rtk);
  assert.equal(env.PATH, "/opt/x:/usr/bin");
  assert.equal(env.HOME, "/h");
  assert.deepEqual({ RTK_TEE: env.RTK_TEE, RTK_RECALL: env.RTK_RECALL, RTK_TELEMETRY_DISABLED: env.RTK_TELEMETRY_DISABLED, RTK_SUPPRESS_HOOK_WARNING: env.RTK_SUPPRESS_HOOK_WARNING }, RTK_ENV);
  assert.equal(withRtkPath({ PATH: "/opt/x:/usr/bin" }, rtk).PATH, "/opt/x:/usr/bin", "already there");
  const none = { PATH: "/usr/bin" };
  assert.equal(withRtkPath(none, null), none);
  // 2026-11-22: RTK_TEE=0 stops rtk keeping a copy of every raw output (recall.db); RTK_RECALL alone did not.
  assert.equal(RTK_ENV.RTK_TEE, "0");
  assert.equal(RTK_ENV.RTK_SUPPRESS_HOOK_WARNING, "1", "no «run rtk init -g» line in every output");
});

test("RTK and RTK_HOST are live Settings keys, RTK on by default and RTK_HOST off", () => {
  const rtk = CONFIG_SCHEMA.find((k) => k.key === "RTK");
  const host = CONFIG_SCHEMA.find((k) => k.key === "RTK_HOST");
  assert.ok(rtk?.live && host?.live);
  assert.equal(rtk.options[0], "on");
  assert.equal(host.options[0], "off");
  const env = { GRIFFIN_RTK_BIN: fakeRtk(tmp(), ""), HOME: tmp(), PATH: "" };
  assert.ok(rtkFor({ full: true, env }));
  setConfigOverrides(() => ({ RTK: "off" }));
  try {
    assert.equal(rtkEnabled(process.env), false, "the Settings value wins");
  } finally {
    setConfigOverrides(null);
  }
});

test("the model is told which output may be shortened and how to get all of it", () => {
  assert.match(RTK_NOTE, /RTK_DISABLED=1/);
  assert.match(RTK_NOTE, /never conclude something is absent/);
});

// The real binary, when one is installed here (CI has none): the rewrite of what the model really runs.
const real = rtkBinary(process.env);
test("with the real rtk: a read-only chain is rewritten; RTK_DISABLED=1 and unknown commands are left alone", { skip: !real && "no rtk binary here" }, async () => {
  const hook = rtkHook({ bin: real, rules: noRules });
  const out = await hook({ tool_name: "Bash", tool_input: { command: "cd /tmp && git status && git log -3", timeout: 1 } });
  assert.match(out.hookSpecificOutput.updatedInput.command, /rtk git status/);
  assert.match(out.hookSpecificOutput.updatedInput.command, /rtk git log -3/);
  assert.equal(out.hookSpecificOutput.updatedInput.timeout, 1);
  assert.equal(out.hookSpecificOutput.permissionDecision, undefined);
  assert.deepEqual(await hook({ tool_name: "Bash", tool_input: { command: "echo hi" } }), {});
  assert.deepEqual(await hook({ tool_name: "Bash", tool_input: { command: "RTK_DISABLED=1 git status" } }), {});
});
