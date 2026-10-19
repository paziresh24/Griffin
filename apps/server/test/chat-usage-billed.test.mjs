// The chat header's token total under the Karsara skin counts what Karsara's header counts (input,
// cache writes and reads, output); Griffin's own header keeps input + output (diff.md §4.1).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp } from "../src/app.mjs";
import { openStore } from "../src/db.mjs";
import { createClaudeEventBridge } from "../src/providers/claude-events.mjs";
import { eventsFromUpdate } from "../src/updates.mjs";
import { foldEvents, usageByModel } from "@griffin/timeline";

test("GET /api/chats/:id: usage (input + output) as before, usageBilled (everything billed) beside it", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "griffin-usage-"));
  const store = openStore(path.join(dir, "db.sqlite"));
  try {
    const chat = store.createChat({ title: "x", model: "opus", mode: "agent" });
    store.appendEvent(chat.id, null, "user", { text: "a" });
    store.appendEvent(chat.id, "r", "run.started", { model: "opus" });
    store.appendEvent(chat.id, "r", "usage", { input_tokens: 30, cache_creation_input_tokens: 212_713, cache_read_input_tokens: 3_386_833, output_tokens: 7_216 });
    store.appendEvent(chat.id, "r", "run.finished", { status: "finished" });
    const body = await (await createApp({ store, runner: { isActive: () => false }, asks: {} }).request(`/api/chats/${chat.id}`)).json();
    assert.equal(body.chat.usage.total, 30 + 7_216);
    assert.equal(body.chat.usageBilled.total, 30 + 212_713 + 3_386_833 + 7_216);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// The Claude bridge used to record each request's usage (message_delta) and then the turn's result,
// which already holds their sum — every total was doubled. Only the result is counted now; the
// requests stay for the context meter.
test("a Claude turn's usage is counted once: the result; each request only fills the context meter", () => {
  const bridge = createClaudeEventBridge();
  const req1 = { input_tokens: 3, cache_creation_input_tokens: 1_000, cache_read_input_tokens: 80_000, output_tokens: 120 };
  const req2 = { input_tokens: 5, cache_creation_input_tokens: 200, cache_read_input_tokens: 81_000, output_tokens: 40 };
  const sum = Object.fromEntries(Object.keys(req1).map((k) => [k, req1[k] + req2[k]]));
  const updates = [
    ...bridge.consume({ type: "stream_event", event: { type: "message_delta", usage: req1 } }),
    ...bridge.consume({ type: "stream_event", event: { type: "message_delta", usage: req2 } }),
    ...bridge.consume({ type: "result", session_id: "s", usage: sum }),
  ];
  let id = 2;
  const events = [
    { id: 1, runId: "r", type: "run.started", data: { model: "opus" } },
    ...updates.flatMap((u) => eventsFromUpdate(u)).map((e) => ({ id: id++, runId: "r", ...e })),
    { id: 99, runId: "r", type: "run.finished", data: { status: "finished" } },
  ];
  assert.equal(events.filter((e) => e.type === "usage").length, 1, "one cost record per turn");
  const { messages } = foldEvents(events);
  const usage = messages.find((m) => m.role === "assistant").usage;
  const billed = sum.input_tokens + sum.cache_creation_input_tokens + sum.cache_read_input_tokens + sum.output_tokens;
  assert.equal(usage.total, billed, "Karsara's figure for the turn");
  assert.equal(usageByModel(messages, { billed: true }).total, billed);
  assert.equal(usageByModel(messages).total, sum.input_tokens + sum.output_tokens, "Griffin's own header, no longer doubled");
  assert.equal(usage.context, 5, "the context meter: the last request, not the turn's sum");
  assert.equal(usage.requests, 2, "two requests, not three");
});
