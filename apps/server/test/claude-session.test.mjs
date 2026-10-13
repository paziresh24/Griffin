import test from "node:test";
import assert from "node:assert/strict";
import { createClaudeProvider } from "../src/providers/claude.mjs";

// «Session ID … is already in use» (2026-10-08..12, ten runs): the runner starts the next queued turn
// at the previous one's «result», while that Claude Code process still runs (its next-message
// suggestion comes after the result). A fake Claude Code that, like the real one, refuses a session
// held by a live process or created again with --session-id.
function fakeClaude({ lingerMs = 50 } = {}) {
  const sessions = new Set(); // created sessions
  const live = new Set(); // sessions held by a running process
  const calls = [];
  const queryImpl = ({ prompt, options }) => {
    const id = options.resume || options.sessionId;
    calls.push(options.resume ? `resume:${id}` : `new:${id}`);
    return (async function* () {
      for await (const _ of prompt) break; // read the user message
      if (live.has(id) || (options.sessionId && sessions.has(id))) throw new Error(`Claude Code process exited with code 1. stderr: Error: Session ID ${id} is already in use.`);
      if (options.resume && !sessions.has(id)) throw new Error(`No conversation found with session ID: ${id}`);
      sessions.add(id);
      live.add(id);
      try {
        yield { type: "system", subtype: "init", session_id: id, mcp_servers: [] };
        yield { type: "result", subtype: "success", is_error: false, result: "ok", session_id: id };
        await new Promise((resolve) => setTimeout(resolve, lingerMs)); // the suggestion, after the result
      } finally {
        live.delete(id);
      }
    })();
  };
  return { queryImpl, calls };
}

test("a turn queued right behind another resumes the session once the first process exits", async () => {
  const fake = fakeClaude();
  const agent = createClaudeProvider({ apiKey: "sk-ant-api-test", queryImpl: fake.queryImpl }).create({ cwd: "/tmp" });
  const first = await agent.send("سلام");
  assert.equal((await first.wait()).status, "finished");
  const second = await agent.send("ادامه"); // at once, as the runner does after the result
  assert.deepEqual(await second.wait(), { status: "finished", error: null });
  assert.deepEqual(fake.calls.map((c) => c.split(":")[0]), ["new", "resume"]);
});

test("a session still held by another process (not this agent's own) is retried once by resuming", async () => {
  const fake = fakeClaude({ lingerMs: 500 });
  const provider = createClaudeProvider({ apiKey: "sk-ant-api-test", queryImpl: fake.queryImpl });
  const a = provider.create({ cwd: "/tmp" });
  const run = await a.send("سلام");
  await run.wait();
  const b = provider.resume(a.agentId, { cwd: "/tmp" }); // a second agent object for the same session
  const result = await (await b.send("ادامه")).wait();
  assert.equal(result.status, "finished");
  assert.deepEqual(fake.calls.map((c) => c.split(":")[0]), ["new", "resume", "resume"]);
});
