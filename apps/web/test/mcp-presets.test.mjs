import { test } from "node:test";
import assert from "node:assert/strict";
import { missingPresets, presetForm, presetKeyMissing } from "../src/mcp.js";

const preset = { id: "support", name: "support", type: "http", url: "https://example.com/api/external/mcp", headers: { "X-Api-Key": "" } };

test("no preset ships by default", () => {
  assert.deepEqual(missingPresets([]), []);
});

test("the form starts with the URL and an empty key header", () => {
  const form = presetForm(preset);
  assert.equal(form.type, "http");
  assert.match(form.url, /\/api\/external\/mcp$/);
  assert.deepEqual(form.headers, { "X-Api-Key": "" });
  // a copy: editing the form never changes the preset
  form.headers["X-Api-Key"] = "x";
  assert.equal(preset.headers["X-Api-Key"], "");
});

test("saving waits for the personal key", () => {
  assert.equal(presetKeyMissing(preset, "X-Api-Key="), true);
  assert.equal(presetKeyMissing(preset, "X-Api-Key=   "), true);
  assert.equal(presetKeyMissing(preset, ""), true);
  assert.equal(presetKeyMissing(preset, "X-Api-Key=msg_abc"), false);
  assert.equal(presetKeyMissing(preset, "x-api-key: msg_abc"), false);
  assert.equal(presetKeyMissing(undefined, ""), false);
});

test("a stdio preset still fills the form", () => {
  const preset = { name: "x", type: "stdio", command: "node", args: ["a.mjs"], hint: "h" };
  const form = presetForm(preset);
  assert.deepEqual(form, { name: "x", type: "stdio", command: "node", args: ["a.mjs"], env: {}, hint: "h" });
  form.args.push("b");
  assert.equal(preset.args.length, 1);
  assert.equal(presetKeyMissing(preset, ""), false);
});
