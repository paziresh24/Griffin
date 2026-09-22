import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openStore } from "../src/db.mjs";
import {
  eventsFromStep,
  findTaskChild,
  materializeTaskChat,
  taskSummary,
} from "../src/tasks.mjs";

function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "griffin-task-"));
  const store = openStore(path.join(dir, "t.sqlite"));
  return { store, dir };
}

test("eventsFromStep maps thinking, text, and tool calls", () => {
  assert.equal(eventsFromStep({ thinkingMessage: { text: "hi", durationMs: 3 } }).length, 2);
  assert.equal(eventsFromStep({ assistantMessage: { text: "done" } })[0].type, "text");
  const tools = eventsFromStep({
    toolCall: {
      toolCallId: "c1",
      readToolCall: { args: { path: "/a" }, result: { success: { content: "x" } } },
    },
  });
  assert.equal(tools[0].type, "tool.started");
  assert.equal(tools[0].data.name, "read");
  assert.equal(tools[1].data.result.content, "x");
});

test("taskSummary takes the last assistant message", () => {
  const summary = taskSummary({
    conversationSteps: [
      { assistantMessage: { text: "first" } },
      { assistantMessage: { text: "**final**" } },
    ],
  });
  assert.equal(summary, "**final**");
});

test("materializeTaskChat creates a child and is idempotent", () => {
  const { store, dir } = tempStore();
  const parent = store.createChat({ title: "root", agent: "nsin-ban", caller: "owner" });
  const callId = "call-task-1";
  const runId = store.startRun(parent.id);
  store.appendEvent(parent.id, runId, "tool.done", {
    callId,
    name: "task",
    args: { description: "Aggregate error URIs", prompt: "parse logs" },
    result: {
      status: "success",
      value: {
        conversationSteps: [
          { thinkingMessage: { text: "thinking", durationMs: 1 } },
          { assistantMessage: { text: "hello" } },
          {
            toolCall: {
              toolCallId: "t1",
              grepToolCall: { args: { pattern: "x" }, result: { success: { content: "1" } } },
            },
          },
          { assistantMessage: { text: "**نتیجه** جدول" } },
        ],
        durationMs: 1200,
      },
    },
  });
  store.finishRun(parent.id, runId, "finished");

  const child = materializeTaskChat(store, parent.id, callId);
  assert.equal(child.parent_chat_id, parent.id);
  assert.equal(child.caller, "task");
  assert.match(child.title, /Aggregate error URIs/);
  assert.equal(findTaskChild(store, parent.id, callId), child.id);

  const events = [...store.allEvents(child.id)];
  assert.ok(events.some((e) => e.type === "text" && e.data?.text === "**نتیجه** جدول"));
  assert.ok(events.some((e) => e.type === "tool.done" && e.data?.name === "grep"));

  const again = materializeTaskChat(store, parent.id, callId);
  assert.equal(again.id, child.id);

  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
