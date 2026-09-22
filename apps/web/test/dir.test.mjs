import test from "node:test";
import assert from "node:assert/strict";
import { isRtlText, textDir } from "../src/dir.js";

test("any Persian forces rtl even when the line starts with Latin", () => {
  assert.equal(textDir("GitLab پروداکشن الان حدود ۱۵ گیگ مموری می‌خورد"), "rtl");
  assert.equal(textDir("## مصرف منابع\n\nالان عادی است."), "rtl");
  assert.equal(textDir("Failed: اتصال برقرار نشد"), "rtl");
  assert.equal(isRtlText("مموری (GiB)"), true);
});

test("pure English stays ltr", () => {
  assert.equal(textDir("Failed to connect to api.cursor.com"), "ltr");
  assert.equal(textDir("namespace/gitlab pod restart"), "ltr");
});

test("empty / digits alone stay auto", () => {
  assert.equal(textDir(""), "auto");
  assert.equal(textDir("42"), "auto");
});
