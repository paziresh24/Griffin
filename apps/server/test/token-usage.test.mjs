import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openStore } from "../src/db.mjs";
import { createApp } from "../src/app.mjs";
import { aggregateTokenUsage, tokenUsageSince, usageParts } from "../src/token-usage.mjs";

test("usageParts counts each token once, whatever engine reported it", () => {
  assert.deepEqual(usageParts({ prompt_tokens: 1000, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 900 } }), {
    input: 100, output: 50, cacheWrite: 0, cacheRead: 900, total: 1050,
  });
  assert.deepEqual(usageParts({ input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 30, cache_read_input_tokens: 40 }), {
    input: 10, output: 20, cacheWrite: 30, cacheRead: 40, total: 100,
  });
  assert.equal(usageParts({ inputTokens: 5, outputTokens: 6, cacheReadTokens: 7 }).total, 18);
  assert.equal(usageParts(null).total, 0);
});

test("aggregateTokenUsage buckets by the owner's calendar day, model and chat", () => {
  const now = new Date("2026-10-12T10:00:00Z");
  const rows = [
    // 21:00Z on the 11th is already the 12th in Tehran (+03:30).
    { at: "2026-10-11T21:00:00Z", chatId: "a", title: "A", model: "glm-5.3-flash", usage: { prompt_tokens: 100, completion_tokens: 10 } },
    { at: "2026-10-11T19:00:00Z", chatId: "b", title: "B", model: "sonnet", usage: { input_tokens: 5, output_tokens: 5 } },
    { at: "2026-09-01T10:00:00Z", chatId: "a", title: "A", model: "glm-5.3-flash", usage: { prompt_tokens: 999 } }, // outside 7 days
  ];
  const out = aggregateTokenUsage(rows, { days: 7, now, timeZone: "Asia/Tehran" });
  assert.equal(out.days.length, 7);
  assert.equal(out.days.at(-1).date, "2026-10-12");
  assert.equal(out.days.at(-1).total, 110);
  assert.equal(out.days.at(-2).total, 10);
  assert.equal(out.totals.total, 120);
  assert.deepEqual(out.byModel.map((m) => [m.model, m.total, m.turns]), [["glm-5.3-flash", 110, 1], ["sonnet", 10, 1]]);
  assert.deepEqual(out.byChat.map((c) => c.chatId), ["a", "b"]);
  // UTC puts both rows on the 11th.
  assert.equal(aggregateTokenUsage(rows, { days: 7, now, timeZone: "UTC" }).days.at(-2).total, 120);
});

test("GET /api/usage/tokens: rows from the usage index, each with its run's model", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "griffin-tokens-"));
  const store = openStore(path.join(dir, "db.sqlite"));
  const chat = store.createChat({ title: "سؤال دیسک" });
  const run1 = store.startRun(chat.id);
  store.appendEvent(chat.id, run1, "run.started", { model: "glm-5.3-flash", provider: "openai" });
  store.appendEvent(chat.id, run1, "text", { text: "x" });
  store.appendEvent(chat.id, run1, "usage", { prompt_tokens: 300, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 200 } });
  store.appendEvent(chat.id, run1, "usage", { prompt_tokens: 100, completion_tokens: 10 });
  const run2 = store.startRun(chat.id);
  store.appendEvent(chat.id, run2, "run.started", { model: "sonnet", provider: "claude" });
  store.appendEvent(chat.id, run2, "usage", { input_tokens: 7, output_tokens: 3 });

  const plan = store.db
    .prepare("EXPLAIN QUERY PLAN SELECT id FROM events WHERE type = 'usage' AND at >= ?")
    .all(tokenUsageSince({ days: 30 }))
    .map((r) => r.detail)
    .join(" ");
  assert.match(plan, /events_usage_at/, "the read never scans the whole event log");

  const app = createApp({ store, runner: { activeCount: () => 0 } });
  const res = await app.request("/api/usage/tokens?days=7");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.range, 7);
  assert.ok(body.timeZone);
  assert.equal(body.totals.total, 440);
  assert.deepEqual(body.byModel.map((m) => [m.model, m.total, m.turns]), [["glm-5.3-flash", 430, 2], ["sonnet", 10, 1]]);
  assert.deepEqual(body.byChat.map((c) => [c.title, c.models]), [["سؤال دیسک", ["glm-5.3-flash", "sonnet"]]]);
  assert.equal((await (await app.request("/api/usage/tokens?days=999")).json()).range, 90, "capped at 90 days");
});
