import { t } from "./i18n.js";
// Words for the rewind dialog, from the server's preview (POST /api/chats/:id/rewind, dryRun).
const fa = (n) => Number(n || 0).toLocaleString("fa-IR");

// What will happen to files: one plain line.
export function filesLine(files) {
  if (!files) return t("در حال بررسی فایل‌ها…");
  if (!files.canRewind) return t("فایلی برای برگرداندن ثبت نشده است.");
  if (!files.changed) return t("از این پیام به بعد فایلی با ابزار ویرایش عوض نشده است.");
  const lines = [files.insertions ? `${fa(files.insertions)} خط اضافه` : "", files.deletions ? `${fa(files.deletions)} خط کم` : ""].filter(Boolean).join(t("، "));
  return `${fa(files.changed)} فایل به حالت قبل از این پیام برمی‌گردد${lines ? ` (${lines})` : ""}.`;
}

// Which of the three choices make sense for this preview.
export function rewindChoices(preview) {
  const files = Boolean(preview?.files?.canRewind && preview.files.changed > 0);
  const conversation = Boolean(preview?.conversation?.canRewind);
  return { both: files && conversation, conversation, files };
}
