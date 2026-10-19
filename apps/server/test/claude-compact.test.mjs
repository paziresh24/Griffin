import test from "node:test";
import assert from "node:assert/strict";
import { createClaudeProvider, contextPressure } from "../src/providers/claude.mjs";

// A fake Claude Code: `script(prompt, n)` gives the result of the n-th query; every prompt is logged.
function fake(script, usage = null) {
  const prompts = [];
  const queryImpl = ({ prompt, options }) => {
    const text = typeof prompt === "string" ? prompt : "(stream)";
    prompts.push(text);
    const result = script(text, prompts.length);
    const iter = (async function* () {
      yield { type: "system", subtype: "init", session_id: options.sessionId || options.resume, mcp_servers: [] };
      yield { type: "result", session_id: options.sessionId || options.resume, ...result };
    })();
    iter.getContextUsage = async () => usage;
    return iter;
  };
  return { prompts, queryImpl };
}
const ok = { subtype: "success", is_error: false, result: "done" };
const tooLong = { subtype: "success", is_error: true, result: "Prompt is too long" };
const agentOf = (queryImpl) => createClaudeProvider({ apiKey: "sk-ant-api-test", queryImpl }).create({ cwd: "/tmp" });

test("a turn the engine refuses as «Prompt is too long» is compacted and sent again, once", async () => {
  let refused = false;
  const { prompts, queryImpl } = fake((text) => {
    if (text === "/compact" || refused) return ok;
    refused = true;
    return tooLong;
  });
  const agent = agentOf(queryImpl);
  const result = await (await agent.send("سلام")).wait();
  assert.equal(result.status, "finished");
  assert.deepEqual(prompts, ["سلام", "/compact", "سلام"]);
});

test("a second refusal after the compaction is shown, not looped", async () => {
  const { prompts, queryImpl } = fake((text) => (text === "/compact" ? ok : tooLong));
  const result = await (await agentOf(queryImpl).send("سلام")).wait();
  assert.equal(result.status, "error");
  assert.match(result.error.message, /too long/i);
  assert.deepEqual(prompts, ["سلام", "/compact", "سلام"]);
});

test("other errors are not compacted away, and a slash command is sent as is", async () => {
  const { prompts, queryImpl } = fake(() => ({ subtype: "success", is_error: true, result: "overloaded" }));
  const agent = agentOf(queryImpl);
  assert.equal((await (await agent.send("سلام")).wait()).status, "error");
  assert.equal((await (await agent.send("/compact")).wait()).status, "error");
  assert.deepEqual(prompts, ["سلام", "/compact"]);
});

test("a session near the window is compacted before the message goes", async () => {
  const { prompts, queryImpl } = fake(() => ok, { totalTokens: 880_000, rawMaxTokens: 1_000_000 });
  const agent = agentOf(queryImpl);
  await (await agent.send("اول")).wait(); // no reading yet: nothing to compact on
  await new Promise((resolve) => setImmediate(resolve)); // the reading lands right after the turn
  await (await agent.send("دوم")).wait();
  assert.deepEqual(prompts, ["اول", "/compact", "دوم"]);
});

test("pressure needs a reading and a window", () => {
  assert.equal(contextPressure(null, 0.8), false);
  assert.equal(contextPressure({ totalTokens: 100, rawMaxTokens: 1000 }, 0.8), false);
  assert.equal(contextPressure({ totalTokens: 800, rawMaxTokens: 1000 }, 0.8), true);
  assert.equal(contextPressure({ totalTokens: 800, maxTokens: 1000 }, 0), false);
});
