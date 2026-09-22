// Suggestion pools: how a human would ask. Agents diagnose and route; never name tools/agents.

const GRIFFIN = [
  { title: "فروش ربع‌ساعت اخیر افت کرده", prompt: "چرا فروش در یک ربع اخیر افت کرده؟ بفهم کجای مسیر مشکل است و خلاصه بگو چه کار کنیم." },
  { title: "مسئلهٔ یک کاربر", prompt: "می‌خوام مسئلهٔ یک کاربر را بررسی کنی. اول بپرس کدوم کاربر / چه نشانه‌ای دیده، بعد تشخیص بده و پیگیری کن." },
  { title: "آپلود فایل کار نمی‌کند", prompt: "کاربرها می‌گویند آپلود فایل کار نمی‌کند. از مسیر کاربر تا ذخیره‌سازی را چک کن و علت محتمل را بگو." },
  { title: "سایت امروز کند شده", prompt: "سایت امروز کند شده. بفهم کندی از لبه/CDN است یا از سرویس پشتش، و نتیجه را ساده بگو." },
  { title: "پرداخت یا نوبت گیر کرده", prompt: "کاربر می‌گه پرداخت یا گرفتن نوبت گیر کرده. مسیر را عیب‌یابی کن و بگو مشکل کجاست." },
  { title: "گزارش وضعیت امروز", prompt: "یک گزارش کوتاه از وضعیت امروز بده: چیزهایی که واقعاً روی کاربر یا فروش اثر گذاشته، نه جزئیات فنی بی‌ربط." },
];

const PLATFORM = [
  { title: "فروش امروز عجیب است", prompt: "فروش امروز نسبت به دیروز و هفتهٔ گذشته چطور بوده؟ اگر افت دارد بگو از کجا می‌آید." },
  { title: "آپلود عکس خطا می‌دهد", prompt: "آپلود عکس در یکی از اپ‌ها خطا می‌دهد. مسیر اپ تا دیتابیس و ذخیره‌سازی را چک کن و علت را بگو." },
  { title: "سرویس برای کاربر می‌افتد", prompt: "یک سرویس برای کاربرها می‌افتد یا خطا می‌دهد. بفهم کدام پاد/سرویس خراب است و چرا." },
  { title: "فضا تمام شده؟", prompt: "نگرانم فضای ذخیره‌سازی پر شده باشد و آپلود یا لاگ‌ها را بشکند. وضعیت را بگو و اگر نزدیک پر شدن است علامت بزن." },
  { title: "دیپلوی اخیر خراب کرده", prompt: "بعد از یک تغییر/دیپلوی اخیر چیزی خراب شده. بفهم چه چیزی عوض شده و اثرش روی سرویس چیست." },
  { title: "هشدارهای مهم امروز", prompt: "از هشدارها و رویدادهای امروز فقط چیزهایی را بگو که روی کاربر یا پایداری اثر دارد." },
];

const ARVAN = [
  { title: "سایت برای کاربر باز نمی‌شود", prompt: "کاربر می‌گه سایت باز نمی‌شود. اول بپرس کدام دامنه، بعد بگو مشکل از لبه است یا باید origin را چک کنیم." },
  { title: "محتوای کهنه می‌بیند", prompt: "کاربر نسخهٔ قدیمی سایت را می‌بیند؛ احتمالاً کش. بگو چه کار کنیم و اگر لازم است دامنه را بپرس." },
  { title: "گواهی یا قفل مرورگر", prompt: "روی یک دامنه هشدار امنیتی/گواهی می‌آید. وضعیت TLS را چک کن؛ اول بپرس کدام دامنه." },
  { title: "دامنه‌های روی CDN", prompt: "چه دامنه‌هایی الان روی CDN ما هستند؟ فهرست کوتاه بده." },
  { title: "کندی فقط از بیرون", prompt: "از بیرون سایت کند است ولی از داخل شبکه بهتر است. لبه و DNS را چک کن و بگو علت محتمل چیست." },
  { title: "بعد از تغییر DNS خراب شد", prompt: "بعد از تغییر DNS یا دامنه چیزی خراب شده. رکوردها و لبه را بررسی کن؛ اول بپرس کدام دامنه." },
];

const NSIN = [
  { title: "دامنه‌های NSIN", prompt: "دامنه‌هایی که روی NSIN داریم را لیست کن." },
  { title: "سایت از بیرون باز نمی‌شود", prompt: "از بیرون سایت باز نمی‌شود. اول بپرس کدام دامنه، بعد آپ‌تایم لبه و SSL و DNS را در NSIN چک کن." },
  { title: "رنج لبهٔ NSIN", prompt: "رنج IPهای لبهٔ NSIN الان چیست؟ خلاصه بگو." },
  { title: "ترافیک ۲۴ساعت", prompt: "خلاصهٔ ترافیک ۲۴ساعت اخیر یک دامنه روی NSIN را بگو؛ اول بپرس کدام دامنه." },
  { title: "کش کهنه بعد از دیپلوی", prompt: "بعد از دیپلوی کش کهنه است؛ مسیر پاک‌سازی روی NSIN را پیشنهاد بده و اگر لازم است دامنه/مسیر را بپرس." },
  { title: "هم‌خوانی با میکروتیک", prompt: "رنج‌های منتشرشدهٔ NSIN با address-list لبه روی میکروتیک یکی است؟ اگر نه، اختلاف را بگو." },
];

const POOLS = {
  griffin: GRIFFIN,
    platform: PLATFORM,
  "arvan-ban": ARVAN,
  "nsin-ban": NSIN,
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
