import { t } from "./i18n.js";
// What the login page says after a failed try — plain Persian, with the exact wait or tries left.
const fa = (n) => Number(n).toLocaleString("fa-IR");

export function waitText(seconds) {
  const s = Math.max(1, Math.ceil(Number(seconds) || 0));
  if (s < 60) return `${fa(s)} ثانیه`;
  return `${fa(Math.ceil(s / 60))} دقیقه`;
}

export function loginError(status, body = {}) {
  if (body.needCode) {
    if (status === 429) return `چند بار کد اشتباه وارد شد؛ ورود تا ${waitText(body.retryAfter || 900)} دیگر بسته است.`;
    if (body.remaining === 0) return `کد درست نیست. ورود از این دستگاه تا ${waitText(body.retryAfter || 900)} دیگر بسته است.`;
    return t("کد درست نیست یا قبلاً استفاده شده؛ کد تازهٔ اپ را بزنید.");
  }
  if (status === 429) return `چند بار پشت‌سرهم اشتباه وارد شد؛ ${waitText(body.retryAfter || 900)} دیگر دوباره امتحان کنید.`;
  if (status === 401) {
    if (body.remaining === 0) return `توکن درست نیست. ورود از این دستگاه تا ${waitText(body.retryAfter || 900)} دیگر بسته است.`;
    if (body.remaining && body.remaining <= 2) return `توکن درست نیست. ${fa(body.remaining)} بار دیگر می‌توانید امتحان کنید.`;
    return t("توکن درست نیست.");
  }
  if (status === 403) return t("این صفحه از نشانی دیگری باز شده؛ آن را از نشانی اصلی باز کنید و دوباره وارد شوید.");
  if (!status) return t("سرور در دسترس نیست؛ اتصال را بررسی کنید و دوباره امتحان کنید.");
  return `ورود انجام نشد (خطای ${fa(status)})؛ کمی بعد دوباره امتحان کنید.`;
}
