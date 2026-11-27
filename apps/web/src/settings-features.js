// Every setting of /api/config as a person reads it: a short title, a plain «?» text, where it lives and
// what it hangs on (owner 2026-11-01: «خیلی پیچیده ست… با جلوه‌های بصری و علامت ؟ به کاربرها بفهمونی»). The
// server's long label stays the fallback for a key with no row, but test/settings-features.test.mjs fails then:
// a new setting comes with its row here, a group and, when it is new, `since` (the «تازه» badge).
//   def       what the server does when nothing is set   requires  the key it depends on (drawn nested)
//   choices   more than on/off: value → label            since     the day it was added
//   restart   needs a restart                            when      "new": applies to new chats
//   careful   touches security, other people or stored data: a suggestion (settings-catalog.js) never
//             offers it in one click, it opens the row instead
import { t } from "./i18n.js";

/** Where each group is drawn: the section of Settings (settings-map.js) that shows its rows. */
export const FEATURE_GROUPS = [
  { id: "chat", label: t("گفتگو"), section: "chat" },
  { id: "tools", label: t("ابزارهای ایجنت"), section: "features" },
  { id: "claude", label: t("Claude Code و اکانت‌ها"), section: "features" },
  { id: "guard", label: t("حفاظت"), section: "features" },
  { id: "upkeep", label: t("نگهداری"), section: "features" },
  { id: "live", label: t("مرورگر سرور"), section: "browser" },
  { id: "identity", label: t("نام و آدرس"), section: "config" },
  { id: "git", label: t("گیت و ریپو"), section: "config" },
  { id: "models", label: t("مدل‌ها"), section: "config" },
  { id: "web", label: t("وب و پیش‌نمایش"), section: "config" },
  { id: "backup", label: t("بکاپ"), section: "config" },
  { id: "access", label: t("دسترسی و سیستم"), section: "config" },
  { id: "stt", label: t("تبدیل صدا به متن"), section: "chat" },
];

export const FEATURES = [
  { key: "PROMPT_SUGGESTIONS", group: "chat", title: t("پیشنهاد پیام بعدی"), help: t("بعد از هر جواب، پیام بعدی احتمالی شما پیشنهاد می‌شود و با Tab پذیرفته می‌شود. فقط روی Claude کار می‌کند و هر پیشنهاد کمی از سهم مصرف می‌برد."), def: "on" },
  { key: "NEXT_STEP_RETURNS", group: "chat", title: t("برگشتن پیشنهاد وقتی کادر خالی شد"), help: t("با تایپ کردن، پیشنهاد کنار می‌رود. این کلید روشن باشد، وقتی متن را پاک کنید دوباره نشان داده می‌شود؛ مثل Claude Code."), def: "off", requires: "PROMPT_SUGGESTIONS", since: "2026-10-15" },
  { key: "AUTO_CONTINUE", group: "chat", title: t("ادامهٔ خودکار بعد از سقف"), help: t("وقتی سقف مصرف باز شد، گفتگوی نیمه‌تمام خودش ادامه پیدا می‌کند؛ حداکثر سه بار پشت هم. هر پیامی از شما لغوش می‌کند."), def: "on" },
  { key: "PLAN_FALLBACK", group: "chat", title: t("وقتی سقف یک موتور پر شد"), help: t("خودکار: گفتگو خودش به موتور بعدی می‌رود. بپرس: در گفتگوهای خود شما اول یک کارت می‌آید و تا جواب ندهید عوض نمی‌شود. گفتگوی همکاران و جاب‌ها همیشه خودشان می‌روند."), def: "auto", choices: { "auto": t("خودکار برود"), "ask": t("اول بپرس") } },
  { key: "PLAN_APPROVAL", group: "chat", title: t("تأیید برنامه با کارت"), help: t("در حالت برنامه، برنامه با یک کارت به شما و تلگرام می‌رسد و با «Approve plan» یا نوشتن «برو»، «تأیید»، «مرج کن»، «go» یا «approve» گفتگو به حالت اجرا می‌رود؛ مثل کارسرا. فقط Claude. برای گفتگوی تازه یا بعد از راه‌اندازی دوباره اعمال می‌شود."), def: "on", when: "new" },
  { key: "ENTER_KEY", group: "chat", title: t("کلید ارسال پیام"), help: t("اینتر: اینتر می‌فرستد و شیفت+اینتر خط بعد می‌رود. شیفت+اینتر: شیفت+اینتر می‌فرستد و اینتر فقط می‌رود خط بعد. روی گوشی لمسی همیشه اینتر خط بعد است."), def: "enter", since: "2026-11-02", choices: { "enter": t("اینتر"), "shiftEnter": t("شیفت+اینتر") } },
  { key: "SIDE_CHAT", group: "chat", title: t("چت کناری"), help: t("یک گفتگوی جدا کنار گفتگوی باز، با همان زمینه؛ برای یک سؤال فرعی بدون به هم ریختن گفتگوی اصلی."), def: "on" },
  { key: "SETTINGS_NUDGES", group: "chat", title: t("پیشنهاد تنظیم از روی کار شما"), help: t("اگر این هفته چند بار به سقف خوردید، پیام را زود فرستادید یا پیامتان تا پایان کار در صف ماند، هفته‌ای حداکثر یک بار کارتی در فهرست کناری تنظیم مربوط را پیشنهاد می‌کند. فقط با کلیک شما اعمال می‌شود."), def: "off", since: "2026-11-23" },
  { key: "CHAT_SEARCH_MESSAGES", group: "chat", title: t("جستجو در متن پیام‌ها"), help: t("جستجوی کنار صفحه علاوه بر عنوان گفتگو، متن پیام‌ها و پاسخ‌ها را هم می‌گردد؛ مثل کارسرا."), def: "off", since: "2026-10-15" },
  { key: "KNOWLEDGE_AUTO_APPROVE", group: "tools", title: t("دانش خودکار"), help: t("هر یادداشتی که ایجنت می‌نویسد بی‌سؤال ذخیره و تأیید می‌شود و به گفتگوها می‌رسد؛ صفحهٔ دانش فقط برای پاک‌کردن است. پیش‌فرض خاموش."), def: "off", since: "2026-11-01", careful: true },
  { key: "WEB_SEARCH", group: "tools", title: t("جستجوی وب"), help: t("همهٔ موتورها می‌توانند وب را بگردند و صفحه بخوانند. نتیجهٔ وب «حرف دیگران» حساب می‌شود و با آن نمی‌شود دانش را خودکار تأیید کرد."), def: "on" },
  { key: "BROWSER", group: "tools", title: t("مرورگر ایجنت"), help: t("Chromium واقعی در سندباکس، برای تست سایت‌ها و کار با پنل‌هایی که API ندارند."), def: "on" },
  { key: "PREVIEW", group: "tools", title: t("پیش‌نمایش زندهٔ اپ‌ها"), help: t("ایجنت کد یا اپ را در سندباکس اجرا می‌کند و صفحه‌اش را همان‌جا در چت نشان می‌دهد."), def: "on" },
  { key: "OWNER_CHAT_TOOLS", group: "tools", title: t("ابزارهای چت‌به‌چت"), help: t("در گفتگوهای خود شما: فهرست و خواندن چت‌ها، پیام به چت دیگر (زنجیره تا دو قدم) و زنگ به گوشی (دقیقه‌ای یک بار). همکاران و جاب‌ها هرگز."), def: "on", careful: true },
  { key: "NETWORK", group: "tools", title: t("شبکهٔ ایجنت‌ها"), help: t("این نصب خودش را به ایجنت‌های همکاران معرفی می‌کند و با آن‌ها حرف می‌زند. برای نصب آزمایشی کنار نصب اصلی خاموشش کنید تا کار همکاران دو جا اجرا نشود."), def: "on", careful: true },
  { key: "PRIVATE_SHARE", group: "tools", title: t("اشتراک خصوصی گفتگو"), help: t("یک گفتگو را از راه تلگرام با یک نفر به اشتراک می‌گذارید: دعوت و کد یک‌بارمصرف به تلگرامش می‌رود، فقط روی یک دستگاه باز می‌شود و هر وقت بخواهید بسته می‌شود. خاموش کردن، لینک‌ها را متوقف می‌کند ولی نمی‌بندد."), def: "on", careful: true },
  { key: "TELEGRAM_FILES", group: "tools", title: t("فایل‌ها در تلگرام و بله"), help: t("فایل‌ها و نمودارهای یک پاسخ هم به تلگرام و بله فرستاده می‌شوند. خاموش: فقط متن پاسخ، مثل کارسرا."), def: "on" },
  { key: "TELEGRAM_LEDGER", group: "tools", title: t("دفتر ارسال تلگرام"), help: t("هر پیامی که از حساب تلگرام شما فرستاده می‌شود با نام چت فرستنده ثبت می‌شود تا جواب طرف به همان چت برگردد. فقط گفتگوهای خود شما آن را می‌خوانند."), def: "on" },
  { key: "TELEGRAM_DM_MODE", group: "tools", title: t("پیام خصوصی همکاران"), help: t("دستیار: به جای شما جواب می‌دهد. صندوق: مثل کارسرا هر پیام به یک چت صندوق می‌رود و بدون شما چیزی برای همکار فرستاده نمی‌شود؛ دفتر ارسال هم خودش روشن می‌شود."), def: "iris", choices: { "iris": t("دستیار جواب می‌دهد"), "inbox": t("صندوق") }, careful: true },
  { key: "CLAUDE_CODE", group: "claude", title: t("Claude Code کامل"), help: t("ترمینال، تنظیمات، مهارت‌ها و MCPهای شخصی، کنار ابزارهای گریفین، در گفتگوهای خود شما. فقط موتور Claude. گفتگوی همکاران هرگز؛ جاب‌ها فقط با گزینهٔ «جاب‌های خود شما»."), def: "on", careful: true },
  { key: "CLAUDE_HOST", group: "claude", title: t("Claude Code کجا اجرا شود"), help: t("کانتینر: داخل کانتینر گریفین. روی سرور: گفتگوهای خود شما با کاربر خودتان روی سرور اجرا می‌شوند، با کلید SSH، kubectl، gh، git، مهارت‌ها و حافظهٔ شما؛ مثل Claude دسکتاپ. بخش‌های دیگر همیشه در کانتینر می‌مانند. سرور باید برای این کار آماده شده باشد (GRIFFIN_CLAUDE_HOST_TARGET)."), def: "off", requires: "CLAUDE_CODE", since: "2026-10-17", choices: { "off": t("کانتینر"), "owner": t("روی سرور"), "owner+jobs": t("سرور و جاب‌ها") }, careful: true },
  { key: "CLAUDE_BACKGROUND_TASKS", group: "claude", title: t("کارهای پس‌زمینه"), help: t("ترمینال یا ایجنتی که در پس‌زمینه اجرا شده، بعد از پایان پاسخ هم ادامه می‌دهد. هر کدام در گفتگو دکمهٔ توقف دارد و نتیجه‌اش به پیام بعدی می‌رسد."), def: "on", requires: "CLAUDE_CODE", when: "new" },
  { key: "CLAUDE_STEER", group: "claude", title: t("پیام وسط کار"), help: t("پیامی که وسط کار می‌فرستید همان لحظه به همان پاسخ می‌رسد، نه بعد از تمام شدنش."), def: "on", requires: "CLAUDE_BACKGROUND_TASKS", when: "new" },
  { key: "RTK", group: "claude", title: t("کوتاه‌کردن خروجی ترمینال"), help: t("خروجی دستورهای git فقط‌خواندنی (status، log، diff، show) و grep با ابزار rtk فشرده می‌شود تا هر پیام توکن کمتری بخورد. فقط در حالت‌های بدون پرسش، فقط وقتی برای Bash قاعدهٔ deny یا ask ندارید، و برای جاب‌ها هرگز. اگر rtk نباشد یا خطا بدهد خود دستور اجرا می‌شود؛ مدل با RTK_DISABLED=1 خروجی کامل می‌گیرد."), def: "on", requires: "CLAUDE_CODE", since: "2026-11-22" },
  { key: "RTK_HOST", group: "claude", title: t("rtk روی خود سرور"), help: t("وقتی Claude Code روی خود سرور اجرا می‌شود، دستورها آنجا هم با rtk فشرده شوند. اول باید فایل rtk روی سرور گذاشته شود (راهنما در deploy/capsule/host-claude)؛ بدون آن دستور فشرده‌شده روی سرور پیدا نمی‌شود."), def: "off", requires: "RTK", since: "2026-11-22", careful: true },
  { key: "LIMIT_RESET_OFFER", group: "claude", title: t("ادامه با ریست سقف"), help: t("گفتگویی که به سقف Claude خورده و منتظر است، اگر حسابش ریست رایگان دارد، دکمهٔ «ادامه با ریست» نشان می‌دهد؛ مثل /limit-reset در Claude Code."), def: "off", since: "2026-11-11" },
  { key: "CLAUDE_FABLE", group: "claude", title: t("مدل Fable"), help: t("Fable در فهرست مدل‌ها، بعد از Opus می‌آید؛ اگر طرح Claude شما آن را دارد."), def: "off", since: "2026-10-15" },
  { key: "MODEL_HOLD", group: "claude", title: t("سقف مدل برای صرفه‌جویی"), help: t("روشن: هر گفتگو روی Sonnet با تلاش متوسط شروع می‌شود و مدل قوی‌تر (Opus، Fable) یا تلاش بیشتر فقط با تأیید دوم در همان گفتگو. خاموش: همان مدلی که روی موتور یا گفتگو گذاشته‌اید اجرا می‌شود."), def: "off", since: "2026-11-16" },
  { key: "ACCOUNT_BALANCE", group: "claude", title: t("پخش گفتگوها بین اکانت‌ها"), help: t("هر گفتگوی تازه و هر کار کوتاه (اسم چت، پیش‌نویس، بازبین) روی اکانت سالمی می‌رود که بیشترین سهم مانده را دارد؛ گفتگو همان‌جا می‌ماند و فقط وقتی اکانتش پر شود یا از ۸۵٪ بگذرد و اکانت دیگری خیلی خالی‌تر باشد جابه‌جا می‌شود. سهم هر اکانت هر ۱۵ دقیقه بدون مصرف توکن خوانده می‌شود. خاموش: ترتیب ثابت قبلی."), def: "on" },
  { key: "CLAUDE_TOKEN_KEEPER", group: "claude", title: t("نگهبان توکن اکانت‌ها"), help: t("قفل تمدیدی را که از پردازهٔ مرده جا مانده برمی‌دارد و توکن را چند دقیقه پیش از تمام شدن تمدید می‌کند، تا اجراها با خطای «another Claude Code process is refreshing it» نخوابند."), def: "off", since: "2026-10-28" },
  // سخت‌سازی اکانت‌های اشتراکی (عرفان ۲۰۲۶-۱۱-۲۵): پنج اکانت اولترا بن شدند و هر پنج از گریفین
  // استفاده می‌کردند. هر رفتار کد خودش را نگه داشته و این کلیدها فقط پیش‌فرضش را آرام می‌کنند.
  { key: "CLAUDE_USAGE_POLL", group: "claude", title: t("خواندن سهم اکانت‌ها روی ساعت"), help: t("سهم هر اکانت Claude هر ۱۵ دقیقه بدون مصرف توکن از خود سرویس خوانده می‌شود. خاموش: سهم فقط از گزارش اجرای واقعی خود اکانت پر می‌شود — پخش گفتگوها کار می‌کند، ولی گریفین روی ساعت از اکانت‌ها چیزی نمی‌پرسد. دکمهٔ «تازه‌سازی» هر اکانت همیشه دستی کار می‌کند."), def: "off", since: "2026-11-25" },
  { key: "CLAUDE_PROBE", group: "claude", title: t("تست سلامت خودکار اکانت Claude"), help: t("باز کردن صفحهٔ موتورها یک پیام واقعی کوتاه به هر اکانت می‌فرستد تا سلامت را ببیند. خاموش: صفحه فقط وضعیت ثبت‌شدهٔ خود اکانت را نشان می‌دهد و دکمهٔ «تست» همان تست واقعی را دستی می‌کند."), def: "off", since: "2026-11-25" },
  { key: "CLAUDE_ORG_LOOKUP", group: "claude", title: t("پرسیدن شناسهٔ سازمان اکانت"), help: t("شناسهٔ سازمان هر اکانت با یک درخواست خام به Anthropic خوانده می‌شود. خاموش: شناسهٔ سازمان فقط اگر اجرای خود اکانت گزارش کرده باشد نمایش داده می‌شود."), def: "off", since: "2026-11-25" },
  { key: "CLAUDE_LANGUAGE_FLAG", group: "claude", title: t("تنظیم زبان در هر اجرا"), help: t("تنظیم زبان «Persian» در هر اجرای Claude Code فرستاده می‌شود؛ همین تضمین می‌کند هر گفتگو فارسی جواب بدهد. خاموش: پاسخ فارسی از متن قواعد می‌آید و شکل درخواست مثل کلاینت عادی می‌شود، ولی ممکن است بعضی جواب‌ها انگلیسی شوند."), def: "on", since: "2026-11-25", careful: true },
  { key: "CLAUDE_TELEMETRY", group: "claude", title: t("تله‌متری Claude Code"), help: t("اجازهٔ فرستادن آمار مصرف و گزارش خطای خود Claude Code به Anthropic. خاموش‌کردنش هیچ قابلیتی از دست نمی‌دهد."), def: "off", since: "2026-11-25" },
  { key: "CLAUDE_PROMPT_APPEND", group: "claude", title: t("قواعد در سیستم‌پرامپت"), help: t("دفترچهٔ قواعد و دانش گریفین به سیستم‌پرامپت هر اجرا ضمیمه می‌شود. خاموش: همان قواعد از مسیر استاندارد Claude Code (فایل پروژه) خوانده می‌شوند و شکل درخواست مثل کلاینت عادی است."), def: "on", since: "2026-11-25" },
  { key: "CLAUDE_MAX_CONCURRENT", group: "claude", title: t("سقف اجرای هم‌زمان هر اکانت"), help: t("چند اجرا روی یک اکانت اشتراکی Claude هم‌زمان باشند. بیشتر از این، گفتگوی تازه روی اکانت دیگری می‌رود تا سهم یک اکانت یک‌جا نسوزد."), def: "2", since: "2026-11-25" },
  { key: "CLAUDE_BACKGROUND_OFF", group: "claude", title: t("کارهای پس‌زمینه روی اکانت اشتراکی نروند"), help: t("جاب‌ها، اسم چت، خلاصه و زیرکارها روی اکانت اشتراکی Claude نمی‌روند و به موتور یا کلید API دیگری می‌روند؛ اگر موتور دیگری نبود باز روی همان اجرا می‌شوند. خاموش: مثل قبل."), def: "on", since: "2026-11-25" },
  { key: "CLAUDE_WARMUP", group: "claude", title: t("گرم‌کردن اکانت تازه"), help: t("اکانت تازهٔ Claude در روزهای اول تا یک سقف نرم روزانه کار می‌کند تا یک‌جا کل سهم هفته را نسوزاند."), def: "on", since: "2026-11-25" },
  { key: "CLAUDE_WARMUP_DAILY_PERCENT", group: "claude", title: t("سقف نرم روزانهٔ اکانت تازه"), help: t("درصد سهمی که اکانت تازه در روزهای اول می‌تواند مصرف کند."), def: "35", since: "2026-11-25" },
  { key: "CLAUDE_WARMUP_DAYS", group: "claude", title: t("چند روز اکانت تازه بماند"), help: t("چند روز اول یک اکانت تازه حساب شود."), def: "3", since: "2026-11-25" },
  { key: "STATE_GUARD", group: "guard", title: t("قفل پوشهٔ داده"), help: t("ترمینال و هر ابزار دیگر نمی‌تواند در انبار دانش و پوشهٔ داده (توکن مالک، کلید رمزها، پایگاه داده) بنویسد؛ خواندن آزاد است."), def: "off", requires: "CLAUDE_CODE", careful: true },
  { key: "GIT_IDENTITY_GUARD", group: "guard", title: t("قفل هویت کامیت"), help: t("ترمینال نمی‌تواند نام و ایمیل کامیت را خودش انتخاب کند؛ کامیت با هویت گیت همان کسی ساخته می‌شود که پوش می‌کند."), def: "on", requires: "CLAUDE_CODE", since: "2026-10-29", careful: true },
  { key: "PEER_BRIDGE_GUARD", group: "guard", title: t("همکار فقط از راه شبکه"), help: t("ایجنت برای کار خواستن از ایجنت همکار فقط از شبکهٔ ایجنت‌ها استفاده می‌کند، نه یک اتصال دست‌ساز؛ این‌طور جواب دیررس هم خودش به همان گفتگو برمی‌گردد."), def: "on", since: "2026-11-09", careful: true },
  { key: "TELEGRAM_INSTRUCTION_GUARD", group: "guard", title: t("حفاظت از دستورالعمل‌ها در برابر تلگرام"), help: t("گفتگویی که از پیام تلگرام کس دیگری ساخته شده نمی‌تواند فایل‌های دستورالعمل شما (CLAUDE.md، تنظیمات، حافظه، مهارت‌ها، hookها) را بنویسد. Saved Messages و ربات خودتان آزادند."), def: "on", requires: "CLAUDE_CODE", careful: true },
  { key: "SELF_HEAL", group: "upkeep", title: t("تعمیر خودکار"), help: t("هر ۱۵ دقیقه سلامت گریفین چک می‌شود و مشکل‌های شناخته‌شده خودشان درست می‌شوند."), def: "off", restart: true },
  { key: "CLICK_MAP", group: "upkeep", title: t("نقشهٔ کلیک‌ها"), help: t("شمارش اینکه کجای صفحه کلیک می‌شود، فقط نام دکمه و بخش و هرگز متن پیام. هر ساعت به نصب نگه‌دارنده می‌رود تا پراستفاده‌ترین و بی‌استفاده‌ترین بخش‌ها پیدا شوند."), def: "on" },
  { key: "COMPACT_EVENTS", group: "upkeep", title: t("فشرده کردن پاسخ‌های قدیمی"), help: t("یک بار، در پس‌زمینه و فقط وقتی کاری در جریان نیست، تکه‌های پاسخ‌های قدیمی در پایگاه داده یکی می‌شوند. گفتگوهای بزرگ سریع‌تر باز می‌شوند و آنچه هر گفتگو نشان می‌دهد عوض نمی‌شود؛ ردیف‌های ذخیره‌شده بازنویسی می‌شوند."), def: "off", since: "2026-10-29", careful: true },
  { key: "LIVE_BROWSER", group: "live", title: t("مرورگر زندهٔ سرور"), help: t("چت‌های خود شما یک Chrome مشترک با صفحه‌نمایش در سندباکس دارند که زنده می‌بینید و با آن کار می‌کنید؛ لاگین‌هایش می‌ماند."), def: "off", since: "2026-10-31" },
  { key: "PRODUCT", group: "identity", title: t("نام محصول"), help: t("در عنوان صفحه، ظاهر پیش‌فرض مرورگر تازه و {product} امضا می‌آید."), choices: { "griffin": t("گریفین"), "karsara": t("کارسرا") } },
  { key: "SIGNATURE", group: "identity", title: t("امضای پیام‌ها"), help: t("زیر پیام‌هایی که دستیار می‌فرستد می‌آید. {name} نام دستیار، {owner} نام شما و {product} نام محصول است؛ مثلاً «— {name}، دستیار {owner} · {product}».") },
  { key: "PUBLIC_URL", group: "identity", title: t("آدرس عمومی"), help: t("برای لینک نمودار و فایل در پیام‌رسان‌ها."), restart: true },
  { key: "GIT_NAME", group: "git", title: t("نام شما برای کامیت‌ها"), help: t("با ایمیل کامیت کامل می‌شود. خالی: کامیت‌ها با نام دستیار ساخته می‌شوند.") },
  { key: "GIT_EMAIL", group: "git", title: t("ایمیل شما برای کامیت‌ها"), help: t("همراه با نام کامیت.") },
  { key: "GIT_BRANCH_PREFIX", group: "git", title: t("پیشوند شاخهٔ چت‌ها"), help: t("مثلاً erfan یعنی شاخه‌ها erfan/<id> می‌شوند. خالی: نام دستیار.") },
  { key: "DEFAULT_REPO", group: "git", title: t("ریپوی پیش‌فرض"), help: t("ریپویی که چت تازه با آن شروع می‌شود.") },
  { key: "WORKTREE_LINK", group: "git", title: t("فایل‌های لینک‌شده در worktree"), help: t("فایل‌های ignore‌شدهٔ ریپو مثل .env یا p24.db، با ویرگول، که در worktree هر گفتگوی تازه از پوشهٔ اصلی لینک می‌شوند؛ مثل کارسرا. ریپو هم می‌تواند فایل .worktreeinclude داشته باشد.") },
  { key: "CHAT_IDLE_DAYS", group: "git", title: t("بایگانی گفتگوی بی‌کار روی ریپو"), help: t("بعد از این چند روز بی‌کاری بایگانی می‌شود. ۰ یعنی هرگز؛ پیش‌فرض ۳."), restart: true },
  { key: "TITLE_MODEL", group: "models", title: t("مدل عنوان چت"), help: t("مدلی که عنوان گفتگوها را می‌سازد.") },
  { key: "GLM_FALLBACK_MODEL", group: "models", title: t("مدل جایگزین موتور OpenAI-compatible"), help: t("وقتی موتور OpenAI-compatible پر شد، این مدل Claude جایش را می‌گیرد.") },
  { key: "PEER_PROVIDER", group: "models", title: t("ایجنت همکاران: حساب موتور"), help: t("حسابی که ایجنت همکاران روی شبکه با آن کار می‌کنند. خالی: مثل پروفایل ایجنت.") },
  { key: "PEER_MODEL", group: "models", title: t("ایجنت همکاران: مدل شروع"), help: t("مدلی که ایجنت همکاران با آن شروع می‌کنند.") },
  { key: "PEER_EFFORT", group: "models", title: t("ایجنت همکاران: میزان فکر"), help: t("میزان فکر ایجنت همکاران روی شبکه.") },
  { key: "UPGRADE_MODEL", group: "models", title: t("مدل ارتقا برای کار واقعی"), help: t("اگر پیام همکار واقعاً کار بود، همان نوبت و همان session به این مدل قوی‌تر می‌رود و پیام بعدی با مدل شروع برمی‌گردد. مثلاً opus. خالی: خاموش. فقط حساب‌های Claude.") },
  { key: "UPGRADE_EFFORT", group: "models", title: t("میزان فکر بعد از ارتقا"), help: t("خالی: پیش‌فرض مدل.") },
  { key: "TEAM_PROVIDER", group: "models", title: t("رشته‌های همکاران: حساب موتور"), help: t("حسابی که رشته‌های همکاران با آن اجرا می‌شوند.") },
  { key: "TEAM_MODEL", group: "models", title: t("رشته‌های همکاران: مدل"), help: t("مدل رشته‌های همکاران.") },
  { key: "TEAM_EFFORT", group: "models", title: t("رشته‌های همکاران: میزان فکر"), help: t("میزان فکر رشته‌های همکاران.") },
  { key: "TEAM_SUB_PROVIDER", group: "models", title: t("زیرکارهای همکار: حساب موتور"), help: t("حسابی که زیرکارهای رشتهٔ همکار با آن اجرا می‌شوند.") },
  { key: "TEAM_SUB_MODEL", group: "models", title: t("زیرکارهای همکار: مدل"), help: t("مدل زیرکارهای رشتهٔ همکار.") },
  { key: "WEB_SEARCH_URL", group: "web", title: t("آدرس SearXNG"), help: t("آدرس SearXNG خودتان برای جستجو، مثل https://searx.example.com/search. خالی: DuckDuckGo بدون کلید.") },
  { key: "PREVIEW_RUNNER", group: "web", title: t("محل اجرای پیش‌نمایش‌ها"), help: t("خودکار: سندباکس، مگر نصب روی هاست باشد و سندباکس نداشته باشد. سندباکس: همیشه سندباکس. روی ماشین: همیشه روی خود ماشین."), restart: true, choices: { "auto": t("خودکار"), "sandbox": t("سندباکس"), "local": t("روی ماشین") } },
  { key: "PREVIEW_IDLE_HOURS", group: "web", title: t("مهلت پیش‌نمایش بی‌بازدید (ساعت)"), help: t("پیش‌نمایشی که این‌قدر کسی نگاهش نکند خاموش می‌شود. خالی یعنی ۲۴ ساعت."), restart: true },
  { key: "PREVIEW_HOST", group: "web", title: t("میزبان پیش‌نمایش‌ها"), help: t("preview.example.com یعنی یک میزبان جدا که اپ‌های با آدرس /assets/… را درست نشان می‌دهد. *.preview.example.com یعنی برای هر پیش‌نمایش یک زیردامنه که بهترین حالت است و DNS و گواهی wildcard می‌خواهد. خالی: روی همان میزبان، فقط برای صفحه‌هایی با آدرس نسبی.") },
  { key: "LIVE_BROWSER_PROXY", group: "web", title: t("پراکسی مرورگر زنده"), help: t("برای سایت‌های فیلترشده، مثل http://host:port یا socks5://host:port. خالی: مستقیم با IP سرور.") },
  { key: "LIVE_BROWSER_SIZE", group: "web", title: t("اندازهٔ صفحهٔ مرورگر زنده"), help: t("مثل 1440x900.") },
  { key: "BACKUP_HOUR", group: "backup", title: t("ساعت بکاپ شبانه"), help: t("از کل پایگاه داده، هر شب به وقت تهران. ۰ تا ۲۳؛ پیش‌فرض ۵؛ off یعنی خاموش.") },
  { key: "BACKUP_KEEP", group: "backup", title: t("تعداد بکاپ‌های نگه‌داشته"), help: t("پیش‌فرض ۸. جدا از این، آخرین بکاپ هر روز تا ۷ روز می‌ماند.") },
  { key: "BACKUP_DIR", group: "backup", title: t("پوشهٔ بکاپ‌ها"), help: t("پیش‌فرض backups داخل پوشهٔ داده. برای امنیت بیشتر یک دیسک یا mount دیگر بدهید.") },
  { key: "BACKUP_S3_URL", group: "backup", title: t("بکاپ بیرون از سرور (S3)"), help: t("آدرس باکت S3 شما و یک پوشه، مثل https://s3.example.com/<باکت>/griffin-backup. با سکرت‌های backup/s3-access-key، backup/s3-secret-key و backup/password (رمز restic) هر بکاپ رمزشده آن‌جا هم می‌رود. یک نسخه از رمز را بیرون از این سرور نگه دارید. خالی: خاموش.") },
  { key: "OWNER_INFISICAL_PROJECTS", group: "access", title: t("پروژه‌های Infisical خود شما"), help: t("نام یا شناسه، با ویرگول. خواندن و نوشتن سکرت در هر پروژهٔ دیگری اول از شما تأیید می‌گیرد. خالی: هر پروژه یک بار در هر گفتگو تأیید می‌گیرد.") },
  { key: "SETUP_ACCESS", group: "access", title: t("جای دسترسی‌ها برای راه‌اندازی"), help: t("برای پرامپت راه‌اندازی می‌گوید دسترسی‌ها کجاست، بدون رمز. مثلاً «شل سرور و توکن owner در Infisical پروژهٔ x، مسیر /capsule».") },
  { key: "MODULES", group: "access", title: t("ماژول‌های روشن (دستی)"), help: t("معمولاً از «بازارچه» عوض می‌شود. خالی: پیش‌فرض محصول. all: همه. a,b: دقیقاً همین‌ها. default,-jobs,+tickets: پیش‌فرض بدون جاب و با تیکت."), restart: true },
  { key: "OPS_MODE", group: "access", title: t("اتاق عملیات هشدارها"), help: t("خاموش، فقط ثبت، فقط بحرانی‌ها یا سایه."), restart: true, choices: { "off": t("خاموش"), "record": t("فقط ثبت"), "critical": t("فقط بحرانی"), "shadow": t("سایه") } },
  { key: "NETWORK_ADMIT", group: "access", title: t("عضو تازهٔ شبکهٔ ایجنت‌ها"), help: t("نصبی که روی دامنه‌های شرکت سلام می‌کند: خودکار فوراً عضو می‌شود؛ با تأیید مالک غیرفعال می‌ماند و کارت «منتظر شما» می‌آید. عضوهای فعلی دست نمی‌خورند."), def: "auto", choices: { auto: t("خودکار"), owner: t("با تأیید مالک") }, since: "2026-10-30", careful: true },
  { key: "PEER_SELF_SERVE", group: "access", title: t("راهنمای «خودت انجام بده»"), help: t("متنی که به ایجنت همکاران داده می‌شود. {user} شناسهٔ همکار است."), multiline: true },
  { key: "STT_BASE_URL", group: "stt", title: t("تبدیل صدا به متن: آدرس سرویس"), help: t("در «گفتگو و اعلان» تنظیم می‌شود.") },
  { key: "STT_MODEL", group: "stt", title: t("تبدیل صدا به متن: مدل"), help: t("در «گفتگو و اعلان» تنظیم می‌شود.") },
  { key: "STT_LANGUAGE", group: "stt", title: t("تبدیل صدا به متن: زبان"), help: t("در «گفتگو و اعلان» تنظیم می‌شود.") },
];

const BY_KEY = new Map(FEATURES.map((f) => [f.key, f]));
/** A setting's row, or null for one that has none (a module's own). */
export const featureOf = (key) => BY_KEY.get(key) || null;

// A feature counts as «تازه» for this many days after it was added.
const FRESH_DAYS = 45;
export const isFresh = (feature, now = Date.now()) => Boolean(feature?.since) && now - Date.parse(feature.since) < FRESH_DAYS * 86_400_000;

/** A plain on/off switch, as opposed to a value or a choice of several. */
export const isSwitch = (feature) => Boolean(feature) && !feature.choices && (feature.def === "on" || feature.def === "off");

/** What the server is running with: the saved value, else the env, else the default. */
export const featureValue = (feature, row) => row?.value || row?.effective || feature?.def || "";

/** Whether a switch is on, an unset one following its default. */
export const featureOn = (feature, row) => featureValue(feature, row) === "on";

/** A row hangs under another: how deep (0 = its own row), through `requires` inside the same group. */
export function featureDepth(feature) {
  let depth = 0;
  for (let up = feature; up?.requires && featureOf(up.requires)?.group === feature.group; up = featureOf(up.requires)) depth += 1;
  return depth;
}

/** The first thing above this feature that is off (nothing for one that can act), from /api/config rows. */
export function blockedBy(feature, rows) {
  for (let up = featureOf(feature?.requires); up; up = featureOf(up.requires)) {
    if (!featureOn(up, rows.find((r) => r.key === up.key))) return up;
  }
  return null;
}
