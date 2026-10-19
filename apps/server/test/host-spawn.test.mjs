import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { forwardEnv, hostSpawner, runsOnHost } from "../src/providers/host-spawn.mjs";

test("host runs: only full Claude Code, by the owner's choice of sections", () => {
  assert.equal(runsOnHost({ claudeCode: false, mode: "owner+jobs" }), false, "no terminal, nothing to move");
  assert.equal(runsOnHost({ claudeCode: true, mode: "off" }), false);
  assert.equal(runsOnHost({ claudeCode: true, mode: "owner" }), true);
  assert.equal(runsOnHost({ claudeCode: true, ownerJob: true, mode: "owner" }), false);
  assert.equal(runsOnHost({ claudeCode: true, ownerJob: true, mode: "owner+jobs" }), true);
});

test("the host process gets the login and Claude switches, not the container's HOME or PATH", () => {
  const env = forwardEnv({ HOME: "/data/home", PATH: "/x", CLAUDE_CONFIG_DIR: "/data/home/.claude", CLAUDE_CODE_OAUTH_TOKEN: "t", ANTHROPIC_BASE_URL: "u", HTTPS_PROXY: "p", SECRET_THING: "s" });
  assert.deepEqual(env, { CLAUDE_CODE_OAUTH_TOKEN: "t", ANTHROPIC_BASE_URL: "u", HTTPS_PROXY: "p" });
});

test("the spawner opens ssh and sends the request line before Claude Code's own stdin", () => {
  let call;
  const fake = (cmd, args, opts) => {
    call = { cmd, args, opts };
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    return child;
  };
  const child = hostSpawner({ target: "me@127.0.0.1", key: "/k", port: "22", knownHosts: "/kh" }, fake)({ args: ["--resume", "s"], cwd: "/workspace/x", env: { CLAUDE_CODE_OAUTH_TOKEN: "t", HOME: "/data/home" } });
  child.stdin.write("next");
  assert.equal(call.cmd, "ssh");
  assert.ok(call.args.includes("me@127.0.0.1") && call.args.includes("UserKnownHostsFile=/kh"));
  let sent = "";
  for (let chunk; (chunk = child.stdin.read()); ) sent += chunk;
  const [line, rest] = sent.split("\n");
  assert.deepEqual(JSON.parse(line), { cwd: "/workspace/x", args: ["--resume", "s"], env: { CLAUDE_CODE_OAUTH_TOKEN: "t" } });
  assert.equal(rest, "next");
});

test("a chat's own choice wins over the section, but never gives a terminal-less chain the host", () => {
  assert.equal(runsOnHost({ claudeCode: true, mode: "off", chosen: "host" }), true);
  assert.equal(runsOnHost({ claudeCode: true, mode: "owner", chosen: "container" }), false);
  assert.equal(runsOnHost({ claudeCode: false, mode: "owner", chosen: "host" }), false);
});

test("«بدون پرسیدن» runs as the owner's own user, whatever the chat or section says (not his jobs)", () => {
  assert.equal(runsOnHost({ claudeCode: true, mode: "off", chosen: "container", bypass: true }), true);
  assert.equal(runsOnHost({ claudeCode: true, ownerJob: true, mode: "owner", bypass: true }), false);
  assert.equal(runsOnHost({ claudeCode: false, bypass: true }), false);
});
