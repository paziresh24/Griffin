// UI language. The Persian string is the key: code reads the same as before, and English comes
// from src/i18n/en/*.json (one file per module, merged at build time). A missing entry falls back
// to the Persian text, so a forgotten translation shows up as Persian, never as a blank.

const STORAGE_KEY = "griffin.lang";

function initialLang() {
  if (typeof document === "undefined") return "fa"; // node tests: Persian keys, no Vite glob
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === "fa" || saved === "en") return saved;
  } catch {
    // storage unavailable: fall through to the browser language
  }
  const langs = typeof navigator !== "undefined" ? navigator.languages || [navigator.language] : [];
  return langs.some((l) => String(l).toLowerCase().startsWith("fa")) ? "fa" : "en";
}

export const lang = initialLang();
export const isRtl = lang === "fa";
export const locale = lang === "fa" ? "fa-IR" : "en-US";

const EN = lang === "en"
  ? Object.assign({}, ...Object.values(import.meta.glob("./i18n/en/*.json", { eager: true, import: "default" })))
  : {};

/** Translate a Persian UI string. `{name}` placeholders are filled from `vars`. */
export function t(fa, vars) {
  let text = (lang === "en" && EN[fa]) || fa;
  if (vars) text = text.replace(/\{(\w+)\}/g, (match, key) => (key in vars ? String(vars[key]) : match));
  return text;
}

/** A number in the UI language's digits. */
export function num(value, options) {
  return Number(value).toLocaleString(locale, options);
}

export function setLang(next) {
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // storage unavailable: the choice lasts for this page only
  }
  window.location.reload();
}

export function applyDocumentLang() {
  document.documentElement.lang = lang;
  document.documentElement.dir = isRtl ? "rtl" : "ltr";
  document.title = lang === "fa" ? "گریفین" : "Griffin";
}
