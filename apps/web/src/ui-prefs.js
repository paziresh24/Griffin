// One UI, personalised per user: the look is appearance only (palette, font,
// radii, flat or framed — <html data-look>, styles.css), and every structural or behavioural choice is
// a flag. Both live on the server (GET/PUT/DELETE /api/ui-prefs) so every device shows the same.
// Precedence: the user's own choice > the snapshot taken on first load after the update > the
// install's preset (GRIFFIN_PRODUCT). «گریفین» and «کارسرا» are two presets of the same flags.
import { useSyncExternalStore } from "react";
import { api } from "./api.js";
import { t } from "./i18n.js";

export const LOOKS = [
  { id: "griffin", label: t("گریفین"), note: t("رنگ و لوگوی همین نصب، گوشه‌های گرد، وزیرمتن") },
  { id: "karsara", label: t("کارسرا"), note: t("پوستهٔ دوم: تخت و ساده، آبی") },
];
const LOOK_IDS = LOOKS.map((l) => l.id);

export const NAV_ITEMS = [
  { id: "telegram", label: t("تلگرام") },
  { id: "jobs", label: t("جاب") },
  { id: "incidents", label: t("حادثه‌ها") },
  { id: "peers", label: t("ایجنت‌های همکاران") },
  { id: "workbench", label: t("میز کار") },
];
const NAV_IDS = NAV_ITEMS.map((i) => i.id);
// «جای بخش‌ها» in Settings → ظاهر (SectionNav.jsx). «یک ردیف آیکون» is the list with flag navIcons.
// Not in any preset: the rows under «جدید» stay everyone's default (owner 2026-10-24: «برای بقیه به شکل فعلی بمونه»).
export const NAV_STYLES = [
  { id: "list", label: t("ردیف‌ها زیر «جدید»"), hint: t("مثل قبل.") },
  { id: "icons", label: t("یک ردیف آیکون"), hint: t("یک خط آیکون زیر «جدید».") },
  { id: "launcher", label: t("لانچر"), hint: t("یک دکمهٔ شبکه‌ای کنار ایجنت؛ هر بخش را می‌شود زیر «جدید» سنجاق کرد.") },
  { id: "rail", label: t("نوار کناری"), hint: t("ستون آیکون لبهٔ چپ صفحه؛ ثابت یا جمع (با بردن موس به لبه باز می‌شود). روی گوشی ردیف‌ها می‌مانند.") },
  { id: "menu", label: t("منوی کاربر"), hint: t("داخل منوی پایین فهرست، و Ctrl+K برای پیدا کردن بخش با نام.") },
];
/** Which of NAV_STYLES the flags draw. */
export const navStyleChoice = (flags) => (["launcher", "rail", "menu"].includes(flags?.navStyle) ? flags.navStyle : flags?.navIcons ? "icons" : "list");
/** The flags that pick one of NAV_STYLES. */
export const navStyleFlags = (id) => (id === "icons" ? { navStyle: "list", navIcons: true } : id === "list" ? { navStyle: "list", navIcons: false } : { navStyle: id });
// A page a module adds (modules.js moduleNavItems): hideable like the core sections.
const MODULE_NAV_ID = /^m:[a-z0-9-]{2,32}:[a-z0-9-]{1,40}$/;

// Every flag: where it shows in Settings → «ظاهر» (or, for a flag a module owns, its card in «بازارچه»), its plain label and line, and each preset's value.
export const FLAGS = [
  { key: "oneList", area: t("فهرست گفتگوها"), label: t("یک فهرست برای همه"), hint: t("گفتگوها، اجراهای جاب و گفتگوهای ایجنت‌های همکاران در یک فهرست: سنجاق‌شده، گروه‌ها، اخیر. خاموش: هر بخش فهرست خودش."), griffin: false, karsara: true },
  { key: "inboxRow", area: t("فهرست گفتگوها"), label: t("ردیف صندوق تلگرام"), hint: t("وقتی پیام‌های خصوصی تلگرام در صندوق جمع می‌شوند، یک ردیف بالای فهرست."), griffin: false, karsara: true },
  { key: "navMore", area: t("فهرست گفتگوها"), label: t("ردیف «بیشتر»"), hint: t("بخش‌های پنهان زیر یک ردیف «بیشتر» می‌مانند؛ خاموش: اصلاً دیده نمی‌شوند."), griffin: true, karsara: false },
  { key: "navIcons", area: t("فهرست گفتگوها"), label: t("بخش‌ها به‌صورت آیکون"), hint: t("یک ردیف آیکون به‌جای یک ردیف برای هر بخش."), griffin: false, karsara: false },
  { key: "userMenu", area: t("فهرست گفتگوها"), label: t("منوی کاربر پایین فهرست"), hint: t("نام شما یک منو باز می‌کند (ایجنت‌ها، مصرف توکن، تنظیمات). خاموش: دکمه‌های تنظیمات و خروج."), griffin: false, karsara: true },
  { key: "agentLogos", area: t("فهرست گفتگوها"), label: t("لوگوی ایجنت‌ها کنار هر گفتگو"), hint: t("لوگوی ایجنت‌هایی که در آن گفتگو کار کرده‌اند، کنار عنوان (فهرست جدا برای هر بخش و «در جریان» صفحهٔ اول). خاموش: فقط عنوان."), griffin: true, karsara: true },
  { key: "updateInSettings", area: t("فهرست گفتگوها"), label: t("آپدیت فقط در تنظیمات"), hint: t("ردیف نسخهٔ تازه پایین فهرست نمی‌آید؛ یک نقطه روی تنظیمات می‌ماند و آپدیت از تنظیمات ← سلامت (کارسرا: وضعیت) اعمال می‌شود."), griffin: false, karsara: false },
  { key: "updateTopButton", area: t("فهرست گفتگوها"), label: t("دکمهٔ آپدیت بالای صفحه"), hint: t("به‌جای ردیف پایین فهرست، یک آیکون کنار عنوان گفتگو که با آمدن نسخهٔ تازه روشن می‌شود؛ زدنش ری‌استارت و اعمال را ثبت می‌کند."), griffin: false, karsara: false },
  { key: "timeAgo", area: t("فهرست گفتگوها"), label: t("زمان به‌صورت «… پیش»"), hint: t("«۵ دقیقه»، «۲ روز و ۲ ساعت پیش» به‌جای ساعت."), griffin: false, karsara: true },
  { key: "homeBoard", area: t("صفحهٔ اول"), label: t("کارهای منتظر شما و در جریان"), hint: t("صفحهٔ گفتگوی جدید «منتظر شما» و کارهای در جریان را نشان می‌دهد و کادر پایین می‌ماند. خاموش: یک خط معرفی و کادر وسط صفحه."), griffin: true, karsara: false },
  { key: "onePlace", area: t("صفحهٔ اول"), label: t("هر چیز فقط یک جا"), hint: t("تأییدها و سؤال‌ها فقط در خود گفتگو جواب داده می‌شوند و این‌جا فقط یک خط با لینک دارند؛ پیام‌های تلگرام فقط در تلگرام، پیشنهادها فقط در فهرست کنار صفحه؛ «در حال کار» و «تازه تمام شد» این‌جا نمی‌آیند (فهرست کنار صفحه نشانشان می‌دهد)."), griffin: false, karsara: false },
  { key: "telegramChat", area: t("فهرست گفتگوها"), label: t("تلگرام مثل خود تلگرام"), hint: t("هر همکار یک گفتگوی کامل تلگرام با همهٔ پیام‌ها؛ کار دستیار زیر همان پیامی که جوابش است؛ دسته‌ها به‌صورت آیکون. خاموش: چت مادر مثل قبل."), griffin: false, karsara: false },
  { key: "workLogOpen", area: t("گفتگو"), label: t("مراحل کار باز، هنگام اجرا"), hint: t("خاموش: بسته، با یک خط از کاری که همین الان انجام می‌شود."), griffin: false, karsara: true },
  { key: "workInline", area: t("گفتگو"), label: t("روایت ایجنت بین مراحل، مثل کلاد دسکتاپ"), hint: t("حرف‌های ایجنت وسط کار روی صفحه می‌مانند و فقط مرحله‌های بین دو حرف («۳ دستور اجرا شد») جمع می‌شوند. خاموش: همه‌چیز در یک ردیف «کار»."), griffin: true, karsara: false },
  { key: "runFooterDetailed", area: t("گفتگو"), label: t("زیر جواب: مدت، مدل و توکن"), hint: t("خاموش: فقط ساعت و مدل (مدت و توکن با نگه داشتن نشانگر)."), griffin: true, karsara: true },
  { key: "editLinks", area: t("گفتگو"), label: t("«ویرایش» و «برگشت» زیر پیام"), hint: t("به‌صورت متن زیر پیام شما؛ خاموش: دو آیکون کنار پیام."), griffin: true, karsara: true },
  { key: "headerCounts", area: t("گفتگو"), label: t("سرصفحهٔ گفتگو مثل کارسرا"), hint: t("توکنِ کلِ صورت‌حساب‌شده، و «ادامه بعد از سقف» در سرصفحه به‌جای بالای کادر."), griffin: false, karsara: true },
  { key: "sideChatSimple", area: t("گفتگو"), label: t("چت کناری ساده"), hint: t("چت کناری بدون نوار زیر کادر و بدون «بعداً»."), griffin: false, karsara: true },
  { key: "scheduledPeek", area: t("کادر پیام"), label: t("یادداشت‌های زمان‌دار بالای کادر"), hint: t("پیام‌هایی که برای بعد گذاشته‌اید، بالای کادر همین گفتگو."), griffin: true, karsara: false },
  { key: "laterButton", area: t("کادر پیام"), label: t("«بعداً» روی دکمهٔ ارسال"), hint: t("راست‌کلیک (روی گوشی نگه داشتن) دکمهٔ ارسال متن را برای بعد نگه می‌دارد؛ در «یادآورها» پایین صفحهٔ اصلی می‌آید."), griffin: true, karsara: true },
  { key: "nextGhost", area: t("کادر پیام"), label: t("پیشنهاد پیام بعدی داخل کادر"), hint: t("کم‌رنگ داخل کادر خالی (با Tab). خاموش: یک ردیف بالای کادر."), griffin: false, karsara: true },
  { key: "nonClaudeHint", area: t("کادر پیام"), label: t("هشدار موتور غیر Claude"), hint: t("«ابزارها و تصویر ممکن است کامل کار نکنند» زیر کادر، وقتی گفتگو روی موتوری جز ورود Claude است."), griffin: true, karsara: true },
  { key: "fastChip", area: t("کادر پیام"), label: t("حالت سریع کنار مدل"), hint: t("خاموش: داخل منوی مدل."), griffin: false, karsara: true },
  { key: "composerStats", area: t("کادر پیام"), label: t("حلقهٔ مصرف"), hint: t("نشانگر کوچک پنجرهٔ زمینه و سهمیهٔ پلن زیر کادر."), griffin: true, karsara: true },
  { key: "effortSimple", area: t("کادر پیام"), label: t("تلاش: فهرست ساده، فقط برای Claude"), hint: t("خاموش: لغزنده برای هر موتوری که تلاش دارد."), griffin: false, karsara: true },
  { key: "modeSimple", area: t("کادر پیام"), label: t("حالت اجرا: فقط Bypass و Plan"), hint: t("دو حالت کارسرا با همین نام‌ها. خاموش: پنج حالت (خودکار، دستی، پذیرش ویرایش‌ها، برنامه‌ریزی، بدون پرسیدن)."), griffin: false, karsara: true },
  { key: "modelLabels", area: t("کادر پیام"), label: t("نام نسخهٔ مدل‌ها"), hint: t("مثل «Opus 5.5»، و مدلی که اجرا می‌شود به‌جای «خودکار»."), griffin: true, karsara: true },
  { key: "repoChipsAlways", area: t("کادر پیام"), label: t("چیپ‌های بالای کادر همیشه پیدا"), hint: t("سرور، ریپو و شاخه همیشه بالای کادر دیده می‌شوند. خاموش: فقط وقتی موس روی کادر است یا در آن می‌نویسید."), griffin: true, karsara: false },
  { key: "repoCapsule", area: t("کادر پیام"), label: t("چیپ «کپسول»"), hint: t("محیط اجرا «کپسول» نامیده می‌شود و worktree فقط بعد از ساخت شاخه."), griffin: false, karsara: true },
  { key: "settingsList", area: t("تنظیمات"), label: t("فهرست تنظیمات کارسرا"), hint: t("بدون گروه، «وضعیت» اول، هر بار از «وضعیت» باز می‌شود."), griffin: false, karsara: true },
  { key: "setupFlat", area: t("تنظیمات"), label: t("ویزارد راه‌اندازی ساده"), hint: t("کارت‌های تخت، بدون آیکون‌های تزئینی."), griffin: false, karsara: true },
];
const FLAG_KEYS = FLAGS.map((f) => f.key);

// The sections of the sidebar that are HIDDEN in each preset (they go under «بیشتر», or nowhere): not a switch, a list.
// «ایجنت‌های همکاران» shows by default in both. (A module page is shown unless hidden.)
const NAV_PRESET = { griffin: NAV_IDS.filter((id) => id !== "peers"), karsara: ["telegram", "incidents", "workbench"] };

/** A preset: the look and every flag as that product draws it. */
export function presetOf(look) {
  const id = LOOK_IDS.includes(look) ? look : "griffin";
  return { look: id, flags: { ...Object.fromEntries(FLAGS.map((f) => [f.key, f[id]])), navHidden: [...NAV_PRESET[id]] } };
}

// The stored prefs' revision. A flag whose preset value changed is listed under the revision that
// changed it: a copy saved before that revision drops it, so the new preset value applies once (a
// choice made after it is the user's and stays). 1: «بعداً» on in Griffin's preset too, so the
// notes list in the sidebar can fill. 2: Karsara's usage ring, detailed run footer,
// model version names, non-Claude hint and edit links on in Griffin's preset too (owner 2026-10-20).
// 3: «ایجنت‌های همکاران» in the menu by default (owner 2026-10-19).
// 4: the repo chips above the box always shown in Griffin's preset (owner 2026-10-22).
export const PREFS_REV = 4;
const CHANGED_AT = { 1: ["laterButton"], 2: ["composerStats", "runFooterDetailed", "modelLabels", "nonClaudeHint", "editLinks"], 4: ["repoChipsAlways"] };
// Rev 3 moved «ایجنت‌های همکاران» out of Griffin's hidden list. Only a copy that is exactly the old Griffin preset
// (all five hidden: nobody changed it) follows; a list the user edited, or a snapshot of another look, stays.
const OLD_GRIFFIN_NAV = ["telegram", "jobs", "incidents", "peers", "workbench"];

/** What a stored value may hold: known flags with the right type; anything else is dropped. */
export function cleanPrefs(value) {
  const out = {};
  if (LOOK_IDS.includes(value?.look)) out.look = value.look;
  if (Number.isInteger(value?.rev)) out.rev = value.rev;
  const flags = {};
  for (const key of FLAG_KEYS) if (typeof value?.flags?.[key] === "boolean") flags[key] = value.flags[key];
  if (Array.isArray(value?.flags?.navHidden)) flags.navHidden = [...new Set(value.flags.navHidden.filter((id) => NAV_IDS.includes(id) || MODULE_NAV_ID.test(id)))];
  // «جای بخش‌ها» (components/SectionNav.jsx) and whether the rail stays open.
  if (NAV_STYLES.some((st) => st.id === value?.flags?.navStyle && st.id !== "icons")) flags.navStyle = value.flags.navStyle;
  if (typeof value?.flags?.railPinned === "boolean") flags.railPinned = value.flags.railPinned;
  // The order the owner dragged the sections into (Sidebar.jsx, drag.js); unknown ids are harmless.
  if (Array.isArray(value?.flags?.navOrder)) flags.navOrder = [...new Set(value.flags.navOrder.filter((id) => NAV_IDS.includes(id) || MODULE_NAV_ID.test(id)))];
  out.flags = flags;
  return out;
}

/** The applied prefs: what is stored (the user's choices and the migration snapshot) over the install's preset. */
export function resolvePrefs(stored, installLook) {
  const clean = cleanPrefs(stored);
  for (const [rev, keys] of Object.entries(CHANGED_AT)) if ((clean.rev || 0) < Number(rev)) for (const key of keys) delete clean.flags[key];
  const hiddenNow = clean.flags.navHidden;
  if ((clean.rev || 0) < 3 && hiddenNow && hiddenNow.length === OLD_GRIFFIN_NAV.length && OLD_GRIFFIN_NAV.every((id) => hiddenNow.includes(id)) && clean.look !== "karsara") clean.flags.navHidden = presetOf("griffin").flags.navHidden;
  // A flag nobody stored (one added after the snapshot) takes the install's preset.
  const base = presetOf(installLook);
  return { look: clean.look || base.look, flags: { ...base.flags, ...clean.flags } };
}

/**
 * The first load after the update, for a user with nothing stored: exactly what this browser showed
 * — its saved skin (griffin.skin) else the install's, and Griffin's sidebar sections as set here
 * (griffin.sidebar.nav.v2; the Karsara sidebar never read them).
 */
export function migrationSnapshot({ savedSkin = null, installLook = "griffin", nav = null } = {}) {
  const look = LOOK_IDS.includes(savedSkin) ? savedSkin : LOOK_IDS.includes(installLook) ? installLook : "griffin";
  const snap = presetOf(look);
  if (look === "griffin" && nav && typeof nav === "object") {
    if (Array.isArray(nav.hidden)) snap.flags.navHidden = [...new Set(nav.hidden.filter((id) => NAV_IDS.includes(id)))];
    if (nav.style === "icons" || nav.style === "list") snap.flags.navIcons = nav.style === "icons";
  }
  return snap;
}

// --- The page's store: <html data-look>, a cache for the next first paint, and the server copy. ---
const CACHE = "griffin.ui"; // the resolved prefs, so the next load paints right before the server answers
const LEGACY_SKIN = "griffin.skin";
const LEGACY_NAV = "griffin.sidebar.nav.v2";

const read = (key) => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
const write = (key, value) => {
  try {
    localStorage.setItem(key, value);
  } catch {
    // storage blocked: this page only
  }
};
const parse = (raw) => {
  try {
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
};

let installLook = "griffin";
let state = null;
const listeners = new Set();

function legacySnapshot() {
  return migrationSnapshot({ savedSkin: read(LEGACY_SKIN), installLook, nav: parse(read(LEGACY_NAV)) });
}

function set(next) {
  state = next;
  if (!next) return;
  if (typeof document !== "undefined") document.documentElement.dataset.look = next.look;
  write(CACHE, JSON.stringify(next));
  for (const listener of listeners) listener();
}

const snapshot = () => {
  if (!state) {
    const cached = parse(read(CACHE));
    state = cached ? resolvePrefs(cached, installLook) : legacySnapshot();
  }
  return state;
};

/** The install's preset is known (brand info): paint from the cache, or what this browser showed before the update. */
export function setInstallLook(install) {
  if (LOOK_IDS.includes(install)) installLook = install;
  state = null;
  set(snapshot());
}

/**
 * Signed in: take the server's copy — or, when the server has none yet (the first load after the
 * update), save this browser's snapshot there once.
 */
let markReady;
/** Settled once the server's copy is in (or could not be read): a redirect that hangs on a flag waits for it. */
export const uiPrefsReady = new Promise((resolve) => {
  markReady = resolve;
});

export async function loadUiPrefs({ request = api } = {}) {
  try {
    await loadFromServer(request);
  } finally {
    markReady();
  }
}

async function loadFromServer(request) {
  try {
    const { stored } = await request("/api/ui-prefs");
    if (stored) return set(resolvePrefs(stored, installLook));
    const snap = legacySnapshot();
    set(snap);
    await request("/api/ui-prefs", { method: "PUT", body: { ...snap, rev: PREFS_REV, migrated: true } });
  } catch {
    // offline: the cached prefs stay
  }
}

/** The user's own choice: a look and/or flags, saved for every device. */
export function setUiPrefs(patch) {
  const current = snapshot();
  const next = resolvePrefs({ look: patch.look || current.look, flags: { ...current.flags, ...(patch.flags || {}) } }, installLook);
  set(next);
  return api("/api/ui-prefs", { method: "PUT", body: { look: next.look, flags: next.flags, rev: PREFS_REV } }).catch(() => {});
}

/** A preset as a starting point: its look and all its flags. */
export const applyPreset = (look) => setUiPrefs(presetOf(look));

/** "Back to the install's default": nothing of the user's stays; the install's preset applies (and follows it). */
export function resetUiPrefs() {
  set(presetOf(installLook));
  return api("/api/ui-prefs", { method: "DELETE" }).catch(() => {});
}

export const installPreset = () => installLook;

function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export const useUiPrefs = () => useSyncExternalStore(subscribe, snapshot, snapshot);
export const useLook = () => useUiPrefs().look;
export const useFlag = (key) => useUiPrefs().flags[key];
/** A flag outside React (after uiPrefsReady). */
export const uiFlag = (key) => snapshot().flags[key];
