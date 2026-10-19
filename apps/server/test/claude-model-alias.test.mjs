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

// Karsara's menu reads ۱ Opus 5.5 / ۲ Fable 5.1 / ۳ Sonnet 5.5 / ۴ Haiku 5.5. Fable is an
// alias like the others (bare "fable" 404s like bare "opus" did), and is listed only where the
// install says its plan has it (GRIFFIN_CLAUDE_FABLE), so other installs' menus are unchanged.
test("fable resolves to a full id; the menu lists it after Opus only with GRIFFIN_CLAUDE_FABLE", async () => {
  const { claudeModelList, versionLabel } = await import("../src/providers/claude.mjs");
  assert.equal(resolveModel("fable"), "claude-fable-5-1");
  assert.deepEqual(claudeModelList({}).map((m) => m.id), ["opus", "sonnet", "haiku"]);
  assert.deepEqual(claudeModelList({ GRIFFIN_CLAUDE_FABLE: "1" }).map((m) => m.id), ["opus", "fable", "sonnet", "haiku"]);
  assert.deepEqual(claudeModelList({ GRIFFIN_CLAUDE_FABLE: "1" }).map((m) => m.label), ["Opus 5.5", "Fable 5.1", "Sonnet 5.5", "Haiku 5.5"]);
  assert.equal(claudeModelList({ GRIFFIN_CLAUDE_FABLE: "0" }).length, 3);
  assert.equal(claudeModelList({}).find((m) => m.id === "opus").name, "Claude Opus");
  assert.equal(versionLabel("claude-opus-4-8"), "Opus 4.8");
  assert.equal(versionLabel("claude-opus-5"), "Opus 5");
  assert.equal(versionLabel("gpt-5"), null);
});

// GRIFFIN_CLAUDE_FABLE used to be read once at start: the Settings key did nothing until a restart.
test("CLAUDE_FABLE is a live Settings key: the provider's model list follows it without a restart", async () => {
  const { createClaudeProvider } = await import("../src/providers/claude.mjs");
  const { setConfigOverrides } = await import("../src/env.mjs");
  const { CONFIG_SCHEMA } = await import("../src/config.mjs");
  const key = CONFIG_SCHEMA.find((k) => k.key === "CLAUDE_FABLE");
  assert.ok(key?.live, "a live Settings key");
  assert.equal(key.options[0], "off", "off first (the default)");
  const provider = createClaudeProvider({ apiKey: "sk-ant-api-test" });
  let settings = {};
  setConfigOverrides(() => settings);
  try {
    assert.deepEqual((await provider.listModels()).map((m) => m.id), ["opus", "sonnet", "haiku"]);
    settings = { CLAUDE_FABLE: "on" };
    assert.deepEqual((await provider.listModels()).map((m) => m.id), ["opus", "fable", "sonnet", "haiku"]);
    settings = { CLAUDE_FABLE: "off" };
    assert.equal((await provider.listModels()).length, 3);
  } finally {
    setConfigOverrides(null);
  }
});
