// The browser tab names where the owner is — the open chat's title or the page (and settings
// section) — with the brand last, so several tabs tell apart.
import { BRAND } from "./brand.js";
import { t } from "./i18n.js";

const PAGE_TITLES = {
  settings: t("تنظیمات"),
  setup: t("راه‌اندازی"),
  telegram: t("تلگرام"),
  jobs: t("جاب‌ها"),
  incidents: t("حادثه‌ها"),
  peers: t("ایجنت‌های همکاران"),
  workbench: t("میز کار"),
  agents: t("ایجنت‌ها"),
};

// `needs`: how many things wait for the owner (the inbox) — «(۲) » in front, seen from any tab.
export function tabTitle({ page = null, section = "", chatId = null, chat = null, running = false, needs = 0 } = {}) {
  const parts = [];
  if (page) {
    if (section) parts.push(section);
    parts.push(PAGE_TITLES[page] || "");
  } else if (!chatId) {
    parts.push(t("گفتگوی جدید"));
  } else if (chat) {
    // A blank title reads as the chat header does.
    parts.push(String(chat.title || "").trim() || t("گفتگوی جدید"));
  }
  const title = [...parts.filter(Boolean), BRAND.name].join(" · ");
  return `${needs > 0 ? `(${needs.toLocaleString("fa-IR")}) ` : ""}${running ? "● " : ""}${title}`;
}
