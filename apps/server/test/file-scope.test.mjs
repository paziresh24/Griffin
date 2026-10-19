import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileGuard, fileGuardHooks, NO_FILE_TOOLS } from "../src/providers/file-scope.mjs";
import { createClaudeProvider } from "../src/providers/claude.mjs";

// A server in miniature: /data with secrets beside a workspace holding the knowledge store, an
// agent folder with its state, and a symlink inside the workspace that points out to /data.
function layout() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "file-scope-"));
  const data = path.join(root, "data");
  const ws = path.join(root, "workspace");
  const agent = path.join(ws, "agents", "griffin");
  const knowledge = path.join(ws, "knowledge");
  for (const dir of [data, path.join(agent, ".griffin-openai-sessions"), path.join(knowledge, "agents", "griffin", "knowledge"), path.join(ws, "repos")]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(data, "owner.token"), "secret");
  fs.writeFileSync(path.join(ws, "notes.md"), "hi");
  fs.symlinkSync(data, path.join(agent, "escape"));
  const guard = fileGuard({ cwd: agent, read: [ws], write: [agent], deny: [knowledge, path.join(agent, ".git"), path.join(agent, ".griffin-openai-sessions"), path.join(agent, "CLAUDE.md")] });
  return { root, data, ws, agent, knowledge, guard, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test("the owner's chat reads the workspace and writes its own folder, nothing else", () => {
  const l = layout();
  try {
    const ok = (tool, input) => assert.equal(l.guard(tool, input), null, `${tool} ${JSON.stringify(input)}`);
    const no = (tool, input) => assert.equal(typeof l.guard(tool, input), "string", `${tool} ${JSON.stringify(input)}`);
    ok("Read", { file_path: path.join(l.ws, "notes.md") });
    ok("Read", { file_path: "../../notes.md" }); // relative to the agent folder, still in the workspace
    ok("Grep", { pattern: "x" }); // no path: the chat's folder
    ok("Glob", { pattern: "**/*.md" });
    ok("Write", { file_path: path.join(l.agent, "report.md") });
    ok("Edit", { file_path: "sub/new.md" });

    no("Read", { file_path: path.join(l.data, "owner.token") }); // server data
    no("Read", { file_path: "../../../data/owner.token" }); // .. out of the workspace
    no("Read", { file_path: path.join(l.agent, "escape", "owner.token") }); // a symlink out
    no("Grep", { pattern: "token", path: path.join(l.agent, "escape") });
    no("Read", { file_path: "~/.claude.json" });
    no("Glob", { pattern: "/data/**" });
    no("Glob", { pattern: "../../../data/*" });
    no("Read", { file_path: path.join(l.knowledge, "agents", "griffin", "knowledge", "x.md") }); // knowledge: its own tools
    no("Write", { file_path: path.join(l.knowledge, "agents", "griffin", "knowledge", "fake.md") }); // a forged «reviewed: true»
    no("Write", { file_path: path.join(l.ws, "notes.md") }); // the workspace, not this chat's folder
    no("Write", { file_path: path.join(l.agent, "CLAUDE.md") }); // the agent's rules
    no("Write", { file_path: path.join(l.agent, ".griffin-openai-sessions", "s.json") }); // another engine's session
    no("Write", { file_path: path.join(l.agent, ".git") });
    no("NotebookEdit", { notebook_path: path.join(l.data, "n.ipynb") });
    assert.equal(l.guard("WebFetch", { url: "https://example.com" }), null, "not a file tool: the scope does not judge it");
  } finally {
    l.cleanup();
  }
});

test("the hook denies through the SDK's PreToolUse answer", async () => {
  const l = layout();
  try {
    const [matcher] = fileGuardHooks(l.guard).PreToolUse;
    assert.match(matcher.matcher, /Read/);
    const denied = await matcher.hooks[0]({ tool_name: "Read", tool_input: { file_path: path.join(l.data, "owner.token") } });
    assert.equal(denied.hookSpecificOutput.permissionDecision, "deny");
    assert.deepEqual(await matcher.hooks[0]({ tool_name: "Read", tool_input: { file_path: path.join(l.ws, "notes.md") } }), {});
  } finally {
    l.cleanup();
  }
});

// What Claude Code is started with: built-ins and the hook only with a file scope; none without one.
async function optionsOf(fileAccess, extra = {}) {
  extra = { rules: "RULES", ...extra };
  let seen = null;
  const queryImpl = ({ prompt, options }) => {
    seen = options;
    return (async function* () {
      for await (const _ of prompt) break;
      yield { type: "system", subtype: "init", session_id: options.sessionId, mcp_servers: [] };
      yield { type: "result", subtype: "success", is_error: false, result: "ok", session_id: options.sessionId };
    })();
  };
  const agent = createClaudeProvider({ apiKey: "sk-ant-api-test", queryImpl }).create({ cwd: "/tmp", ...(fileAccess !== undefined ? { fileAccess } : {}), ...extra });
  await (await agent.send("سلام")).wait();
  return seen;
}

test("a chain the owner did not start gets no built-in file or web tool; his own gets them, guarded", async () => {
  for (const missing of [null, undefined]) {
    const options = await optionsOf(missing);
    assert.deepEqual(options.tools, [...NO_FILE_TOOLS], "no scope: no file or web tool (fail closed)");
    assert.ok(!options.allowedTools.some((t) => /^(Read|Write|Edit|Glob|Grep|WebFetch|WebSearch)$/.test(t)));
    assert.equal(options.hooks, undefined);
  }
  const own = await optionsOf({ read: ["/tmp"], write: ["/tmp"], deny: [] });
  assert.ok(own.tools.includes("Read") && own.tools.includes("WebFetch"));
  assert.ok(own.hooks?.PreToolUse?.[0]?.hooks?.length, "the path guard rides along");
});

test("the owner's full Claude Code (CLAUDE_CODE=on): every built-in, his settings and MCP, the deny list still holds", async () => {
  const full = await optionsOf({ read: ["/tmp"], write: ["/tmp"], deny: ["/tmp/knowledge"] }, { claudeCode: true });
  assert.equal(full.tools, undefined, "no tool list: the preset's built-ins, Bash included");
  assert.equal(full.disallowedTools, undefined);
  assert.deepEqual(full.settingSources, ["user", "project", "local"]);
  assert.equal(full.strictMcpConfig, false);
  assert.match(full.systemPrompt.append, /Bash/, "the rules say Bash is his here");
  const [m] = full.hooks.PreToolUse;
  assert.equal((await m.hooks[0]({ tool_name: "Write", tool_input: { file_path: "/tmp/knowledge/x.md" } })).hookSpecificOutput.permissionDecision, "deny");
  assert.deepEqual(await m.hooks[0]({ tool_name: "Read", tool_input: { file_path: "/etc/hostname" } }), {});
  // Without a file scope (not the owner's chat) the switch changes nothing.
  const other = await optionsOf(null, { claudeCode: true });
  assert.deepEqual(other.tools, [...NO_FILE_TOOLS]);
  assert.ok(other.disallowedTools.includes("Bash"));
  assert.equal(other.strictMcpConfig, true);
});
