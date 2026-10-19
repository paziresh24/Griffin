import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { answerTokens } from "../src/tokens-format.js";
import { foldEvents } from "../../../packages/timeline/src/index.mjs";

// diff §5.1: Karsara's footer reads «۳.۶M توکن» (input + cache reads + output); Griffin's «7k tok»
// counted input + output only and wrote an English unit.
// The run diff.md §5.1 cites (6د ۴۸ث, opus), its real usage: Karsara shows «3.6M», cache writes counted.
test("answerTokens: Karsara's total and unit on the real run, the split on hover, nothing for an unbilled run", () => {
  const { messages } = foldEvents([
    { id: 1, runId: null, type: "user", data: { text: "a" } },
    { id: 2, runId: "r", type: "run.started", data: { model: "opus" } },
    { id: 3, runId: "r", type: "usage", data: { input_tokens: 30, cache_creation_input_tokens: 212_713, cache_read_input_tokens: 3_386_833, output_tokens: 7_216 } },
    { id: 4, runId: "r", type: "run.finished", data: { status: "finished" } },
  ]);
  const usage = messages.find((m) => m.role === "assistant").usage;
  assert.deepEqual(answerTokens(usage), { label: "3.6M توکن", title: "ورودی 212,743 · از کش 3,386,833 · خروجی 7,216" });
  // OpenAI-style usage: prompt_tokens already hold the cached part; it is not counted twice.
  const glm = foldEvents([
    { id: 1, runId: "g", type: "run.started", data: { model: "glm" } },
    { id: 2, runId: "g", type: "usage", data: { prompt_tokens: 1000, prompt_tokens_details: { cached_tokens: 800 }, completion_tokens: 50 } },
  ]).messages.find((m) => m.role === "assistant").usage;
  assert.equal(answerTokens(glm).label, "1.1k توکن");
  assert.equal(answerTokens({ input: 712_900, cached: 0, output: 0 }).label, "712.9k توکن");
  assert.equal(answerTokens({ input: 900, cached: 0, output: 12 }).label, "912 توکن");
  assert.equal(answerTokens({ input: 0, cached: 0, output: 0 }), null);
  assert.equal(answerTokens(undefined), null);
});

// diff §4.3: Karsara pins IRANSansX's weight axis at 400, so its markdown bold reads as plain text.
// The skin's face carries the same pin; Griffin's own face (Vazirmatn) is untouched.
test("the Karsara skin's IRANSansX face pins the weight at 400, as Karsara's does", () => {
  const css = fs.readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
  const faces = [...css.matchAll(/@font-face\s*{([^}]*)}/g)].map((m) => m[1]);
  const iran = faces.filter((f) => /font-family:\s*"iran-sans-x"/.test(f));
  assert.equal(iran.length, 1);
  assert.match(iran[0], /font-variation-settings:\s*"wght" 400;/);
  for (const face of faces.filter((f) => !iran.includes(f))) assert.doesNotMatch(face, /font-variation-settings/);
});
