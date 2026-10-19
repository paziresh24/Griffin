// Griffin shell brand + per-agent accents. Agent ids stay stable; labels/colors are UI-facing.
// Griffin is the platform; the assistant's name and the product come from the server (persona.mjs,
// identity.mjs) via loadBrand(). Nothing here names an install's assistant or owner.
import { lang, t } from "./i18n.js";
import { setInstallLook } from "./ui-prefs.js";

export const BRAND = {
  id: "griffin",
  name: t("گریفین"),
  nameEn: "Griffin",
  product: t("گریفین"),
  productId: "griffin",
  color: "#e8873a",
  iconV: "", // when the install's logo last changed (server), so a new logo gets a new URL
  // The browser tab's last part: the product when the install is set to the Karsara look, else the assistant.
  get title() {
    return this.productId === "karsara" ? this.product : this.name;
  },
};

/** A logo URL that changes with the install's logo (the page and the browser cache it by URL). */
export const iconUrl = (path = "/icon.svg") => (BRAND.iconV ? `${path}?v=${BRAND.iconV}` : path);

/** After the logo changed (or once it is known): every logo URL from now on, and the tab's icon. */
export function setIconVersion(v) {
  BRAND.iconV = String(v || "");
  AGENT_META.griffin.icon = iconUrl("/agents/griffin.svg");
  for (const link of document.querySelectorAll('link[rel="icon"]')) link.href = iconUrl("/icon.svg");
}

export const STORAGE = {
  theme: "griffin.theme",
  mode: "griffin.mode",
  model: "griffin.model",
  agent: "griffin.agent",
  provider: "griffin.provider",
  effort: "griffin.effort",
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

export const KARSARA_BLURB = t("یک دستیار مختص شما.");

// `fetchImpl` and `onSkin` are for tests; the page uses fetch and the install's preset (ui-prefs.js).
export async function loadBrand({ fetchImpl = fetch, onSkin = setInstallLook } = {}) {
  try {
    const res = await fetchImpl("/api/public/brand/info", { signal: AbortSignal.timeout(3000) });
    const { name, latin, product, productLatin, productId, skin, iconV } = await res.json();
    if (iconV) setIconVersion(iconV);
    // The assistant's own name per install (server persona); English UI shows its Latin form.
    const shown = (lang === "en" && latin) || name;
    if (shown) BRAND.name = AGENT_META.griffin.label = AGENT_META.griffin.short = shown;
    if (latin) BRAND.nameEn = latin;
    const productShown = (lang === "en" && productLatin) || product;
    if (productShown) BRAND.product = productShown;
    if (productId) BRAND.productId = productId;
    onSkin(skin || "griffin");
  } catch {
    onSkin("griffin"); // keep the built-in defaults; the cached look still paints
  }
  try {
    // Signed in only: the line under the assistant's name names its owner.
    const res = await fetchImpl("/api/brand", { signal: AbortSignal.timeout(3000) });
    if (res.ok) {
      const { blurb, brand } = await res.json();
      if (typeof blurb === "string") AGENT_META.griffin.blurb = blurb;
      applyAgentColor(brand);
    }
  } catch {
    // signed out or offline: no line
  }
  // An install with the Karsara look keeps that look's own new-chat line.
  if (BRAND.productId === "karsara") AGENT_META.griffin.blurb = KARSARA_BLURB;
}

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

/** Drive page primary from the active specialist; the assistant (default) keeps --brand (the install's own colour). */
export function applyAgentTheme(agentId) {
  const root = document.documentElement;
  if (!agentId || agentId === "griffin" || !AGENT_META[agentId]) {
    root.removeAttribute("data-agent");
    return;
  }
  root.setAttribute("data-agent", agentId);
}

// Tool cards and pickers tint with AGENT_META.griffin.color as `${hex}55`, so only a hex goes there.
// `brand` is the install's saved look (GET /api/setup/brand, also on /api/brand); none = Griffin's.
const STOCK = { color: AGENT_META.griffin.color, colorDark: AGENT_META.griffin.colorDark };
export function applyAgentColor(brand) {
  const hex = (v) => (/^#[0-9a-f]{6}$/i.test(v || "") ? v : null);
  const light = hex(brand?.palette?.light?.brand);
  AGENT_META.griffin.color = light || STOCK.color;
  AGENT_META.griffin.colorDark = hex(brand?.palette?.dark?.brand) || light || STOCK.colorDark;
}
