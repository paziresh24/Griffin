import test from "node:test";
import assert from "node:assert/strict";
import { clampCandidate, isHeavyEffort, isHeavyModel, needsConfirm, shownChoice } from "../src/model-policy.mjs";

test("heavy models are anything above Sonnet and Haiku", () => {
  for (const m of ["opus", "fable", "claude-opus-5-5", "claude-2:opus", "claude-fable-5-1[1m]"]) assert.equal(isHeavyModel(m), true, m);
  for (const m of ["sonnet", "claude:haiku", "claude-sonnet-5-5", "auto", "", null, "gpt-4o"]) assert.equal(isHeavyModel(m), false, String(m));
});

test("only high, xhigh and max need confirmation", () => {
  assert.deepEqual(["low", "medium", "high", "xhigh", "max"].filter(isHeavyEffort), ["high", "xhigh", "max"]);
  assert.deepEqual(needsConfirm({ model: "opus", effort: "high" }), ["model", "effort"]);
  assert.deepEqual(needsConfirm({ model: "sonnet", effort: "medium" }), []);
});

test("candidates fall back to sonnet and medium unless the chat confirmed", () => {
  const c = { provider: "claude", model: "opus", effort: "max" };
  assert.deepEqual(clampCandidate(c), { provider: "claude", model: "sonnet", effort: "medium" });
  assert.deepEqual(clampCandidate(c, { model: true }), { provider: "claude", model: "opus", effort: "medium" });
  assert.deepEqual(clampCandidate(c, { model: true, effort: true }), c);
  assert.equal(clampCandidate({ provider: "claude", model: "sonnet", effort: null }).effort, "medium");
});

test("the picker shows what the run's clamp leaves, the chat's account kept", () => {
  assert.deepEqual(shownChoice({ model: "opus", effort: "high" }), { model: "sonnet", effort: "medium" });
  assert.deepEqual(shownChoice({ model: "claude-5:opus", effort: null }), { model: "claude-5:sonnet", effort: "medium" });
  assert.deepEqual(shownChoice({ model: "opus", effort: "high" }, { model: true, effort: true }), { model: "opus", effort: "high" });
  assert.deepEqual(shownChoice({ model: "claude-5:opus", effort: "max" }, { model: true }), { model: "claude-5:opus", effort: "medium" });
  assert.deepEqual(shownChoice({ model: null, effort: null }), { model: null, effort: "medium" });
});
