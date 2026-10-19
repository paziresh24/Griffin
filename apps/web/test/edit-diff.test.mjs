import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { buildEditDiff } from "../src/edit-diff.js";

// diff §7.2: a Write showed «جزئیات ▾» with raw JSON; Karsara shows the file as a green diff.
test("Write: every line of the new file is an added line", () => {
  assert.equal(buildEditDiff({ file_path: "/a.txt", content: "one\ntwo" }), "+one\n+two");
});

test("Edit: only the changed lines are -/+, the rest stays as context", () => {
  assert.equal(buildEditDiff({ old_string: "a\nb\nc", new_string: "a\nB\nc" }), " a\n-b\n+B\n c");
});

test("MultiEdit: each edit in turn; no text at all gives no diff", () => {
  assert.equal(buildEditDiff({ edits: [{ old_string: "x", new_string: "y" }, { old_string: "", new_string: "z" }] }), "-x\n+y\n-\n+z");
  assert.equal(buildEditDiff({}), "");
});

test("the tool card draws Claude Code's Edit, MultiEdit and Write with the diff", () => {
  const src = fs.readFileSync(new URL("../src/components/Tool.jsx", import.meta.url), "utf8");
  const body = src.slice(src.indexOf("function ToolBody"), src.indexOf("function SentText"));
  for (const name of ["Edit", "MultiEdit", "Write"]) assert.match(body, new RegExp(`case "${name}":`));
  assert.match(body, /buildEditDiff\(args\)/);
});
