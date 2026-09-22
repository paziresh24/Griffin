import { finalText } from "@griffin/timeline";
import { CALLER_LABELS } from "../agents/registry.mjs";

// Turning a finished run into messenger messages.

const PLACEHOLDER = (i) => `@@GRIFFINBLOCK${i}@@`;

// One-line live status for messengers (edited in place, then deleted before the final answer).
const TOOL_STATUS = {
  kube_status: "وضعیت کلاستر",
  kube_get: "خواندن کلاستر",
  kube_logs: "خواندن لاگ",
  kube_df: "فضای دیسک",
  kube_secret: "خواندن Secret",
  metrics_query: "کوئری متریک",
  pg_query: "کوئری دیتابیس",
  gitlab_version: "نسخه GitLab",
  gitlab_projects: "پروژه‌های GitLab",
  gitlab_search: "جستجوی GitLab",
  gitlab_file: "فایل GitLab",
  grafana_search: "جستجوی Grafana",
  grafana_dashboard: "داشبورد Grafana",
  grafana_panel_query: "دادهٔ پنل Grafana",
  grafana_query: "کوئری Grafana",
  s3_list: "فهرست S3",
  s3_get: "دانلود S3",
  mikrotik_print: "خواندن میکروتیک",
  mikrotik_ping: "پینگ میکروتیک",
  debug_exec: "دستور روی debug",
  ask_owner: "منتظر تأیید Owner",
  ask_agent: "پرسش از ایجنت دیگر",
  end_agent: "بستن جلسه",
  visualize: "رسم نمودار",
  show_media: "آماده‌سازی فایل",
  telegram_read: "خواندن تلگرام",
  telegram_send: "ارسال تلگرام",
  telegram_dialogs: "فهرست گفتگوها",
  dns_lookup: "DNS",
  http_check: "چک HTTP",
  tls_check: "چک TLS",
  arvan_cache_purge: "پاکسازی کش آروان",
  read: "خواندن فایل",
  grep: "جستجو در کد",
  glob: "یافتن فایل",
  edit: "ویرایش فایل",
};

export function liveStatusLine(event) {
  if (!event?.type) return null;
  if (event.type === "run.started") return "شروع کار…";
  if (event.type === "run.phase") {
    const phase = event.data?.phase;
    if (phase === "connecting") return "وصل شدن به مدل…";
    if (phase) return String(phase);
  }
  if (event.type === "tool.started") {
    const name = event.data?.name;
    if (!name) return "در حال کار…";
    const a = event.data?.args || {};
    if (name === "ask_agent") {
      const who = CALLER_LABELS[a.agent] || a.agent || "ایجنت";
      const task = String(a.request || "").trim();
      const clipped = task.length > 80 ? `${task.slice(0, 80)}…` : task;
      return clipped ? `${who} در حال انجام ${clipped}…` : `${who} در حال انجام درخواست…`;
    }
    const label = TOOL_STATUS[name] || name;
    const hint = [a.cluster, a.namespace, a.pod, a.kind, a.path, a.query, a.chat].filter(Boolean).slice(0, 2).join(" · ");
    return hint ? `${label}: ${hint}` : label;
  }
  if (event.type === "tool.done" && event.data?.name === "ask_owner") return "تأیید Owner گرفته شد…";
  return null;
}

// Telegram HTML: the small subset it accepts (b, i, code, pre, a). Tables and code blocks become <pre>.
export function markdownToTelegramHtml(markdown) {
  const escape = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const blocks = [];
  let text = String(markdown || "").replace(/```[^\n]*\n([\s\S]*?)```/g, (_, code) => {
    blocks.push(`<pre>${escape(code.replace(/\n$/, ""))}</pre>`);
    return PLACEHOLDER(blocks.length - 1);
  });
  // Markdown tables → aligned plain text in <pre>
  text = text.replace(/((?:^\|.*\|[ \t]*$\n?){2,})/gm, (table) => {
    const rows = table
      .trim()
      .split("\n")
      .filter((line) => !/^\|\s*:?-{2,}/.test(line))
      .map((line) => line.replace(/^\||\|$/g, "").split("|").map((c) => c.trim().replace(/\*\*|`/g, "")));
    blocks.push(`<pre>${escape(rows.map((r) => r.join(" │ ")).join("\n"))}</pre>`);
    return `${PLACEHOLDER(blocks.length - 1)}\n`;
  });
  text = escape(text)
    .replace(/`([^`\n]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>")
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>')
    .replace(/^#{1,6}\s+(.+)$/gm, "<b>$1</b>")
    .replace(/^\s*[-*]\s+/gm, "• ");
  return text.replace(/@@GRIFFINBLOCK(\d+)@@/g, (_, i) => blocks[Number(i)]);
}

// Bale and plain fallbacks: strip markup, keep structure readable.
export function markdownToPlain(markdown) {
  return String(markdown || "")
    .replace(/```[^\n]*\n([\s\S]*?)```/g, "$1")
    .replace(/^\|\s*:?-{2,}.*$\n?/gm, "")
    .replace(/^\|(.*)\|\s*$/gm, (_, row) => row.split("|").map((c) => c.trim()).join(" │ "))
    .replace(/\*\*([^*\n]+)\*\*/g, "$1")
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, "$1 ($2)")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[-*]\s+/gm, "• ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Split into ≤ limit chunks on paragraph/line boundaries (Telegram allows 4096 characters).
export function chunk(text, limit = 3900) {
  const out = [];
  let rest = String(text || "");
  while (rest.length > limit) {
    let cut = rest.lastIndexOf("\n\n", limit);
    if (cut < limit / 2) cut = rest.lastIndexOf("\n", limit);
    if (cut < limit / 2) cut = limit;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}

// Footer on every messenger deliver so peers can tell agent messages from the owner's own words.
export const AGENT_FOOTER = "— گریفین";

export function withAgentFooter(text) {
  const body = String(text ?? "").replace(/\s+$/u, "");
  if (/—\s*(ایجنت\s*)?گریفین\s*$/u.test(body)) return body || AGENT_FOOTER;
  if (!body) return AGENT_FOOTER;
  return `${body}\n\n${AGENT_FOOTER}`;
}

// The parts of a run worth delivering: final answer text plus files and charts produced by tools.
export function deliverable(run) {
  const files = [];
  const charts = [];
  for (const part of run.parts || []) {
    if (part.type !== "tool" || part.status !== "success") continue;
    const summary = firstJson(part.result);
    const media = summary?.media || (summary?.image?.mediaId ? { ...summary.image, name: summary.key?.split("/").pop() } : null);
    if (media?.mediaId) files.push({ mediaId: media.mediaId, mimeType: media.mimeType, name: media.name || "file", caption: summary.title || null });
    if (summary?.chartId) charts.push({ chartId: summary.chartId, title: summary.title });
  }
  return { text: finalText(run).trim(), files, charts, status: run.status, error: run.error };
}

export function firstJson(result) {
  const content = result?.value?.content || result?.content;
  if (!Array.isArray(content)) return null;
  for (const c of content) {
    const text = typeof c.text === "string" ? c.text : c.text?.text;
    if (typeof text !== "string") continue;
    try {
      const value = JSON.parse(text);
      if (value && typeof value === "object") return value;
    } catch {
      // not JSON
    }
  }
  return null;
}
