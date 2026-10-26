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

test("an English sentence that quotes Persian stays ltr; Persian full of English names stays rtl", () => {
  assert.equal(textDir("The narration panel («روایت») is still English, so I'll fix Work.jsx."), "ltr");
  assert.equal(textDir('The user wants "فارسی" text right-aligned.'), "ltr");
  assert.equal(textDir("Checking the روایت panel and the alignment in Work.jsx now"), "ltr");
  assert.equal(textDir("namespace profile-app روی east هنوز pod های crashloop داره"), "rtl");
  assert.equal(textDir("`kubectl get pods -n profile-app --context east` را زدم"), "rtl");
  assert.equal(textDir("GitLab MR !54 merge شد"), "rtl");
  assert.equal(textDir("«روایت»"), "rtl");
  assert.equal(textDir("See [سند](https://example.com/docs) for details on the setup"), "ltr");
});
