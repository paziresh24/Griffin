import { t } from "./i18n.js";
// Plain-language helpers for a tool card's opened body. A tool without its own body used to show
// `{args, result}` as raw JSON; now each field gets a Persian label and its natural shape (a short
// value inline, long text in a box, a list of records as a table, a link as a link).

const LABELS = {
  path: t("مسیر"), old: t("متن قبلی"), new: t("متن جدید"), all: t("همهٔ موارد"), replaced: t("تعداد جایگزینی"), written: t("حجم نوشته‌شده (بایت)"),
  content: t("محتوا"), text: t("متن"), lines: t("تعداد خط"), shown: t("خطوط نمایش‌داده‌شده"), files: t("فایل‌ها"), total: t("مجموع"), truncated: t("بریده شده"),
  output: t("خروجی"), error: t("خطا"), ok: t("موفق"), status: t("وضعیت"), state: t("وضعیت"), message: t("پیام"), name: t("نام"), title: t("عنوان"),
  description: t("توضیح"), project: t("پروژه"), repo: t("ریپو"), branch: t("شاخه"), worktree: t("پوشهٔ کار"), cluster: t("کلاستر"), namespace: "namespace",
  domain: t("دامنه"), host: t("میزبان"), url: t("نشانی"), command: t("دستور"), query: t("جستجو"), search: t("جستجو"), pattern: t("الگو"), id: t("شناسه"),
  chat: t("گفتگو"), chatId: t("شناسهٔ گفتگو"), args: t("آرگومان‌ها"), mrTitle: t("عنوان MR"), mrDescription: t("شرح MR"), mrUrl: t("لینک MR"),
  request: t("درخواست"), agent: t("ایجنت"), action: t("اقدام"), type: t("نوع"), value: t("مقدار"), summary: t("خلاصه"), note: t("یادداشت"), count: t("تعداد"),
  source: t("منبع"), ms: t("زمان (میلی‌ثانیه)"), bytes: t("حجم (بایت)"), size: t("اندازه"), enabled: t("فعال"), schedule: t("زمان‌بندی"),
  prompt: t("دستور کار"), label: t("برچسب"), reason: t("دلیل"), provider: t("موتور"), model: t("مدل"), limit: t("سقف"), offset: t("از خط"), version: t("نسخه"),
  matches: t("نتایج"), items: t("موارد"), results: t("نتایج"), records: t("رکوردها"), rows: t("ردیف‌ها"), columns: t("ستون‌ها"), tools: t("ابزارها"),
  email: t("ایمیل"), user: t("کاربر"), username: t("نام کاربری"), role: t("نقش"), person: t("فرد"), thread: t("رشته"), iid: t("شمارهٔ MR"), ref: t("نسخه/شاخه"),
  from: t("از"), to: t("به"), sha: t("شناسهٔ کامیت"), created: t("ساخته شد"), updated: t("به‌روز شد"), deleted: t("حذف شد"), cancelled: t("لغو شد"),
  token: t("توکن"), key: t("کلید"), env: t("محیط"), environment: t("محیط"), folder: t("پوشه"), folders: t("پوشه‌ها"), secrets: t("کلیدها"),
  ignoreCase: t("بی‌توجه به بزرگی حروف"), durationMs: t("مدت (میلی‌ثانیه)"), exitCode: t("کد خروج"), stdout: t("خروجی"), stderr: t("خروجی خطا"),
  emoji: t("ایموجی"), period: t("بازه"), range: t("بازه"), router: t("روتر"), address: t("آدرس"), list: t("فهرست"), port: t("پورت"), publicPort: t("پورت عمومی"),
  toAddress: t("آدرس مقصد"), toPort: t("پورت مقصد"), ttl: "TTL", cloud: t("پشت CDN"), scope: t("دامنهٔ اثر"), kind: t("نوع منبع"), pod: t("پاد"),
  container: t("کانتینر"), database: t("پایگاه‌داده"), sql: t("دستور SQL"), write: t("نوشتنی"), rowCount: t("تعداد ردیف"), hint: t("راهنما"),
};

export function keyLabel(key) {
  return LABELS[key] || String(key);
}

export function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isScalar(value) {
  return value === null || ["string", "number", "boolean"].includes(typeof value);
}

// A value that must sit in its own box: multi-line or long text.
export function isLongText(value) {
  return typeof value === "string" && (value.includes("\n") || value.length > 140);
}

export function isUrl(value) {
  return typeof value === "string" && /^https?:\/\/\S+$/.test(value);
}

// The text of one short value: yes/no for booleans, nothing for empty ones.
export function scalarText(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "boolean") return value ? t("بله") : t("خیر");
  return String(value);
}

// A field worth showing: not missing and not blank.
export function hasValue(value) {
  return value !== undefined && value !== null && value !== "";
}

// Facts of an object in display order: only fields that hold something.
export function factEntries(data) {
  return isRecord(data) ? Object.entries(data).filter(([, value]) => hasValue(value)) : [];
}
