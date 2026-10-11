// Griffin shell brand + per-agent accents. Agent ids stay stable; labels/colors are UI-facing.
import { t } from "./i18n.js";

export const BRAND = {
  id: "griffin",
  name: t("گریفین"),
  nameEn: "Griffin",
  color: "#e8873a",
};

export const STORAGE = {
  theme: "griffin.theme",
  mode: "griffin.mode",
  model: "griffin.model",
  agent: "griffin.agent",
  provider: "griffin.provider",
};

export const PROVIDER_META = {
  cursor: { id: "cursor", label: "Cursor", short: "Cursor" },
  claude: { id: "claude", label: "Claude", short: "Claude" },
  openai: { id: "openai", label: "OpenAI", short: "OpenAI" },
};

export function readSetting(key, fallback = "") {
  try {
    const value = localStorage.getItem(key);
    return value != null && value !== "" ? value : fallback;
  } catch {
    return fallback;
  }
}

export function writeSetting(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // storage unavailable; setting lives for this session only
  }
}

export const AGENT_META = {
  griffin: {
    label: t("گریفین"),
    short: t("گریفین"),
    color: "#e8873a",
    colorDark: "#f0a35a",
    icon: "/agents/griffin.svg",
    blurb: t("دستیار هوشمند شما"),
  },
  platform: {
    label: t("پلتفرم‌بان"),
    short: t("پلتفرم"),
    color: "#1baf7a",
    colorDark: "#34d399",
    icon: "/agents/platform.svg",
    blurb: t("مسئلهٔ پلتفرم را می‌فهمد و خودش عیب‌یابی می‌کند."),
  },
  "arvan-ban": {
    label: t("آروان‌بان"),
    short: t("آروان"),
    color: "#039595",
    colorDark: "#2dd4bf",
    icon: "/agents/arvan-ban.svg",
    blurb: t("CDN آروان را می‌فهمد؛ اگر origin خراب باشد ارجاع می‌دهد."),
  },
  "nsin-ban": {
    label: t("انسین‌بان"),
    short: "NSIN",
    color: "#22b8c8",
    colorDark: "#5eead4",
    icon: "/agents/nsin-ban.png",
    blurb: t("CDN انسین: دامنه، DNS، کش، آنالیتیکس و آپ‌تایم."),
  },
};

export function agentMeta(id) {
  return AGENT_META[id] || {
    label: id || t("ایجنت"),
    short: id || t("ایجنت"),
    color: "var(--brand)",
    colorDark: "var(--brand)",
    icon: null,
    blurb: "",
  };
}

/** Drive page primary from the active specialist; Griffin (default) keeps --brand (orange). */
export function applyAgentTheme(agentId) {
  const root = document.documentElement;
  if (!agentId || agentId === "griffin" || !AGENT_META[agentId]) {
    root.removeAttribute("data-agent");
    return;
  }
  root.setAttribute("data-agent", agentId);
}
