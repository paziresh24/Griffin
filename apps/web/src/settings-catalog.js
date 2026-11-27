// Every setting a person can change, in one list and in the words they read (owner 2026-11-23: «یه
// سیستمی بسازی که به کاربر پیشنهاد یک تنظیم رو بده با ai»). The server builds the model's question from it
// and checks the answer against it (settings-suggest.mjs); the page draws the suggestion card from the
// same entries: what is on now, what would change, for whom, and whether one click may do it.
// No React, no fetch: node imports it (the server, tests).
//
// An entry:
//   id       set:<KEY> (a server setting), flag:<key> (a switch of «ظاهر»), choice:<id> (one choice made of
//            several flags), tab:<section> (a place: «where do I add a Telegram bot?») — the same ids as the
//            search of settings-map.js, so «برو به تنظیم» opens the same row
//   scope    "install" every chat of this install · "you" your own view, on every device · null a place
//   options  [{ value, label }] · null for a free value (an address, a model name): never set from here
//   current  the value now, or null when unknown
import { t } from "./i18n.js";
import { FEATURES, FEATURE_GROUPS, featureOf, featureValue, isSwitch } from "./settings-features.js";
import { FLAGS, LOOKS, NAV_STYLES, navStyleChoice, navStyleFlags } from "./ui-flags.js";
import { FLAGS_ELSEWHERE, MERGED_FLAGS, ZONES, homeChoice, homeFlags, pageOf, pagesFor, updateChoice, updateFlags, workChoice, workFlags } from "./settings-map.js";

const ON_OFF = [{ value: "on", label: t("روشن") }, { value: "off", label: t("خاموش") }];
const opts = (pairs) => pairs.map(([value, label]) => ({ value, label }));

// The choices of «ظاهر» that set several flags at once (Appearance.jsx); `focus` is their row there.
const CHOICES = [
  {
    id: "look", zone: "look", focus: null, title: t("سبک ظاهر"), help: LOOKS.map((l) => `${l.label}: ${l.note}`).join(t("؛ ")),
    options: LOOKS.map((l) => ({ value: l.id, label: l.label })),
    read: (prefs) => prefs.look, write: (value) => ({ look: value }),
  },
  {
    id: "nav", zone: "sidebar", focus: "navIcons", title: t("جای بخش‌ها"), help: t("تلگرام، جاب، حادثه‌ها و بقیهٔ بخش‌ها کجای صفحه باشند."),
    options: NAV_STYLES.map((s) => ({ value: s.id, label: s.label })),
    read: (prefs) => navStyleChoice(prefs.flags), write: (value) => ({ flags: navStyleFlags(value) }),
  },
  {
    id: "update", zone: "sidebar", focus: "updateTopButton", title: t("خبر نسخهٔ تازه کجا بیاید"), help: t("یک ردیف پایین فهرست، یک آیکون بالای صفحه، یا فقط یک نقطه روی تنظیمات."),
    options: opts([["list", t("پایین فهرست")], ["top", t("بالای صفحه")], ["settings", t("فقط در تنظیمات")]]),
    read: (prefs) => updateChoice(prefs.flags), write: (value) => ({ flags: updateFlags(value) }),
  },
  {
    id: "home", zone: "home", focus: "homeBoard", title: t("صفحهٔ گفتگوی جدید چه نشان بدهد"), help: t("ساده: یک خط معرفی. کارها: «منتظر شما» و کارهای در جریان. هر چیز یک جا: تأییدها فقط در خود گفتگو."),
    options: opts([["simple", t("ساده")], ["board", t("کارها")], ["one", t("هر چیز فقط یک جا")]]),
    read: (prefs) => homeChoice(prefs.flags), write: (value) => ({ flags: homeFlags(value) }),
  },
  {
    id: "work", zone: "chat", focus: "workInline", title: t("مراحل کار ایجنت"), help: t("یک خط: بسته. باز: همهٔ مراحل هنگام اجرا. روایت: حرف‌های ایجنت روی صفحه می‌مانند و مراحل بین آن‌ها جمع می‌شوند."),
    options: opts([["fold", t("یک خط")], ["open", t("باز")], ["inline", t("روایت")]]),
    read: (prefs) => workChoice(prefs.flags), write: (value) => ({ flags: workFlags(value) }),
  },
];
const CHOICE_BY_ID = new Map(CHOICES.map((c) => [c.id, c]));

/**
 * The list. `rows` are /api/config's settings (null: the server's values unknown), `prefs` the resolved
 * look and flags ({ look, flags }, null: unknown), `hub` the maintainer's install (its own tabs).
 */
export function settingsCatalog({ rows = null, prefs = null, hub = false } = {}) {
  const pages = pagesFor(hub);
  const byKey = new Map((rows || []).map((r) => [r.key, r]));
  const appearance = pageOf("appearance", pages).label;
  const entries = [];
  for (const page of pages) {
    for (const s of page.sections) {
      entries.push({ id: `tab:${s.id}`, kind: "place", title: s.label === page.label ? page.label : s.label, help: s.description, where: page.label, section: s.id, focus: null, scope: null, options: null, current: null });
    }
  }
  for (const feature of FEATURES) {
    const row = byKey.get(feature.key);
    const group = FEATURE_GROUPS.find((g) => g.id === feature.group);
    const section = row?.modules?.length ? "market" : group.section;
    const options = feature.choices ? Object.entries(feature.choices).map(([value, label]) => ({ value, label })) : isSwitch(feature) ? ON_OFF : null;
    entries.push({
      id: `set:${feature.key}`, kind: "config", key: feature.key, title: feature.title, help: feature.help,
      where: `${pageOf(section, pages).label} ← ${group.label}`, section, focus: feature.key, scope: "install", options,
      requires: feature.requires || null, careful: Boolean(feature.careful), restart: Boolean(feature.restart),
      current: rows ? featureValue(feature, row) : null, saved: row?.value ?? "",
    });
  }
  for (const flag of FLAGS) {
    if (MERGED_FLAGS[flag.key]) continue; // one of CHOICES
    const elsewhere = Object.entries(FLAGS_ELSEWHERE).find(([, keys]) => keys.includes(flag.key))?.[0];
    const zone = ZONES.find((z) => z.flags.includes(flag.key));
    entries.push({
      id: `flag:${flag.key}`, kind: "flag", key: flag.key, title: flag.label, help: flag.hint,
      where: elsewhere ? pageOf(elsewhere, pages).label : `${appearance} ← ${zone?.label || flag.area}`, section: elsewhere || "appearance", focus: flag.key,
      scope: "you", options: ON_OFF, current: prefs ? (prefs.flags?.[flag.key] ? "on" : "off") : null,
    });
  }
  for (const choice of CHOICES) {
    const zone = ZONES.find((z) => z.id === choice.zone);
    entries.push({
      id: `choice:${choice.id}`, kind: "choice", key: choice.id, title: choice.title, help: choice.help,
      where: `${appearance} ← ${zone.label}`, section: "appearance", focus: choice.focus, scope: "you", options: choice.options,
      current: prefs ? choice.read({ look: prefs.look, flags: prefs.flags || {} }) : null,
    });
  }
  return entries;
}

/** What a value reads as on the card: its option's label, the free value itself, or «خالی». */
export function valueLabel(entry, value) {
  if (value == null || value === "") return t("خالی");
  return entry?.options?.find((o) => o.value === value)?.label || String(value);
}

// Why one click may not do it: the card opens the row instead and says why.
export const NO_CLICK = {
  text: t("مقدارش را خودتان در صفحهٔ تنظیم بنویسید."),
  careful: t("این تنظیم روی امنیت، همکاران یا داده‌ها اثر دارد؛ در صفحهٔ خودش و با خواندن توضیحش عوضش کنید."),
  restart: t("بعد از ری‌استارت اعمال می‌شود؛ از صفحهٔ خودش عوضش کنید."),
  same: t("همین الان همین است."),
  blocked: t("اول باید «{by}» روشن شود، که از صفحهٔ خودش انجام می‌شود."),
};

/**
 * What «اعمال» would do: { ok: true, patch: { config?, flags?, look? }, also: [titles turned on with it] },
 * or { ok: false, why } (a key of NO_CLICK, with `by` for "blocked"). Never applies anything itself.
 */
export function applyPlan(entry, value, entries = []) {
  if (!entry || entry.kind === "place") return { ok: false, why: "place" };
  if (!entry.options) return { ok: false, why: "text" };
  if (!entry.options.some((o) => o.value === value)) return { ok: false, why: "text" };
  if (entry.careful) return { ok: false, why: "careful" };
  if (entry.restart) return { ok: false, why: "restart" };
  if (entry.current != null && entry.current === value) return { ok: false, why: "same" };
  if (entry.kind === "config") {
    const config = { [entry.key]: value };
    const also = [];
    // A switch it hangs on that is off comes on with it, when one click may turn that one on too.
    if (value !== "off") {
      for (let up = featureOf(entry.requires); up; up = featureOf(up.requires)) {
        const parent = entries.find((e) => e.id === `set:${up.key}`);
        if (!parent || parent.current === "on") continue;
        if (parent.careful || parent.restart) return { ok: false, why: "blocked", by: parent.title };
        config[up.key] = "on";
        also.push(parent.title);
      }
    }
    return { ok: true, patch: { config }, also };
  }
  if (entry.kind === "flag") return { ok: true, patch: { flags: { [entry.key]: value === "on" } }, also: [] };
  const choice = CHOICE_BY_ID.get(entry.key);
  return choice ? { ok: true, patch: choice.write(value), also: [] } : { ok: false, why: "text" };
}

/**
 * What puts things back as they were before `plan` (the card's «برگردان»): a server setting goes back to
 * what was saved (empty = the install's default again), a look choice to what it read. Null when unknown.
 */
export function undoPatch(entry, plan, entries = []) {
  if (!plan?.ok || entry?.current == null) return null;
  if (entry.kind === "config") {
    return { config: Object.fromEntries(Object.keys(plan.patch.config).map((key) => [key, entries.find((e) => e.id === `set:${key}`)?.saved ?? ""])) };
  }
  if (entry.kind === "flag") return { flags: { [entry.key]: entry.current === "on" } };
  return CHOICE_BY_ID.get(entry.key)?.write(entry.current) || null;
}

// A server setting changed on this page (a suggestion card, or a row of Settings): every view of
// /api/config reads it again (Config.jsx, SettingsSuggest.jsx).
export const CONFIG_EVENT = "griffin:config-changed";
export function configChanged(source = "") {
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(CONFIG_EVENT, { detail: { source } }));
}

/** Where a change lands, in the card's words. */
export const scopeLabel = (scope) => (scope === "install" ? t("برای همهٔ گفتگوهای این نصب") : scope === "you" ? t("فقط صفحهٔ شما، روی همهٔ دستگاه‌ها") : "");
