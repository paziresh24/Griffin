import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

// Tables in answers keep copy, download (CSV) and fullscreen; code blocks stay copy-only.
test("chat tables keep download and fullscreen; code blocks stay copy-only", () => {
  const source = fs.readFileSync(new URL("../src/components/Thread.jsx", import.meta.url), "utf8");
  const line = source.split("\n").find((l) => /^const controls = /.test(l));
  assert.ok(line, "Thread.jsx declares the Streamdown controls");
  const controls = Function(`return (${line.replace(/^const controls = /, "").replace(/;\s*$/, "")});`)();
  assert.deepEqual(controls.table, { copy: true, download: true, fullscreen: true });
  assert.deepEqual(controls.code, { copy: true, download: false });
  assert.match(source, /controls=\{controls\}/);
  // Fullscreen is portalled outside .sd-block: one alignment rule for its headers and cells, no per-cell bidi.
  const css = fs.readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
  const rule = css.match(/\[data-streamdown="table-fullscreen"\][^{]*table-header-cell[^{]*\{([^}]*)\}/);
  assert.ok(rule && /text-align:\s*start/.test(rule[1]));
  assert.doesNotMatch(rule[1], /unicode-bidi/);
});
