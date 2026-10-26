import { t } from "./i18n.js";
// Modules (modules/<id>/, docs/modules.md): the web side is generic (the hooks are in module-hooks.js). The server says which modules
// are on and what their pages look like (module.json); this file and ModulePage.jsx draw them. A
// module adds a page without a line of React.

const ROUTE = /^#\/m\/([a-z0-9-]{2,32})\/([a-z0-9-]{1,40})$/;

export const modulePath = (moduleId, pageId) => `/m/${moduleId}/${pageId}`;

/** "#/m/<module>/<page>" -> { module, page }, else null. */
export function parseModuleRoute(hash) {
  const m = ROUTE.exec(String(hash || ""));
  return m ? { module: m[1], page: m[2] } : null;
}

// The words a module.json shows (titles, labels, hints) are Persian keys like any other UI text;
// the agent's own prompt and profile fields stay as written.
const SHOWN = new Set(["title", "description", "label", "hint", "choice", "switchNote", "blurb", "placeholder", "empty"]);
const NAMES = new Set(["pages", "agents"]);

/** A module manifest from the server with its shown words in the UI language. */
export function translateManifest(value) {
  if (Array.isArray(value)) return value.map(translateManifest);
  if (!value || typeof value !== "object") return value;
  const out = {};
  for (const [key, v] of Object.entries(value)) {
    if (typeof v === "string") out[key] = SHOWN.has(key) ? t(v) : v;
    // adds.pages / adds.agents: the names the marketplace card lists
    else if (NAMES.has(key) && Array.isArray(v)) out[key] = v.map((x) => (typeof x === "string" ? t(x) : translateManifest(x)));
    else out[key] = translateManifest(v);
  }
  return out;
}

/** The sidebar entries: one per page of every enabled module. */
export function moduleNavItems(modules) {
  const items = [];
  for (const mod of modules || []) {
    for (const page of mod.pages || []) {
      if (page.kind === "builtin") continue; // the core sections (NAV_ITEMS) draw themselves
      items.push({ id: `m:${mod.id}:${page.id}`, label: page.title, icon: page.icon, path: modulePath(mod.id, page.id), module: mod.id, page: page.id });
    }
  }
  return items;
}

/**
 * Is this core section (telegram, jobs, …) on in this install? Until the module list has arrived
 * (null) every section shows, so the menu does not jump on load.
 */
export const sectionOn = (modules, id) => modules === null || modules === undefined || modules.some((m) => m.id === id);

/** The pages that are modules' builtin sections, and the module each belongs to; every other page (settings, setup, …) is always there. */
// The Telegram inbox page is deliberately not here: it was always reachable and stays so, whichever
// Telegram variant is on (the variants only choose how DMs are answered, they never hide a screen).
export const SECTION_MODULE = { telegram: "telegram", jobs: "jobs", incidents: "incidents", peers: "peers", workbench: "workbench" };
export const SECTION_PAGES = Object.keys(SECTION_MODULE);

/** True when this page is a core section whose module is off in this install. */
export const pageOff = (modules, page) => page in SECTION_MODULE && !sectionOn(modules, SECTION_MODULE[page]);

/** A filter box's values as a query string; empty values are left out. */
export function filterQuery(values) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values || {})) if (String(value ?? "").trim()) params.set(key, String(value).trim());
  return params.toString();
}

/** The filters' starting values: each filter's default, else empty. */
export function initialFilters(page) {
  return Object.fromEntries((page?.filters || []).map((f) => [f.key, f.default || ""]));
}

/** What a row's cell shows, as text; a missing value is a dash. Time cells are the browser's local time. */
export function cellText(field, row) {
  const value = row?.[field.key];
  if (value === null || value === undefined || value === "") return "—";
  if (field.type === "time") {
    const at = new Date(value);
    return Number.isNaN(at.getTime()) ? String(value) : at.toLocaleString("fa-IR", { dateStyle: "short", timeStyle: "short" });
  }
  return String(value);
}

/** An action's answer: the chat to open (the page makes it through the ordinary chat API), a note, or nothing. */
export function actionOutcome(result) {
  if (result?.openChat?.text) return { kind: "chat", chat: result.openChat };
  if (typeof result?.message === "string" && result.message) return { kind: "message", message: result.message };
  return { kind: "none" };
}

/**
 * What a switch will do, as the lines the owner reads before confirming (the server's plan, no
 * judgement here). Each line: { tone: "off" | "on" | "fix" | "note", text }.
 */
export function planLines(plan) {
  if (!plan) return [];
  const lines = [];
  for (const step of plan.steps || []) {
    if (step.kind === "disable") {
      lines.push({ tone: "off", text: t("«{title}» خاموش می‌شود — {why}", { title: t(step.title), why: step.why }) });
      if (step.chats) lines.push({ tone: "note", text: t("{chats} گفتگوی آن به پوشهٔ «{folder}» در فهرست گفتگوها می‌رود (چیزی پاک نمی‌شود)", { chats: step.chats, folder: step.folder }) });
    } else if (step.kind === "enable") {
      lines.push({ tone: "on", text: t("«{title}» روشن می‌شود{v}", { title: t(step.title), v: step.why ? ` — ${step.why}` : "" }) });
      if (step.restores) lines.push({ tone: "note", text: t("{restores} گفتگوی قبلی آن از پوشه به جای اولشان برمی‌گردد", { restores: step.restores }) });
    } else if (step.kind === "fix") {
      lines.push({ tone: "fix", text: t("تنظیم «{title}» با وضعیت واقعی نمی‌خواند — {why}؛ درست می‌شود", { title: t(step.title), why: step.why }) });
    }
  }
  for (const [key, value] of Object.entries(plan.config || {})) lines.push({ tone: "note", text: t("تنظیم {key} روی «{value}» می‌رود", { key, value }) });
  for (const note of plan.notes || []) lines.push({ tone: "note", text: note });
  return lines;
}

/** The small facts under a module's name in the marketplace. */
export function moduleFacts(mod) {
  const facts = [];
  if (mod.builtin) facts.push(t("بخش خود گریفین"));
  if (mod.adds?.agents?.length) facts.push(t("ایجنت: {join}", { join: mod.adds.agents.join(t("، ")) }));
  if (mod.adds?.tools) facts.push(t("{tools} ابزار", { tools: mod.adds.tools }));
  if (mod.adds?.pages?.length && !mod.builtin) facts.push(t("صفحه: {join}", { join: mod.adds.pages.join(t("، ")) }));
  if (mod.chats) facts.push(t("{chats} گفتگو", { chats: mod.chats }));
  if (mod.preset) facts.push(t("پیش‌فرض این محصول"));
  return facts;
}

/** A select filter's option: a plain string, or { value, label }. */
export const optionOf = (option) => (option && typeof option === "object" ? { value: option.value, label: option.label || option.value } : { value: String(option), label: String(option) });

/** Does the search box's text match a row? Every word must appear in the row's text cells. */
export function rowMatches(row, text) {
  const words = String(text || "").toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = Object.values(row || {}).filter((v) => typeof v === "string" || typeof v === "number").join(" ").toLowerCase();
  return words.every((w) => hay.includes(w));
}

/**
 * The shelves of a page that has groupBy: the rows that match the search, put on their shelf, in the
 * shelves' order. `counts` says how many each shelf holds (so the chips show them); `only` shows a
 * single shelf. A row whose category no shelf names goes on a last shelf «بقیه».
 */
export function shelves(page, rows, { search = "", only = "" } = {}) {
  const groupBy = page?.groupBy;
  const matching = (rows || []).filter((row) => rowMatches(row, search));
  if (!groupBy) return { shelves: [{ key: "", label: "", tone: "muted", hint: "", rows: matching }], counts: {}, total: matching.length };
  const known = new Set(groupBy.groups.map((g) => g.key));
  const groups = [...groupBy.groups, { key: "_other", label: t("بقیه"), tone: "muted", hint: "" }];
  const counts = {};
  const out = groups.map((g) => {
    const list = matching.filter((row) => (known.has(row[groupBy.field]) ? row[groupBy.field] : "_other") === g.key);
    counts[g.key] = list.length;
    return { ...g, rows: list };
  });
  return { shelves: out.filter((s) => s.rows.length && (!only || s.key === only)), counts, total: matching.length };
}

// The marketplace's shelves, in order (a module's category is in its module.json).
export const MARKET_SHELVES = [
  { key: "team", label: t("همکاری و ارتباط"), hint: t("تلگرام و ایجنت‌های همکاران") },
  { key: "support", label: t("پشتیبانی"), hint: t("پشتیبانی مشتری‌ها") },
  { key: "ops", label: t("عملیات و پایش"), hint: t("هشدارها و کارهای زمان‌بندی‌شده") },
  { key: "dev", label: t("کد و توسعه"), hint: t("مرج ریکوئست‌ها و کار روی ریپوها") },
  { key: "tools", label: t("ابزارها"), hint: "" },
  { key: "other", label: t("بقیه"), hint: "" },
];

/** «تلگرام (صندوق، مثل کارسرا)» -> { group: t("تلگرام"), option: t("صندوق، مثل کارسرا") }; a plain title is its own option. */
export function titleParts(title) {
  const m = /^(.+?)\s*\((.+)\)\s*$/.exec(String(title || ""));
  return m ? { group: m[1], option: m[2] } : { group: String(title || ""), option: String(title || "") };
}

const entryText = (e) => (e.kind === "choice" ? [e.title, e.question, ...e.options.flatMap((o) => [o.title, o.description])] : [e.mod.title, e.mod.description]).join(" ").toLowerCase();

/**
 * The marketplace as the owner reads it: modules on shelves by category, and modules that fill the
 * same slot (two ways of answering Telegram) as ONE choice with options instead of two switches.
 * `show`: all | on | off; a choice is «on» when one of its options is. `counts` are before `show`.
 */
export function marketView(modules, { show = "all", search = "" } = {}) {
  const list = modules || [];
  const bySlot = new Map();
  for (const m of list) for (const slot of m.provides || []) bySlot.set(slot, [...(bySlot.get(slot) || []), m]);
  const taken = new Set();
  const entries = [];
  for (const m of list) {
    if (taken.has(m.id)) continue;
    const slot = (m.provides || []).find((s) => bySlot.get(s).length > 1);
    if (slot) {
      const mods = bySlot.get(slot).filter((o) => !taken.has(o.id));
      for (const o of mods) taken.add(o.id);
      const parts = mods.map((o) => titleParts(o.title));
      entries.push({
        kind: "choice",
        key: `slot:${slot}`,
        category: mods[0].category || "other",
        title: parts.every((p) => p.group === parts[0].group) ? parts[0].group : slot,
        question: mods.map((o) => o.choice).find(Boolean) || t("یکی را انتخاب کنید"),
        options: mods.map((o, i) => ({ ...o, label: parts[i].option })),
        enabled: mods.find((o) => o.enabled) || null,
        on: mods.some((o) => o.enabled),
        attention: mods.some((o) => o.error || o.drift),
      });
    } else {
      taken.add(m.id);
      entries.push({ kind: "one", key: m.id, category: m.category || "other", mod: m, on: m.enabled, attention: Boolean(m.error || m.drift) });
    }
  }
  const words = String(search || "").toLowerCase().split(/\s+/).filter(Boolean);
  const found = entries.filter((e) => words.every((w) => entryText(e).includes(w)));
  const counts = { all: found.length, on: found.filter((e) => e.on).length, off: found.filter((e) => !e.on).length };
  const shown = found.filter((e) => show === "all" || (show === "on" ? e.on : !e.on));
  const name = (e) => (e.kind === "choice" ? e.title : e.mod.title);
  const known = new Set(MARKET_SHELVES.map((s) => s.key));
  const shelves = MARKET_SHELVES.map((s) => ({
    ...s,
    entries: shown
      .filter((e) => (known.has(e.category) ? e.category : "other") === s.key)
      .sort((a, b) => Number(b.attention) - Number(a.attention) || Number(b.on) - Number(a.on) || name(a).localeCompare(name(b), "fa")),
  })).filter((s) => s.entries.length);
  return { shelves, counts };
}

/** The small tags on a module card: what it brings, in words. */
export function moduleTags(mod) {
  const tags = [];
  // A page named like the module itself (every builtin section) says nothing new.
  const pages = (mod.adds?.pages || []).filter((p) => p && !String(mod.title || "").startsWith(p));
  if (pages.length) tags.push(t("صفحهٔ «{join}»", { join: pages.join(t("»، «")) }));
  if (mod.adds?.agents?.length) tags.push(t("ایجنت «{join}»", { join: mod.adds.agents.join(t("»، «")) }));
  if (mod.adds?.tools) tags.push(t("{toLocaleString} ابزار", { toLocaleString: Number(mod.adds.tools).toLocaleString("fa-IR") }));
  if (mod.chats) tags.push(t("{toLocaleString} گفتگو", { toLocaleString: Number(mod.chats).toLocaleString("fa-IR") }));
  return tags;
}

/**
 * What a module's card offers under «تنظیمات»: its core settings (rows of /api/config, in the order
 * module.json lists them), its own settings, the per-user UI flags it owns, and its pages that are
 * menu entries (a builtin page only if the menu knows it: `navIds`). Empty parts are empty arrays.
 */
export function moduleSettings(mod, { config = [], flags = [], navIds = [] } = {}) {
  const byKey = new Map(config.map((s) => [s.key, s]));
  const known = new Set(navIds);
  return {
    config: (mod?.settings?.config || []).map((k) => byKey.get(k)).filter(Boolean),
    own: mod?.settings?.own || [],
    flags: flags.filter((f) => (mod?.settings?.flags || []).includes(f.key)),
    nav: (mod?.nav || []).filter((p) => !p.builtin || known.has(p.id)),
  };
}

/** How many things the card's «تنظیمات» holds. */
export const settingsCount = (s) => s.config.length + s.own.length + s.flags.length + s.nav.length;

/** The UI flags some installed module owns: Settings → ظاهر leaves them to the module's card. */
export const ownedFlags = (market) => new Set((market || []).flatMap((m) => m.settings?.flags || []));
