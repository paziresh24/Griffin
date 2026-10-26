import test from "node:test";
import assert from "node:assert/strict";
import { createClaudeProvider, contextPressure, compactWindow, withModelWindow, withCompactWindow } from "../src/providers/claude.mjs";

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

test("a 1M model compacts at 600k by default, and it is configurable", () => {
  assert.equal(compactWindow({}), 600_000);
  assert.equal(compactWindow({ GRIFFIN_CLAUDE_COMPACT_WINDOW: "0" }), 0);
  assert.equal(compactWindow({ GRIFFIN_CLAUDE_COMPACT_WINDOW: "500000" }), 500_000);
  // 610k of a 1M window is under 80% but past the 600k compact point; 500k is neither.
  const reading = { totalTokens: 610_000, rawMaxTokens: 1_000_000 };
  assert.equal(contextPressure(reading, 0.8), false);
  assert.equal(contextPressure(reading, 0.8, 600_000), true);
  assert.equal(contextPressure({ totalTokens: 500_000, rawMaxTokens: 1_000_000 }, 0.8, 600_000), false);
  // A model whose own window is smaller still compacts at 80% of it.
  assert.equal(contextPressure({ totalTokens: 170_000, rawMaxTokens: 200_000 }, 0.8, 600_000), true);
});

test("runs tell Claude Code the compact window; a host setting wins", () => {
  assert.equal(withCompactWindow({}, 200_000).CLAUDE_CODE_AUTO_COMPACT_WINDOW, "200000");
  assert.equal(withCompactWindow({ CLAUDE_CODE_AUTO_COMPACT_WINDOW: "300000" }, 200_000).CLAUDE_CODE_AUTO_COMPACT_WINDOW, "300000");
  assert.equal(withCompactWindow({}, 0).CLAUDE_CODE_AUTO_COMPACT_WINDOW, undefined);
});

test("a session past the compact point is compacted before the message goes", async () => {
  const { prompts, queryImpl } = fake(() => ok, { totalTokens: 620_000, rawMaxTokens: 1_000_000 });
  const agent = agentOf(queryImpl);
  await (await agent.send("اول")).wait();
  await new Promise((resolve) => setImmediate(resolve));
  await (await agent.send("دوم")).wait();
  assert.deepEqual(prompts, ["اول", "/compact", "دوم"]);
});

test("a reading capped at the compact window gets the model's 1M back; a smaller model stays", () => {
  const capped = { totalTokens: 90_000, rawMaxTokens: 600_000, maxTokens: 600_000 };
  assert.equal(withModelWindow(capped, {}).rawMaxTokens, 1_000_000);
  assert.equal(withModelWindow(capped, { GRIFFIN_CLAUDE_MODEL_WINDOW: "800000" }).rawMaxTokens, 800_000);
  assert.equal(withModelWindow({ totalTokens: 9, rawMaxTokens: 200_000 }, {}).rawMaxTokens, 200_000);
  assert.equal(withModelWindow(capped, { GRIFFIN_CLAUDE_COMPACT_WINDOW: "0" }), capped);
  // 480k of the capped 600k must not compact (80% of a 600k "window"); 610k still does.
  assert.equal(contextPressure(withModelWindow({ ...capped, totalTokens: 480_000 }, {}), 0.8, 600_000), false);
  assert.equal(contextPressure(withModelWindow({ ...capped, totalTokens: 610_000 }, {}), 0.8, 600_000), true);
});
