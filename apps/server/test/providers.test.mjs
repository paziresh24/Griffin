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
    // The result keeps the tool's name (finalText finds end_agent by it).
    const done = bridge.consume({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "call-1", content: "ok" }] } });
    assert.equal(done[0].toolCall.args.toolName, "kube_df");
  });

it("claude: subscription token goes in CLAUDE_CODE_OAUTH_TOKEN, api key in ANTHROPIC_API_KEY", async () => {
  const { claudeAuthEnv } = await import("../src/providers/claude.mjs");
  const oauth = claudeAuthEnv("sk-ant-oat01-x");
  assert.equal(oauth.CLAUDE_CODE_OAUTH_TOKEN, "sk-ant-oat01-x");
  assert.equal(oauth.ANTHROPIC_API_KEY, undefined);
  const key = claudeAuthEnv("sk-ant-api03-y");
  assert.equal(key.ANTHROPIC_API_KEY, "sk-ant-api03-y");
  assert.equal(key.CLAUDE_CODE_OAUTH_TOKEN, undefined);
});

it("claude: images become one streamed user message with image blocks", async () => {
  const { toPrompt } = await import("../src/providers/claude.mjs");
  assert.equal(toPrompt({ text: "hi", images: [] }), "hi");
  const out = [];
  for await (const m of toPrompt({ text: "what is this", images: [{ data: "AAA", mimeType: "image/jpeg" }] }, () => "s1")) out.push(m);
  assert.equal(out.length, 1);
  assert.equal(out[0].session_id, "s1");
  assert.deepEqual(out[0].message.content.map((c) => c.type), ["image", "text"]);
  assert.equal(out[0].message.content[0].source.media_type, "image/jpeg");
});

  it("free-form objects never become z.record (Claude Code drops the MCP server on propertyNames)", () => {
    const shape = jsonSchemaToZodShape({ type: "object", properties: { spec: { type: "object" }, tags: { type: "object", additionalProperties: { type: "string" } } } });
    const json = JSON.stringify(z.toJSONSchema(z.object(shape)));
    assert.ok(!json.includes("propertyNames"), json);
  });
});
