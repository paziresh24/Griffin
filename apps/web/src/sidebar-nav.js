// Which of the sidebar's top sections show, and how (Settings → ظاهر), per browser. Hidden ones go
// to the «بیشتر» menu at the end, so none is out of reach. «کم» is Karsara's short list.
import { useSyncExternalStore } from "react";
import { t } from "./i18n.js";

export const NAV_ITEMS = [
  { id: "telegram", label: t("تلگرام") },
  { id: "jobs", label: t("جاب") },
  { id: "incidents", label: t("حادثه‌ها") },
  { id: "peers", label: t("ایجنت‌های همکاران") },
  { id: "workbench", label: t("میز کار") },
];
export const NAV_STYLES = [
  { id: "list", label: t("فهرست"), note: t("هر بخش یک ردیف با اسم") },
  { id: "icons", label: t("آیکون"), note: t("یک ردیف آیکون؛ اسم با نگه داشتن نشانگر") },
];
export const NAV_PRESETS = [
  { id: "all", label: t("همه"), hidden: [] },
  { id: "few", label: t("کم (مثل کارسرا)"), hidden: ["jobs", "incidents", "peers", "workbench"] },
];

const KEY = "griffin.sidebar.nav";
const DEFAULT = { style: "list", hidden: [] };
const ids = new Set(NAV_ITEMS.map((i) => i.id));

export function cleanNav(value) {
  const style = NAV_STYLES.some((s) => s.id === value?.style) ? value.style : DEFAULT.style;
  const hidden = Array.isArray(value?.hidden) ? [...new Set(value.hidden.filter((id) => ids.has(id)))] : [];
  return { style, hidden };
}

function read() {
  try {
    return cleanNav(JSON.parse(localStorage.getItem(KEY) || "null"));
  } catch {
    return { ...DEFAULT };
  }
}

let current = null;
const listeners = new Set();
const snapshot = () => (current ??= read());

export function setNavPrefs(patch) {
  current = cleanNav({ ...snapshot(), ...patch });
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    // private mode: kept for this tab only
  }
  for (const listener of listeners) listener();
}

function subscribe(listener) {
  listeners.add(listener);
  // Another tab of the same browser changed it.
  const onStorage = (event) => {
    if (event.key !== KEY) return;
    current = null;
    listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

export const useNavPrefs = () => useSyncExternalStore(subscribe, snapshot);
