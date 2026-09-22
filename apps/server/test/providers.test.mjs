import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { z } from "zod";
import { jsonSchemaToZodShape } from "../src/providers/json-schema-zod.mjs";
import { createClaudeEventBridge } from "../src/providers/claude-events.mjs";
import { normalizeProvider, PROVIDER_CLAUDE, PROVIDER_CURSOR } from "../src/providers/index.mjs";

describe("providers helpers", () => {
  it("normalizes provider ids", () => {
    assert.equal(normalizeProvider("claude"), PROVIDER_CLAUDE);
    assert.equal(normalizeProvider("cursor"), PROVIDER_CURSOR);
    assert.equal(normalizeProvider("other"), PROVIDER_CURSOR);
  });

  it("converts JSON Schema objects to Zod shapes", () => {
    const shape = jsonSchemaToZodShape({
      type: "object",
      properties: {
        question: { type: "string", description: "q" },
        count: { type: "integer" },
        flag: { type: "boolean" },
      },
      required: ["question"],
      additionalProperties: false,
    });
    assert.ok(shape.question);
    const parsed = z.object(shape).parse({ question: "hi", count: 2 });
    assert.equal(parsed.question, "hi");
    assert.equal(parsed.count, 2);
    assert.equal(parsed.flag, undefined);
  });

  it("maps Claude stream text and tools to Cursor-shaped updates", () => {
    const bridge = createClaudeEventBridge();
    const text = bridge.consume({
      type: "stream_event",
      event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "سلام" } },
    });
    assert.deepEqual(text, [{ type: "text-delta", text: "سلام" }]);

    const started = bridge.consume({
      type: "stream_event",
      event: {
        type: "content_block_start",
        index: 1,
        content_block: { type: "tool_use", id: "call-1", name: "mcp__griffin__kube_df", input: {} },
      },
    });
    assert.equal(started[0].type, "tool-call-started");
    assert.equal(started[0].toolCall.args.toolName, "kube_df");
  });
});
