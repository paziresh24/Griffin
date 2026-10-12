// Words for the "change repo" confirmation, from the server's preview (GET /api/chats/:id/folder).
import { num, t } from "./i18n.js";

export const FOLDER_BUSY = t("این گفتگو الان در حال کار است. بعد از تمام شدنِ کار دوباره امتحان کنید.");

// The dialog's lines, in order: what happens to the conversation, to the old repo's work, and what
// stops the move.
export function folderSwitchLines(preview) {
  const { from, to } = preview;
  const lines = [t("گفتگو با همین پیام‌ها روی {to} ادامه پیدا می‌کند و ایجنت در پیام بعدی می‌فهمد که ریپو عوض شده است.", { to })];
  if (preview.returning) lines.push(t("همان نسخه‌ای که این گفتگو قبلاً در {to} داشت، با همهٔ تغییراتش، برمی‌گردد.", { to }));
  if (!preview.parked) lines.push(t("در {from} کاری روی دیسک نمانده که کنار گذاشته شود.", { from }));
  else if (preview.changed > 0) lines.push(t("{n} فایل تغییرکرده یا تازه در {from} هست. پاک نمی‌شوند و دست‌نخورده کنار گذاشته می‌شوند.", { n: num(preview.changed || 0), from }));
  else lines.push(t("{from} تغییر ذخیره‌نشده‌ای ندارد و دست‌نخورده کنار گذاشته می‌شود.", { from }));
  if (preview.unpushed) lines.push(t("کامیت‌هایی که هنوز push نشده‌اند هم همان‌جا می‌مانند."));
  if (preview.parked) lines.push(t("اگر بعداً به {from} برگردید، همین نسخه دوباره باز می‌شود.", { from }));
  if (preview.busy) lines.push(FOLDER_BUSY);
  return lines;
}

// The server's refusal, in words.
export function folderSwitchError(error) {
  if (error?.status === 409) return FOLDER_BUSY;
  return t("ریپو عوض نشد: {message}", { message: error?.message || t("خطای ناشناخته") });
}
