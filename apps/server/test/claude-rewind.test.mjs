import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openStore } from "../src/db.mjs";
import { createRunner } from "../src/runner.mjs";
import { createClaudeProvider } from "../src/providers/claude.mjs";

// A fake Claude Code process: records each query, answers each turn, rewinds on request.
function fakeClaude() {
  const queries = [];
  const queryImpl = ({ prompt, options }) => {
    const seen = { options, messages: [] };
    queries.push(seen);
    // Only a turn is iterated; the rewind's process is never read (its prompt waits for the abort).
    const iter = (async function* () {
      if (typeof prompt === "string") seen.messages.push(prompt);
      else for await (const m of prompt) seen.messages.push(m);
      yield { type: "system", subtype: "init", session_id: options.sessionId || options.resume, mcp_servers: [] };
      yield { type: "result", subtype: "success", is_error: false, result: "ok", session_id: options.sessionId || options.resume };
    })();
    iter.rewindFiles = async (id) => ((seen.rewound = id), { canRewind: true, filesChanged: ["/tmp/a.txt", "/tmp/b.txt"] });
    return iter;
  };
  return { queries, queryImpl };
}

test("the owner's own chat checkpoints each message; other chains do not", async () => {
  const { queries, queryImpl } = fakeClaude();
  const provider = createClaudeProvider({ apiKey: "sk-ant-api-test", queryImpl });
  const own = provider.create({ cwd: "/tmp", fileAccess: { read: ["/tmp"], write: ["/tmp"], deny: [] } });
  const run = await own.send("فایل را عوض کن", { userMessageId: "11111111-1111-4111-8111-111111111111" });
  await run.wait();
  assert.equal(queries[0].options.enableFileCheckpointing, true);
  assert.equal(queries[0].messages[0].uuid, "11111111-1111-4111-8111-111111111111", "the message carries the runner's id");
  assert.deepEqual(run.checkpoint, { sessionId: own.agentId, userMessageId: "11111111-1111-4111-8111-111111111111", cwd: "/tmp" });

  for (const options of [{ cwd: "/tmp" }, { cwd: "/tmp", fileAccess: { read: ["/tmp"], write: ["/tmp"] }, ownerJob: true }]) {
    const other = await provider.create(options).send("hi", { userMessageId: "22222222-2222-4222-8222-222222222222" });
    await other.wait();
    assert.equal(queries.at(-1).options.enableFileCheckpointing, undefined);
    assert.equal(other.checkpoint, undefined);
  }
});

test("a rewind puts back the files Claude edited from that message on; without a checkpoint it does nothing", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "griffin-rewind-"));
  const store = openStore(path.join(dir, "db.sqlite"));
  const { queries, queryImpl } = fakeClaude();
  const sdk = { ...createClaudeProvider({ apiKey: "sk-ant-api-test", queryImpl }), kind: "claude" };
  const runner = createRunner({ store, sdk, agentOptions: async () => ({ cwd: dir, fileAccess: { read: [dir], write: [dir], deny: [] } }), log: { error() {} } });
  const chat = store.createChat({ title: "t" });
  const finished = () => store.eventsAfter(chat.id).filter((e) => e.type === "run.finished").length;

  await runner.send(chat.id, { text: "اول", ownerText: true });
  for (let i = 0; i < 400 && !finished(); i += 1) await new Promise((r) => setTimeout(r, 5));
  const first = store.eventsAfter(chat.id).find((e) => e.type === "user");
  assert.equal(finished(), 1);
  const mark = store.eventsAfter(chat.id).find((e) => e.type === "run.checkpoint");
  assert.equal(mark.data.userMessageId, queries[0].messages[0].uuid);

  const result = await runner.rewindFiles(store.getChat(chat.id), first.id);
  assert.deepEqual(result, { restored: 2 });
  const rewind = queries.at(-1);
  assert.equal(rewind.options.resume, mark.data.sessionId, "a short process resumes the chat's session");
  assert.equal(rewind.options.cwd, dir);
  assert.equal(rewind.options.enableFileCheckpointing, true);
  assert.equal(rewind.rewound, mark.data.userMessageId);
  assert.ok(rewind.options.abortController.signal.aborted, "and exits");

  // Past the last checkpoint: nothing to put back, the rewind only cuts the conversation.
  assert.equal(await runner.rewindFiles(store.getChat(chat.id), mark.id + 1), null);

  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a resumed session's own turn (a task notification) does not end the owner's turn", async () => {
  const id = "33333333-3333-4333-8333-333333333333";
  const updates = [];
  const queryImpl = ({ prompt, options }) =>
    (async function* () {
      if (typeof prompt !== "string") for await (const m of prompt) void m;
      yield { type: "system", subtype: "init", session_id: options.resume || "s1", mcp_servers: [] };
      // Claude Code first answers the killed background shell's notification…
      yield { type: "result", subtype: "success", is_error: false, result: "", user_message_uuid: "notification-turn", session_id: "s1" };
      // …then the owner's message.
      yield { type: "stream_event", session_id: "s1", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } };
      yield { type: "stream_event", session_id: "s1", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "جواب واقعی" } } };
      yield { type: "stream_event", session_id: "s1", event: { type: "content_block_stop", index: 0 } };
      yield { type: "result", subtype: "success", is_error: false, result: "جواب واقعی", user_message_uuid: id, session_id: "s1" };
    })();
  const own = createClaudeProvider({ apiKey: "sk-ant-api-test", queryImpl }).create({ cwd: "/tmp", fileAccess: { read: ["/tmp"], write: ["/tmp"], deny: [] } });
  const run = await own.send("سؤال", { userMessageId: id, onDelta: ({ update }) => updates.push(update) });
  const result = await run.wait();
  assert.equal(result.status, "finished");
  assert.ok(JSON.stringify(updates).includes("جواب واقعی"), "the answer reached the run before it finished");
});

test("a permission mode reaches Claude Code, and its permission prompts become the owner's yes/no", async () => {
  const { PERMISSION_MODES, askOwnerTool, permissionQuestion } = await import("../src/providers/claude.mjs");
  const seen = [];
  const queryImpl = ({ prompt, options }) => {
    seen.push(options);
    return (async function* () {
      if (typeof prompt !== "string") for await (const m of prompt) void m;
      yield { type: "result", subtype: "success", is_error: false, result: "ok", session_id: "s1" };
    })();
  };
  const asked = [];
  const own = createClaudeProvider({ apiKey: "sk-ant-api-test", queryImpl }).create({ cwd: "/tmp", fileAccess: { read: ["/tmp"], write: ["/tmp"], deny: [] }, approve: async (q) => (asked.push(q), q.includes("ls")) });
  for (const [mode, want] of Object.entries(PERMISSION_MODES)) {
    await (await own.send("x", { mode })).wait();
    assert.equal(seen.at(-1).permissionMode, want, mode);
  }
  await (await own.send("x", { mode: "nonsense" })).wait();
  assert.equal(seen.at(-1).permissionMode, "bypassPermissions");
  const can = seen.at(-1).canUseTool;
  assert.equal((await can("Bash", { command: "ls -la", description: "فهرست" })).behavior, "allow");
  assert.equal((await can("Bash", { command: "rm -rf x" })).behavior, "deny");
  assert.equal((await can("ExitPlanMode", { plan: "p" })).behavior, "deny");
  assert.match(asked[0], /Bash.*فهرست[\s\S]*ls -la[\s\S]*اجازه/);
  assert.equal((await askOwnerTool(null)("Bash", {})).behavior, "deny");
  assert.match(permissionQuestion("mcp__griffin__kube_get", { path: "/x" }), /^Claude می‌خواهد kube_get/);
});
