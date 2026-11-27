// A tool the chat draws in the answer without a click (web Work.jsx RESULT_TOOLS) must reach the page with its
// whole result (timeline-cache.mjs SHOWN_WITHOUT_CLICK): held back as a lazy stub, its card drew empty
// (2026-11-23: the settings_suggest card said «تنظیمی پیدا نشد» over three suggestions).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), "utf8");
const names = (src, start) => [...src.slice(src.indexOf(start)).split(")")[0].matchAll(/"([A-Za-z_]+)"/g)].map((m) => m[1]);

test("every tool drawn in the answer goes out with its whole result", () => {
  const drawn = names(read("../../web/src/components/Work.jsx"), "const RESULT_TOOLS");
  const whole = new Set(names(read("../src/timeline-cache.mjs"), "const SHOWN_WITHOUT_CLICK"));
  assert.ok(drawn.length > 5 && whole.size > 5);
  assert.deepEqual(drawn.filter((name) => !whole.has(name)), []);
});
