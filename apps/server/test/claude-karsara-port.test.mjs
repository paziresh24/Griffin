import test from "node:test";
import assert from "node:assert/strict";
import { createClaudeEventBridge, limitClosed } from "../src/providers/claude-events.mjs";
import { createClaudeProvider, resultFailure, mcpInitProblem, confirmMcpProblem, askOwnerTool, NO_ANSWER } from "../src/providers/claude.mjs";
import { firstJson } from "../src/integrations/format.mjs";

// Claude-path behaviour brought over when the Karsara codebase was merged into Griffin.

test("a Griffin tool's result keeps its JSON summary apart from the text meant for the model", () => {
  const bridge = createClaudeEventBridge();
  bridge.consume({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "mcp__griffin__show_media", input: { path: "a.md" } }] } });
  const [done] = bridge.consume({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: '{"media":{"mediaId":"m1"}}' }, { type: "text", text: "# file text" }] }] },
  });
  // What the Telegram sender (and the web card) read: the first part's JSON.
  assert.equal(firstJson(done.toolCall.result)?.media?.mediaId, "m1");
  assert.deepEqual(done.toolCall.result.value.content.map((c) => c.text), ['{"media":{"mediaId":"m1"}}', "# file text"]);
});

test("another tool's result is still plain text", () => {
  const bridge = createClaudeEventBridge();
  bridge.consume({ type: "assistant", message: { content: [{ type: "tool_use", id: "t2", name: "Read", input: {} }] } });
  const [done] = bridge.consume({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t2", content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }] } });
  assert.equal(done.toolCall.result.value, "a\nb");
});

test("Claude Code compacting the context shows as the summarizing phase", () => {
  const bridge = createClaudeEventBridge();
  assert.deepEqual(bridge.consume({ type: "system", subtype: "status", status: "compacting" }), [{ type: "summary-started" }]);
});

test("a local slash command's output is shown once, as the answer", () => {
  const a = createClaudeEventBridge();
  assert.deepEqual(a.consume({ type: "result", subtype: "success", local_command: "/cost", result: "Total cost: $0.10" }), [{ type: "text-delta", text: "Total cost: $0.10" }]);
  const b = createClaudeEventBridge();
  assert.deepEqual(b.consume({ type: "system", subtype: "local_command_output", content: "usage: 12%" }), [{ type: "text-delta", text: "usage: 12%" }]);
  assert.deepEqual(b.consume({ type: "result", subtype: "success", local_command: "/usage", result: "usage: 12%" }), []);
});

test("a rejection carried by extra usage is not a closed limit", () => {
  assert.equal(limitClosed({ status: "rejected" }), true);
  assert.equal(limitClosed({ status: "rejected", isUsingOverage: true }), false);
  assert.equal(limitClosed({ status: "rejected", overageStatus: "allowed" }), false);
  assert.equal(limitClosed({ status: "allowed" }), false);
  assert.deepEqual(createClaudeEventBridge().consume({ type: "rate_limit_event", rate_limit_info: { status: "rejected", isUsingOverage: true } }), []);
});

test("a success with nothing in it is an error, never a silent finished run", () => {
  assert.equal(resultFailure({ subtype: "success", result: "", usage: { output_tokens: 0 } }).message, NO_ANSWER);
  assert.equal(resultFailure({ subtype: "success", result: "", usage: { output_tokens: 0 } }).code, "no_answer");
  assert.equal(resultFailure({ subtype: "success", result: "", usage: { output_tokens: 0 } }, { produced: true }), null);
  assert.equal(resultFailure({ subtype: "success", result: "hi", usage: { output_tokens: 3 } }), null);
  assert.equal(resultFailure({ subtype: "success", result: "" }), null); // no usage: not judged
});

test("a refused login says what to do, in Persian", () => {
  const error = resultFailure({ subtype: "success", is_error: true, result: "Failed to authenticate. API Error: 401" });
  assert.match(error.message, /ورود یا کلید Claude پذیرفته نشد/);
  assert.match(error.message, /401/);
});

test("Griffin's MCP server connected with no tools is a problem", () => {
  assert.equal(mcpInitProblem({ mcp_servers: [{ name: "griffin", status: "connected" }], tools: ["Read", "Bash"] }), "connected, no tools");
  assert.equal(mcpInitProblem({ mcp_servers: [{ name: "griffin", status: "connected" }], tools: ["mcp__griffin__ask_owner"] }), null);
  assert.equal(mcpInitProblem({ mcp_servers: [{ name: "griffin", status: "failed" }] }), "failed");
  assert.equal(mcpInitProblem({ mcp_servers: [] }), "missing");
});

test("an init that missed Griffin's server is not final while the live status says connected", async () => {
  let calls = 0;
  const late = { mcpServerStatus: async () => (++calls < 3 ? [{ name: "griffin", status: "pending" }] : [{ name: "griffin", status: "connected" }]) };
  assert.equal(await confirmMcpProblem(late, "missing", { waitMs: 2_000, stepMs: 10 }), null);
  const failed = { mcpServerStatus: async () => [{ name: "griffin", status: "failed" }] };
  assert.equal(await confirmMcpProblem(failed, "missing", { waitMs: 200, stepMs: 10 }), "failed");
  const gone = { mcpServerStatus: async () => [] };
  assert.equal(await confirmMcpProblem(gone, "missing", { waitMs: 50, stepMs: 10 }), "missing");
  assert.equal(await confirmMcpProblem({}, "missing"), "missing");
  assert.equal(await confirmMcpProblem(late, null), null);
});

test("a run whose init missed Griffin's server goes on once Claude Code reports it connected", async () => {
  const queryImpl = ({ options }) => {
    const gen = (async function* () {
      yield { type: "system", subtype: "init", session_id: options.sessionId, mcp_servers: [], tools: ["Read"] };
      yield { type: "result", subtype: "success", result: "ok", session_id: options.sessionId };
    })();
    gen.mcpServerStatus = async () => [{ name: "griffin", status: "connected" }];
    return gen;
  };
  const agent = createClaudeProvider({ apiKey: "sk-ant-api-test", queryImpl }).create({ cwd: "/tmp", customTools: { ping: { description: "p", inputSchema: { type: "object", properties: {} }, execute: async () => ({}) } } });
  const result = await (await agent.send("سلام")).wait();
  assert.equal(result.status, "finished");
});

test("a run whose Griffin tools did not load stops with an error", async () => {
  const queryImpl = ({ options }) =>
    (async function* () {
      yield { type: "system", subtype: "init", session_id: options.sessionId, mcp_servers: [{ name: "griffin", status: "connected" }], tools: ["Read"] };
      yield { type: "result", subtype: "success", result: "ok", session_id: options.sessionId };
    })();
  const agent = createClaudeProvider({ apiKey: "sk-ant-api-test", queryImpl }).create({ cwd: "/tmp", customTools: { ping: { description: "p", inputSchema: { type: "object", properties: {} }, execute: async () => ({}) } } });
  const result = await (await agent.send("سلام")).wait();
  assert.equal(result.status, "error");
  assert.match(result.error.message, /connected, no tools/);
});

test("a session the CLI failed to resume starts fresh", async () => {
  const queryImpl = () =>
    (async function* () {
      throw new Error("Failed to resume session: corrupt transcript");
    })();
  const agent = createClaudeProvider({ apiKey: "sk-ant-api-test", queryImpl }).resume("s1", { cwd: "/tmp" });
  const result = await (await agent.send("سلام")).wait();
  assert.equal(result.error.code, "agent_not_found");
});

test("AskUserQuestion becomes the owner's question card, not a yes/no on the tool", async () => {
  const asked = [];
  const askTool = { execute: async (args) => (asked.push(args), { content: [{ type: "text", text: JSON.stringify({ answered: true, answer: "Postgres", selected: ["Postgres"] }) }] }) };
  const events = [];
  let approveCalled = false;
  const gate = askOwnerTool(async () => (approveCalled = true), { askTool, emit: async (u) => events.push(u.type) });
  const input = { questions: [{ question: "Which DB?", options: [{ label: "Postgres" }, { label: "MySQL" }] }] };
  const decision = await gate("AskUserQuestion", input, { toolUseID: "u1" });
  assert.equal(approveCalled, false);
  assert.equal(decision.behavior, "allow");
  assert.deepEqual(decision.updatedInput.answers, { "Which DB?": "Postgres" });
  assert.equal(asked[0].question, "Which DB?");
  assert.deepEqual(events, ["tool-call-started", "tool-call-completed"]);
});
