import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

// 2026-10-28 (Ms. Najafi): a new chat's repo list missed repos cloned after the page loaded; it
// came right only once the first message re-mounted the picker. Opening the list reads it again.
test("the repo picker reads the list again each time it opens", () => {
  const src = fs.readFileSync(new URL("../src/components/RepoChips.jsx", import.meta.url), "utf8");
  assert.match(src, /usePolling\(refresh \? `\/api\/repos\?r=\$\{refresh\}` : null/);
  assert.match(src, /const toggle = \(next\) => \{\s*if \(next\) setRefresh\(\(n\) => n \+ 1\);\s*setOpen\(next\);/);
  assert.match(src, /<Popover\.Root open=\{open\} onOpenChange=\{toggle\}>/);
});
