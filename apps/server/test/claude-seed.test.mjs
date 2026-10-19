import test from "node:test";
import assert from "node:assert/strict";
import { seedText, withSeed } from "../src/providers/claude.mjs";

// A Claude chat that lost its session must not restart blank.
test("a fresh Claude session carries the conversation so far", () => {
  const seed = seedText([{ role: "user", content: "add tracker to MCP" }, { role: "assistant", content: "branch alice/46828e0e pushed" }]);
  assert.match(seed, /User: add tracker/);
  assert.match(seed, /You: branch alice/);
  const msg = withSeed({ text: "why stuck?", images: [] }, seed);
  assert.match(msg.text, /branch alice[\s\S]*why stuck\?$/);
  assert.equal(seedText([]), "");
  assert.equal(seedText(Array.from({ length: 50 }, () => ({ role: "user", content: "x".repeat(5000) }))).length < 60_000, true);
});
