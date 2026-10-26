import { genv, setConfigOverrides } from "./env.mjs";

// Settings that used to need an env edit and a redeploy; setting up should never need leaving the UI
// or the CLI. Each one is still read through genv(), so the env stays the fallback; a
// value set here (kv "config") wins. live:false ones are read once at start — the UI says so and
// offers a restart. Paths, ports and the broker socket stay deploy-time on purpose, and so do
// OWNER_NAME and TZ (read while modules load, before this store exists).
export const CONFIG_SCHEMA = [
  { key: "PRODUCT", label: "نام محصول در عنوان صفحه، ظاهر پیش‌فرض مرورگر تازه و {product} در امضا: griffin = گریفین (پیش‌فرض)؛ karsara = کارسرا", options: ["griffin", "karsara"], live: true },
  { key: "SIGNATURE", label: "امضای زیر پیام‌هایی که دستیار می‌فرستد (پیش‌فرض: «— نام دستیار»). {name} = نام دستیار، {owner} = نام شما، {product} = نام محصول؛ مثلاً «— {name}، دستیارِ {owner} · {product}»", live: true },
  { key: "OWNER_INFISICAL_PROJECTS", label: "پروژه‌های Infisical خود شما (نام یا شناسه، با ویرگول). خواندن و نوشتن سکرت در هر پروژهٔ دیگری اول از شما تأیید می‌گیرد؛ خالی = همهٔ پروژه‌ها", live: true },
  { key: "SETUP_ACCESS", label: "برای پرامپت راه‌اندازی: دسترسی‌ها کجاست (بدون رمز). مثلاً «شل سرور و توکن owner در Infisical پروژهٔ x، prod، مسیر /setup: کلیدهای HOST/USER/PASSWORD و OWNER_TOKEN»", live: true },
  { key: "PUBLIC_URL", label: "آدرس عمومی (لینک‌های نمودار/فایل در پیام‌رسان‌ها)", live: false },
  { key: "OPS_MODE", label: "اتاق عملیات هشدارها", options: ["off", "record", "critical", "shadow"], live: false },
  { key: "WORKTREE_LINK", label: "فایل‌های ignore‌شدهٔ ریپو (مثل .env یا p24.db) که در worktree هر گفتگوی تازه به‌صورت لینک از پوشهٔ اصلی ریپو آورده شوند، مثل کارسرا؛ با ویرگول. ریپو هم می‌تواند فایل .worktreeinclude داشته باشد. فقط فایل‌هایی که git نادیده می‌گیرد", live: true },
  { key: "SELF_HEAL", label: "تعمیر خودکار هر ۱۵ دقیقه", options: ["on", "off"], live: false },
  { key: "REVIEW", label: "بازبینی دوگانهٔ تغییرها قبل از اجرا", options: ["on", "off"], live: true },
  { key: "AUTO_CONTINUE", label: "ادامهٔ خودکار گفتگو بعد از بازشدن سقف مصرف (حداکثر سه بار پشت هم؛ هر پیام شما لغوش می‌کند؛ پیش‌فرض روشن)", options: ["on", "off"], live: true },
  { key: "PLAN_FALLBACK", label: "وقتی سقف پلن یک موتور پر شد: auto = گفتگو خودش به موتور بعدی می‌رود (پیش‌فرض)؛ ask = در گفتگوهای خود شما اول با یک کارت می‌پرسد و تا جواب ندهید عوض نمی‌شود. گفتگوی همکاران و جاب‌ها همیشه خودشان می‌روند", options: ["ask", "auto"], live: true },
  { key: "ACCOUNT_BALANCE", label: "پخش گفتگوها بین اکانت‌های Claude: هر گفتگوی تازه روی اکانتی شروع می‌شود که بیشترین سهم مانده را دارد و همان‌جا می‌ماند؛ فقط وقتی اکانتش پر شود یا از ۸۵٪ بگذرد و اکانت دیگری خیلی خالی‌تر باشد جابه‌جا می‌شود (پیش‌فرض روشن). off = ترتیب ثابت قبلی", options: ["on", "off"], live: true },
  { key: "CLICK_MAP", label: "نقشهٔ کلیک‌ها: شمارش اینکه کجای صفحه کلیک می‌شود (فقط نام دکمه و بخش، هرگز متن پیام)، کلیک‌های بی‌اثر و دکمه‌های غیرفعال؛ هر ساعت به نصب نگه‌دارنده می‌رود تا پراستفاده‌ترین و بی‌استفاده‌ترین بخش‌ها پیدا شوند (پیش‌فرض روشن)", options: ["on", "off"], live: true },
  { key: "PROMPT_SUGGESTIONS", label: "پیشنهاد پیام بعدی در کادر (فقط Claude؛ Tab برای پذیرفتن؛ هر پیشنهاد کمی از سهم مصرف می‌برد؛ پیش‌فرض روشن)", options: ["on", "off"], live: true },
  { key: "PRIVATE_SHARE", label: "اشتراکِ خصوصیِ یک گفتگو با یک نفر از راهِ تلگرامِ شما: دعوت و کدِ یک‌بارمصرف به تلگرامِ او می‌رود، فقط روی یک دستگاه باز می‌شود، می‌خواند و یادداشت می‌گذارد و هر وقت بخواهید بسته می‌شود (به اکانت تلگرامِ وصل نیاز دارد؛ پیش‌فرض روشن). خاموش‌کردن لینک‌های ساخته‌شده را متوقف می‌کند ولی نمی‌بندد: با روشن‌کردنِ دوباره برمی‌گردند، مگر آن‌ها را از منوی اشتراک بسته باشید", options: ["on", "off"], live: true },
  { key: "NETWORK", label: "شبکهٔ ایجنت‌ها: این نصب خودش را به ایجنت‌های همکاران معرفی کند و با آن‌ها حرف بزند (پیش‌فرض روشن). off برای نصب آزمایشی کنار نصب اصلی همان شخص، تا کار همکاران دو جا اجرا نشود", options: ["on", "off"], live: true },
  { key: "SIDE_CHAT", label: "چت کناری کنار گفتگوهای شما (پیش‌فرض روشن)", options: ["on", "off"], live: true },
  { key: "NEXT_STEP_RETURNS", label: "پیشنهادِ پیامِ بعدی وقتی جعبهٔ پیام خالی شد دوباره نشان داده شود (مثل Claude Code؛ پیش‌فرض خاموش: با تایپ کنار می‌رود)", options: ["off", "on"], live: true },
  { key: "CLAUDE_CODE", label: "Claude Code کامل در گفتگوهای خود شما: ترمینال (Bash)، تنظیمات، مهارت‌ها و MCPهای شخصی، کنار ابزارهای گریفین (فقط موتور Claude؛ گفتگوی همکاران هرگز؛ جاب‌ها فقط با گزینهٔ «جاب‌های خود شما»؛ پیش‌فرض روشن)", options: ["on", "off"], live: true },
  { key: "CLAUDE_FABLE", label: "مدل Fable در فهرست مدل‌های Claude، بعد از Opus (اگر طرح Claude شما Fable دارد؛ پیش‌فرض خاموش)", options: ["off", "on"], live: true },
  { key: "CLAUDE_HOST", label: "Claude Code کامل کجا اجرا شود: off = داخل کانتینر گریفین (پیش‌فرض)؛ owner = گفتگوهای خود شما روی خود سرور با کاربر شما (کلید SSH، kubectl، gh، git، مهارت‌ها، CLAUDE.md و حافظهٔ شما، مثل Claude دسکتاپ)؛ owner+jobs = جاب‌های خود شما هم. بخش‌های دیگر (همکاران، ایجنت همکاران، اتاق عملیات، میز تلگرام) ترمینال ندارند و همیشه در کانتینر می‌مانند. فقط وقتی Claude Code کامل روشن است و سرور برای آن آماده شده (GRIFFIN_CLAUDE_HOST_TARGET)", options: ["off", "owner", "owner+jobs"], live: true },
  { key: "CLAUDE_BACKGROUND_TASKS", label: "کارهای پس‌زمینهٔ Claude Code (ترمینال یا ایجنتی که در پس‌زمینه اجرا شده) بعد از پایان پاسخ هم ادامه دهند؛ هر کدام در گفتگو با دکمهٔ توقف خودش دیده می‌شود و نتیجه‌اش به پیام بعدی می‌رسد؛ با بایگانی یا حذف گفتگو متوقف می‌شوند (فقط وقتی Claude Code کامل روشن است؛ برای چت‌های تازه یا بعد از ری‌استارت؛ پیش‌فرض روشن)", options: ["on", "off"], live: true },
  { key: "CLAUDE_STEER", label: "پیامی که وسط کار Claude Code می‌فرستید همان لحظه به همان پاسخ برسد، نه بعد از تمام شدنش (فقط وقتی Claude Code کامل و «کارهای پس‌زمینه» روشن‌اند؛ برای چت‌های تازه یا بعد از ری‌استارت؛ پیش‌فرض روشن)", options: ["on", "off"], live: true },
  { key: "STATE_GUARD", label: "با Claude Code کامل، ترمینال (Bash) و هر ابزار دیگر هم نتواند در انبار دانش و پوشهٔ داده (توکن مالک، کلید رمزها، پایگاه داده) بنویسد؛ خواندن آزاد است (پیش‌فرض خاموش؛ فقط وقتی Claude Code کامل روشن است)", options: ["on", "off"], live: true },
  { key: "TELEGRAM_INSTRUCTION_GUARD", label: "گفتگویی که از پیام تلگرامِ کس دیگری ساخته شده نتواند فایل‌های دستورالعمل شما را بنویسد (CLAUDE.md، تنظیمات، حافظه، مهارت‌ها، hookها، core.md)؛ Saved Messages و ربات خودتان آزادند (پیش‌فرض روشن؛ فقط وقتی Claude Code کامل روشن است)", options: ["on", "off"], live: true },
  { key: "OWNER_CHAT_TOOLS", label: "ابزارهای چت‌به‌چت در گفتگوهای خود شما: فهرست و خواندن چت‌ها، پیام به چت دیگر (زنجیره تا دو قدم)، زنگ به گوشی (دقیقه‌ای یک بار)؛ همکاران و جاب‌ها هرگز؛ پیش‌فرض روشن", options: ["on", "off"], live: true },
  { key: "TELEGRAM_LEDGER", label: "دفتر ارسال تلگرام: هر پیامی که از حساب تلگرام شما فرستاده می‌شود با نام چتی که فرستاده ثبت شود، تا جواب طرف به همان چت برگردد؛ فقط گفتگوهای خود شما آن را می‌خوانند (پیش‌فرض روشن)", options: ["on", "off"], live: true },
  { key: "PLAN_APPROVAL", label: "حالت برنامه در گفتگوهای خود شما (Claude): برنامه با کارت سؤال به شما (و تلگرام) می‌رسد و با «Approve plan» یا تایپ دقیق «برو / تأیید / مرج کن / go / approve» گفتگو به حالت اجرا می‌رود؛ برای گفتگوی تازه یا بعد از راه‌اندازی دوباره اعمال می‌شود؛ پیش‌فرض روشن", options: ["on", "off"], live: true },
  { key: "TELEGRAM_FILES", label: "فایل‌ها و نمودارهای یک پاسخ هم به تلگرام و بله فرستاده شوند؛ off = فقط متن پاسخ (پیش‌فرض روشن)", options: ["on", "off"], live: true },
  { key: "CHAT_SEARCH_MESSAGES", label: "جستجوی کنار صفحه متن پیام‌ها و پاسخ‌ها را هم بگردد، نه فقط عنوان گفتگو (پیش‌فرض خاموش)", options: ["off", "on"], live: true },
  { key: "TELEGRAM_DM_MODE", label: "پیام خصوصی همکاران در تلگرام: assistant = دستیار شما به جای شما جواب می‌دهد (چت مادر هر نفر؛ پیش‌فرض)؛ inbox = هر پیام به یک چت «Telegram inbox» می‌رود که جواب را به همان چتی که پیام را فرستاده بود برمی‌گرداند یا موضوع تازه را به‌صورت پیشنهاد چت نشان می‌دهد؛ بدون شما چیزی برای همکار فرستاده نمی‌شود. دفتر ارسال در این حالت خودبه‌خود روشن است.", options: ["assistant", "inbox"], live: true },
  { key: "TEAM_PROVIDER", label: "رشته‌های همکاران: حساب موتور", kind: "account", live: true },
  { key: "TEAM_MODEL", label: "رشته‌های همکاران: مدل", live: true },
  { key: "TEAM_EFFORT", label: "رشته‌های همکاران: میزان فکر", options: ["", "low", "medium", "high", "xhigh", "max"], live: true },
  { key: "PEER_PROVIDER", label: "ایجنت‌های همکاران روی شبکه: حساب موتور (خالی = مثل پروفایل ایجنت)", kind: "account", live: true },
  { key: "PEER_MODEL", label: "ایجنت‌های همکاران روی شبکه: مدل شروع", live: true },
  { key: "PEER_EFFORT", label: "ایجنت‌های همکاران روی شبکه: میزان فکر", options: ["", "low", "medium", "high", "xhigh", "max"], live: true },
  { key: "UPGRADE_MODEL", label: "مدل قوی‌تری که گفتگوی همکار (تلگرام یا ایجنتش) اگر پیام واقعاً کار بود خودش به آن می‌رود — همان نوبت و همان session؛ پیام بعدی دوباره با مدل شروع (مثلاً opus؛ خالی = خاموش، فقط حساب‌های Claude)", live: true },
  { key: "UPGRADE_EFFORT", label: "میزان فکر بعد از ارتقا (خالی = پیش‌فرض مدل)", options: ["", "low", "medium", "high", "xhigh", "max"], live: true },
  { key: "TEAM_SUB_PROVIDER", label: "زیرکارهای رشتهٔ همکار: حساب موتور", kind: "account", live: true },
  { key: "TEAM_SUB_MODEL", label: "زیرکارهای رشتهٔ همکار: مدل", live: true },
  { key: "FALLBACK_CLAUDE_MODEL", label: "مدل جایگزین Claude وقتی موتور OpenAI-compatible پر شد", live: true },
  { key: "TITLE_MODEL", label: "مدل ساختن عنوان چت", live: true },
  { key: "BACKUP_EVERY_HOURS", label: "بکاپ خودکار گفتگوها (کل پایگاه داده) هر چند ساعت یک بار (پیش‌فرض ۶؛ ۰ = خاموش)", live: true },
  { key: "BACKUP_KEEP", label: "تعداد بکاپ‌های آخر که نگه داشته می‌شود (پیش‌فرض ۸؛ جدا از آن، آخرین بکاپ هر روز تا ۷ روز می‌ماند)", live: true },
  { key: "BACKUP_DIR", label: "پوشهٔ بکاپ‌ها (پیش‌فرض backups داخل پوشهٔ داده؛ برای امنیت بیشتر یک دیسک یا mount دیگر بدهید)", live: true },
  { key: "CHAT_IDLE_DAYS", label: "بایگانی خودکار گفتگوی بی‌کار روی ریپو بعد از این چند روز (۰ = هرگز؛ پیش‌فرض ۳؛ بعد از ری‌استارت)", live: false },
  { key: "GIT_NAME", label: "نام شما برای کامیت‌ها (با GIT_EMAIL)؛ خالی = کامیت‌ها با نام دستیار", live: true },
  { key: "GIT_EMAIL", label: "ایمیل شما برای کامیت‌ها (با GIT_NAME)", live: true },
  { key: "GIT_BRANCH_PREFIX", label: "پیشوند شاخهٔ چت‌های تازه، مثلاً alice → alice/<id>؛ خالی = نام دستیار", live: true },
  { key: "DEFAULT_REPO", label: "ریپوی پیش‌فرض چت تازه", live: true },
  { key: "PEER_SELF_SERVE", label: "راهنمای «خودت انجام بده» برای ایجنت همکاران ({user} = شناسهٔ همکار)", multiline: true, live: true },
  { key: "WEB_SEARCH", label: "جستجوی وب و خواندن صفحه برای همهٔ موتورها (ابزارهای web_search و web_fetch؛ پیش‌فرض روشن). نتیجهٔ وب «حرف دیگران» حساب می‌شود و با آن نمی‌شود دانش را خودکار تأیید کرد", options: ["on", "off"], live: true },
  { key: "WEB_SEARCH_URL", label: "آدرس SearXNG خودتان برای جستجو، مثل https://searx.example.com/search (خالی = DuckDuckGo بدون کلید)", live: true },
  { key: "MODULES", label: "ماژول‌های روشن این نصب (پوشهٔ modules/): بخش‌های گریفین (تلگرام، جاب، حادثه‌ها، ایجنت‌های همکاران، میز کار) و بخش‌هایی مثل «مرج ریکوئست‌ها» هرکدام یک ماژول‌اند. خالی = پیش‌فرض محصول (گریفین یا کارسرا)؛ all = همه؛ «a,b» = دقیقاً همین‌ها؛ «default,-jobs,+mr-explainer» = پیش‌فرض، بدون جاب، با مرج ریکوئست‌ها. بعد از ری‌استارت اعمال می‌شود", live: false },
  { key: "PREVIEW", label: "پیش‌نمایش زندهٔ اپ‌ها در چت: ایجنت کد یا اپ را در سندباکس اجرا می‌کند و صفحه‌اش را همان‌جا نشان می‌دهد (ابزارهای preview_*؛ پیش‌فرض روشن)", options: ["on", "off"], live: true },
  { key: "PREVIEW_RUNNER", label: "پیش‌نمایش‌ها کجا اجرا شوند: auto = سندباکس، مگر نصب روی هاست باشد و سندباکس نداشته باشد (آن‌وقت روی خود ماشین با همان کاربر نصب)؛ sandbox = همیشه سندباکس؛ local = همیشه روی خود ماشین. بعد از ری‌استارت اعمال می‌شود", options: ["auto", "sandbox", "local"], live: false },
  { key: "BROWSER", label: "مرورگر واقعی برای ایجنت‌ها: Chromium با Playwright در سندباکس، برای تست سایت‌ها و کار با پنل‌هایی که API ندارند (ابزارهای browser_*؛ پیش‌فرض روشن)", options: ["on", "off"], live: true },
  { key: "PREVIEW_HOST", label: "نام میزبانِ جدا برای پیش‌نمایش‌ها (باید به همین سرور برسد و با PUBLIC_URL فرق کند). preview.example.com = یک میزبانِ جدا؛ صفحه مبدأ خودش را دارد و اپ‌هایی با آدرس‌های /assets/… درست کار می‌کنند (در Chrome؛ Safari کوکی درون‌قاب را نمی‌پذیرد). *.preview.example.com = برای هر پیش‌نمایش یک زیردامنه (نیاز به DNS و گواهی wildcard)، بهترین حالت. خالی = پیش‌نمایش روی همان میزبان و در قفص (sandbox)، فقط برای صفحه‌هایی با آدرس نسبی", live: true },
  { key: "STT_BASE_URL", label: "تبدیل صدا به متن: آدرس سرویس", live: true },
  { key: "STT_MODEL", label: "تبدیل صدا به متن: مدل", live: true },
  { key: "STT_LANGUAGE", label: "تبدیل صدا به متن: زبان", live: true },
];
const KEYS = new Set(CONFIG_SCHEMA.map((c) => c.key));

export function createConfig({ store }) {
  let cache = null;
  const read = () => {
    if (!cache) {
      try {
        cache = JSON.parse(store.getKv("config") || "{}") || {};
      } catch {
        cache = {};
      }
    }
    return cache;
  };
  setConfigOverrides(read);

  return {
    view() {
      const saved = read();
      return CONFIG_SCHEMA.map((c) => {
        const own = saved[c.key];
        return { ...c, value: own ?? "", effective: genv(c.key, "") || "", fromEnv: own === undefined && Boolean(genv(c.key, "")) };
      });
    },
    set(patch) {
      const next = { ...read() };
      const changed = [];
      for (const [key, value] of Object.entries(patch || {})) {
        if (!KEYS.has(key)) throw new Error(`unknown setting ${key}`);
        const text = value == null ? "" : String(value).trim().slice(0, 4000);
        const spec = CONFIG_SCHEMA.find((c) => c.key === key);
        if (text && spec.options && !spec.options.includes(text)) throw new Error(`${key} must be one of ${spec.options.filter(Boolean).join(", ")}`);
        if (text) next[key] = text;
        else delete next[key];
        changed.push(spec);
      }
      store.setKv("config", JSON.stringify(next));
      cache = next;
      return { restart: changed.some((c) => !c.live) };
    },
  };
}
