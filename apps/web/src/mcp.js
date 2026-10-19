import { t } from "./i18n.js";
// Settings → MCP (from Karsara): the live servers of the most recently used open Claude Code
// process (GET /api/mcp).
const STATUS = {
  connected: { label: t("وصل"), tone: "ok" },
  failed: { label: t("خطا"), tone: "bad" },
  "needs-auth": { label: t("نیاز به ورود"), tone: "warn" },
  pending: { label: t("در حال اتصال"), tone: "muted" },
  disabled: { label: t("خاموش"), tone: "muted" },
};
export const mcpStatus = (status) => STATUS[status] || { label: String(status || "—"), tone: "muted" };

export function mcpSourceLine(view) {
  if (!view?.available) return view?.reason || t("هیچ جلسهٔ باز Claude Code نیست؛ در یک گفتگو پیامی بفرستید، بعد «تازه کردن» را بزنید.");
  return view.chatTitle ? `فهرست از آخرین گفتگوی استفاده‌شده: «${view.chatTitle}»` : t("فهرست از آخرین گفتگوی استفاده‌شده");
}

// «بررسی اتصال» result of one configured server (POST /api/mcp-servers/:name/check) as one line.
const REASON = {
  auth: t("توکن یا هدر Authorization قبول نشد (۴۰۱/۴۰۳)"),
  timeout: t("جواب نداد (timeout)"),
  ECONNREFUSED: t("اتصال رد شد؛ سرور بالا نیست یا پورت اشتباه است"),
  ENOTFOUND: t("آدرس پیدا نشد"),
  ECONNRESET: t("اتصال قطع شد"),
  no_endpoint_event: t("سرور SSE نیست یا endpoint نمی‌دهد"),
};
export function mcpCheckLine(result) {
  if (!result?.checked) return null;
  if (result.ok) {
    const ms = Number(result.ms).toLocaleString("fa-IR");
    const tools = result.tools != null ? ` · ${Number(result.tools).toLocaleString("fa-IR")} ابزار` : "";
    return { tone: "ok", text: `وصل است · ${ms} میلی‌ثانیه${tools}` };
  }
  return { tone: "bad", text: `وصل نیست: ${REASON[result.reason] || result.reason || t("نامشخص")}` };
}

// Ready-made servers offered on Settings → MCP servers: one click fills the form and the person types
// only their own key. `headers` are the form's starting header lines (the value stays empty on purpose).
// Add your own (id, name, title, summary, type, url, headers, hint).
export const MCP_PRESETS = [];

/** Presets not yet configured (matched by server name). */
export const missingPresets = (servers = []) => {
  const have = new Set(servers.map((s) => s.name));
  return MCP_PRESETS.filter((p) => !have.has(p.name));
};

/** The form's starting state for a preset. */
export const presetForm = (preset) => ({ name: preset.name, type: preset.type, url: preset.url, headers: { ...preset.headers }, hint: preset.hint });

/** A preset's key header still empty → the form must not save it yet. */
export const presetKeyMissing = (preset, pairs) =>
  Object.keys(preset?.headers || {}).some((h) => !new RegExp(`^\\s*${h}\\s*[=:]\\s*\\S`, "im").test(pairs || ""));
