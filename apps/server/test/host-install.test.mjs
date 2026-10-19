// Host install: Griffin runs on the owner's machine as their own user, outside Docker.
// Each container assumption it needs changed is a setting; with none set, the image's behaviour holds.
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const claude = await import("../src/providers/claude.mjs");
const mcp = await import("../src/mcp-servers.mjs");

function withEnv(vars, fn) {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  const restore = () => {
    for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  };
  try {
    const out = fn();
    if (out && typeof out.then === "function") return out.finally(restore);
    restore();
    return out;
  } catch (error) {
    restore();
    throw error;
  }
}

async function runOptions(apiKey) {
  let seen = null;
  const queryImpl = ({ prompt, options }) => {
    seen = options;
    return (async function* () {
      for await (const _ of prompt) break;
      yield { type: "system", subtype: "init", session_id: options.sessionId, mcp_servers: [] };
      yield { type: "result", subtype: "success", is_error: false, result: "ok", session_id: options.sessionId };
    })();
  };
  const agent = claude.createClaudeProvider({ apiKey, queryImpl }).create({ cwd: "/tmp", rules: "RULES", fileAccess: { read: ["/tmp"], write: ["/tmp"], deny: [] }, claudeCode: true });
  await (await agent.send("hi")).wait();
  return seen;
}

test("GRIFFIN_CLAUDE_LOGIN=claude-code: the base account uses Claude Code's own login, no key injected", async () => {
  assert.equal(typeof claude.claudeCodeLoginKey, "function", "a host install can name Claude Code's own login");
  assert.equal(claude.claudeCodeLoginKey({}), "", "unset: no marker, Griffin's key rules are unchanged");
  assert.equal(claude.claudeCodeLoginKey({ GRIFFIN_CLAUDE_LOGIN: "yes" }), "", "only the exact value switches it on");
  const key = claude.claudeCodeLoginKey({ GRIFFIN_CLAUDE_LOGIN: "claude-code" });
  assert.ok(key, "set: a marker that counts as a key");
  const options = await withEnv({ ANTHROPIC_API_KEY: "sk-ant-api-leftover", CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-leftover", CLAUDE_CONFIG_DIR: "/home/someone/acct", HOME: "/home/someone" }, () => runOptions(key));
  assert.equal(options.env.ANTHROPIC_API_KEY, undefined, "no API key reaches Claude Code");
  assert.equal(options.env.CLAUDE_CODE_OAUTH_TOKEN, undefined, "no OAuth token either: the login folder decides");
  assert.equal(options.env.CLAUDE_CONFIG_DIR, "/home/someone/acct", "their login folder is passed through");
  assert.equal(options.env.HOME, "/home/someone", "their HOME is passed through");
  assert.equal((await claude.createClaudeProvider({ apiKey: key }).health()).ok, true, "health does not ping the API with the marker");
});

test("with a real key, Claude Code still gets exactly that key (container default)", async () => {
  const options = await withEnv({ ANTHROPIC_API_KEY: undefined, CLAUDE_CODE_OAUTH_TOKEN: undefined }, () => runOptions("sk-ant-oat-test"));
  assert.equal(options.env.CLAUDE_CODE_OAUTH_TOKEN, "sk-ant-oat-test");
  assert.equal(options.env.ANTHROPIC_API_KEY, undefined);
  assert.equal(options.pathToClaudeCodeExecutable, undefined, "no GRIFFIN_CLAUDE_BIN: the SDK's bundled Claude Code");
});

test("GRIFFIN_CLAUDE_BIN runs a host-installed Claude Code", async () => {
  const options = await withEnv({ GRIFFIN_CLAUDE_BIN: "/home/someone/.local/bin/claude" }, () => runOptions("sk-ant-oat-test"));
  assert.equal(options.pathToClaudeCodeExecutable, "/home/someone/.local/bin/claude");
});

test("Settings → MCP servers edits the .claude.json Claude Code reads: inside CLAUDE_CONFIG_DIR when set", () => {
  assert.equal(typeof mcp.claudeJsonPath, "function");
  assert.equal(mcp.claudeJsonPath({}, "/data/home"), "/data/home/.claude.json", "image: beside ~/.claude, as before");
  assert.equal(mcp.claudeJsonPath({ CLAUDE_CONFIG_DIR: "/home/u/acct" }, "/home/u"), "/home/u/acct/.claude.json");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "griffin-host-mcp-"));
  try {
    fs.writeFileSync(path.join(dir, ".claude.json"), JSON.stringify({ mcpServers: { here: { type: "http", url: "http://127.0.0.1:1/mcp" } } }));
    const names = withEnv({ CLAUDE_CONFIG_DIR: dir }, () => JSON.stringify(mcp.createMcpServers().list?.() ?? null));
    assert.match(names, /here/, "the default store reads the account folder's file");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the self-check never sends the Claude Code login marker to the Anthropic API", async () => {
  const { createDoctor } = await import("../src/doctor.mjs");
  const { openStore } = await import("../src/db.mjs");
  assert.equal(typeof claude.claudeCodeLoginKey, "function");
  const marker = claude.claudeCodeLoginKey({ GRIFFIN_CLAUDE_LOGIN: "claude-code" });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "griffin-host-doctor-"));
  try {
    const calls = [];
    const doctor = createDoctor({
      store: openStore(path.join(dir, "t.sqlite")),
      runner: { cancel: async () => {} },
      providers: { claude: { kind: "claude" } },
      providerKey: () => marker,
      providerConfig: () => ({}),
      engineIds: ["claude"],
      dataDir: dir,
      fetchImpl: async (url) => {
        calls.push(String(url));
        return new Response("invalid x-api-key", { status: 401 });
      },
    });
    const result = await doctor.probeEngine("claude");
    assert.deepEqual(calls, [], "no request carries the marker");
    assert.equal(result.ok, true, "a Claude Code login is not reported as a bad key (heal would move agents off it)");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
