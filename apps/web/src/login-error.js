import { t } from "./i18n.js";
// What the login page says after a failed try — plain Persian, with the exact wait or tries left.
const fa = (n) => Number(n).toLocaleString("fa-IR");

export function waitText(seconds) {
  const s = Math.max(1, Math.ceil(Number(seconds) || 0));
  if (s < 60) return t("{fa} ثانیه", { fa: fa(s) });
  return t("{fa} دقیقه", { fa: fa(Math.ceil(s / 60)) });
}

export function loginError(status, body = {}) {
  if (body.needCode) {
    if (status === 429) return t("چند بار کد اشتباه وارد شد؛ ورود تا {waitText} دیگر بسته است.", { waitText: waitText(body.retryAfter || 900) });
    if (body.remaining === 0) return t("کد درست نیست. ورود از این دستگاه تا {waitText} دیگر بسته است.", { waitText: waitText(body.retryAfter || 900) });
    return t("کد درست نیست یا قبلاً استفاده شده؛ کد تازهٔ اپ را بزنید.");
  }
  if (status === 429) return t("چند بار پشت‌سرهم اشتباه وارد شد؛ {waitText} دیگر دوباره امتحان کنید.", { waitText: waitText(body.retryAfter || 900) });
  if (status === 401) {
    if (body.remaining === 0) return t("توکن درست نیست. ورود از این دستگاه تا {waitText} دیگر بسته است.", { waitText: waitText(body.retryAfter || 900) });
    if (body.remaining && body.remaining <= 2) return t("توکن درست نیست. {fa} بار دیگر می‌توانید امتحان کنید.", { fa: fa(body.remaining) });
    return t("توکن درست نیست.");
  }
  if (status === 403) return t("این صفحه از نشانی دیگری باز شده؛ آن را از نشانی اصلی باز کنید و دوباره وارد شوید.");
  if (!status) return t("سرور در دسترس نیست؛ اتصال را بررسی کنید و دوباره امتحان کنید.");
  return t("ورود انجام نشد (خطای {fa})؛ کمی بعد دوباره امتحان کنید.", { fa: fa(status) });
}
