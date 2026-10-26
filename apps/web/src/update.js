import { t } from "./i18n.js";
// The update offer at the bottom of the sidebar (UpdateNotice.jsx): the host publishes the newest
// release with what it changes and fetches it right away; the owner reads the Persian lines and
// presses «ری‌استارت و اعمال», which only switches to what is already downloaded.
/**
 * The bar's state from /api/update: null (nothing to offer), offered (the host has not started on
 * it), downloading, download-failed, ready, waiting (pressed; switches once downloaded and no chat
 * is working), installing or failed.
 */
export function offerState(update, pressedAt = 0, now = Date.now()) {
  const available = update?.available;
  if (!available) return null;
  const host = update.status?.state;
  if (host === "failed") return "failed";
  if (host === "installing") return "installing";
  // Pressed here (or a moment ago: the host has not picked the request up yet).
  if (update.requested || (pressedAt && now - pressedAt < 3 * 60_000)) return "waiting";
  if (host === "downloading" || host === "ready" || host === "download-failed") return host;
  return "offered";
}

const fa = (n, opts) => Number(n).toLocaleString("fa-IR", opts);
const minutes = (sec) => `${fa(Math.max(1, Math.ceil(sec / 60)))} دقیقه`;

/** When this install switches by itself, in one Persian sentence, from the host's policy and what is going on now. */
export function autoLine(update) {
  const policy = update?.policy;
  const live = update?.live;
  if (!policy) return t("با دکمهٔ «اعمال» همین حالا می‌توانید بگیرید.");
  if (!policy.auto) return t("اعمال خودکار برای این نصب خاموش است؛ با دکمهٔ «اعمال» بگیرید.");
  if (policy.autoFailed) return t("قبلاً خودکار نصب نشد و دوباره امتحان نمی‌شود؛ با دکمهٔ «اعمال» دوباره امتحان کنید.");
  if (live?.active > 0) return `خودکار اعمال می‌شود، وقتی هیچ گفتگویی در حال کار نباشد (الان ${fa(live.active)} گفتگو باز است).`;
  if (live?.quietSec != null && policy.quietSec && live.quietSec < policy.quietSec) {
    return `خودکار اعمال می‌شود، وقتی ${minutes(policy.quietSec)} هیچ فعالیتی نباشد (الان ${fa(Math.floor(live.quietSec / 60))} دقیقه بی‌فعالیت؛ ${minutes(policy.quietSec - live.quietSec)} دیگر).`;
  }
  if (policy.gapLeftSec > 0) return `خودکار اعمال می‌شود؛ چون تازه یک آپدیت گرفته‌اید، ${minutes(policy.gapLeftSec)} دیگر.`;
  return t("چند لحظهٔ دیگر خودکار اعمال می‌شود.");
}

/**
 * What the sidebar item says right now: `label` (the step) and `sub` (what happens next, or what it
 * is waiting for), so it is never just «در حال اعمال آپدیت…».
 */
export function describeUpdate(update, state) {
  const live = update?.live;
  const size = formatSize(update?.status?.size);
  switch (state) {
    case "offered":
      return { label: t("آپدیت جدید"), sub: t("هنوز دانلود نشده؛ تا یک دقیقهٔ دیگر در پس‌زمینه شروع می‌شود.") };
    case "downloading":
      return { label: t("در حال دانلود آپدیت…"), sub: `${size ? `${size}؛ ` : ""}${autoLine(update)}` };
    case "download-failed":
      return { label: t("آپدیت جدید (دانلود نشد)"), sub: t("دانلود ناموفق بود؛ چند دقیقهٔ دیگر خودش دوباره امتحان می‌کند.") };
    case "ready":
      return { label: t("آپدیت دانلود شد"), sub: autoLine(update) };
    case "waiting": {
      if (update?.status?.state === "downloading") return { label: t("ری‌استارت ثبت شد"), sub: `منتظر تمام شدن دانلود${size ? ` (${size})` : ""}؛ بعدش بلافاصله اعمال می‌شود.` };
      if (live?.working > 0) return { label: t("ری‌استارت ثبت شد"), sub: `منتظر پایان ${fa(live.working)} گفتگوی در حال کار؛ به‌محض اینکه تمام شوند اعمال می‌شود.` };
      return { label: t("ری‌استارت ثبت شد"), sub: t("کسی در حال کار نیست؛ تا یک دقیقهٔ دیگر اعمال می‌شود.") };
    }
    case "installing":
      return { label: t("در حال نصب نسخهٔ تازه…"), sub: t("ری‌استارت و بررسی سالم بودن (تا ۲ دقیقه). اگر سالم بالا نیاید خودش برمی‌گردد. صفحه خودش تازه می‌شود.") };
    case "failed":
      return { label: t("آپدیت نصب نشد"), sub: t("نسخهٔ تازه سالم بالا نیامد و نسخهٔ قبلی برگشت (چیزی از دست نرفته). «اعمال» دوباره امتحان می‌کند.") };
    default:
      return { label: "", sub: "" };
  }
}

/** «۲۸۴ مگابایت»; nothing for an unknown size. */
export function formatSize(bytes) {
  const b = Number(bytes) || 0;
  if (!b) return "";
  if (b >= 1024 ** 3) return `${fa(b / 1024 ** 3, { maximumFractionDigits: 1 })} گیگابایت`;
  if (b >= 1024 ** 2) return `${fa(Math.round(b / 1024 ** 2))} مگابایت`;
  return `${fa(Math.max(1, Math.round(b / 1024)))} کیلوبایت`;
}

/** A date in the owner's calendar, e.g. «۲۶ مهر، ۱۴:۰۵»; empty when unknown. */
/** The changes grouped by the day they were made (newest first, as given): [{ day, items }]. */
export function byDay(changes) {
  const out = [];
  for (const c of changes || []) {
    const d = c.at ? new Date(c.at) : null;
    const day = d && !Number.isNaN(d.getTime()) ? d.toLocaleDateString("fa-IR", { weekday: "long", day: "numeric", month: "long" }) : t("بدون تاریخ");
    if (out.at(-1)?.day === day) out.at(-1).items.push(c);
    else out.push({ day, items: [c] });
  }
  return out;
}

export function formatWhen(iso) {
  const d = iso ? new Date(iso) : null;
  if (!d || Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("fa-IR", { day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" });
}
