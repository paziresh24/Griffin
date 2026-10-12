import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveModel } from "../src/providers/claude.mjs";

// 2026-10-10: the Anthropic API stopped resolving bare aliases ("model: opus" → 404) and every
// colleague thread died with "Unknown Model". The provider must map the short names to a full id.
test("claude model aliases map to current full ids; full ids pass through", () => {
  assert.equal(resolveModel("opus"), "claude-opus-5-5");
  assert.equal(resolveModel("Sonnet"), "claude-sonnet-5-5");
  assert.equal(resolveModel("haiku"), "claude-haiku-5-5");
  assert.equal(resolveModel("claude-opus-5-5"), "claude-opus-5-5");
  assert.equal(resolveModel(""), "");
});
