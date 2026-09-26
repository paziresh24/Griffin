// Griffin shell brand + per-agent accents. Agent ids stay stable; labels/colors are UI-facing.

export const BRAND = {
  id: "griffin",
  name: "گریفین",
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
    label: "گریفین",
    short: "گریفین",
    color: "#e8873a",
    colorDark: "#f0a35a",
    icon: "/agents/griffin.svg",
    blurb: "دستیار عملیاتی شما",
  },
  platform: {
    label: "پلتفرم‌بان",
    short: "پلتفرم",
    color: "#1baf7a",
    colorDark: "#34d399",
    icon: "/agents/platform.svg",
    blurb: "مسئلهٔ پلتفرم را می‌فهمد و خودش عیب‌یابی می‌کند.",
  },
  "arvan-ban": {
    label: "آروان‌بان",
    short: "آروان",
    color: "#039595",
    colorDark: "#2dd4bf",
    icon: "/agents/arvan-ban.svg",
    blurb: "CDN آروان را می‌فهمد؛ اگر origin خراب باشد ارجاع می‌دهد.",
  },
  "nsin-ban": {
    label: "انسین‌بان",
    short: "NSIN",
    color: "#22b8c8",
    colorDark: "#5eead4",
    icon: "/agents/nsin-ban.png",
    blurb: "CDN انسین: دامنه، DNS، کش، آنالیتیکس و آپ‌تایم.",
  },
};

export function agentMeta(id) {
  return AGENT_META[id] || {
    label: id || "ایجنت",
    short: id || "ایجنت",
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
