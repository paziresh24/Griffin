// The map of Settings (owner 2026-11-01: «در نهایت احتمالا ۷-۸ تا گزینه سمت راست… نباید امکانی از دست بره»):
// eight pages, each with its sections as tabs. A section's id is what links use (#/settings/<id>), so
// every older link still lands on the right tab (ALIASES); nothing here knows about React or icons.
import { FLAGS } from "./ui-flags.js";
import { FEATURES, FEATURE_GROUPS } from "./settings-features.js";
import { t } from "./i18n.js";

export const SETTINGS_GROUPS = [
  { id: "personal", label: t("شخصی") },
  { id: "ai", label: t("هوش مصنوعی") },
  { id: "integrations", label: t("اتصال‌ها و افزونه‌ها") },
  { id: "system", label: t("سیستم و گزارش‌ها") },
];

export const SETTINGS_PAGES = [
  {
    id: "appearance",
    group: "personal",
    label: t("ظاهر و گفتگو"),
    icon: "palette",
    blurb: t("سبک صفحه، چیدمان منو، رفتار گفتگو و اعلان"),
    sections: [
      { id: "appearance", label: t("ظاهر و چیدمان"), description: t("روی هر قسمت پیش‌نمایش بزنید تا گزینه‌هایش بیاید؛ تغییرها همان لحظه دیده می‌شوند.") },
      { id: "chat", label: t("گفتگو و اعلان"), description: t("رفتار کادر پیام، ادامهٔ خودکار کار و اعلان روی همین دستگاه.") },
    ],
  },
  {
    id: "account",
    group: "personal",
    label: t("حساب و امنیت"),
    icon: "user",
    blurb: t("نام، زبان، ورود دومرحله‌ای، نشست‌ها و سکرت‌ها"),
    sections: [
      { id: "account", label: t("حساب و نشست‌ها"), description: t("نام شما در منو، زبان رابط، ورود دومرحله‌ای و نشست‌های فعال.") },
      { id: "users", ownerOnly: true, label: t("کاربران"), description: t("افزودن همکاران و اعضای تیم با توکن شخصی؛ چت‌ها و یادداشت‌های هر کاربر جداست و موتورها مشترک‌اند.") },
      { id: "secrets", ownerOnly: true, label: t("سکرت‌ها"), description: t("کلیدهای موتورها و ابزارها، رمزنگاری‌شده روی همین سرور.") },
    ],
  },
  {
    id: "engines",
    group: "ai",
    label: t("موتورها و سهمیه"),
    icon: "cpu",
    blurb: t("اکانت‌های کلاد و مدل‌ها، سهمیه و مصرف توکن"),
    sections: [
      { id: "providers", label: t("موتورها و اکانت‌ها"), description: t("مدیریت حساب‌های Claude، OpenAI، Codex و مدل پیش‌فرض هر موتور.") },
      { id: "tokens", label: t("مصرف و سهمیه"), description: t("مصرف روزانهٔ توکن و وضعیت سهمیهٔ اشتراک‌ها.") },
      // The maintainer's install only (accounting.mjs): shown when GET /api/accounting answers.
      { id: "accounting", label: t("حسابداری مصرف"), hubOnly: true, description: t("مصرف همهٔ نصب‌ها از دیتابیس خودشان، اکانت‌های مشترک Claude و هشدارها. فقط روی همین نصب.") },
    ],
  },
  {
    id: "assistant",
    group: "ai",
    label: t("ایجنت‌ها و دانش"),
    icon: "bot",
    blurb: t("پروفایل ایجنت‌ها، ابزارها و یادداشت‌های دانش"),
    sections: [
      { id: "agents", label: t("ایجنت‌ها"), description: t("هر ایجنت پروفایل، توضیح و ابزارهای خودش را دارد. برای تنظیم روی کارت بزنید.") },
      { id: "knowledge", label: t("دانش"), description: t("یادداشت‌های دائمی که دستیار در گفتگوهای بعدی از آن‌ها استفاده می‌کند.") },
    ],
  },
  {
    id: "links",
    group: "integrations",
    label: t("اتصال‌ها"),
    icon: "plug",
    blurb: t("تلگرام، بله، MCP، مرورگر، گوشی و پراکسی/VPN"),
    sections: [
      { id: "connections", label: t("پیام‌رسان‌ها"), description: t("ربات‌ها و اکانت تلگرامی که دستیار از آن‌ها پیام می‌گیرد.") },
      { id: "mcp", label: "MCP", description: t("سرورهای MCP شخصی شما برای اتصال به ابزارهای بیرونی.") },
      { id: "browser", label: t("مرورگر"), description: t("مرورگر خود شما از راه افزونه، و یک Chrome واقعی روی سرور که شما و ایجنت با هم در آن کار می‌کنید.") },
      { id: "phone", label: t("گوشی"), description: t("گوشی اندرویدی که با کابل به همین کامپیوتر وصل است، از راه مرورگر (WebUSB) به ایجنت می‌رسد.") },
      { id: "proxy", label: t("پراکسی و VPN"), description: t("لینک VPN (v2ray یا اشتراک) یا پراکسی HTTP برای رسیدن به Claude، Cursor و تلگرام.") },
    ],
  },
  {
    id: "extend",
    group: "integrations",
    label: t("افزونه‌ها و قابلیت‌ها"),
    icon: "store",
    blurb: t("بازارچهٔ بخش‌ها و کلیدهای قابلیت"),
    sections: [
      { id: "market", label: t("بازارچه"), description: t("بخش‌های گریفین و افزونه‌ها: روشن و خاموش کردن، آمدن در منو و تنظیمات هر کدام، همه روی کارت خودش.") },
      { id: "features", label: t("قابلیت‌ها"), description: t("هر کلید را می‌شود جدا روشن و خاموش کرد؛ علامت ؟ می‌گوید چه می‌کند. قابلیت‌های تازه برچسب «تازه» دارند.") },
    ],
  },
  {
    id: "status",
    group: "system",
    label: t("سیستم و سلامت"),
    icon: "activity",
    blurb: t("چک و تعمیر، منابع سرور و پیکربندی پیشرفته"),
    sections: [
      { id: "health", label: t("چک و تعمیر"), description: t("چک زنده و تعمیر با یک کلیک، آپدیت و وضعیت اتصال‌ها.") },
      { id: "server", label: t("وضعیت سرور"), description: t("منابع سرور و سرویس‌های گریفین.") },
      { id: "config", label: t("پیکربندی پیشرفته"), description: t("تنظیمات سیستمی، نام‌ها، مدل‌ها، بکاپ و آدرس‌ها.") },
    ],
  },
  {
    id: "reports",
    group: "system",
    label: t("گزارش‌ها و بازخورد"),
    icon: "chart",
    blurb: t("بازخورد همکاران و نقشهٔ کلیک‌ها"),
    sections: [
      { id: "feedback", label: t("بازخوردها"), description: t("بازخورد و درخواست پشتیبانی که از نصب همکاران (و همین‌جا) رسیده، با تصویر صفحه و جزئیات.") },
      { id: "clicks", label: t("نقشهٔ کلیک‌ها"), description: t("کجای صفحه بیشتر کلیک می‌شود، کدام کلیک‌ها بی‌اثرند و کدام بخش‌ها زده نمی‌شوند؛ ۱۴ روز اخیر.") },
    ],
  },
];

// What older pages, links and the Karsara list called them, and a page's own id (its first tab).
const ALIASES = {
  profile: "account",
  security: "account",
  notifications: "chat",
  composer: "chat",
  doctor: "health",
  status: "health",
  system: "health",
  modules: "market",
  mybrowser: "browser",
  serverbrowser: "browser",
  assistant: "agents",
  engines: "providers",
  models: "providers",
  links: "connections",
  extend: "market",
  reports: "feedback",
};

export const FIRST_SECTION = "health";
export const DEFAULT_SECTION = "providers";

const MEMBER_SECTIONS = new Set(["appearance", "account"]);
export const pagesFor = (hub = false, member = false) =>
  SETTINGS_PAGES.map((page) => ({
    ...page,
    sections: page.sections.filter((s) => {
      if (member) return MEMBER_SECTIONS.has(s.id);
      return hub || !s.hubOnly;
    }),
  })).filter((page) => page.sections.length > 0);

/** A section id, an old name or a page's id → the section it means; null for anything else. */
export function sectionId(id) {
  const next = ALIASES[id] || id;
  return SETTINGS_PAGES.some((page) => page.sections.some((s) => s.id === next)) ? next : null;
}

export const pageOf = (id, pages = SETTINGS_PAGES) => pages.find((page) => page.sections.some((s) => s.id === id)) || null;

// "#/settings/<section>" or "#/settings/<section>/<row>": the row is where a suggestion card's «برو به
// تنظیم» lands (SettingsSuggest.jsx) — a setting's key or a flag's (settings-catalog.js `focus`).
const SETTINGS_LINK = /^#\/settings\/([a-z-]{2,32})(?:\/([A-Za-z][A-Za-z0-9_]{1,40}))?$/;
/** The section an address names: "#/settings/providers" → "providers"; "#/settings" names none. */
export const linkedSection = (hash) => sectionId(SETTINGS_LINK.exec(hash || "")?.[1]);
/** The row an address names: "#/settings/chat/ENTER_KEY" → "ENTER_KEY"; null for none. */
export const linkedRow = (hash) => (linkedSection(hash) ? SETTINGS_LINK.exec(hash)[2] || null : null);
/** The address of a section, and of one row in it. */
export const settingsLink = (section, row = null) => `#/settings/${section}${row ? `/${row}` : ""}`;

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
  const appearancePage = pageOf("appearance", pages);  const appearance = appearancePage?.label || "";
  if (appearancePage) {
    for (const flag of FLAGS) {
      const elsewhere = Object.entries(FLAGS_ELSEWHERE).find(([, keys]) => keys.includes(flag.key))?.[0];
      const targetPage = elsewhere ? pageOf(elsewhere, pages) : appearancePage;
      if (!targetPage) continue;
      const zone = ZONES.find((z) => z.id === zoneOfFlag(flag.key));
      entries.push({ id: `flag:${flag.key}`, title: flag.label, path: elsewhere ? targetPage.label : `${appearance} ← ${zone?.label || ""}`, section: elsewhere || "appearance", focus: flag.key, words: fold(`${flag.label} ${flag.hint} ${flag.key}`) });
    }
  }
  for (const feature of FEATURES) {
    const row = rows.find((r) => r.key === feature.key);
    const group = FEATURE_GROUPS.find((g) => g.id === feature.group);
    const section = row?.modules?.length ? "market" : group.section;
    const targetPage = pageOf(section, pages);
    if (!targetPage) continue;
    entries.push({ id: `set:${feature.key}`, title: feature.title, path: `${targetPage.label} ← ${group.label}`, section, focus: feature.key, words: fold(`${feature.title} ${feature.help} ${feature.key}`) });
  }
  return entries;
}

/** The best matches for what was typed: main pages and tabs first, then title hits before body hits. */
export function searchSettings(query, entries, limit = 12) {
  const parts = fold(query).split(" ").filter(Boolean);
  if (!parts.length) return [];
  const hits = entries.filter((e) => parts.every((part) => e.words.includes(part)));
  const whole = parts.join(" ");
  const isNav = (e) => e.id.startsWith("page:") || e.id.startsWith("tab:");
  const rank = (e) => {
    const title = fold(e.title);
    if (title === whole) return isNav(e) ? 0 : 1;
    if (title.includes(whole)) return isNav(e) ? 2 : 4;
    if (parts.every((part) => title.includes(part))) return isNav(e) ? 3 : 5;
    // Matching a main page/tab's blurb (e.g. «تلگرام» in اتصال‌ها / پیام‌رسان‌ها) ranks ahead of obscure flags.
    return isNav(e) ? 3.5 : 6;
  };
  return hits.sort((a, b) => rank(a) - rank(b)).slice(0, limit);
}
