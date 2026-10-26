import { t } from "./i18n.js";
// Pure helpers for the purpose-built tool cards (ToolViews.jsx): a shell step as a terminal block,
// GitLab merge requests / pipelines / diffs as what they are instead of «key: value» lists.
// Owner, 2026-10-20: «خروجی این دو ابزار اصلا مفهوم نیست؛ می‌تونست یک دیزاین مشخص و خوب داشته باشه».

const fa = (n) => Number(n).toLocaleString("fa-IR");

// A status as one Persian word and a tone (ok / bad / warn / info / muted) for its chip.
const STATUS = {
  // merge request state
  opened: [t("باز"), "info"], merged: [t("ادغام شد"), "ok"], closed: [t("بسته"), "muted"], locked: [t("قفل"), "muted"],
  // pipeline / job
  success: [t("موفق"), "ok"], passed: [t("موفق"), "ok"], failed: [t("شکست"), "bad"], running: [t("در حال اجرا"), "info"],
  pending: [t("در صف"), "warn"], created: [t("ساخته شد"), "muted"], canceled: [t("لغو شد"), "muted"], cancelled: [t("لغو شد"), "muted"],
  canceling: [t("در حال لغو"), "warn"], skipped: [t("رد شد"), "muted"], manual: [t("دستی"), "warn"], scheduled: [t("زمان‌بندی‌شده"), "muted"],
  waiting_for_resource: [t("منتظر منابع"), "warn"], preparing: [t("آماده‌سازی"), "info"], waiting_for_callback: [t("منتظر پاسخ"), "warn"],
  // detailed merge status
  mergeable: [t("آمادهٔ ادغام"), "ok"], can_be_merged: [t("آمادهٔ ادغام"), "ok"], cannot_be_merged: [t("تداخل دارد"), "bad"],
  ci_must_pass: [t("منتظر سبز شدن CI"), "warn"], ci_still_running: [t("CI هنوز اجراست"), "warn"], draft_status: [t("پیش‌نویس است"), "warn"],
  not_approved: [t("تأیید نشده"), "warn"], conflict: [t("تداخل دارد"), "bad"], need_rebase: [t("نیاز به rebase"), "warn"],
  discussions_not_resolved: [t("بحث‌های باز دارد"), "warn"], checking: [t("در حال بررسی"), "muted"], unchecked: [t("بررسی نشده"), "muted"],
  blocked_status: [t("مسدود"), "warn"], not_open: [t("باز نیست"), "muted"],
};

export function statusInfo(status) {
  const key = String(status ?? "").trim().toLowerCase();
  if (!key) return null;
  const known = STATUS[key];
  return known ? { label: known[0], tone: known[1] } : { label: key.replace(/_/g, " "), tone: "muted" };
}

// Why a job failed, in plain words (GitLab's failure_reason).
const FAILURE = {
  script_failure: t("اسکریپت شکست خورد"),
  job_execution_timeout: t("زمان اجرا تمام شد (تایم‌اوت)"),
  runner_system_failure: t("خطای سیستم رانر"),
  runner_unsupported: t("رانر پشتیبانی نمی‌کند"),
  stuck_or_timeout_failure: t("در صف ماند یا تایم‌اوت شد"),
  data_integrity_failure: t("خطای یکپارچگی داده در رانر"),
  api_failure: t("خطای API"),
  scheduler_failure: t("خطای زمان‌بند"),
  missing_dependency_failure: t("وابستگی کم است"),
  unmet_prerequisites: t("پیش‌نیازها برقرار نیست"),
  archived_failure: t("بایگانی شده"),
  forward_deployment_failure: t("استقرار جلوتر رفته"),
  protected_environment_failure: t("محیط محافظت‌شده"),
  image_pull_failure: t("دانلود ایمیج شکست خورد"),
};

export function failureText(reason) {
  const key = String(reason ?? "").trim();
  return key ? FAILURE[key] || key.replace(/_/g, " ") : "";
}

// 4 → «۴ ثانیه», 129.7 → «۲ دقیقه و ۱۰ ثانیه», 3700 → «۱ ساعت و ۱ دقیقه».
export function durationText(seconds) {
  if (seconds == null || seconds === "") return "";
  const total = Math.round(Number(seconds));
  if (!Number.isFinite(total) || total < 0) return "";
  if (total < 60) return `${fa(total)} ثانیه`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return total % 60 ? `${fa(minutes)} دقیقه و ${fa(total % 60)} ثانیه` : `${fa(minutes)} دقیقه`;
  const hours = Math.floor(minutes / 60);
  return minutes % 60 ? `${fa(hours)} ساعت و ${fa(minutes % 60)} دقیقه` : `${fa(hours)} ساعت`;
}

// Seconds between two ISO stamps, or null.
export function secondsBetween(from, to) {
  const a = from ? new Date(from).getTime() : NaN;
  const b = to ? new Date(to).getTime() : NaN;
  return Number.isFinite(a) && Number.isFinite(b) && b >= a ? (b - a) / 1000 : null;
}

// «refs/merge-requests/147/head» → «MR !147»; «refs/heads/x» → «x».
export function refLabel(ref) {
  const text = String(ref ?? "");
  const mr = text.match(/^refs\/merge-requests\/(\d+)\//);
  if (mr) return `MR !${mr[1]}`;
  return text.replace(/^refs\/(heads|tags)\//, "");
}

export function shortSha(sha) {
  return String(sha ?? "").slice(0, 8);
}

// The project part of «group/name» for a compact row.
export function projectName(project) {
  return String(project ?? "").split("/").filter(Boolean).slice(-1)[0] || "";
}

// ── shell steps ─────────────────────────────────────────────────────────────────────────────

const HOSTS = { sandbox: t("سندباکس"), debug: t("نود کلاستر debug"), capsule: t("کپسول"), griffin: t("سرور گریفین") };

// Where a command ran, as a short place name for the terminal header.
export function shellPlace(toolName, args = {}, result = {}) {
  switch (toolName) {
    case "debug_exec": return HOSTS[args.host || result?.host || "sandbox"] || String(args.host || result?.host);
    case "ssh_exec": return [args.user || result?.user, args.host || result?.host].filter(Boolean).join("@") || t("سرور");
    case "kube_exec": return [t("پاد"), args.pod, args.namespace && `(${args.namespace})`, args.cluster && `· ${args.cluster}`].filter(Boolean).join(" ");
    case "mikrotik_exec": return `میکروتیک ${args.router || result?.router || ""}`.trim();
    default: return t("ترمینال");
  }
}

// What a shell tool returned, split into the output and the error stream.
export function shellOutput(result) {
  if (result == null) return { stdout: "", stderr: "" };
  if (typeof result === "string") return { stdout: result, stderr: "" };
  if (typeof result.output === "string") return { stdout: result.output, stderr: "" };
  return { stdout: String(result.stdout ?? ""), stderr: String(result.stderr ?? "") };
}

// The first `limit` lines of a text, with how many were left out.
export function clipLines(text, limit = 14) {
  const lines = String(text ?? "").replace(/\s+$/, "").split("\n");
  if (lines.length <= limit) return { shown: lines.join("\n"), hidden: 0, total: lines.length };
  return { shown: lines.slice(0, limit).join("\n"), hidden: lines.length - limit, total: lines.length };
}

// The last `limit` lines (a job log's useful part is its end).
export function tailLines(text, limit = 14) {
  const lines = String(text ?? "").replace(/\s+$/, "").split("\n");
  if (lines.length <= limit) return { shown: lines.join("\n"), hidden: 0, total: lines.length };
  return { shown: lines.slice(-limit).join("\n"), hidden: lines.length - limit, total: lines.length };
}

// ── GitLab ──────────────────────────────────────────────────────────────────────────────────

// Pipeline jobs by stage, stages in the order they ran (the API lists the newest job first).
export function groupJobsByStage(jobs = []) {
  const stages = new Map();
  for (const job of jobs) {
    const stage = job.stage || "—";
    const entry = stages.get(stage) || { stage, minId: Infinity, jobs: [] };
    entry.minId = Math.min(entry.minId, Number(job.id) || Infinity);
    entry.jobs.push(job);
    stages.set(stage, entry);
  }
  return [...stages.values()]
    .sort((a, b) => a.minId - b.minId)
    .map(({ stage, jobs: list }) => ({ stage, jobs: [...list].sort((a, b) => (Number(a.id) || 0) - (Number(b.id) || 0)) }));
}

// «۱۰ کار: ۹ موفق · ۱ شکست»
export function jobsSummary(jobs = []) {
  if (!jobs.length) return "";
  const counts = {};
  for (const job of jobs) counts[job.status] = (counts[job.status] || 0) + 1;
  const order = ["failed", "running", "pending", "manual", "success", "skipped", "canceled", "created"];
  const parts = order.filter((s) => counts[s]).map((s) => `${fa(counts[s])} ${statusInfo(s).label}`);
  for (const [s, n] of Object.entries(counts)) if (!order.includes(s)) parts.push(`${fa(n)} ${statusInfo(s).label}`);
  return `${fa(jobs.length)} کار: ${parts.join(" · ")}`;
}

// The total change of a diff result: files, added and removed lines.
export function changesTotals(files = []) {
  let added = 0;
  let removed = 0;
  for (const f of files) {
    added += Number(f.added) || 0;
    removed += Number(f.removed) || 0;
  }
  return { files: files.length, added, removed };
}

const ROLE = { 10: "Guest", 20: "Reporter", 30: "Developer", 40: "Maintainer", 50: "Owner" };
export function roleName(level) {
  return ROLE[Number(level)] || String(level ?? "");
}

// What a merge/ready/view call came to, in one sentence (the banner of the MR card).
export function mrOutcome(args = {}, result = {}) {
  const action = args.action || "view";
  if (action === "merge") return result.merged ? { text: t("ادغام شد"), tone: "ok" } : { text: t("ادغام نشد"), tone: "bad" };
  if (action === "ready") return result.draft === false ? { text: t("از حالت پیش‌نویس درآمد"), tone: "ok" } : { text: t("هنوز پیش‌نویس است"), tone: "warn" };
  return null;
}
