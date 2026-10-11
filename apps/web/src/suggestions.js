// Suggestion pools: how a person would ask. Agents decide how; never name tools or agents.
import { t } from "./i18n.js";

const GRIFFIN = [
  { title: t("چه کارهایی از دستت برمی‌آید؟"), prompt: t("بگو با ایجنت‌ها و ابزارهایی که الان داری چه کارهایی از دستت برمی‌آید، با چند مثال کوتاه.") },
  { title: t("یک گزارش هفتگی بساز"), prompt: t("یک جاب هفتگی بساز که هر دوشنبه صبح خلاصهٔ هفتهٔ قبل را برایم بفرستد. اول بپرس از کجا بخوانی و کجا بفرستی.") },
  { title: t("یک متن را خلاصه کن"), prompt: t("می‌خواهم یک متن یا فایل را خلاصه کنی. اول بپرس کدام، بعد نکته‌های اصلی و کارهای لازم را جدا بگو.") },
  { title: t("یک ایجنت تازه بسازیم"), prompt: t("کمکم کن یک ایجنت تازه بسازم: اول بپرس قرار است چه کاری کند، بعد دستورالعمل، ابزارها و اینکه چه کسی بتواند صدایش بزند را پیشنهاد بده.") },
  { title: t("یک پیام بنویس"), prompt: t("کمکم کن یک پیام کوتاه و مؤدبانه بنویسم. اول بپرس برای چه کسی و دربارهٔ چه.") },
  { title: t("برنامهٔ این هفته"), prompt: t("کمکم کن کارهای این هفته را اولویت‌بندی کنم. فهرست را از من بگیر و یک برنامهٔ ساده پیشنهاد بده.") },
];

const RESEARCHER = [
  { title: t("دو گزینه را مقایسه کن"), prompt: t("دو گزینه را برایم مقایسه کن. اول بپرس کدام‌ها و چه معیاری برایم مهم است، بعد نتیجه را با منبع بگو.") },
  { title: t("دربارهٔ یک موضوع توجیهم کن"), prompt: t("دربارهٔ یک موضوع یک خلاصهٔ یک‌صفحه‌ای بده: چه می‌دانیم، چه نمی‌دانیم و منبع هر ادعا. اول بپرس کدام موضوع.") },
  { title: t("ادعا را بسنج"), prompt: t("یک ادعا را برایم بسنج. بگو منابع چه می‌گویند و چقدر مطمئنی؛ حدس را جدا از یافته بگو.") },
  { title: t("یادداشت‌ها را مرور کن"), prompt: t("یادداشت‌های ذخیره‌شده را مرور کن و بگو چه چیزهایی تکراری، کهنه یا متناقض‌اند.") },
];

const WRITER = [
  { title: t("متنم را ویرایش کن"), prompt: t("متنی را که می‌فرستم روان و کوتاه‌تر کن، بدون تغییر معنی. آخرش در سه خط بگو چه عوض شد.") },
  { title: t("ترجمه کن"), prompt: t("متنی را که می‌فرستم ترجمه کن و لحنش را حفظ کن. اول بپرس به چه زبانی.") },
  { title: t("یک ایمیل بنویس"), prompt: t("یک ایمیل کوتاه بنویس. اول بپرس برای چه کسی، دربارهٔ چه و با چه لحنی.") },
  { title: t("خلاصه برای مدیر"), prompt: t("این متن را به یک خلاصهٔ پنج‌خطی برای یک مدیر پرمشغله تبدیل کن: نتیجه اول، بعد تصمیم‌هایی که لازم است.") },
];

const ASSISTANT = [
  { title: t("پیام‌های امروز را خلاصه کن"), prompt: t("پیام‌های امروز را مرور کن و فقط چیزهایی را بگو که جواب یا کار از من می‌خواهند.") },
  { title: t("یادآوری بساز"), prompt: t("یک یادآوری زمان‌بندی‌شده برایم بساز. اول بپرس کی و دربارهٔ چه.") },
  { title: t("این را به خاطر بسپار"), prompt: t("چیزی را که می‌گویم در یادداشت‌ها نگه دار تا بعداً بپرسم؛ رمز و توکن هرگز.") },
  { title: t("جواب یک پیام"), prompt: t("کمکم کن به یک پیام جواب بدهم. پیام را بخوان، یک پیش‌نویس کوتاه بده و فقط وقتی گفتم بفرست.") },
];

const PLATFORM = [
  { title: t("الان چه چیزی خراب است؟"), prompt: t("وضعیت سیستم‌هایی را که به آن‌ها دسترسی داری چک کن و فقط چیزهایی را بگو که روی کاربرها اثر دارد.") },
  { title: t("فضا تمام می‌شود؟"), prompt: t("نگرانم فضای ذخیره‌سازی پر شود. وضعیت را بگو و اگر چیزی نزدیک پر شدن است علامت بزن.") },
  { title: t("بعد از دیپلوی خراب شد"), prompt: t("بعد از یک تغییر یا دیپلوی اخیر چیزی خراب شده. بفهم چه عوض شده و اثرش چیست.") },
  { title: t("هشدارهای مهم امروز"), prompt: t("از هشدارهای امروز فقط چیزهایی را بگو که واقعاً روی کاربر یا پایداری اثر دارند.") },
];

const CDN = [
  { title: t("سایت باز نمی‌شود"), prompt: t("یک سایت برای کاربر باز نمی‌شود. اول بپرس کدام دامنه، بعد بگو مشکل از لبه است یا از سرور اصلی.") },
  { title: t("محتوای کهنه می‌بینند"), prompt: t("کاربرها نسخهٔ قدیمی سایت را می‌بینند. بگو چه کار کنیم؛ اگر لازم است دامنه را بپرس.") },
  { title: t("هشدار گواهی"), prompt: t("روی یک دامنه هشدار گواهی می‌آید. وضعیت TLS را چک کن؛ اول بپرس کدام دامنه.") },
  { title: t("دامنه‌های روی CDN"), prompt: t("چه دامنه‌هایی الان روی CDN هستند؟ فهرست کوتاه بده.") },
];

const POOLS = {
  griffin: GRIFFIN,
  researcher: RESEARCHER,
  writer: WRITER,
  assistant: ASSISTANT,
  platform: PLATFORM,
  "arvan-ban": CDN,
  "nsin-ban": CDN,
};

function daySeed(extra = "") {
  const d = new Date();
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}-${d.getHours()}-${extra}`;
}

function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function shuffle(list, seed) {
  const out = [...list];
  let s = hash(seed);
  for (let i = out.length - 1; i > 0; i -= 1) {
    s = (Math.imul(s, 48271) + 11) >>> 0;
    const j = s % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** Pick a rotating subset; optionally prefer titles that look related to recent chats. */
export function pickSuggestions(agentId, { count = 4, recentTitles = [], salt = "" } = {}) {
  const pool = POOLS[agentId] || POOLS.griffin;
  const seed = daySeed(`${agentId}:${salt}`);
  const ranked = shuffle(pool, seed);
  if (recentTitles.length) {
    const lowered = recentTitles.map((t) => String(t).toLowerCase());
    ranked.sort((a, b) => {
      const score = (item) => lowered.some((t) => t.includes(item.title.slice(0, 8).toLowerCase()) || item.title.toLowerCase().includes(t.slice(0, 8))) ? 1 : 0;
      return score(b) - score(a);
    });
  }
  return ranked.slice(0, count);
}
