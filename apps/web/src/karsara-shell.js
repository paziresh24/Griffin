import { t } from "./i18n.js";
// The Karsara skin's shell, as pure functions (owner, 2026-10-15: on Griffin his install must look
// and behave like Karsara). Griffin's own skin keeps chat-list.js / elapsed.js as they are.

const fa = (n) => n.toLocaleString("fa-IR");

const stampMs = (stamp) => {
  if (typeof stamp === "number") return stamp < 1e12 ? stamp * 1000 : stamp;
  const s = String(stamp || "");
  // SQLite's «2026-10-07 11:00:00» is UTC without a zone.
  return Date.parse(/^\d{4}-\d\d-\d\d \d/.test(s) ? `${s.replace(" ", "T")}Z` : s);
};

/** Karsara's short relative time for a sidebar row: «الان», «۵ دقیقه», «۲ ساعت», «۳ روز», «۲ ماه». */
export function shortAgo(stamp, now = Date.now()) {
  const ms = stamp ? stampMs(stamp) : NaN;
  if (!Number.isFinite(ms)) return "";
  const minutes = Math.max(0, Math.round((now - ms) / 60000));
  if (minutes < 1) return t("الان");
  if (minutes < 60) return `${fa(minutes)} دقیقه`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${fa(hours)} ساعت`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${fa(days)} روز`;
  return `${fa(Math.round(days / 30))} ماه`;
}

/** The same with «پیش», for a stamp shown on its own (a knowledge note, a job's last run). */
export function agoPhrase(stamp, now = Date.now()) {
  const short = shortAgo(stamp, now);
  return !short || short === t("الان") ? short : `${short} پیش`;
}

/**
 * The «Telegram inbox» row above the list (Karsara's InboxRow), from GET /api/telegram-inbox/status:
 * only while the install's DM mode is "inbox" and its chat exists.
 */
export function inboxRow(status) {
  if (status?.mode !== "inbox" || !status.chatId) return null;
  const pending = Number(status.pending) || 0;
  return { chatId: status.chatId, title: "Telegram inbox", badge: pending > 99 ? "99+" : pending > 0 ? fa(pending) : null };
}

const KIND_LABEL = { telegram_bot: t("ربات تلگرام"), bale_bot: t("ربات بله"), telegram_account: t("اکانت تلگرام") };
const DOWN = new Set(["error", "unavailable", "stopped"]);

/**
 * Settings → «وضعیت» (Karsara's «وضعیت اتصال‌ها»): one row per connection, each ok / warn / off.
 * From fast reads only (GET /api/setup, /api/integrations, /api/telegram-inbox/status,
 * /api/mcp-servers): the live engine calls stay in «چک زنده» below it.
 */
export function connectionRows({ setup = null, integrations = null, inbox = null, mcp = null, checks = null } = {}) {
  const rows = [];
  if (setup) {
    rows.push(
      setup.needsEngine
        ? { id: "engine", level: "warn", title: t("موتور هوش مصنوعی"), subtitle: t("وصل نیست؛ بدون آن ایجنت‌ها جواب نمی‌دهند."), action: { label: t("ورود"), href: "#/setup/engine" } }
        : { id: "engine", level: "ok", title: t("موتور هوش مصنوعی"), subtitle: t("وصل است") },
    );
  }
  // The VPN (setup checks): only where this server can run one.
  const vpn = checks?.vpn;
  if (vpn?.kit) {
    const action = { label: t("پراکسی و VPN"), section: "proxy" };
    if (!vpn.configured) rows.push({ id: "vpn", level: "off", title: "VPN", subtitle: t("لینکی داده نشده"), action });
    else if (vpn.working) rows.push({ id: "vpn", level: "ok", title: "VPN", subtitle: vpn.telegram === false ? t("وصل است (تلگرام از آن رد نمی‌شود)") : t("وصل است"), action });
    else rows.push({ id: "vpn", level: "warn", title: "VPN", subtitle: t("لینک ذخیره شده ولی الان وصل نیست"), action });
  }
  for (const i of integrations || []) {
    const title = KIND_LABEL[i.kind] || i.kind;
    const name = i.name ? ` · ${i.name}` : "";
    const state = i.status?.state;
    if (!i.enabled) rows.push({ id: `integration:${i.id}`, level: "off", title, subtitle: `خاموش${name}` });
    else if (DOWN.has(state)) rows.push({ id: `integration:${i.id}`, level: "warn", title, subtitle: `وصل نیست${name}`, action: { label: t("اتصال‌ها"), section: "connections" } });
    else rows.push({ id: `integration:${i.id}`, level: "ok", title, subtitle: `وصل است${name}` });
  }
  if (inbox?.mode === "inbox") {
    rows.push({ id: "inbox", level: "ok", title: t("صندوق تلگرام"), subtitle: t("روشن است؛ پیام‌های خصوصی تلگرامت در یک گفتگوی سنجاق‌شده جمع می‌شوند.") });
  }
  if (mcp?.servers?.length) {
    rows.push({ id: "mcp", level: "ok", title: t("سرورهای MCP"), subtitle: `${fa(mcp.servers.length)} سرور ثبت شده`, action: { label: "MCP", section: "mcp" } });
  }
  return rows;
}
