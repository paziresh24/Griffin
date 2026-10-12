import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import http from "node:http";
import { clipToolText, createOpenAIProvider, parallelSafe, promisesWork } from "../src/providers/openai.mjs";
import { errorHint } from "../src/tools.mjs";

// Harness behaviours added 2026-10-08 (harness-engineering pass): parallel read batches, head+tail
// clipping, stale tool-result clearing, error-streak and premature-stop nudges, actionable hints.

describe("harness helpers", () => {
  it("spots a closing promise of unfinished work, not offers or questions", () => {
    assert.equal(promisesWork("دیسک پر است. الان تنظیمات کش را چک می‌کنم و بعد گزارش می‌دم. — گریفین"), true);
    assert.equal(promisesWork("نتیجه رو همینجا خبر میدم"), true);
    assert.equal(promisesWork("Let me check the pods."), true);
    assert.equal(promisesWork("۸٫۶G آزاد است از ۹۰۴G."), false);
    assert.equal(promisesWork("اگر خواستید purge را اعمال می‌کنم."), false);
    assert.equal(promisesWork("بررسی کنم؟"), false);
    assert.equal(promisesWork("تصمیم بعدی با شماست — بگویید و اجرا می‌کنم."), false);
  });

  it("keeps the tail of a clipped tool output", () => {
    const text = `${"a".repeat(5000)}ERROR AT END`;
    const clipped = clipToolText(text, 1000);
    assert.ok(clipped.startsWith("aaa"));
    assert.ok(clipped.endsWith("ERROR AT END"));
    assert.ok(clipped.length < 1200);
    assert.equal(clipToolText("short", 1000), "short");
  });

  it("runs only reads in parallel", () => {
    assert.equal(parallelSafe({ name: "kube_get", args: {} }), true);
    assert.equal(parallelSafe({ name: "debug_exec", args: { command: "ls" } }), true);
    assert.equal(parallelSafe({ name: "debug_exec", args: { host: "griffin", command: "ls" } }), false);
    assert.equal(parallelSafe({ name: "pg_query", args: { write: true } }), false);
    assert.equal(parallelSafe({ name: "ask_owner", args: {} }), false);
    assert.equal(parallelSafe({ name: "infisical_upsert", args: {} }), false);
  });

  it("gives an actionable hint for recurring tool errors", () => {
    assert.match(errorHint('Arvan /domains/x.example.com/caching http_404: {"message": "Domain not found."}'), /zone apex/);
    assert.match(errorHint("GitLab /projects/a/repository/files/b/raw http_404: 404 File Not Found"), /filenames/);
    assert.match(errorHint("all paths failed for cluster-a"), /unreachable/);
    assert.equal(errorHint("something new"), "");
  });
});

// Scripted, non-streaming OpenAI-compatible endpoint: each request takes the next reply.
function mockEndpoint() {
  const requests = [];
  let replies = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      requests.push(JSON.parse(body));
      const reply = replies.shift() || { text: "done" };
      const message = reply.calls
        ? { role: "assistant", content: reply.text || null, tool_calls: reply.calls.map((c, i) => ({ id: `c${requests.length}-${i}`, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args || {}) } })) }
        : { role: "assistant", content: reply.text };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message, finish_reason: reply.calls ? "tool_calls" : "stop" }], usage: { prompt_tokens: 10, completion_tokens: 1 } }));
    });
  });
  return { server, requests, script: (list) => (replies = list) };
}

describe("harness loop", () => {
  let mock;
  let baseUrl;
  before(async () => {
    mock = mockEndpoint();
    await new Promise((r) => mock.server.listen(0, "127.0.0.1", r));
    baseUrl = `http://127.0.0.1:${mock.server.address().port}/v1`;
  });
  after(() => new Promise((r) => mock.server.close(r)));

  async function run(tools, opts = {}, providerOpts = {}) {
    mock.requests.length = 0;
    const provider = createOpenAIProvider({ apiKey: "k", baseUrl, log: { error() {}, warn() {} }, ...providerOpts });
    const agent = provider.create({ customTools: tools, rules: "R", ...opts });
    const handle = await agent.send("go", { onDelta: () => {} });
    return handle.wait();
  }

  it("runs a batch of reads concurrently and keeps result order", async () => {
    const slow = (tag) => ({ description: tag, inputSchema: { type: "object" }, execute: async () => (await new Promise((r) => setTimeout(r, 150)), { tag }) });
    mock.script([{ calls: [{ name: "kube_get" }, { name: "kube_status" }] }, { text: "ok" }]);
    const started = Date.now();
    const result = await run({ kube_get: slow("A"), kube_status: slow("B") });
    assert.equal(result.status, "finished");
    assert.ok(Date.now() - started < 280, "two 150ms reads should overlap");
    const tail = mock.requests[1].messages.filter((m) => m.role === "tool").map((m) => JSON.parse(m.content).tag);
    assert.deepEqual(tail, ["A", "B"]);
  });

  it("continues a run that promised work with nothing pending — once", async () => {
    mock.script([{ text: "الان چک می‌کنم و خبر می‌دم" }, { text: "الان چک می‌کنم" }]);
    const result = await run({});
    assert.equal(result.status, "finished");
    assert.equal(mock.requests.length, 2);
    assert.match(mock.requests[1].messages.at(-1).content, /قول کاری/);
  });

  it("lets a run end on a promise while a delegated subtask will wake it", async () => {
    mock.script([{ text: "سپردم؛ نتیجه رو خبر می‌دم" }]);
    await run({}, { pendingWork: () => 1 });
    assert.equal(mock.requests.length, 1);
  });

  it("nudges after a streak of failing tool calls", async () => {
    const failing = { description: "x", inputSchema: { type: "object" }, execute: async () => ({ isError: true, content: [{ type: "text", text: '{"error":"nope"}' }] }) };
    mock.script([1, 2, 3].map((n) => ({ calls: [{ name: "gitlab_file", args: { path: `p${n}` } }] })).concat([{ text: "مانع: فایل نیست" }]));
    await run({ gitlab_file: failing });
    assert.match(mock.requests[3].messages.at(-1).content, /خطا داد/);
  });

  it("stubs stale tool results once enough pile up, keeping the recent ones", async () => {
    const big = { description: "x", inputSchema: { type: "object" }, execute: async (a) => ({ n: a.n, pad: "x".repeat(2000) }) };
    mock.script([...Array(9)].map((_, n) => ({ calls: [{ name: "kube_get", args: { n } }] })).concat([{ text: "تمام" }]));
    await run({ kube_get: big }, {}, { clearAtTokens: 1, clearKeep: 2 });
    const tools = mock.requests.at(-1).messages.filter((m) => m.role === "tool");
    assert.equal(tools.length, 9);
    assert.ok(tools.slice(0, 6).every((m) => m.content.startsWith("[نتیجهٔ قدیمی ابزار")));
    assert.ok(!tools.at(-1).content.startsWith("[نتیجهٔ قدیمی ابزار"));
  });
});
