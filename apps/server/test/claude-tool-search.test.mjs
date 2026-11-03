import test from "node:test";
import assert from "node:assert/strict";
import { ALWAYS_LOAD, alwaysLoaded, createClaudeProvider, withToolSearch } from "../src/providers/claude.mjs";
import { planModeRefusal } from "../src/providers/plan-mode-guard.mjs";
import { buildRules } from "../src/prompt.mjs";

// Checked live 2026-10-20 (SDK 0.3.296): a deferred tool is still named in the init message, and the
// model loads it with ToolSearch {query:"select:mcp__griffin__<name>"} and calls it.

test("only the core tools load in every request; config can name others or all", () => {
  const core = alwaysLoaded({});
  assert.equal(core("ask_owner"), true);
  assert.equal(core("delegate"), true);
  assert.equal(core("kube_get"), false);
  assert.ok(ALWAYS_LOAD.length < 20);
  const named = alwaysLoaded({ GRIFFIN_CLAUDE_ALWAYS_LOAD: "kube_get, pg_query" });
  assert.equal(named("kube_get"), true);
  assert.equal(named("ask_owner"), false);
  assert.equal(alwaysLoaded({ GRIFFIN_CLAUDE_ALWAYS_LOAD: "*" })("anything"), true);
});

test("a chain with restricted built-ins keeps ToolSearch, once", () => {
  assert.deepEqual(withToolSearch(["TodoWrite"]), ["TodoWrite", "ToolSearch"]);
  assert.deepEqual(withToolSearch(["TodoWrite", "ToolSearch"]), ["TodoWrite", "ToolSearch"]);
});

test("a colleague chain's run gets ToolSearch among its built-ins", async () => {
  let seen = null;
  const queryImpl = ({ options }) => {
    seen = options;
    return (async function* () {
      yield { type: "system", subtype: "init", session_id: options.sessionId, mcp_servers: [{ name: "griffin", status: "connected" }], tools: ["ToolSearch", "mcp__griffin__ping"] };
      yield { type: "result", subtype: "success", result: "ok", session_id: options.sessionId };
    })();
  };
  const agent = createClaudeProvider({ apiKey: "sk-ant-api-test", queryImpl }).create({ cwd: "/tmp", customTools: { ping: { description: "p", inputSchema: { type: "object", properties: {} }, execute: async () => ({}) } } });
  const result = await (await agent.send("سلام")).wait();
  assert.equal(result.status, "finished");
  assert.ok(seen.tools.includes("ToolSearch"));
  assert.ok(seen.allowedTools.includes("ToolSearch"));
});

test("plan mode lets ToolSearch through: loading a tool changes nothing", () => {
  assert.equal(planModeRefusal("ToolSearch", { query: "select:mcp__griffin__kube_get" }, "mcp__griffin__"), null);
});

test("every run gets the capability map of its own tools; a limited caller is told the rest does not apply", () => {
  const tools = ["kube_get", "ask_owner"];
  const owner = buildRules({ agent: "griffin", caller: "owner", tools });
  assert.match(owner, /Capability map — written from the tools THIS conversation really has \(2\)/);
  assert.doesNotMatch(owner, /does not apply here/);
  const team = buildRules({ agent: "griffin", caller: "team", tools });
  assert.match(team, /Capability map/);
  assert.match(team, /not in the list at the top of this map does not apply here/);
  assert.doesNotMatch(team, /mikrotik_\*/); // only families it has
});
