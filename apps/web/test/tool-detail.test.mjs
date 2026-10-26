import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { factEntries, hasValue, isLongText, isUrl, keyLabel, scalarText } from "../src/tool-detail.js";

// A tool without its own view used to open as `{args, result}` raw JSON; now every field is named
// in Persian and shown in its natural shape.
test("known fields get a Persian name, unknown ones keep theirs", () => {
  assert.equal(keyLabel("replaced"), "تعداد جایگزینی");
  assert.equal(keyLabel("path"), "مسیر");
  assert.equal(keyLabel("someNewField"), "someNewField");
});

test("short values are text, yes/no for booleans, nothing for blanks", () => {
  assert.equal(scalarText(true), "بله");
  assert.equal(scalarText(false), "خیر");
  assert.equal(scalarText(0), "0");
  assert.equal(scalarText(""), null);
  assert.equal(scalarText(undefined), null);
});

test("long text, links and empty fields are told apart", () => {
  assert.equal(isLongText("a\nb"), true);
  assert.equal(isLongText("x".repeat(141)), true);
  assert.equal(isLongText("short"), false);
  assert.equal(isUrl("https://gitlab.example/a/b/-/merge_requests/1"), true);
  assert.equal(isUrl("see https://x.y"), false);
  assert.equal(hasValue(0), true);
  assert.equal(hasValue(false), true);
  assert.equal(hasValue(""), false);
  assert.deepEqual(factEntries({ a: 1, b: "", c: null, d: false }), [["a", 1], ["d", false]]);
  assert.deepEqual(factEntries("nope"), []);
});

test("the card's fallback is the readable view, not raw JSON; the repo tools have their own", () => {
  const src = fs.readFileSync(new URL("../src/components/Tool.jsx", import.meta.url), "utf8");
  const body = src.slice(src.indexOf("function ToolBody"), src.indexOf("function SentText"));
  assert.match(body, /default:\s*return <GenericDetail args=\{args\} result=\{result\} \/>/);
  assert.doesNotMatch(body, /<Json value=\{\{ args, result \}\} \/>/);
  for (const name of ["repo_edit", "repo_write", "repo_read", "repo_list", "repo_search", "repo_git"]) assert.match(body, new RegExp(`case "${name}":`));
});
