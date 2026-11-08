import test from "node:test";
import assert from "node:assert/strict";
import { systemNote } from "../src/system-note.js";

test("a network answer: who, status, reason and the answer — the agent's instructions folded", () => {
  const raw =
    "[گزارش خودکار زیرکارها — شبکهٔ ایجنت‌ها — پاسخ «راوی (آناهیتا منصوری)» به درخواست taskId ecb516d2-f973؛ این پیام را سیستم فرستاده، نه Owner]\n\n" +
    "وضعیت: failed (the owner did not approve in time)\n\nPipeline سبز شده است.\n\nاین نتیجه را برای کسی که کار را خواسته جمع‌بندی کن (نتیجه اول).";
  const note = systemNote(raw);
  assert.equal(note.kind, "network");
  assert.match(note.title, /راوی \(آناهیتا منصوری\)/);
  assert.doesNotMatch(note.title, /taskId|سیستم/);
  assert.equal(note.status, "failed");
  assert.equal(note.reason, "the owner did not approve in time");
  assert.equal(note.text, "Pipeline سبز شده است.");
  assert.equal(note.folded, true);
  assert.equal(note.raw, raw);
});

test("a queued network question", () => {
  const note = systemNote(
    "[گزارش خودکار زیرکارها — شبکهٔ ایجنت‌ها — پاسخ «x» به درخواست taskId t1؛ این پیام وقتی آن ایجنت در دسترس نبود (آپدیت/قطع) در صف ماند و بعد از برگشتنش رفت؛ این پیام را سیستم فرستاده، نه Owner]\n\n" +
      'آن ایجنت سؤالی پرسیده: کدام شاخه؟\nگزینه‌ها: main · dev\nجواب را با network_reply {agent: "x", taskId: "t1", answer} بده.\n\nاین نتیجه را برای کسی که کار را خواسته جمع‌بندی کن (نتیجه اول).',
  );
  assert.equal(note.queued, true);
  assert.equal(note.status, "input-required");
  assert.equal(note.text, "کدام شاخه؟\nگزینه‌ها: main · dev");
});

test("subtasks: one section each, with the chat to open; still-running names without ids", () => {
  const note = systemNote(
    "[گزارش خودکار زیرکارها — این پیام را سیستم فرستاده، نه Owner]\n\n" +
      "### کدنویس — finished (subtask c-1)\nدرست شد.\nابزارهای اجراشده: Bash, Edit\n\n### بازبین — failed (subtask c-2)\nنشد.\nنامعلوم/خطا: timeout\n" +
      "هنوز در کار: تستر (c-3) — نتیجه‌شان خودکار می‌رسد؛ منتظر نمان.\nاین نتیجه‌ها را برای کسی که کار را خواسته جمع‌بندی کن (نتیجه اول). ادامه…",
  );
  assert.equal(note.kind, "subtasks");
  assert.deepEqual(note.sections, [
    { label: "کدنویس", status: "finished", chatId: "c-1", text: "درست شد." },
    { label: "بازبین", status: "failed", chatId: "c-2", text: "نشد.\nنامعلوم/خطا: timeout" },
  ]);
  assert.equal(note.still, "تستر");
});

test("instruction-only notes keep just their title; the owner's own text is not a note", () => {
  const nudge = systemNote("[تذکر سیستمی — این پیام را سیستم فرستاده، نه Owner] نوبت قبلت با قول کاری تمام شد…");
  assert.equal(nudge.title, "تذکر سیستمی");
  assert.equal(nudge.text, "");
  assert.equal(systemNote("[ادامه پس از ری‌استارت سرور]\nاجرای قبلی قطع شد. از همان‌جا ادامه بده.").text, "");
  const lost = systemNote("[ادامه پس از ری‌استارت سرور — این پیام را سیستم فرستاده، نه Owner]\nاین کارهای پس‌زمینهٔ این گفتگو با ری‌استارت متوقف شدند و نتیجه‌شان دیگر نمی‌رسد:\n- «build»\nاگر هنوز لازم است، اول ببین هر کدام کجا مانده.");
  assert.match(lost.text, /- `build`$/);
  const cmd = systemNote("[ادامه پس از ری‌استارت سرور — این پیام را سیستم فرستاده، نه Owner]\nاین کارهای پس‌زمینهٔ این گفتگو با ری‌استارت متوقف شدند و نتیجه‌شان دیگر نمی‌رسد:\n- «until curl -s http://x/healthz; do sleep 20; done»\nاگر هنوز لازم است، اول ببین.");
  assert.match(cmd.text, /^- `until curl -s http:\/\/x\/healthz; do sleep 20; done`$/m);
  assert.doesNotMatch(cmd.text, /اگر هنوز لازم است/);
  assert.equal(systemNote("[یک لینک](http://x) ببین"), null);
  assert.equal(systemNote("سلام"), null);
});

test("a tool build report links its build chat", () => {
  const note = systemNote("[گزارش خودکار ساخت ابزار «جستجو» — این پیام را سیستم فرستاده، نه Owner]\n\nساخته شد.\n\nگفتگوی ساخت: abc-1. اگر ادغام شد…");
  assert.equal(note.kind, "tool");
  assert.equal(note.title, "ساخت ابزار «جستجو»");
  assert.equal(note.text, "ساخته شد.");
  assert.equal(note.chatId, "abc-1");
});
