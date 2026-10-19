import test from "node:test";
import assert from "node:assert/strict";
import { createClaudeProvider } from "../src/providers/claude.mjs";

test("a Claude agent keeps the SDK's own context count (getContextUsage) read at the turn's result", async () => {
  let asked = null;
  const queryImpl = ({ options }) => {
    const iter = (async function* () {
      yield { type: "system", subtype: "init", session_id: options.sessionId, mcp_servers: [] };
      yield { type: "result", subtype: "success", is_error: false, result: "ok", session_id: options.sessionId };
    })();
    iter.getContextUsage = async (opts) => ((asked = opts), { totalTokens: 45_000, rawMaxTokens: 1_000_000, maxTokens: 967_000, model: "claude-opus-5-5" });
    return iter;
  };
  const agent = createClaudeProvider({ apiKey: "sk-ant-api-test", queryImpl }).create({ cwd: "/tmp" });
  assert.equal(agent.contextUsage(), null, "nothing before a turn: no process is started to measure");
  await (await agent.send("سلام")).wait();
  await new Promise((resolve) => setImmediate(resolve)); // the reading lands right after the turn, unawaited
  assert.deepEqual(asked, { detail: "summary" });
  assert.equal(agent.contextUsage().totalTokens, 45_000);
  assert.equal(agent.contextUsage().rawMaxTokens, 1_000_000);
});
