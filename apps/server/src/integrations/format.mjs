import { finalText } from "@griffin/timeline";
import { CALLER_LABELS } from "../agents/registry.mjs";
import { DEFAULT_TZ } from "../jobs/cron.mjs";
import { beforeSignature, cutCopiedSignature, endsWithSignature, isProductSigned, stripProductSignature } from "../identity.mjs";
import { CALL_RE, outgoingSignature, PERSONA, SIGNATURE_RE } from "../persona.mjs";

// Turning a finished run into messenger messages.

const PLACEHOLDER = (i) => `@@GRIFFINBLOCK${i}@@`;

// One-line live status for messengers (edited in place, then deleted before the final answer).
const TOOL_STATUS = {
  kube_status: "وضعیت کلاستر",
  kube_get: "خواندن کلاستر",
  kube_logs: "خواندن لاگ",
  kube_df: "فضای دیسک",
  kube_exec: "اجرای دستور در پاد",
  kube_secret: "خواندن Secret",
  metrics_query: "کوئری متریک",
  pg_query: "کوئری دیتابیس",
  gitlab_version: "نسخه GitLab",
  gitlab_projects: "پروژه‌های GitLab",
  gitlab_search: "جستجوی GitLab",
  gitlab_file: "فایل GitLab",
  gitlab_mr_changes: "تغییرات MR",
  grafana_search: "جستجوی Grafana",
  grafana_dashboard: "داشبورد Grafana",
  grafana_panel_query: "دادهٔ پنل Grafana",
  grafana_query: "کوئری Grafana",
  s3_list: "فهرست S3",
  s3_get: "دانلود S3",
  mikrotik_print: "خواندن میکروتیک",
  mikrotik_ping: "پینگ میکروتیک",
  debug_exec: "اجرای دستور",
  delegate: "شروع بررسی",
  subtasks: "پیگیری کار",
  knowledge_list: "خواندن یادداشت‌ها",
  knowledge_edit: "ویرایش یادداشت",
  knowledge_delete: "حذف یادداشت",
  infisical_get: "خواندن تنظیمات",
  infisical_list: "خواندن تنظیمات",
  infisical_upsert: "ثبت تنظیمات",
  gitlab_mr: "مرج‌ریکوئست",
  gitlab_pipeline: "پایپ‌لاین",
  gitlab_project_member: "دسترسی پروژهٔ گیت‌لب",
  gitlab_propose: "ساخت مرج‌ریکوئست",
  gitlab_commits: "تاریخچهٔ کد",
  ask_owner: "منتظر تأیید Owner",
  ask_agent: "پرسش از ایجنت دیگر",
  end_agent: "بستن جلسه",
  visualize: "رسم نمودار",
  show_media: "آماده‌سازی فایل",
  web_search: "جستجوی وب",
  web_fetch: "خواندن صفحهٔ وب",
  browser_open: "باز کردن صفحه در مرورگر",
  browser_snapshot: "خواندن صفحه در مرورگر",
  browser_click: "کلیک در مرورگر",
  browser_type: "نوشتن در مرورگر",
  browser_screenshot: "عکس از صفحه",
  telegram_read: "خواندن تلگرام",
  telegram_media: "دیدن تصویر تلگرام",
  telegram_watch_list: "فهرست چت‌های واچ تلگرام",
  telegram_send: "ارسال تلگرام",
  telegram_edit: "ویرایش پیام تلگرام",
  telegram_delete: "حذف پیام تلگرام",
  telegram_dialogs: "فهرست گفتگوها",
  dns_lookup: "DNS",
  http_check: "چک HTTP",
  tls_check: "چک TLS",
  arvan_cache_purge: "پاکسازی کش آروان",
  arvan_load_balancer_get: "خواندن لود‌بالانسر آروان",
  arvan_reports: "گزارش ترافیک و خطاهای آروان",
  arvan_page_rules: "خواندن page ruleهای آروان",
  arvan_dns_records: "خواندن رکوردهای DNS آروان",
  arvan_dns_export: "خروجی BIND رکوردهای DNS آروان",
  vcenter_vms: "فهرست VMهای vCenter",
  vcenter_vm_get: "وضعیت VM در vCenter",
  vcenter_inventory: "منابع vCenter",
  vcenter_customization_specs: "specهای vCenter",
  vcenter_vm_create: "ساخت VM در vCenter",
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
    // The question itself is delivered as its own message; a status line naming the tool
    // («⏳ ask_requester») reached a colleague's chat on 2026-10-06. Unknown tools get a plain
    // line, never their raw name.
    if (name === "ask_requester") return null;
    const label = TOOL_STATUS[name] || "در حال کار…";
    if (!TOOL_STATUS[name]) return label;
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

// Ported from Karsara (format.mjs): code-fence-aware, grapheme-safe splitting.
// The longest prefix of `text` that is at most `max` UTF-16 units and ends on a grapheme boundary
// (never inside a surrogate pair, a ZWJ emoji or a flag, and not right after a ZWJ/ZWNJ joiner).
// Intl.Segmenter when available, else code points. Always at least one grapheme so callers advance.
const segmenter = typeof Intl !== "undefined" && Intl.Segmenter ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : null;
export function cutUnits(text, max) {
  if (text.length <= max) return text;
  // Segment only a small window around the cut (linear overall). Boundaries at or before `max`
  // are reliable: the window starts 32 units earlier and ends 32 units after.
  let w0 = Math.max(0, max - 32);
  if (/[\uDC00-\uDFFF]/.test(text[w0] || "")) w0--; // do not start inside a surrogate pair
  const head = text.slice(w0, max + 32);
  const bounds = [];
  if (segmenter) {
    for (const s of segmenter.segment(head)) bounds.push(w0 + s.index + s.segment.length);
  } else {
    let o = w0;
    for (const c of head) bounds.push((o += c.length));
  }
  for (let k = bounds.length - 1; k >= 0; k--) {
    const b = bounds[k];
    if (b > max || b <= w0) continue;
    if (/[\u200C\u200D]$/.test(text.slice(b - 1, b))) continue;
    return text.slice(0, b);
  }
  // A grapheme longer than the window: hard-cut at a code-point boundary so the limit still holds.
  let b = max;
  if (/[\uDC00-\uDFFF]/.test(text[b] || "") && b > 1) b--;
  return text.slice(0, Math.max(1, b));
}

// Split Markdown into ≤ limit parts for a messenger: whole paragraphs where they fit, else whole
// lines; a ``` code block is never left open in a part — a block longer than one part is closed
// at the cut and reopened (same fence line) in the next. Only a single line longer than the limit
// is cut mid-line (at a space when there is one).
export function splitMarkdown(text, limit = 3900) {
  const lines = String(text || "").replace(/\r\n/g, "\n").split("\n");
  const blocks = []; // { lines, fence: opener line | null }
  let para = [];
  const flush = () => {
    if (para.length) blocks.push({ lines: para, fence: null });
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {
      flush();
      const body = [];
      let j = i + 1;
      while (j < lines.length && !/^\s*```\s*$/.test(lines[j])) body.push(lines[j++]);
      // A fence opener that would leave little room for the body is hard-cut (its info string
      // shortened) so every part still fits the limit and the loop below always consumes input.
      const fence = line.trim();
      blocks.push({ lines: body, fence: fence.length > limit / 4 ? cutUnits(fence, Math.max(3, Math.floor(limit / 4))) : fence });
      i = j; // skip the closing fence (or run to the end when it is missing)
      continue;
    }
    if (!line.trim()) flush();
    else para.push(line);
  }
  flush();

  const cutLine = (line, max) => {
    max = Math.max(1, Math.floor(max)); // never cut at <= 0: that would loop without consuming input
    const out = [];
    let rest = line;
    while (rest.length > max) {
      let cut = cutUnits(rest, max).length;
      const space = rest.lastIndexOf(" ", cut);
      if (space >= max / 2) cut = space;
      out.push(rest.slice(0, cut));
      rest = rest.slice(cut).replace(/^ /, "");
    }
    out.push(rest);
    return out;
  };
  const pieces = [];
  for (const block of blocks) {
    const wrap = (body) => (block.fence ? `${block.fence}\n${body}\n\`\`\`` : body);
    const whole = wrap(block.lines.join("\n"));
    if (whole.length <= limit) {
      pieces.push(whole);
      continue;
    }
    const room = Math.max(1, block.fence ? limit - block.fence.length - 5 : limit);
    let cur = [];
    let size = 0;
    for (const line of block.lines.flatMap((l) => cutLine(l, room))) {
      if (cur.length && size + 1 + line.length > room) {
        pieces.push(wrap(cur.join("\n")));
        cur = [];
        size = 0;
      }
      size += (cur.length ? 1 : 0) + line.length;
      cur.push(line);
    }
    if (cur.length) pieces.push(wrap(cur.join("\n")));
  }
  const parts = [];
  let current = "";
  for (const piece of pieces) {
    if (!current) current = piece;
    else if (current.length + 2 + piece.length <= limit) current += `\n\n${piece}`;
    else {
      parts.push(current);
      current = piece;
    }
  }
  if (current) parts.push(current);
  return parts;
}

// Footer on every messenger deliver so peers can tell agent messages from the owner's own words: this
// install's SIGNATURE setting («— <name>» by default), read on every send so a rename shows at once.
export const agentFooter = () => outgoingSignature();
// The sign-off regexes, built from the names in use now: after a rename, «— <new name>» written by
// hand is the assistant's signature too (persona.mjs CALL_RE still holds the names at start).
const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function signatureRegexes() {
  const live = [PERSONA.name, PERSONA.latin].filter(Boolean).map(esc);
  const names = [...new Set([...live, CALL_RE])].sort((a, b) => b.length - a.length).join("|");
  const sig = `(?:${SIGNATURE_RE}|(?:ایجنت\\s*)?(?:${names}))`;
  return {
    // A sign-off ends its line or is followed by a note «(…)»; «— Griffin پلتفرم ماست» is a sentence.
    signed: new RegExp(`^([\\s\\S]*?—\\s*${sig})(?=[ \\t]*(?:\\n|$|\\())`, "u"),
    // An old-name sign-off out of habit becomes the current one.
    oldNameTail: new RegExp(`—\\s*(?:ایجنت\\s*)?(?:${names})\\s*$`, "u"),
    endsSigned: new RegExp(`—\\s*${sig}\\s*$`, "u"),
  };
}

// Sent by an assistant (ends with its sign-off, or with any install's product signature), not typed by the owner.
export const signedByAgent = (text) =>
  signatureRegexes().endsSigned.test(String(text ?? "").trimEnd()) || isProductSigned(text) || endsWithSignature(text, outgoingSignature());

export function withAgentFooter(text, footerOverride = null) {
  // Whatever the model writes after its own signature is a note to itself (a «(… only the owner
  // knows)» aside reached a colleague, 2026-10-07) — it never goes out. The same for a copy of the new
  // signature line «— …، دستیارِ … · گریفین», whole or in part.
  const footer = footerOverride || agentFooter();
  const { signed: SIGNED, oldNameTail, endsSigned } = signatureRegexes();
  const given = String(text ?? "");
  // A copy of this install's own signature (free-form, SIGNATURE), with any note after it.
  const raw = cutCopiedSignature(beforeSignature(given, footer) ?? given);
  const signed = raw.match(SIGNED);
  let body = stripProductSignature((signed ? signed[1] : raw).replace(/\s+$/u, ""));
  if (endsSigned.test(body)) {
    // A specialist that signed by hand («— ایجنت پلتفرم») keeps its own line.
    if (!oldNameTail.test(body)) return body;
    body = body.replace(oldNameTail, "").replace(/\s+$/u, "");
  }
  // An unclosed ``` block would swallow the footer (Karsara format.mjs appendFooter).
  if (((body.match(/^\s*```/gmu) || []).length) % 2 === 1) body += "\n```";
  return body ? `${body}\n\n${footer}` : footer;
}

// A long signed message (over one Telegram message) goes out in parts, each numbered «(بخش ۱ از ۳)»
// and each signed, as Karsara does (format.mjs signedParts): the other assistant then sees every part
// as an agent's and joins them into one request before answering (partOf, manager.receivePeerAgent).
// Short enough for one message, it is returned as it is; long but not ending in this install's
// footer (a specialist's own hand-signed line), it is cut as before (chunk), unnumbered.
const FA_DIGITS = (n) => String(n).replace(/\d/g, (d) => "۰۱۲۳۴۵۶۷۸۹"[d]);
const PART_HEAD = /^\(بخش ([0-9۰-۹]+) از ([0-9۰-۹]+)\)\n/u;

export function signedParts(signed, limit = 4000) {
  const text = String(signed ?? "");
  const footer = `\n\n${agentFooter()}`;
  if (text.length <= limit) return [text];
  if (!text.endsWith(footer)) return splitMarkdown(text, limit);
  const pieces = splitMarkdown(text.slice(0, -footer.length), Math.max(500, limit - footer.length - 30));
  if (pieces.length <= 1) return [text];
  return pieces.map((piece, i) => `(بخش ${FA_DIGITS(i + 1)} از ${FA_DIGITS(pieces.length)})\n${piece}${footer}`);
}

/** «(بخش ۲ از ۳)» at the head of a part → { index: 2, total: 3, body }; null for a whole message. */
export function partOf(text) {
  const m = String(text ?? "").match(PART_HEAD);
  if (!m) return null;
  const num = (s) => Number(s.replace(/[۰-۹]/g, (d) => "۰۱۲۳۴۵۶۷۸۹".indexOf(d)));
  const index = num(m[1]);
  const total = num(m[2]);
  if (!(index >= 1 && total >= 2 && index <= total && total <= 50)) return null;
  return { index, total, body: String(text).slice(m[0].length) };
}

// "⏱ ۰۹:۳۴ · ۲۳ث": when the answer arrived (Tehran clock) and how long the run took. The owner
// wanted to see both under every answer (2026-09-24).
const STAMP_CLOCK = new Intl.DateTimeFormat("fa-IR", { timeZone: DEFAULT_TZ, hour: "2-digit", minute: "2-digit", hour12: false });

export function answerStamp(run) {
  const end = new Date(run?.endedAt || NaN);
  if (Number.isNaN(end.getTime())) return "";
  const start = new Date(run?.startedAt || NaN);
  const seconds = Number.isNaN(start.getTime()) ? null : Math.max(1, Math.round((end - start) / 1000));
  const fa = (n) => n.toLocaleString("fa-IR");
  const took = seconds == null ? "" : seconds < 60 ? `${fa(seconds)}ث` : `${fa(Math.floor(seconds / 60))}د${seconds % 60 ? ` ${fa(seconds % 60)}ث` : ""}`;
  return `⏱ ${STAMP_CLOCK.format(end)}${took ? ` · ${took}` : ""}`;
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
  // The openai provider emitted plain-string values before 2026-09-28; parse those too so old
  // chats still deliver their charts/files.
  if (typeof result?.value === "string") {
    try {
      const parsed = JSON.parse(result.value);
      if (parsed && typeof parsed === "object") return parsed;
    } catch {
      /* not JSON */
    }
  }
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
