// The map of Settings (owner 2026-11-01: «در نهایت احتمالا ۷-۸ تا گزینه سمت راست… نباید امکانی از دست بره»):
// eight pages, each with its sections as tabs. A section's id is what links use (#/settings/<id>), so
// every older link still lands on the right tab (ALIASES); nothing here knows about React or icons.
import { FLAGS } from "./ui-prefs.js";
import { FEATURES, FEATURE_GROUPS } from "./settings-features.js";
import { t } from "./i18n.js";

export const SETTINGS_PAGES = [
  {
    id: "status",
    label: t("وضعیت"),
    icon: "activity",
    blurb: t("سلامت، آپدیت و اتصال‌ها"),
    sections: [
      { id: "health", label: t("چک و تعمیر"), description: t("چک زنده و تعمیر با یک کلیک، و وضعیت اتصال‌ها.") },
      { id: "server", label: t("وضعیت سرور"), description: t("منابع سرور و سرویس‌های گریفین.") },
    ],
  },
  {
    id: "account",
    label: t("حساب"),
    icon: "user",
    blurb: t("نام، زبان، ورود دومرحله‌ای و نشست‌ها"),
    sections: [{ id: "account", label: t("حساب"), description: t("نام شما در منو، زبان رابط و نشست‌های ورود.") }],
  },
  {
    id: "appearance",
    label: t("ظاهر"),
    icon: "palette",
    blurb: t("سبک، لوگو و چیدمان صفحه"),
    sections: [{ id: "appearance", label: t("ظاهر"), description: t("روی هر قسمت پیش‌نمایش بزنید تا گزینه‌هایش بیاید؛ تغییرها همان لحظه دیده می‌شوند.") }],
  },
  {
    id: "chat",
    label: t("گفتگو و اعلان"),
    icon: "message",
    blurb: t("رفتار گفتگو، صدا و اعلان"),
    sections: [{ id: "chat", label: t("گفتگو و اعلان"), description: t("رفتار کادر پیام و ادامهٔ کار، و اعلان روی همین دستگاه.") }],
  },
  {
    id: "assistant",
    label: t("دستیار"),
    icon: "bot",
    blurb: t("ایجنت‌ها، موتورها، دانش و سکرت‌ها"),
    sections: [
      { id: "agents", label: t("ایجنت‌ها"), description: t("هر ایجنت پروفایل خودش را دارد: موتور، مدل و ابزارهای روشن. برای تنظیم، روی کارت بزن.") },
      { id: "providers", label: t("موتورها"), description: t("حساب‌ها، کلیدها و مدل پیش‌فرض هر موتور.") },
      { id: "knowledge", label: t("دانش"), description: t("فقط یادداشت‌های تأییدشده به قواعد ایجنت می‌روند.") },
      { id: "secrets", label: t("سکرت‌ها"), description: t("کلیدهای موتورها و ابزارها، رمزنگاری‌شده روی همین سرور.") },
    ],
  },
  {
    id: "links",
    label: t("اتصال‌ها"),
    icon: "plug",
    blurb: t("پیام‌رسان‌ها، VPN، MCP، گوشی و مرورگر"),
    sections: [
      { id: "connections", label: t("پیام‌رسان‌ها"), description: t("ربات‌ها و اکانت تلگرامی که دستیار از آن‌ها پیام می‌گیرد.") },
      { id: "proxy", label: t("پراکسی و VPN"), description: t("لینک VPN (v2ray یا اشتراک) یا پراکسی HTTP، برای رسیدن به Claude، Cursor و تلگرام.") },
      { id: "mcp", label: "MCP", description: t("سرورهای MCP شخصی شما برای Claude Code کامل.") },
      { id: "phone", label: t("گوشی"), description: t("گوشی اندرویدی که با کابل به همین کامپیوتر وصل است، از راه مرورگر (WebUSB) به ایجنت می‌رسد؛ ایجنت روی آن adb دارد. بدون نرم‌افزار روی کامپیوتر.") },
      { id: "browser", label: t("مرورگر"), description: t("مرورگر خود شما از راه افزونه، و یک Chrome واقعی روی سرور که شما و ایجنت با هم در آن کار می‌کنید.") },
    ],
  },
  {
    id: "extend",
    label: t("بازارچه و قابلیت‌ها"),
    icon: "store",
    blurb: t("بخش‌ها، قابلیت‌های تازه و پیکربندی"),
    sections: [
      { id: "market", label: t("بازارچه"), description: t("بخش‌های گریفین و افزونه‌ها: روشن و خاموش کردن، آمدن در منو و تنظیمات هر کدام، همه روی کارت خودش. تعارض‌ها و جابه‌جایی گفتگوها را خودش حساب می‌کند.") },
      { id: "features", label: t("قابلیت‌ها"), description: t("هر کلید را می‌شود جدا روشن و خاموش کرد؛ علامت ؟ می‌گوید چه می‌کند. قابلیت‌های تازه برچسب «تازه» دارند و بیشترشان پیش‌فرض خاموش‌اند.") },
      { id: "config", label: t("پیکربندی"), description: t("مقدارهایی که قبلاً متغیر محیطی بود: نام‌ها، مدل‌ها، بکاپ و آدرس‌ها.") },
    ],
  },
  {
    id: "reports",
    label: t("گزارش‌ها"),
    icon: "chart",
    blurb: t("مصرف توکن، کلیک‌ها و بازخوردها"),
    sections: [
      { id: "tokens", label: t("مصرف توکن"), description: t("توکن روزبه‌روز، به تفکیک مدل و گفتگو.") },
      // The maintainer's install only (accounting.mjs): shown when GET /api/accounting answers.
      { id: "accounting", label: t("حسابداری مصرف"), hubOnly: true, description: t("مصرف همهٔ نصب‌ها از دیتابیس خودشان، اکانت‌های مشترک Claude و هشدارها. فقط روی همین نصب.") },
      { id: "clicks", label: t("نقشهٔ کلیک‌ها"), description: t("کجای صفحه بیشتر کلیک می‌شود، کدام کلیک‌ها بی‌اثرند و کدام بخش‌ها زده نمی‌شوند؛ ۱۴ روز اخیر. روی نصب نگه‌دارنده، همهٔ نصب‌ها با هم. فقط نام دکمه و بخش شمرده می‌شود، هرگز متن.") },
      { id: "feedback", label: t("بازخوردها"), description: t("بازخورد و درخواست پشتیبانی که از نصب همکاران (و همین‌جا) رسیده، با تصویر صفحه و جزئیات.") },
    ],
  },
];

// What older pages, links and the Karsara list called them, and a page's own id (its first tab).
const ALIASES = {
  profile: "account",
  notifications: "chat",
  composer: "chat",
  doctor: "health",
  status: "health",
  modules: "market",
  mybrowser: "browser",
  serverbrowser: "browser",
  assistant: "agents",
  links: "connections",
  extend: "market",
  reports: "tokens",
};

export const FIRST_SECTION = "health";

export const pagesFor = (hub = false) => SETTINGS_PAGES.map((page) => ({ ...page, sections: page.sections.filter((s) => hub || !s.hubOnly) }));

/** A section id, an old name or a page's id → the section it means; null for anything else. */
export function sectionId(id) {
  const next = ALIASES[id] || id;
  return SETTINGS_PAGES.some((page) => page.sections.some((s) => s.id === next)) ? next : null;
}

export const pageOf = (id, pages = SETTINGS_PAGES) => pages.find((page) => page.sections.some((s) => s.id === id)) || null;

/** The section an address names: "#/settings/providers" → "providers"; "#/settings" names none. */
export const linkedSection = (hash) => sectionId(/^#\/settings\/([a-z-]{2,32})$/.exec(hash || "")?.[1]);

/** Where «ظاهر» draws a flag. The other flags of FLAGS are parts of one choice (MERGED_FLAGS). */
export const ZONES = [
  { id: "look", label: t("سبک و رنگ"), flags: [] },
  { id: "sidebar", label: t("فهرست کناری"), flags: ["oneList", "userMenu", "agentLogos", "timeAgo", "telegramChat"] },
  { id: "home", label: t("صفحهٔ اول"), flags: [] },
  { id: "chat", label: t("گفتگو"), flags: ["runFooterDetailed", "editLinks", "headerCounts", "sideChatSimple"] },
  { id: "composer", label: t("کادر پیام"), flags: ["modeSimple", "effortSimple", "fastChip", "modelLabels", "composerStats", "repoChipsAlways", "repoCapsule", "scheduledPeek", "laterButton", "nonClaudeHint"] },
  { id: "other", label: t("سایر"), flags: ["settingsList", "setupFlat"] },
];

// Flags that became one choice, flag → the zone that draws it. They used to be separate switches
// whose combinations made no difference (both update switches on = the top button; a narrated log
// ignores «open while running»), so every behaviour is still there, in fewer questions.
export const MERGED_FLAGS = {
  navIcons: "sidebar", // «جای بخش‌ها»
  navMore: "sidebar", // under «جای بخش‌ها», while the rows are in the list
  updateInSettings: "sidebar", // «خبر نسخهٔ تازه»
  updateTopButton: "sidebar",
  homeBoard: "home", // «صفحهٔ اول»
  onePlace: "home",
  workLogOpen: "chat", // «مراحل کار»
  workInline: "chat",
};

// A flag drawn outside «ظاهر»: section → flags.
export const FLAGS_ELSEWHERE = {
  chat: ["nextGhost"], // with PROMPT_SUGGESTIONS, «پیشنهاد پیام بعدی»
  market: ["inboxRow"], // on the Telegram inbox's card
};

/** The zone of «ظاهر» that shows a flag, or null for one drawn elsewhere. */
export function zoneOfFlag(key) {
  return ZONES.find((zone) => zone.flags.includes(key))?.id || MERGED_FLAGS[key] || null;
}

// One choice made of several flags: «خبر نسخهٔ تازه» (UpdateNotice.jsx).
export const updateChoice = (flags) => (flags?.updateTopButton ? "top" : flags?.updateInSettings ? "settings" : "list");
export const updateFlags = (id) => ({ updateTopButton: id === "top", updateInSettings: id === "settings" });
// «صفحهٔ اول» (Board.jsx): «هر چیز فقط یک جا» only means something while the board is on.
export const homeChoice = (flags) => (!flags?.homeBoard ? "simple" : flags?.onePlace ? "one" : "board");
export const homeFlags = (id) => ({ homeBoard: id !== "simple", onePlace: id === "one" });
// «مراحل کار» (Work.jsx): a narrated log ignores «open while running».
export const workChoice = (flags) => (flags?.workInline ? "inline" : flags?.workLogOpen ? "open" : "fold");
export const workFlags = (id) => ({ workInline: id === "inline", workLogOpen: id === "open" });

// --- Search: every page, tab, look option and setting by the words a person would type. ---
const fold = (text) => String(text || "").toLowerCase().replace(/ي/g, "ی").replace(/ك/g, "ک").replace(/[‌ً-ْ]/g, "").replace(/\s+/g, " ").trim(); // i18n-ignore

/** What to search. `rows` are /api/config's, for the settings a module's card shows instead. */
export function settingsIndex(rows = [], pages = pagesFor(true)) {
  const entries = [];
  for (const page of pages) {
    entries.push({ id: `page:${page.id}`, title: page.label, path: page.blurb, section: page.sections[0].id, words: fold(`${page.label} ${page.blurb}`) });
    if (page.sections.length > 1) for (const s of page.sections) entries.push({ id: `tab:${s.id}`, title: s.label, path: page.label, section: s.id, words: fold(`${s.label} ${s.description}`) });
  }
  const appearance = pageOf("appearance", pages).label;
  for (const flag of FLAGS) {
    const elsewhere = Object.entries(FLAGS_ELSEWHERE).find(([, keys]) => keys.includes(flag.key))?.[0];
    const zone = ZONES.find((z) => z.id === zoneOfFlag(flag.key));
    entries.push({ id: `flag:${flag.key}`, title: flag.label, path: elsewhere ? pageOf(elsewhere, pages).label : `${appearance} ← ${zone?.label || ""}`, section: elsewhere || "appearance", focus: flag.key, words: fold(`${flag.label} ${flag.hint} ${flag.key}`) });
  }
  for (const feature of FEATURES) {
    const row = rows.find((r) => r.key === feature.key);
    const group = FEATURE_GROUPS.find((g) => g.id === feature.group);
    const section = row?.modules?.length ? "market" : group.section;
    entries.push({ id: `set:${feature.key}`, title: feature.title, path: `${pageOf(section, pages).label} ← ${group.label}`, section, focus: feature.key, words: fold(`${feature.title} ${feature.help} ${feature.key}`) });
  }
  return entries;
}

/** The best matches for what was typed: a hit in the title before one in the text. */
export function searchSettings(query, entries, limit = 12) {
  const parts = fold(query).split(" ").filter(Boolean);
  if (!parts.length) return [];
  const hits = entries.filter((e) => parts.every((part) => e.words.includes(part)));
  const whole = parts.join(" ");
  const inTitle = (e) => {
    const title = fold(e.title);
    return title === whole ? 0 : title.includes(whole) ? 1 : parts.every((part) => title.includes(part)) ? 2 : 3;
  };
  return hits.sort((a, b) => inTitle(a) - inTitle(b)).slice(0, limit);
}
