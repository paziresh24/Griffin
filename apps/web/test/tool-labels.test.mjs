import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { APP_TOOL_NAMES } from "../../server/src/agents/profiles.mjs";

// Tool names are API ids (English, snake_case); the UI row must say them in Persian. A new tool
// without a TOOLS entry in Tool.jsx would show its raw id, so this fails until it gets a label.
const source = readFileSync(fileURLToPath(new URL("../src/components/Tool.jsx", import.meta.url)), "utf8");
const labeled = new Set([...source.matchAll(/^\s{2}([A-Za-z_][A-Za-z0-9_]*):\s*\{\s*(?:icon|get)\b/gm)].map((m) => m[1]));

test("every app tool has a Persian label in Tool.jsx", () => {
  const missing = APP_TOOL_NAMES.filter((name) => !labeled.has(name));
  assert.deepEqual(missing, []);
});

test("every broker tool has a Persian label in Tool.jsx", () => {
  const broker = readFileSync(fileURLToPath(new URL("../../broker/src/tools.mjs", import.meta.url)), "utf8");
  const names = [...broker.matchAll(/^ {4}([a-z][a-z0-9_]+): \{$/gm)].map((m) => m[1]);
  assert.ok(names.length > 10);
  assert.deepEqual(names.filter((name) => !labeled.has(name)), []);
});

test("labels are Persian text", () => {
  const labels = [...source.matchAll(/^\s{2}([a-z][a-z0-9_]*):\s*\{[^}\n]*?label:\s*(?:t\()?"([^"]+)"/gm)];
  assert.ok(labels.length > 100);
  for (const [, name, label] of labels) assert.match(label, /[؀-ۿ]/, `${name}: «${label}» has no Persian`);
});
