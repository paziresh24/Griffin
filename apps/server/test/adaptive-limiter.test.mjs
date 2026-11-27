import { describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createAdaptiveLimiter, sleepAbortable } from "../src/providers/adaptive-limiter.mjs";
import { createOpenAIProvider } from "../src/providers/openai.mjs";

describe("adaptive rate limiter (AIMD)", () => {
  it("starts open, halves concurrency on 429, and grows additively on 200s without a fixed ceiling", async () => {
    let clock = 1_000;
    const lim = createAdaptiveLimiter({
      initialLimit: 4,
      minLimit: 1,
      maxLimit: 10,
      basePaceMs: 500,
      jitterRatio: 0,
      now: () => clock,
      random: () => 0,
    });

    // 4 concurrent slots acquire immediately
    const slots = await Promise.all([lim.acquire(), lim.acquire(), lim.acquire(), lim.acquire()]);
    assert.equal(lim.snapshot().inFlight, 4);
    assert.equal(lim.snapshot().limit, 4);

    // First 429 halves limit: 4 -> 2, arms 500ms cooldown/pace
    const wait1 = lim.onRateLimit(0);
    assert.equal(wait1, 500);
    assert.equal(lim.snapshot().limit, 2);
    assert.equal(lim.snapshot().paceMs, 500);

    // Second consecutive 429 halves limit: 2 -> 1, doubles pace: 500 -> 1000
    const wait2 = lim.onRateLimit(0);
    assert.equal(wait2, 1000);
    assert.equal(lim.snapshot().limit, 1);
    assert.equal(lim.snapshot().paceMs, 1000);

    for (const s of slots) s.release();
    assert.equal(lim.snapshot().inFlight, 0);

    // Successes decay pace and grow limit additively back up and beyond initialLimit
    clock += 2_000;
    for (let i = 0; i < 60; i++) {
      const cap = lim.snapshot().limit;
      lim.onSuccess(cap);
    }
    assert.equal(lim.snapshot().paceMs, 0);
    assert.ok(lim.snapshot().limit > 4, `expected limit to climb past 4, got ${lim.snapshot().limit}`);
    assert.ok(lim.snapshot().limit <= 10);
  });

  it("honors explicit Retry-After without over-waiting", () => {
    let clock = 5_000;
    const lim = createAdaptiveLimiter({ initialLimit: 4, basePaceMs: 2_000, now: () => clock });
    const wait = lim.onRateLimit(50);
    assert.equal(wait, 50);
    assert.equal(lim.snapshot().cooldownMs, 50);
    assert.equal(lim.snapshot().paceMs, 50);
  });

  it("cancels a queued waiter immediately on AbortSignal without leaking slots", async () => {
    const lim = createAdaptiveLimiter({ initialLimit: 1 });
    const first = await lim.acquire();
    const ac = new AbortController();
    const pending = lim.acquire(ac.signal);
    assert.equal(lim.snapshot().queued, 1);

    ac.abort();
    await assert.rejects(pending, { name: "AbortError" });
    assert.equal(lim.snapshot().queued, 0);

    first.release();
    const next = await lim.acquire();
    assert.equal(lim.snapshot().inFlight, 1);
    next.release();
    assert.equal(lim.snapshot().inFlight, 0);
  });

  it("sleepAbortable rejects immediately when aborted", async () => {
    const ac = new AbortController();
    const p = sleepAbortable(60_000, ac.signal);
    ac.abort();
    await assert.rejects(p, { name: "AbortError" });
  });

  it("openai provider queues concurrent runs behind adaptive limiter on 429 and completes all", async () => {
    let inFlight = 0;
    let maxObservedAfter429 = 0;
    let saw429 = false;
    const serverCap = 2;

    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => {
        inFlight += 1;
        if (saw429 && inFlight > maxObservedAfter429) maxObservedAfter429 = inFlight;
        if (inFlight > serverCap) {
          saw429 = true;
          inFlight -= 1;
          res.writeHead(429, { "Content-Type": "application/json", "Retry-After": "0.03" });
          res.end(JSON.stringify({ error: { code: "1302", message: "Rate limit reached for requests" } }));
          return;
        }
        setTimeout(() => {
          inFlight -= 1;
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "ok" } }] })}\n\n`);
          res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
          res.end("data: [DONE]\n\n");
        }, 25);
      });
    });

    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address();
    try {
      const lim = createAdaptiveLimiter({ initialLimit: 4, basePaceMs: 25, jitterRatio: 0 });
      const provider = createOpenAIProvider({
        apiKey: "test-key",
        baseUrl: `http://127.0.0.1:${port}`,
        defaultModel: "glm-5.3-flash",
        rateLimiter: lim,
        log: { error() {}, warn() {}, info() {} },
      });

      // Fire 6 concurrent chats at once; server only allows 2 at a time.
      const runBatch = (n) =>
        Promise.all(
          Array.from({ length: n }, async () => {
            const agent = provider.create({ cwd: "/tmp", rules: "sys" });
            const run = await agent.send("hi", {});
            const result = await run.wait();
            return { status: result.status };
          }),
        );

      const wave1 = await runBatch(6);
      assert.equal(wave1.length, 6);
      for (const r of wave1) assert.equal(r.status, "finished");
      assert.ok(saw429, "expected initial burst to trigger 429");
      assert.ok(lim.snapshot().limit <= 2, `expected adaptive window to shrink <= 2, got ${lim.snapshot().limit}`);

      // Second concurrent wave after adaptation stays within the learned ceiling
      maxObservedAfter429 = 0;
      const wave2 = await runBatch(4);
      for (const r of wave2) assert.equal(r.status, "finished");
      assert.ok(maxObservedAfter429 <= 2, `expected adapted concurrency <= 2, saw ${maxObservedAfter429}`);
    } finally {
      server.closeAllConnections?.();
      server.close();
    }
  });
});
