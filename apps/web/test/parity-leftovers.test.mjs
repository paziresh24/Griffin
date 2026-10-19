// Leftovers of the Karsara-skin parity work: the «مدل‌های بیشتر» list names models as the
// skin's menu does and its search finds «5.5»; a Persian tool subtitle (AskUserQuestion) reads RTL;
// the header token total counts what Karsara's counts.
import test from "node:test";
import assert from "node:assert/strict";
import { modelMatches, modelName } from "../src/model-names.js";
import { targetLook } from "../src/dir.js";
import { foldEvents, usageByModel } from "../../../packages/timeline/src/index.mjs";

const sonnet = { id: "sonnet", name: "Claude Sonnet", label: "Sonnet 5.5", provider: "claude-2" };

test("model menu rows: the version label under the Karsara skin, the name under Griffin's", () => {
  assert.equal(modelName(sonnet, true), "Sonnet 5.5");
  assert.equal(modelName(sonnet, false), "Claude Sonnet");
  assert.equal(modelName({ id: "gpt-5", name: "GPT-5" }, true), "GPT-5", "a model with no label keeps its name");
  assert.equal(modelName({ id: "x" }, true), "x");
});

test("model search under the Karsara skin matches the version («5.5»); Griffin's skin searches as before", () => {
  assert.ok(modelMatches(sonnet, "5.5", true));
  assert.ok(modelMatches(sonnet, "sonnet 5", true));
  assert.ok(modelMatches(sonnet, "claude", true));
  assert.ok(!modelMatches(sonnet, "opus", true));
  assert.ok(!modelMatches(sonnet, "5.5", false), "the label is not shown there, so it is not searched");
  assert.ok(modelMatches(sonnet, "claude", false));
  assert.ok(modelMatches(sonnet, ""), "an empty search keeps every row");
});

test("a tool row's target: Persian reads right to left in the text face; paths stay LTR monospace", () => {
  assert.deepEqual(targetLook("کدام شاخه را مرج کنم؟"), { dir: "rtl", className: "min-w-0 truncate text-xs" });
  assert.equal(targetLook("apps/web/src/App.jsx").dir, "ltr");
  assert.match(targetLook("git status").className, /font-mono/);
  // A path, URL or pattern with a Persian segment is still a path (the first strong letter decides).
  assert.equal(targetLook("/docs/doctor-voice/نظر بیماران.md").dir, "ltr");
  assert.equal(targetLook("https://example.ir/پزشک").dir, "ltr");
  assert.equal(targetLook("«کدام» branch?").dir, "rtl");
});

test("header total: Karsara's formula (everything billed) on request; Griffin's input + output stays the default", () => {
  const { messages } = foldEvents([
    { id: 1, runId: null, type: "user", data: { text: "a" } },
    { id: 2, runId: "r", type: "run.started", data: { model: "opus" } },
    { id: 3, runId: "r", type: "usage", data: { input_tokens: 30, cache_creation_input_tokens: 212_713, cache_read_input_tokens: 3_386_833, output_tokens: 7_216 } },
    { id: 4, runId: "r", type: "usage", data: { input_tokens: 10, cache_read_input_tokens: 1_000, output_tokens: 5 } },
    { id: 5, runId: "r", type: "run.finished", data: { status: "finished" } },
  ]);
  // Karsara's runs.tokens: per usage event input + cache reads + cache writes + output, summed.
  const karsara = (30 + 212_713 + 3_386_833 + 7_216) + (10 + 1_000 + 5);
  assert.deepEqual(usageByModel(messages, { billed: true }), { total: karsara, byModel: [{ model: "opus", tokens: karsara }] });
  assert.equal(usageByModel(messages).total, 30 + 7_216 + 10 + 5, "Griffin's own header is unchanged");
});
