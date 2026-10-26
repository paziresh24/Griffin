import { t } from "./i18n.js";
// Words for the rewind dialog, from the server's preview (POST /api/chats/:id/rewind, dryRun).
const fa = (n) => Number(n || 0).toLocaleString("fa-IR");

// What will happen to files: one plain line.
export function filesLine(files) {
  if (!files) return t("در حال بررسی فایل‌ها…");
  if (!files.canRewind) return t("فایلی برای برگرداندن ثبت نشده است.");
  if (!files.changed) return t("از این پیام به بعد فایلی با ابزار ویرایش عوض نشده است.");
  const lines = [files.insertions ? t("{fa} خط اضافه", { fa: fa(files.insertions) }) : "", files.deletions ? t("{fa} خط کم", { fa: fa(files.deletions) }) : ""].filter(Boolean).join(t("، "));
  return t("{fa} فایل به حالت قبل از این پیام برمی‌گردد{v}.", { fa: fa(files.changed), v: lines ? ` (${lines})` : "" });
}

// Which of the three choices make sense for this preview.
export function rewindChoices(preview) {
  const files = Boolean(preview?.files?.canRewind && preview.files.changed > 0);
  const conversation = Boolean(preview?.conversation?.canRewind);
  return { both: files && conversation, conversation, files };
}

// The message rewound away comes back to the composer, as in Claude Code (owner 2026-10-22: its
// text was lost). Not for «فقط فایل‌ها» (the message stays) nor for an edit (sent again at once).
export function textBackToBox(body, text) {
  if (!text?.trim() || body?.conversation === false || body?.text != null) return "";
  return text;
}
