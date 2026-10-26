import { createContext, useContext, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Streamdown } from "streamdown";
import { code } from "@streamdown/code";
import { BRAND, agentMeta } from "../brand.js";
import { targetLook, textDir } from "../dir.js";
import { DirBlock } from "./DirBlock.jsx";
import { api, navigate, useRoute } from "../api.js";
import { AskCard } from "./Ask.jsx";
import { buildEditDiff } from "../edit-diff.js";
import {
  GitlabChangesBody, GitlabCommitsBody, GitlabMemberBody, GitlabMrBody, GitlabMrsBody, GitlabPipelineBody, GitlabPushBody, ShellBody, ShellCommand,
} from "./ToolViews.jsx";
import { factEntries, hasValue, isLongText, isRecord, isScalar, isUrl, keyLabel, scalarText } from "../tool-detail.js";
import { MediaView } from "./Media.jsx";
import { ChartCard } from "./Chart.jsx";
import { PreviewCard } from "./Preview.jsx";
import { AgentGlyph } from "./Controls.jsx";
import { t, num } from "../i18n.js";
import { useLook } from "../ui-prefs.js";
import { sentStatus } from "../telegram.js";
import {
  AlertTriangle, AppWindow, Boxes, Check, ChevronDown, CircleDashed, CircleHelp, Cloud, Copy, Database, Eye, EyeOff, ExternalLink, FileText, FolderTree, GitBranch,
  Globe, HardDrive, KeyRound, Lock, Network, Send, ListChecks, Loader2, PencilLine, Router, ScrollText, Search, Server, ShieldAlert, Terminal, Trash2, Workflow, X,
  Square, Activity, AlarmClock, CalendarClock, BookOpen, Users, Pause, Inbox, Camera, Keyboard, MousePointerClick,
} from "lucide-react";

// Peer-call child chats of the open chat (ask_agent/delegate), so a running peer card can link to
// the child chat while it works instead of only after it finishes.
export const ChatChildrenContext = createContext([]);

const mdPlugins = { code };

const TOOLS = {
  read: { icon: FileText, label: t("خواندن فایل"), subtitle: (a) => a.path },
  edit: { icon: PencilLine, label: t("ویرایش فایل"), subtitle: (a) => a.path, open: true },
  write: { icon: PencilLine, label: t("نوشتن فایل"), subtitle: (a) => a.path },
  delete: { icon: Trash2, label: t("حذف فایل"), subtitle: (a) => a.path },
  grep: { icon: Search, label: t("جستجو در کد"), subtitle: (a) => a.pattern },
  glob: { icon: FolderTree, label: t("یافتن فایل‌ها"), subtitle: (a) => a.globPattern },
  ls: { icon: FolderTree, label: t("فهرست پوشه"), subtitle: (a) => a.path },
  semSearch: { icon: Search, label: t("جستجوی معنایی"), subtitle: (a) => a.query },
  readLints: { icon: AlertTriangle, label: t("بررسی خطاهای lint") },
  updateTodos: { icon: ListChecks, label: t("برنامهٔ کار"), open: true },
  readTodos: { icon: ListChecks, label: t("خواندن برنامهٔ کار") },
  todo_write: { icon: ListChecks, label: t("برنامهٔ کار"), open: true },
  inbox_list: { icon: Inbox, label: t("کارهای منتظر صاحب") },
  owner_task: { icon: ListChecks, label: t("دسترسی لازم"), subtitle: (a) => a.access || a.title, open: true },
  webSearch: { icon: Globe, label: t("جستجوی وب"), subtitle: (a) => a.searchTerm || a.query },
  webFetch: { icon: Globe, label: t("خواندن صفحهٔ وب"), subtitle: (a) => a.url },
  task: { icon: Workflow, label: t("زیرایجنت"), subtitle: (a) => a.description },
  gitlab_version: { icon: GitBranch, label: t("نسخهٔ GitLab") },
  kube_status: { icon: Boxes, label: t("وضعیت کلاستر"), subtitle: (a) => [a.cluster, a.namespace, a.prefix].filter(Boolean).join(" / "), open: true },
  kube_get: { icon: Database, label: t("خواندن منابع کلاستر"), subtitle: (a) => [a.cluster, a.kind, a.namespace, a.name].filter(Boolean).join(" / ") },
  kube_logs: { icon: ScrollText, label: t("لاگ پاد"), subtitle: (a) => [a.cluster, a.namespace, a.pod].filter(Boolean).join(" / ") },
  kube_exec: { icon: ScrollText, label: t("دستور داخل پاد"), subtitle: (a) => [a.cluster, a.namespace, a.pod].filter(Boolean).join(" / ") },
  kube_df: { icon: HardDrive, label: t("فضای دیسک پاد"), subtitle: (a) => [a.cluster, a.namespace, a.pod, a.path].filter(Boolean).join(" / "), open: true },
  metrics_query: { icon: Search, label: t("کوئری Prometheus"), subtitle: (a) => [a.cluster, a.range, a.promql].filter(Boolean).join(" · "), open: false },
  pg_query: { icon: Database, label: t("کوئری Postgres"), subtitle: (a) => `${a.cluster}/${a.namespace}/${a.name}${a.database ? `/${a.database}` : ""}${a.write ? " ✎" : ""}`, open: true },
  show_media: { icon: FileText, label: t("نمایش فایل"), subtitle: (a) => a.title || a.path || a.url, open: true },
  // preview_start draws its own card (PreviewCard); the rest are plain rows.
  preview_start: { icon: AppWindow, label: t("پیش‌نمایش اپ"), subtitle: (a) => a.title || a.command, open: true },
  preview_restart: { icon: AppWindow, label: t("اجرای دوبارهٔ پیش‌نمایش"), subtitle: (a) => a.id },
  preview_stop: { icon: AppWindow, label: t("توقف پیش‌نمایش"), subtitle: (a) => a.id },
  preview_list: { icon: AppWindow, label: t("پیش‌نمایش‌های این گفتگو") },
  preview_logs: { icon: ScrollText, label: t("لاگ پیش‌نمایش"), subtitle: (a) => a.id },
  telegram_dialogs: { icon: Send, label: t("گفتگوهای تلگرام"), subtitle: (a) => a.query },
  telegram_read: { icon: Send, label: t("خواندن تلگرام"), subtitle: (a) => a.chat, open: true },
  telegram_media: { icon: FileText, label: t("دریافت فایل از تلگرام"), subtitle: (a) => [a.chat, a.messageId].filter(Boolean).join(" · "), open: true },
  telegram_ledger: { icon: Send, label: t("دفتر ارسال تلگرام"), subtitle: (a) => a.peerId },
  inbox_route: { icon: Send, label: t("مسیردهی صندوق تلگرام"), subtitle: (a) => a.chatId },
  telegram_send: { icon: Send, label: t("ارسال در تلگرام"), subtitle: (a) => a.chat, open: true },
  // Telegram v2: the mother chat's threads and the one way text reaches a colleague.
  delegate: { icon: Workflow, label: t("ترد تازه"), subtitle: (a) => String(a.request || "").split("\n")[0] },
  subtasks: { icon: Workflow, label: t("پیگیری ترد"), subtitle: (a) => a.action },
  team_threads: { icon: ListChecks, label: t("ترد‌های همه") },
  thread_join: { icon: Users, label: t("همان مسئله"), subtitle: (a) => a.thread },
  send_to_person: { icon: Send, label: t("📤 فرستادن به همکار"), open: true },
  edit_sent: { icon: Send, label: t("✏️ ویرایش پیام فرستاده"), subtitle: (a) => (a.id != null ? `#${a.id}` : ""), open: true },
  delete_sent: { icon: Send, label: t("🗑 برداشتن پیام فرستاده"), subtitle: (a) => (a.id != null ? `#${a.id}` : "") },
  react: { icon: Send, label: t("واکنش روی پیام"), subtitle: (a) => `${a.emoji || t("برداشتن واکنش")}${a.id != null ? ` · #${String(a.id).replace(/^#/, "")}` : ""}` },
  tell_person: { icon: Send, label: t("سپردن به چت مادر"), subtitle: (a) => a.person, open: true },
  telegram_people: { icon: Users, label: t("فهرست افراد") },
  feed_read: { icon: ScrollText, label: t("گزارش‌ها") },
  telegram_pause: { icon: Pause, get label() { return t("توقف/ادامهٔ {name}", { name: BRAND.name }); }, subtitle: (a) => (a.paused ? t("توقف") : t("ادامه")) },
  grafana_search: { icon: Search, label: t("جستجوی داشبورد Grafana"), subtitle: (a) => [a.cluster, a.query].filter(Boolean).join(" / ") },
  grafana_dashboard: { icon: Boxes, label: t("خواندن داشبورد Grafana"), subtitle: (a) => a.uid },
  grafana_panel_query: { icon: Database, label: t("دادهٔ پنل Grafana"), subtitle: (a) => `${a.uid} #${a.panelId}${a.from ? ` · ${a.from}` : ""}`, open: true },
  grafana_query: { icon: Database, label: t("کوئری روی دیتاسورس Grafana"), subtitle: (a) => a.datasourceUid, open: true },
  s3_list: { icon: Database, label: t("فهرست باکت S3"), subtitle: (a) => [a.bucket, a.prefix].filter(Boolean).join(" / ") },
  s3_get: { icon: FileText, label: t("دریافت فایل از S3"), subtitle: (a) => `${a.bucket}/${a.key}`, open: true },
  mikrotik_print: { icon: Router, label: t("خواندن میکروتیک"), subtitle: (a) => [a.router, a.path, a.where && Object.entries(a.where).map(([k, v]) => `${k}=${v}`).join(" ")].filter(Boolean).join(" ") },
  mikrotik_ping: { icon: Router, label: t("پینگ از میکروتیک"), subtitle: (a) => a.address },
  mikrotik_forward_add: { icon: Router, label: t("افزودن port forward"), subtitle: (a) => `:${a.publicPort} → ${a.toAddress}:${a.toPort}`, open: true },
  mikrotik_address_list_add: { icon: Router, label: t("افزودن به address-list"), subtitle: (a) => `${a.list} ← ${a.address}`, open: true },
  mikrotik_set_enabled: { icon: Router, label: t("فعال/غیرفعال قاعدهٔ میکروتیک"), subtitle: (a) => `${a.path} ${a.id} ${a.enabled ? "on" : "off"}`, open: true },
  mikrotik_remove: { icon: Router, label: t("حذف از میکروتیک"), subtitle: (a) => `${a.path} ${a.id}`, open: true },
  debug_exec: { icon: Terminal, label: t("دستور روی سرور debug"), subtitle: (a) => a.command },
  ssh_exec: { icon: Terminal, label: t("دستور روی سرور"), subtitle: (a) => a.command },
  mikrotik_exec: { icon: Router, label: t("کنسول میکروتیک"), subtitle: (a) => a.command },
  kube_secret: { icon: KeyRound, label: t("خواندن Secret کلاستر"), subtitle: (a) => [a.cluster, a.namespace, a.name].filter(Boolean).join(" / "), open: true },
  infisical_get: { icon: KeyRound, label: t("خواندن از Infisical"), subtitle: (a) => a.name, open: true },
  gitlab_projects: { icon: GitBranch, label: t("پروژه‌های GitLab"), subtitle: (a) => a.search },
  gitlab_search: { icon: Search, label: t("جستجوی کد GitLab"), subtitle: (a) => `${a.scope || "blobs"}: ${a.search}`, open: true },
  gitlab_file: { icon: FileText, label: t("خواندن فایل GitLab"), subtitle: (a) => `${a.project}/${a.path}`, open: true },
  gitlab_mr: { icon: GitBranch, label: t("Merge Request گیت‌لب"), subtitle: (a) => `${a.project}!${a.iid} · ${({ ready: t("آمادهٔ ادغام"), merge: t("ادغام") })[a.action] || t("نمایش")}`, open: true },
  infisical_projects: { icon: FolderTree, label: t("پروژه‌های Infisical") },
  infisical_list: { icon: FolderTree, label: t("فهرست Infisical"), subtitle: (a) => a.path },
  infisical_upsert: { icon: KeyRound, label: t("ذخیره در Infisical"), subtitle: (a) => a.name, open: true },
  arvan_domains: { icon: Cloud, label: t("دامنه‌های آروان"), subtitle: (a) => a.search },
  arvan_dns_records: { icon: Globe, label: t("رکوردهای DNS آروان"), subtitle: (a) => [a.domain, a.type, a.name].filter(Boolean).join(" / "), open: true },
  arvan_dns_export: { icon: FileText, label: t("خروجی BIND آروان"), subtitle: (a) => a.domain },
  arvan_dnssec: { icon: Lock, label: t("وضعیت DNSSEC"), subtitle: (a) => a.domain },
  arvan_cache_settings: { icon: Cloud, label: t("تنظیمات کش آروان"), subtitle: (a) => a.domain, open: true },
  arvan_load_balancer_get: { icon: Cloud, label: t("لود‌بالانسر آروان"), subtitle: (a) => [a.domain, a.name].filter(Boolean).join(" / "), open: true },
  arvan_purge_tags: { icon: Cloud, label: t("تگ‌های purge"), subtitle: (a) => a.domain },
  arvan_cache_purge: { icon: Cloud, label: t("پاک‌کردن کش آروان"), subtitle: (a) => [a.domain, a.scope].filter(Boolean).join(" · "), open: true },
  dns_lookup: { icon: Network, label: t("جست‌وجوی DNS"), subtitle: (a) => `${a.type || "A"} ${a.name || ""}`.trim(), open: true },
  http_check: { icon: Globe, label: t("بررسی HTTP"), subtitle: (a) => a.url, open: true },
  web_search: { icon: Globe, label: t("جستجوی وب"), subtitle: (a) => a.query },
  web_fetch: { icon: Globe, label: t("خواندن صفحهٔ وب"), subtitle: (a) => a.url },
  // The agent's own browser in the sandbox (browser.mjs).
  browser_open: { icon: AppWindow, label: t("مرورگر"), subtitle: (a) => a.url || { back: t("برگشت"), forward: t("جلو"), reload: t("بارگذاری دوباره") }[a.go] },
  browser_snapshot: { icon: AppWindow, label: t("خواندن صفحه در مرورگر") },
  browser_click: { icon: MousePointerClick, label: t("کلیک در مرورگر"), subtitle: (a) => a.ref || a.selector || a.text },
  browser_hover: { icon: MousePointerClick, label: t("نگه‌داشتن نشانگر"), subtitle: (a) => a.ref || a.selector || a.text },
  browser_type: { icon: Keyboard, label: t("نوشتن در مرورگر"), subtitle: (a) => a.ref || a.selector || a.text },
  browser_select: { icon: Keyboard, label: t("انتخاب گزینه در مرورگر"), subtitle: (a) => (a.values || []).join(t("، ")) },
  browser_press: { icon: Keyboard, label: t("زدن کلید در مرورگر"), subtitle: (a) => a.key },
  browser_upload: { icon: FileText, label: t("بارگذاری فایل در مرورگر"), subtitle: (a) => (a.paths || []).join(t("، ")) },
  browser_wait: { icon: Loader2, label: t("صبر در مرورگر"), subtitle: (a) => a.text || a.textGone || a.selector || (a.seconds ? `${a.seconds}s` : "") },
  browser_eval: { icon: Terminal, label: t("اجرای JavaScript در صفحه"), subtitle: (a) => a.expression },
  browser_screenshot: { icon: Camera, label: t("عکس از صفحه"), subtitle: (a) => a.title, open: true },
  browser_tabs: { icon: AppWindow, label: t("تب‌های مرورگر"), subtitle: (a) => a.action },
  browser_console: { icon: ScrollText, label: t("خطاهای صفحه") },
  browser_close: { icon: X, label: t("بستن مرورگر") },
  tls_check: { icon: Lock, label: t("بررسی گواهی TLS"), subtitle: (a) => a.host, open: true },
  nsin_edge_ranges: { icon: Network, label: t("رنج‌های لبهٔ NSIN") },
  nsin_domains: { icon: Cloud, label: t("دامنه‌های NSIN"), subtitle: (a) => a.search },
  nsin_domain: { icon: Globe, label: t("جزئیات دامنهٔ NSIN"), subtitle: (a) => a.domain, open: true },
  nsin_dns_records: { icon: Globe, label: t("رکوردهای DNS انسین"), subtitle: (a) => [a.domain, a.type, a.name].filter(Boolean).join(" / "), open: true },
  nsin_dns_create: { icon: Globe, label: t("ساخت رکورد NSIN"), subtitle: (a) => [a.domain, a.type, a.name].filter(Boolean).join(" / "), open: true },
  nsin_dns_update: { icon: Globe, label: t("ویرایش رکورد NSIN"), subtitle: (a) => [a.domain, a.recordId].filter(Boolean).join(" #"), open: true },
  nsin_dns_delete: { icon: Globe, label: t("حذف رکورد NSIN"), subtitle: (a) => [a.domain, a.recordId].filter(Boolean).join(" #"), open: true },
  nsin_ssl_status: { icon: Lock, label: t("وضعیت SSL انسین"), subtitle: (a) => a.domain, open: true },
  nsin_ssl_issue: { icon: Lock, label: t("صدور گواهی NSIN"), subtitle: (a) => a.domain, open: true },
  nsin_check_nameservers: { icon: Network, label: t("چک نیم‌سرور NSIN"), subtitle: (a) => a.domain },
  nsin_developer_mode: { icon: Cloud, label: t("حالت توسعه‌دهنده NSIN"), subtitle: (a) => `${a.domain} · ${a.enabled ? t("روشن") : t("خاموش")}`, open: true },
  nsin_cache_stats: { icon: Cloud, label: t("آمار کش NSIN"), subtitle: (a) => a.domain, open: true },
  nsin_cache_keys: { icon: Cloud, label: t("کلیدهای کش NSIN"), subtitle: (a) => [a.domain, a.path].filter(Boolean).join(" · ") },
  nsin_cache_purge: { icon: Cloud, label: t("پاک‌کردن کل کش NSIN"), subtitle: (a) => a.domain, open: true },
  nsin_cache_purge_path: { icon: Cloud, label: t("پاک‌کردن مسیر کش NSIN"), subtitle: (a) => [a.domain, a.path].filter(Boolean).join(" · "), open: true },
  nsin_rules: { icon: FolderTree, label: t("قوانین لبهٔ NSIN"), subtitle: (a) => [a.domain, a.kind].filter(Boolean).join(" / "), open: true },
  nsin_rule_toggle: { icon: FolderTree, label: t("سوییچ قانون NSIN"), subtitle: (a) => [a.domain, a.kind, a.ruleId].filter(Boolean).join(" / "), open: true },
  nsin_analytics_summary: { icon: Network, label: t("خلاصهٔ ترافیک NSIN"), subtitle: (a) => [a.domain, a.period].filter(Boolean).join(" · "), open: true },
  nsin_top_uris: { icon: Network, label: t("URIهای پربازدید NSIN"), subtitle: (a) => a.domain, open: true },
  nsin_request_logs: { icon: FileText, label: t("لاگ درخواست NSIN"), subtitle: (a) => a.domain },
  nsin_waf_logs: { icon: Lock, label: t("لاگ WAF انسین"), subtitle: (a) => a.domain },
  nsin_analytics_query: { icon: FileText, label: t("کوئری آنالیتیکس NSIN"), open: true },
  nsin_uptime_live: { icon: Network, label: t("آپ‌تایم زندهٔ NSIN"), subtitle: (a) => a.domain, open: true },
  nsin_uptime_incidents: { icon: Network, label: t("قطع‌های NSIN"), subtitle: (a) => a.domain },
  nsin_recommendations: { icon: FileText, label: t("پیشنهادهای NSIN"), subtitle: (a) => a.domain, open: true },
  ask_agent: { icon: Workflow, label: t("درخواست از ایجنت همتا"), subtitle: (a) => a.agent, open: true },
  task: { icon: Workflow, label: t("زیرایجنت"), subtitle: (a) => a.description, open: false },
  knowledge_write: { icon: FileText, label: t("یادداشت دانش"), subtitle: (a) => a.title, open: true },
  knowledge_list: { icon: FolderTree, label: t("فهرست دانش"), subtitle: (a) => a.agent },
  knowledge_edit: { icon: FileText, label: t("ویرایش یادداشت"), subtitle: (a) => a.file },
  knowledge_delete: { icon: FileText, label: t("حذف یادداشت"), subtitle: (a) => a.file },
  jobs_list: { icon: FolderTree, label: t("فهرست جاب‌ها") },
  jobs_create: { icon: FolderTree, label: t("ساخت جاب"), subtitle: (a) => a.name },
  jobs_update: { icon: FolderTree, label: t("ویرایش جاب"), subtitle: (a) => a.name || a.id },
  jobs_delete: { icon: FolderTree, label: t("حذف جاب"), subtitle: (a) => a.id },
  jobs_run: { icon: FolderTree, label: t("اجرای جاب"), subtitle: (a) => a.id },

  // Claude Code's own tools. Griffin's Claude engine runs only griffin MCP tools
  // with Bash off, but a stray native call still gets a label and icon instead of a raw-name row.
  Bash: { icon: Terminal, label: t("اجرای دستور"), subtitle: (a) => a.command },
  Edit: { icon: PencilLine, label: t("ویرایش فایل"), subtitle: (a) => a.file_path, open: true },
  MultiEdit: { icon: PencilLine, label: t("ویرایش فایل (چندبخشی)"), subtitle: (a) => a.file_path, open: true },
  Write: { icon: PencilLine, label: t("نوشتن فایل"), subtitle: (a) => a.file_path, open: true },
  Read: { icon: FileText, label: t("خواندن فایل"), subtitle: (a) => a.file_path },
  Grep: { icon: Search, label: t("جستجو در کد"), subtitle: (a) => a.pattern },
  Glob: { icon: FolderTree, label: t("یافتن فایل‌ها"), subtitle: (a) => a.pattern },
  WebFetch: { icon: Globe, label: t("خواندن صفحهٔ وب"), subtitle: (a) => a.url },
  WebSearch: { icon: Globe, label: t("جستجوی وب"), subtitle: (a) => a.query },
  Task: { icon: Workflow, label: t("زیرایجنت"), subtitle: (a) => a.description },
  Agent: { icon: Workflow, label: t("زیرایجنت"), subtitle: (a) => a.description },
  TodoWrite: { icon: ListChecks, label: t("برنامهٔ کار"), open: true },
  NotebookEdit: { icon: PencilLine, label: t("ویرایش نوت‌بوک"), subtitle: (a) => a.notebook_path, open: true },
  TaskCreate: { icon: ListChecks, label: t("افزودن کار"), subtitle: (a) => a.subject || a.description },
  TaskUpdate: { icon: ListChecks, label: t("به‌روزرسانی کار"), subtitle: (a) => a.subject || a.taskId || a.task_id },
  TaskList: { icon: ListChecks, label: t("فهرست کارها") },
  TaskGet: { icon: ListChecks, label: t("خواندن کار"), subtitle: (a) => a.taskId || a.task_id },
  TaskOutput: { icon: Terminal, label: t("خروجی کار"), subtitle: (a) => a.taskId || a.task_id },
  TaskStop: { icon: X, label: t("توقف کار"), subtitle: (a) => a.taskId || a.task_id },
  Monitor: { icon: Activity, label: t("پایش"), subtitle: (a) => a.description || a.command },
  ScheduleWakeup: { icon: AlarmClock, label: t("بیدارباش"), subtitle: (a) => [a.delaySeconds != null ? `${a.delaySeconds}s` : null, a.reason].filter(Boolean).join(" · ") },
  CronCreate: { icon: CalendarClock, label: t("زمان‌بندی"), subtitle: (a) => a.cron || a.schedule },
  Artifact: { icon: Globe, label: t("صفحهٔ claude.ai"), subtitle: (a) => [a.action || "publish", a.url || a.file_path].filter(Boolean).join(" · ") },
  Workflow: { icon: Workflow, label: t("گردش‌کار"), subtitle: (a) => a.description },
  Skill: { icon: BookOpen, label: t("مهارت"), subtitle: (a) => a.skill },
  ToolSearch: { icon: Search, label: t("یافتن ابزار"), subtitle: (a) => a.query },
  ExitPlanMode: { icon: ListChecks, label: t("پایان نقشه"), open: true },
  // Claude Code's built-in question; its ask_owner twin, when there is one, is dropped (Work.jsx).
  AskUserQuestion: { icon: CircleHelp, label: t("پرسش از شما"), subtitle: (a) => a.questions?.[0]?.question },
  // consult (peers.mjs): another model's answer inside one call; the body is ConsultBody.
  consult: { icon: Users, label: t("مشورت با مدل دیگر"), subtitle: (a) => [a.provider, a.model].filter(Boolean).join(" · "), open: true },

  // Griffin's own tools that had no row label: the English id stays the API name, the row says it in Persian.
  ask_owner: { icon: CircleHelp, label: t("پرسش از شما"), subtitle: (a) => a.question },
  ask_requester: { icon: CircleHelp, label: t("پرسش از درخواست‌کننده"), subtitle: (a) => a.question },
  visualize: { icon: Activity, label: t("رسم نمودار"), subtitle: (a) => a.title },
  end_agent: { icon: Check, label: t("پایان گفتگو") },
  notify_owner: { icon: Send, label: t("اعلان به گوشی شما"), subtitle: (a) => a.text },
  tell_owner: { icon: Send, label: t("خبر به صاحب‌کار"), subtitle: (a) => a.text },
  build_tool: { icon: Server, label: t("درخواست ساخت ابزار"), subtitle: (a) => a.title, open: true },
  alerts_active: { icon: AlertTriangle, label: t("هشدارهای فعال"), subtitle: (a) => a.cluster },
  telegram_edit: { icon: Send, label: t("ویرایش پیام تلگرام"), subtitle: (a) => a.chat, open: true },
  telegram_delete: { icon: Trash2, label: t("حذف پیام تلگرام"), subtitle: (a) => a.chat, open: true },
  telegram_watch_list: { icon: Users, label: t("گفتگوهای زیر نظر") },
  related_chat_send: { icon: Send, label: t("پیام به گفتگوی همان درخواست‌کننده"), subtitle: (a) => a.chat },
  // Incidents (the ops room).
  incidents_list: { icon: AlertTriangle, label: t("حادثه‌های باز") },
  incident_history: { icon: ScrollText, label: t("سابقهٔ حادثه"), subtitle: (a) => a.id },
  incident_update: { icon: PencilLine, label: t("ثبت بررسی حادثه"), subtitle: (a) => a.id },
  incident_ack: { icon: Check, label: t("عمدی/شناخته‌شده کردن حادثه"), subtitle: (a) => a.id, open: true },
  incident_sources: { icon: AlertTriangle, label: t("منابع داده حادثه‌ها") },
  incident_source_set: { icon: PencilLine, label: t("مدیریت منبع حادثه‌ها"), subtitle: (a) => [a.action, a.name || a.id || a.chat].filter(Boolean).join(" · "), open: true },
  incident_assign: { icon: Check, label: t("اساین حادثه به چت"), subtitle: (a) => a.id, open: true },
  incident_suggest: { icon: Check, label: t("پیشنهاد حادثه در فضای کار"), subtitle: (a) => a.title || a.id, open: true },
  // Jobs and chats.
  jobs_list: { icon: CalendarClock, label: t("فهرست کارهای زمان‌بندی‌شده") },
  jobs_create: { icon: CalendarClock, label: t("ساخت کار زمان‌بندی‌شده"), subtitle: (a) => a.name, open: true },
  jobs_update: { icon: CalendarClock, label: t("ویرایش کار زمان‌بندی‌شده"), subtitle: (a) => a.name || a.id, open: true },
  jobs_delete: { icon: Trash2, label: t("حذف کار زمان‌بندی‌شده"), subtitle: (a) => a.id, open: true },
  jobs_run: { icon: CalendarClock, label: t("اجرای فوری کار"), subtitle: (a) => a.id },
  chat_list: { icon: Inbox, label: t("فهرست گفتگوهای شما"), subtitle: (a) => a.query },
  chat_read: { icon: Inbox, label: t("خواندن یک گفتگو"), subtitle: (a) => a.chatId },
  chat_send: { icon: Send, label: t("پیام به گفتگوی دیگر"), subtitle: (a) => a.chatId },
  chat_archive: { icon: Inbox, label: t("بایگانی گفتگوها"), open: true },
  chat_suggest: { icon: Inbox, label: t("پیشنهاد گفتگوی تازه"), subtitle: (a) => a.title },
  chat_dismiss_suggestion: { icon: X, label: t("پس‌گرفتن پیشنهاد"), subtitle: (a) => a.id },
  chat_chapter: { icon: BookOpen, label: t("فصل تازهٔ گفتگو"), subtitle: (a) => a.title },
  // Agents, network, MCP servers, self-check.
  list_agents: { icon: Users, label: t("فهرست ایجنت‌ها") },
  agent_create: { icon: Users, label: t("ساخت ایجنت"), subtitle: (a) => a.label, open: true },
  agent_delete: { icon: Trash2, label: t("حذف ایجنت"), subtitle: (a) => a.id, open: true },
  agent_settings_get: { icon: Server, label: t("خواندن تنظیمات ایجنت") },
  agent_settings_set: { icon: Server, label: t("تغییر تنظیمات ایجنت"), open: true },
  agent_tools_list: { icon: ListChecks, label: t("ابزارهای این ایجنت") },
  agent_tools_enable: { icon: ListChecks, label: t("روشن کردن ابزار برای ایجنت"), subtitle: (a) => (a.tools || []).join(t("، ")), open: true },
  agent_tools_disable: { icon: ListChecks, label: t("خاموش کردن ابزار ایجنت"), subtitle: (a) => (a.tools || []).join(t("، ")), open: true },
  network_agents: { icon: Users, label: t("ایجنت‌های همکاران") },
  network_ask: { icon: Send, label: t("پرسش از ایجنت همکار"), subtitle: (a) => a.agent, open: true },
  network_reply: { icon: Send, label: t("جواب به ایجنت همکار"), subtitle: (a) => a.agent },
  network_connect: { icon: Users, label: t("وصل شدن به ایجنت همکار"), subtitle: (a) => a.url },
  peer_invite: { icon: Users, label: t("دعوت همکار به ایجنت‌ها"), subtitle: (a) => a.label || a.id, open: true },
  peer_connection: { icon: Network, label: t("وضعیت اتصال ایجنت همکار"), subtitle: (a) => a.user },
  mcp_server_list: { icon: Server, label: t("سرورهای MCP شما") },
  mcp_server_add: { icon: Server, label: t("افزودن سرور MCP"), subtitle: (a) => a.name, open: true },
  mcp_server_login: { icon: KeyRound, label: t("ورود به سرور MCP"), subtitle: (a) => a.name, open: true },
  mcp_server_remove: { icon: Trash2, label: t("حذف سرور MCP"), subtitle: (a) => a.name, open: true },
  self_check: { icon: Activity, label: t("بررسی سلامت خود برنامه") },
  self_fix: { icon: Activity, label: t("اعمال تعمیر پیشنهادی"), subtitle: (a) => a.fix, open: true },
  // Cluster and GitLab, Infisical, git repos of this chat.
  kube_create: { icon: Boxes, label: t("ساختن آبجکت در کلاستر"), subtitle: (a) => [a.cluster, a.namespace, a.manifest?.kind, a.manifest?.metadata?.name].filter(Boolean).join(" / "), open: true },
  later: { icon: CalendarClock, label: t("یادآوری برای بعد"), subtitle: (a) => [a.in || a.at, String(a.text || "").slice(0, 60)].filter(Boolean).join(" — ") },
  kube_copy_secret: { icon: KeyRound, label: t("کپی Secret بین کلاسترها"), subtitle: (a) => [a.fromCluster, a.toCluster, a.namespace, a.name].filter(Boolean).join(" / "), open: true },
  cnpg_retry_bootstrap: { icon: Database, label: t("تلاش دوباره برای ساخت دیتابیس"), subtitle: (a) => [a.cluster, a.namespace, a.name].filter(Boolean).join(" / "), open: true },
  gitlab_commits: { icon: GitBranch, label: t("کامیت‌های GitLab"), subtitle: (a) => [a.project, a.path].filter(Boolean).join(" / ") },
  gitlab_mrs: { icon: GitBranch, label: t("فهرست Merge Requestها"), subtitle: (a) => a.project || a.search },
  gitlab_mr_changes: { icon: GitBranch, label: t("تغییرات Merge Request"), subtitle: (a) => (a.iid ? `${a.project}!${a.iid}` : [a.project, a.from, a.to].filter(Boolean).join(" ")), open: true },
  gitlab_pipeline: { icon: GitBranch, label: t("وضعیت پایپ‌لاین GitLab"), subtitle: (a) => [a.project, a.id].filter(Boolean).join(" #") },
  gitlab_propose: { icon: GitBranch, label: t("پیشنهاد تغییر (Merge Request)"), subtitle: (a) => a.title, open: true },
  gitlab_project_member: { icon: Users, label: t("دادن دسترسی به پروژهٔ GitLab"), subtitle: (a) => `${a.username} → ${a.project}`, open: true },
  mr_explainer_overview: { icon: GitBranch, label: t("نمای کلی Merge Request"), subtitle: (a) => `${a.project}!${a.iid}` },
  infisical_access: { icon: KeyRound, label: t("دسترسی‌های Infisical"), subtitle: (a) => a.person || a.project },
  infisical_create_project: { icon: FolderTree, label: t("ساخت پروژهٔ Infisical"), subtitle: (a) => a.name, open: true },
  infisical_machine_identity: { icon: KeyRound, label: t("ساخت هویت ماشینی Infisical"), subtitle: (a) => a.name, open: true },
  git_clone: { icon: GitBranch, label: t("کلون ریپو"), subtitle: (a) => a.project },
  git_fetch: { icon: GitBranch, label: t("به‌روز کردن ریپو"), subtitle: (a) => a.repo },
  git_push: { icon: GitBranch, label: t("پوش شاخه"), subtitle: (a) => `${a.repo} · ${a.branch}`, open: true },
  repo_list: { icon: FolderTree, label: t("فهرست فایل‌های ریپو"), subtitle: (a) => a.path },
  repo_read: { icon: FileText, label: t("خواندن فایل ریپو"), subtitle: (a) => a.path },
  repo_search: { icon: Search, label: t("جستجو در ریپو"), subtitle: (a) => a.pattern },
  repo_write: { icon: PencilLine, label: t("نوشتن فایل ریپو"), subtitle: (a) => a.path, open: true },
  repo_edit: { icon: PencilLine, label: t("ویرایش فایل ریپو"), subtitle: (a) => a.path, open: true },
  repo_git: { icon: GitBranch, label: t("دستور git"), subtitle: (a) => (a.args || []).join(" ") },
  repo_push: { icon: GitBranch, label: t("پوش این شاخه و باز کردن MR"), subtitle: (a) => a.mrTitle, open: true },
  // vCenter.
  vcenter_inventory: { icon: Server, label: t("منابع vCenter") },
  vcenter_vms: { icon: Server, label: t("ماشین‌های مجازی"), subtitle: (a) => a.search },
  vcenter_vm_get: { icon: Server, label: t("وضعیت یک ماشین مجازی"), subtitle: (a) => a.vm },
  vcenter_vm_create: { icon: Server, label: t("ساخت ماشین مجازی"), subtitle: (a) => a.name, open: true },
  vcenter_customization_specs: { icon: Server, label: t("قالب‌های شخصی‌سازی vCenter") },
};

// A running step under the Karsara skin: a thin spinning ring instead of a spinner icon.
const Ring = () => <span aria-label={t("در حال اجرا")} className="inline-block size-3 shrink-0 animate-spin rounded-full border-[1.5px] border-current border-t-transparent opacity-70" />;

// A file path shortened to its last two segments, so the one-line row stays readable.
export function shortTarget(value) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (/^[A-Za-z]:[\\/]|^\//.test(text) && !text.includes(" ")) return text.split(/[\\/]/).filter(Boolean).slice(-2).join("/");
  return text;
}

export function ToolCard(props) {
  if (props.toolName === "ask_owner" || props.toolName === "ask_requester") return <AskCard {...props} />;
  if (props.toolName === "visualize") return <ChartCard {...props} />;
  if (props.toolName === "preview_start") return <PreviewCard {...props} />;
  if (props.toolName === "ask_agent") return <PeerCard {...props} />;
  if (props.toolName === "task") return <TaskCard {...props} />;
  // A consult that ran but got no answer (timeout, the asking chat stopped) is a failure on the row too.
  if (props.toolName === "consult") return <GenericToolCard {...props} isError={props.isError || props.result?.state === "failed"} />;
  // The board's "open" scrolls to this card (focus.js): by the chore id, or by title for older ones.
  if (props.toolName === "owner_task") return <div data-chore={props.result?.id || ""} data-chore-title={props.args?.access ? `دسترسی: ${props.args.access}` : props.args?.title || ""}><GenericToolCard {...props} /></div>; // i18n-ignore: matches the server's chore title
  return <GenericToolCard {...props} />;
}

function PeerCard({ args = {}, result, isError, status }) {
  const running = status?.type === "running" || result === undefined;
  const envelope = result && typeof result === "object" ? result : null;
  const meta = agentMeta(args.agent);
  const task = String(args.request || "").trim();
  const taskLine = task.length > 90 ? `${task.slice(0, 90)}…` : task;
  const markdown = String(envelope?.summary || envelope?.brief || "").trim();
  const hasBody = Boolean(markdown || (envelope?.unknowns?.length) || (envelope?.facts?.length));
  const [open, setOpen] = useState(false);
  const expanded = open;
  const children = useContext(ChatChildrenContext);
  const liveChild = running
    ? children.find((child) => child.agent === args.agent && child.runStatus === "running") || null
    : null;
  const headline = running
    ? t("{agent} در حال انجام {task}…", { agent: meta.label, task: taskLine || t("درخواست") })
    : isError
      ? t("{agent} · خطا", { agent: meta.label })
      : t("{agent} · انجام شد", { agent: meta.label });
  // Karsara: the same content in a flat frame (a tool row, the body in its own box).
  const karsara = useLook() === "karsara";

  return (
    <div
      className={karsara ? "my-0.5" : `my-2 overflow-hidden rounded-xl border ${isError ? "border-bad/50" : ""}`}
      style={karsara ? undefined : {
        borderColor: isError ? undefined : `${meta.color}55`,
        background: `color-mix(in srgb, ${meta.color} 10%, var(--card))`,
      }}
    >
      <button
        type="button"
        onClick={() => !running && hasBody && setOpen(!expanded)}
        className={karsara ? "g-tool-head flex w-full items-start gap-1.5 rounded-md px-1.5 py-1 text-start text-sm hover:bg-muted" : "flex w-full items-start gap-2.5 px-3 py-2.5 text-start text-sm hover:bg-black/5 dark:hover:bg-white/5"}
        disabled={running || !hasBody}
      >
        <AgentGlyph id={args.agent} className={karsara ? "mt-0.5 size-4" : "mt-0.5 size-7"} />
        <div className="min-w-0 flex-1 space-y-0.5">
          <p className={`font-medium leading-snug ${running ? "shimmer" : ""}`} dir="auto" style={{ color: meta.color }}>
            {headline}
          </p>
          {!running && task ? (
            <p className="text-xs text-muted-foreground" dir="auto">{taskLine}</p>
          ) : null}
        </div>
        <span className="ms-auto flex shrink-0 items-center gap-1.5 pt-0.5">
          {running && liveChild ? (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); navigate(liveChild.id); }}
              className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] font-medium hover:bg-muted"
              style={{ borderColor: `${meta.color}55` }}
              title={t("باز کردن چت این ایجنت (زنده)")}
            >
              <ExternalLink className="size-3" />
              {t("دیدن چت")}
            </button>
          ) : null}
          {running && liveChild ? (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); api(`/api/chats/${liveChild.id}/cancel`, { method: "POST" }).catch(() => {}); }}
              className="inline-flex items-center gap-1 rounded-md border border-bad/40 px-2 py-1 text-[11px] font-medium text-bad hover:bg-bad/10"
              title={t("توقف این زیرایجنت")}
            >
              <Square className="size-3" />
              {t("توقف")}
            </button>
          ) : null}
          {!running && envelope?.chatRef ? (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); navigate(envelope.chatRef); }}
              className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] font-medium hover:bg-muted"
              style={{ borderColor: `${meta.color}55` }}
              title={t("باز کردن چت این ایجنت")}
            >
              <ExternalLink className="size-3" />
              {t("چت")}
            </button>
          ) : null}
          {running ? (
            karsara ? <Ring /> : <Loader2 className="size-4 animate-spin" style={{ color: meta.color }} />
          ) : isError ? (
            <X className="size-4 text-bad" />
          ) : karsara ? null : (
            <Check className="size-4 text-ok" />
          )}
          {!running && hasBody ? (
            <motion.span animate={{ rotate: expanded ? 180 : 0 }} transition={{ duration: 0.2 }} className="flex">
              <ChevronDown className="size-4 text-muted-foreground" />
            </motion.span>
          ) : null}
        </span>
      </button>
      <AnimatePresence initial={false}>
        {expanded && !running && hasBody ? (
          <motion.div
            key="peer-body"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.22, ease: [0.2, 0, 0, 1] }}
            className="overflow-hidden"
          >
            <div className={karsara ? "g-tool-body my-1 space-y-2 rounded-lg border px-3 py-2.5 text-sm" : "space-y-2 border-t px-3 py-2.5 text-sm"} style={karsara ? undefined : { borderColor: `${meta.color}33` }}>
              {markdown ? <PeerMarkdown text={markdown} /> : null}
              {Array.isArray(envelope?.unknowns) && envelope.unknowns.length ? (
                <p className="text-xs text-bad" dir="auto">{envelope.unknowns.join(" · ")}</p>
              ) : null}
              {Array.isArray(envelope?.facts) && envelope.facts.length ? (
                <PeerFacts facts={envelope.facts} color={meta.color} />
              ) : null}
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

// A consult's answer (peers.mjs consultTool: { consultId, state, from, answer, error }). Shared by both
// skins: the frame around it is GenericToolCard's, so only this body is new.
function ConsultBody({ args = {}, result }) {
  const failed = result?.state === "failed";
  const answer = String(result?.answer || "").trim();
  const question = String(args.prompt || "").trim();
  return (
    <div className="space-y-2">
      {question ? (
        <details>
          <summary className="cursor-pointer text-xs text-muted-foreground">{t("پرسش")}</summary>
          <p className="mt-1 whitespace-pre-wrap break-words text-sm" dir="auto">{question}</p>
        </details>
      ) : null}
      {failed ? <p className="text-xs text-bad" dir="auto">{t("به جواب نرسید: {error}", { error: result.error || t("خطا") })}</p> : null}
      {answer ? <PeerMarkdown text={answer} /> : failed ? null : <p className="text-xs text-muted-foreground">{t("جوابی نیامد.")}</p>}
      {result?.from || result?.consultId ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          {result?.from ? <span className="ltr min-w-0 truncate font-mono" title={t("مدلی که جواب داد")}>{result.from}</span> : null}
          {result?.consultId ? (
            <button
              type="button"
              onClick={() => navigate(result.consultId)}
              className="ms-auto inline-flex shrink-0 items-center gap-1 rounded-md border px-2 py-1 text-[11px] font-medium hover:bg-muted"
              title={t("باز کردن چتِ این مشورت")}
            >
              <ExternalLink className="size-3" />
              {t("دیدن چت")}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function PeerMarkdown({ text }) {
  const dir = textDir(text) === "ltr" ? "ltr" : "rtl";
  return (
    <div className="sd-block chat-text leading-7 [&_pre]:my-2 [&_table]:my-2" dir={dir}>
      <Streamdown dir={dir} BlockComponent={DirBlock} plugins={mdPlugins} shikiTheme={["github-light", "github-dark"]}>
        {text}
      </Streamdown>
    </div>
  );
}

function PeerFacts({ facts, color }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-lg border" style={{ borderColor: `${color}33` }}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-xs text-muted-foreground hover:text-foreground"
      >
        <span>{t("{n} خروجی ابزار", { n: num(facts.length) })}</span>
        <motion.span animate={{ rotate: open ? 180 : 0 }} transition={{ duration: 0.2 }} className="ms-auto flex">
          <ChevronDown className="size-3.5" />
        </motion.span>
      </button>
      <AnimatePresence initial={false}>
        {open ? (
          <motion.div
            key="facts"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <ul className="space-y-2 border-t px-2.5 py-2" style={{ borderColor: `${color}22` }}>
              {facts.map((fact, i) => {
                const name = fact?.tool || "tool";
                const meta = TOOLS[name] || { label: name, icon: Server };
                const Icon = meta.icon || Server;
                const payload = unwrapPeerFact(fact?.result);
                return (
                  <li key={i} className="rounded-md bg-background/60 px-2 py-1.5">
                    <p className="mb-1 flex items-center gap-1.5 text-xs font-medium">
                      <Icon className="size-3.5 text-muted-foreground" />
                      {meta.label || name}
                    </p>
                    <div className="text-xs">
                      <ToolBody toolName={name} args={fact?.args || {}} result={payload} isError={false} />
                    </div>
                  </li>
                );
              })}
            </ul>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

function unwrapPeerFact(result) {
  if (!result || typeof result !== "object") return result;
  if (result.df || result.records || result.pods || result.source) return result;
  const content = result.value?.content || result.content;
  if (!Array.isArray(content)) return result;
  for (const part of content) {
    const text = typeof part?.text === "string" ? part.text : typeof part?.text?.text === "string" ? part.text.text : null;
    if (!text) continue;
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === "object") return parsed;
    } catch {
      // keep looking
    }
  }
  return result;
}

function TaskCard({ args = {}, result, isError, status, callId }) {
  const parentId = useRoute();
  const running = status?.type === "running" || result === undefined;
  const [open, setOpen] = useState(false);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState(null);
  const description = String(args.description || "").trim() || t("زیرایجنت");
  const steps = Array.isArray(result?.conversationSteps) ? result.conversationSteps : [];
  const summary = taskFinalText(steps);
  const hasBody = Boolean(summary || steps.length || isError);
  const toolCount = steps.filter((s) => s?.toolCall).length;
  const karsara = useLook() === "karsara";

  const openSubchat = async (e) => {
    e.stopPropagation();
    if (!parentId || !callId || opening) return;
    setOpening(true);
    setError(null);
    try {
      const { chat } = await api(`/api/chats/${parentId}/tasks`, { method: "POST", body: { callId } });
      navigate(chat.id);
    } catch (err) {
      setError(err.message || t("باز نشد"));
    } finally {
      setOpening(false);
    }
  };

  return (
    <div className={karsara ? "my-0.5" : `my-2 overflow-hidden rounded-xl border bg-card ${isError ? "border-bad/50" : ""}`}>
      <div className={karsara ? "g-tool-head flex w-full items-start gap-1.5 rounded-md px-1.5 py-1 text-sm" : "flex w-full items-start gap-2.5 px-3 py-2.5 text-sm"}>
        <button
          type="button"
          onClick={() => !running && hasBody && setOpen(!open)}
          className="flex min-w-0 flex-1 items-start gap-2.5 text-start hover:opacity-90"
          disabled={running || !hasBody}
        >
          <Workflow className={`mt-0.5 size-4 shrink-0 ${running ? "animate-pulse text-signal" : "text-muted-foreground"}`} />
          <div className="min-w-0 flex-1 space-y-0.5">
            <p className={`font-medium leading-snug ${running ? "shimmer" : ""}`} dir="auto">
              {running ? t("زیرایجنت در حال انجام {task}…", { task: description }) : t("زیرایجنت · {task}", { task: description })}
            </p>
            {!running && steps.length ? (
              <p className="text-xs text-muted-foreground">
                {toolCount ? t("{n} ابزار", { n: num(toolCount) }) : null}
                {toolCount && result?.durationMs ? " · " : null}
                {result?.durationMs ? t("{n}ث", { n: num(Math.max(1, Math.round(result.durationMs / 1000))) }) : null}
              </p>
            ) : null}
          </div>
        </button>
        <span className="ms-auto flex shrink-0 items-center gap-1.5 pt-0.5">
          {!running && callId && parentId ? (
            <button
              type="button"
              onClick={openSubchat}
              disabled={opening}
              className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] font-medium hover:bg-muted"
              title={t("باز کردن ساب‌چت")}
            >
              {opening ? <Loader2 className="size-3 animate-spin" /> : <ExternalLink className="size-3" />}
              {t("ساب‌چت")}
            </button>
          ) : null}
          {running ? (karsara ? <Ring /> : <Loader2 className="size-4 animate-spin text-muted-foreground" />) : isError ? <X className="size-4 text-bad" /> : karsara ? null : <Check className="size-4 text-ok" />}
          {!running && hasBody ? (
            <button type="button" onClick={() => setOpen(!open)} className="rounded p-0.5 hover:bg-muted" aria-label={t("جزئیات")}>
              <motion.span animate={{ rotate: open ? 180 : 0 }} transition={{ duration: 0.2 }} className="flex">
                <ChevronDown className="size-4 text-muted-foreground" />
              </motion.span>
            </button>
          ) : null}
        </span>
      </div>
      {error ? <p className="border-t px-3 py-1.5 text-xs text-bad">{error}</p> : null}
      <AnimatePresence initial={false}>
        {open && !running && hasBody ? (
          <motion.div
            key="task-body"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.22, ease: [0.2, 0, 0, 1] }}
            className="overflow-hidden"
          >
            <div className={karsara ? "g-tool-body my-1 space-y-3 rounded-lg border px-3 py-2.5 text-sm" : "space-y-3 border-t px-3 py-2.5 text-sm"}>
              {summary ? <PeerMarkdown text={summary} /> : <p className="text-xs text-muted-foreground">{t("خلاصه‌ای نبود؛ ساب‌چت را باز کن.")}</p>}
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

function taskFinalText(steps) {
  let last = null;
  for (const step of steps) {
    const text = step?.assistantMessage?.text;
    if (text) last = String(text);
  }
  return last;
}

// A command step reads like Claude Desktop: the row is a plain sentence — the model's own (Claude
// Bash's `description`, or the `intent` a guarded call carries), else where the command ran — and the
// raw command waits in the opened body. Running or failed, the command stays on the row too.
const SHELL_PLACES = {
  debug_exec: (a) => (a.host && a.host !== "sandbox" ? t("دستور روی {host}", { host: a.host }) : t("دستور در سندباکس")),
  ssh_exec: (a) => (a.host ? t("دستور روی {host}", { host: a.host }) : t("دستور روی سرور")),
  kube_exec: (a) => (a.pod ? t("دستور داخل پاد {pod}", { pod: a.pod }) : t("دستور داخل پاد")),
  mikrotik_exec: (a) => (a.router ? t("کنسول میکروتیک {router}", { router: a.router }) : t("کنسول میکروتیک")),
  Bash: () => t("دستور"),
};

export function stepTitle(toolName, args) {
  const place = SHELL_PLACES[toolName];
  if (!place) return null;
  const own = [args?.description, args?.intent].find((v) => typeof v === "string" && v.trim());
  return own ? own.replace(/\s+/g, " ").trim() : place(args || {});
}

// One plain line for a step in progress: its own title, else "label — target" from TOOLS, else null.
export function stepLine(toolName, args) {
  const own = stepTitle(toolName, args);
  if (own) return own;
  const meta = TOOLS[toolName];
  if (!meta) return null;
  let target = "";
  try {
    target = meta.subtitle ? String(meta.subtitle(args || {}) || "") : "";
  } catch {
    target = "";
  }
  return target ? `${meta.label} — ${target}` : meta.label;
}

function GenericToolCard({ toolName, args = {}, result, isError, status }) {
  const meta = TOOLS[toolName] || { icon: Server, label: toolName };
  const running = status?.type === "running" || result === undefined;
  const [open, setOpen] = useState(null);
  const expanded = open ?? (!result?.cancelled && (isError || (!running && Boolean(meta.open))));
  const Icon = meta.icon;
  const plain = stepTitle(toolName, args);
  const subtitle = plain ? (running || isError ? args.command : "") : safe(() => meta.subtitle?.(args));
  const karsara = useLook() === "karsara";

  if (karsara) {
    // Karsara: no card — a flat row (icon · name · «·» · short target), no ✓ on success, a ring while
    // running; the opened body is its own box. Claude Code's tools keep their English name.
    const name = /^[A-Z]/.test(toolName || "") && toolName !== "AskUserQuestion" ? toolName : meta.label;
    const target = plain ? "" : subtitle;
    return (
      <div className="my-0.5">
        <button type="button" onClick={() => setOpen(!expanded)} aria-expanded={expanded} className="g-tool-head flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-start text-sm text-muted-foreground hover:bg-muted">
          <Icon className="size-3.5 shrink-0" />
          {plain ? (
            <span dir="auto" className="min-w-0 truncate text-foreground/85" title={args.command ? `${plain}\n${args.command}` : plain}>{plain}</span>
          ) : (
            <span className="shrink-0 text-foreground/85">{name}</span>
          )}
          {target ? (
            <>
              <span aria-hidden>·</span>
              <span dir={targetLook(target).dir} className={targetLook(target).className} title={String(target)}>{shortTarget(target)}</span>
            </>
          ) : null}
          <span className="ms-auto flex shrink-0 items-center gap-2">
            {result?.source ? <SourceBadge source={result.source} attempts={result.attempts} /> : null}
            {running ? <Ring /> : result?.cancelled ? <span className="text-xs">{t("متوقف شد")}</span> : isError ? <X className="size-3.5 text-bad" /> : null}
            <ChevronDown className={`size-3.5 ${expanded ? "rotate-180" : ""}`} />
          </span>
        </button>
        {expanded && !running ? (
          <div className="g-tool-body my-1 rounded-lg border px-3 py-2 text-sm">
            <ToolBody toolName={toolName} args={args} result={result} isError={isError} />
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div className={`my-2 overflow-hidden rounded-lg border bg-card ${isError ? "border-bad/50" : ""}`}>
      <button
        type="button"
        onClick={() => setOpen(!expanded)}
        className="flex w-full items-center gap-2 px-3 py-2 text-start text-sm hover:bg-muted/60"
      >
        <Icon className="size-4 shrink-0 text-muted-foreground" />
        {plain ? (
          <span dir="auto" className={`min-w-0 truncate font-medium ${running ? "shimmer" : ""}`} title={args.command ? `${plain}\n${args.command}` : plain}>{plain}</span>
        ) : (
          <span className={`shrink-0 font-medium ${running ? "shimmer" : ""}`}>{meta.label}</span>
        )}
        {subtitle ? <span className="ltr min-w-0 truncate font-mono text-xs text-muted-foreground">{subtitle}</span> : null}
        <span className="ms-auto flex shrink-0 items-center gap-2">
          {result?.source ? <SourceBadge source={result.source} attempts={result.attempts} /> : null}
          {running ? (
            <Loader2 className="size-4 animate-spin text-muted-foreground" />
          ) : result?.cancelled ? (
            <span className="text-xs text-muted-foreground">{t("متوقف شد")}</span>
          ) : isError ? (
            <X className="size-4 text-bad" />
          ) : (
            <Check className="size-4 text-ok" />
          )}
          <motion.span animate={{ rotate: expanded ? 180 : 0 }} transition={{ duration: 0.2 }} className="flex">
            <ChevronDown className="size-4 text-muted-foreground" />
          </motion.span>
        </span>
      </button>
      <AnimatePresence initial={false}>
        {expanded && !running ? (
          <motion.div
            key="body"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.22, ease: [0.2, 0, 0, 1] }}
            className="overflow-hidden"
          >
            <div className="border-t px-3 py-2 text-sm">
              <ToolBody toolName={toolName} args={args} result={result} isError={isError} />
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

export function SourceBadge({ source, attempts }) {
  const emergency = String(source).startsWith("emergency");
  const label = String(source).startsWith("routeros") ? t("میکروتیک") : String(source).startsWith("public-api") ? t("API عمومی") : String(source).startsWith("s3 ") ? "S3" : String(source).startsWith("grafana ") ? "Grafana" : String(source).split(" ")[0];
  const failed = (attempts || []).filter((a) => !a.ok);
  const title = [source, ...failed.map((a) => `${a.path}: ${a.error}`)].join("\n");
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${
        emergency ? "bg-emergency/15 text-emergency" : "bg-ok/15 text-ok"
      }`}
    >
      {emergency ? <ShieldAlert className="size-3" /> : null}
      {emergency ? t("مسیر اضطراری") : label}
    </span>
  );
}

function ToolBody({ toolName, args, result, isError }) {
  // The row shows only the sentence, so a failed command keeps the command above the error.
  if (isError && stepTitle(toolName, args) && args.command) {
    return (
      <div className="space-y-1.5">
        <ShellCommand command={args.command} />
        <ErrorBody result={result} />
      </div>
    );
  }
  // A consult that ran keeps its own body when it failed: the reason, any partial answer, its chat.
  if (isError && toolName === "consult" && result?.consultId) return <ConsultBody args={args} result={result} />;
  if (isError) return <ErrorBody result={result} />;
  // Any tool may return a file; show it the same way everywhere.
  if (result?.media?.mediaId && toolName !== "s3_get") {
    return <MediaView media={result.media} caption={result.title || args?.title} />;
  }
  switch (toolName) {
    case "edit":
      return result?.diffString ? <Diff text={result.diffString} /> : <GenericDetail args={args} result={result} />;
    case "Edit":
    case "MultiEdit":
    case "Write": {
      const diff = buildEditDiff(args);
      return diff ? <Diff text={diff} /> : <GenericDetail args={args} result={result} />;
    }
    case "read":
      return <Code text={result?.content} footer={result?.totalLines ? t("{n} خط", { n: num(result.totalLines) }) : null} />;
    case "updateTodos":
    case "readTodos":
    case "TodoWrite":
    case "todo_write":
      return <Todos todos={result?.todos || args.todos || []} />;
    case "glob":
      return <List items={result?.files} total={result?.totalFiles} />;
    case "kube_status":
      return <KubeStatus value={result} />;
    case "kube_df":
      return <KubeDf value={result} />;
    case "kube_logs":
      return <Code text={result?.logs} />;
    case "kube_get":
      return <Table rows={result?.items} footer={result?.truncated ? t("{shown} از {total}", { shown: num(result.items.length), total: num(result.total) }) : t("{n} مورد", { n: num(result?.total ?? 0) })} />;
    case "kube_secret":
      return <SecretBody data={result?.data} note={`${result?.namespace}/${result?.name}`} />;
    case "infisical_get":
      return <SecretBody data={result?.value != null ? { [args.name || "value"]: result.value } : {}} note={result?.path} />;
    case "gitlab_projects":
      return <Table rows={(result?.projects || []).map((p) => ({ path: p.path, branch: p.defaultBranch }))} columns={["path", "branch"]} footer={t("{n} پروژه", { n: num(result?.projects?.length ?? 0) })} />;
    case "gitlab_search":
      return result?.scope === "projects"
        ? <List items={(result?.results || []).map((r) => r.path)} total={result?.results?.length} />
        : (
          <div className="space-y-2">
            {(result?.results || []).map((r, i) => (
              <div key={i} className="rounded-md border bg-muted/40 p-2">
                <p className="ltr text-xs text-muted-foreground">{t("پروژه {project}", { project: r.project })} · {r.path}{r.startline ? `:${r.startline}` : ""}</p>
                <pre className="ltr mt-1 overflow-x-auto whitespace-pre-wrap break-words text-xs">{r.line}</pre>
              </div>
            ))}
            {result?.note ? <p className="text-xs text-muted-foreground">{result.note}</p> : null}
          </div>
        );
    case "gitlab_file":
      return <Code text={result?.content} footer={`${result?.path} @ ${result?.ref}`} />;
    case "arvan_dns_records":
      return <Table rows={result?.records} columns={["type", "name", "value", "ttl", "cloud"]} footer={t("{n} رکورد", { n: num(result?.total ?? 0) })} />;
    case "arvan_dns_export":
      return <Code text={result?.bind} footer={result?.domain} />;
    case "dns_lookup":
      return (
        <div className="space-y-2">
          {result?.error ? <p className="text-warn">{result.error}</p> : null}
          <Table
            rows={(result?.records || []).map((r) => (typeof r === "object" ? r : { value: r }))}
            footer={`${result?.type || ""} · ${result?.resolver || ""} · ${result?.ms ?? ""}ms`}
          />
        </div>
      );
    case "http_check":
      return <HttpCheckBody value={result} />;
    case "tls_check":
      return (
        <div className="space-y-2">
          {result?.error ? <p className="ltr text-bad">{result.error}</p> : null}
          <div className="flex flex-wrap gap-2">
            <Stat label="CN" value={result?.subject?.CN} />
            <Stat label={t("صادرکننده")} value={result?.issuer?.O || result?.issuer?.CN} />
            <Stat label={t("روز مانده")} value={result?.daysLeft} tone={result?.daysLeft != null && result.daysLeft < 14 ? "bad" : "ok"} />
            <Stat label={t("پروتکل")} value={result?.protocol} />
          </div>
          {result?.altNames?.length ? <List items={result.altNames} total={result.altNames.length} /> : null}
        </div>
      );


    case "infisical_projects":
      return <Table rows={result?.projects} columns={["name", "id"]} footer={t("{n} پروژه", { n: num(result?.projects?.length ?? 0) })} />;
    case "infisical_list":
      return <List items={[...(result?.folders || []).map((f) => `📁 ${f}`), ...(result?.secrets || [])]} total={(result?.folders?.length || 0) + (result?.secrets?.length || 0)} />;
    case "infisical_upsert":
      return (
        <div className="space-y-1 text-sm">
          <p>{result?.action === "created" ? t("ساخته شد") : t("به‌روزرسانی شد")}: <code className="ltr">{result?.name}</code> {t("در")} <span className="ltr">{result?.project}{result?.path}</span></p>
          {result?.consoleUrl ? <a href={result.consoleUrl} target="_blank" rel="noreferrer" className="text-primary underline">{t("باز کردن در Infisical")}</a> : null}
          {result?.note ? <p className="text-xs text-muted-foreground">{result.note}</p> : null}
        </div>
      );
    case "debug_exec":
    case "ssh_exec":
    case "kube_exec":
    case "mikrotik_exec":
    case "Bash":
      return <ShellBody toolName={toolName} args={args} result={result} />;
    case "gitlab_mr":
      return <GitlabMrBody args={args} result={result} />;
    case "gitlab_pipeline":
      return <GitlabPipelineBody args={args} result={result} />;
    case "gitlab_mrs":
      return <GitlabMrsBody result={result} />;
    case "gitlab_mr_changes":
      return <GitlabChangesBody args={args} result={result} />;
    case "gitlab_commits":
      return <GitlabCommitsBody args={args} result={result} />;
    case "gitlab_propose":
    case "git_push":
    case "repo_push":
      return <GitlabPushBody result={result} />;
    case "gitlab_project_member":
      return <GitlabMemberBody args={args} result={result} />;
    case "mikrotik_print":
      return <Table rows={result?.items} footer={result?.truncated ? t("{n} مورد (بریده شد)", { n: num(result?.total ?? 0) }) : t("{n} مورد", { n: num(result?.total ?? 0) })} />;
    case "mikrotik_ping":
      return <p className="ltr font-mono">{result?.received}/{result?.sent} {result?.times?.length ? `· ${result.times.join(" ")}` : ""}</p>;
    case "pg_query":
      return (
        <div className="space-y-1">
          <Code text={args.sql} />
          <Table
            rows={result?.rows}
            columns={result?.columns?.length ? result.columns.slice(0, 12) : undefined}
            footer={`${result?.truncated ? t("{n} ردیف (۵۰۰ ردیف اول)", { n: num(result?.rowCount ?? 0) }) : t("{n} ردیف", { n: num(result?.rowCount ?? 0) })} · ${result?.mode === "read-write" ? t("خواندن‌ونوشتن") : t("فقط‌خواندنی")} · ${result?.database} · ${result?.ms ?? ""}ms`}
          />
        </div>
      );
    case "telegram_dialogs":
      return <Table rows={result?.dialogs} columns={["title", "type", "unread", "lastAt"]} footer={t("{n} گفتگو", { n: num(result?.dialogs?.length ?? 0) })} />;
    case "telegram_read":
      return (
        <ul className="scrollbar-thin max-h-96 space-y-2 overflow-y-auto">
          {(result?.messages || []).map((m) => (
            <li key={m.id} className="rounded-lg bg-muted/50 px-3 py-2">
              <p className="flex gap-2 text-xs text-muted-foreground"><span dir="auto">{m.from || "—"}</span><span className="ltr ms-auto">{m.at}</span></p>
              <p className="mt-0.5 whitespace-pre-wrap break-words text-sm" dir="auto">{m.text || (m.media ? `[${m.media}]` : "")}</p>
            </li>
          ))}
        </ul>
      );
    case "send_to_person":
    case "edit_sent":
    case "delete_sent":
    case "tell_person":
      return <SentText text={args.text} result={result} toPerson={toolName !== "tell_person"} />;
    case "owner_task":
      return args.why || args.detail ? <p className="whitespace-pre-wrap break-words text-sm" dir="auto">{args.why || args.detail}</p> : <p className="text-sm" dir="auto">{args.access || args.title}</p>;
    case "react":
      return <p className="text-sm">{result?.reacted ? t("✓ {emoji} روی پیام #{id}", { emoji: result.emoji || t("واکنش برداشته شد"), id: result.id }) : result?.held ? t("نرفت: شما در گفتگو بودید یا پاسخ‌ها خاموش است") : result?.error ? t("نرفت: {error}", { error: result.error }) : t("نرفت")}</p>;
    case "telegram_send":
      return <p className="text-sm">{result?.sent ? t("✓ فرستاده شد به «{chat}»", { chat: result.chat }) : result?.reason ? t("فرستاده نشد ({reason})", { reason: result.reason }) : t("فرستاده نشد")}</p>;
    case "grafana_search":
      return <Table rows={result?.dashboards} columns={["title", "folder", "uid"]} footer={t("{n} داشبورد", { n: num(result?.dashboards?.length ?? 0) })} />;
    case "grafana_dashboard":
      return (
        <Table
          rows={(result?.panels || []).map((p) => ({ id: p.id, title: p.title, type: p.type, query: p.targets?.[0]?.query?.replace(/\s+/g, " ").slice(0, 80) || "" }))}
          columns={["id", "title", "type", "query"]}
          footer={`${result?.title || ""} · ${t("{n} پنل", { n: num(result?.panels?.length ?? 0) })}`}
        />
      );
    case "grafana_panel_query":
    case "grafana_query":
      return <GrafanaResults value={result} />;
    case "s3_list":
      return (
        <Table
          rows={(result?.objects || []).map((o) => ({ key: o.key, size: o.size, lastModified: o.lastModified }))}
          columns={["key", "size", "lastModified"]}
          footer={result?.complete ? t("{n} کلید خوانده شد", { n: num(result?.scanned ?? 0) }) : t("{n} کلید خوانده شد — کل باکت نه؛ ترتیب فقط روی همین‌ها", { n: num(result?.scanned ?? 0) })}
        />
      );
    case "s3_get":
      return <S3Object value={result} />;
    case "consult":
      return <ConsultBody args={args} result={result} />;
    case "repo_edit":
      return (
        <div className="space-y-1.5">
          <p className="text-sm" dir="auto">
            {result?.replaced != null ? `${Number(result.replaced).toLocaleString("fa-IR")} جایگزینی در ` : t("ویرایش ")}
            <code className="ltr font-mono text-xs">{result?.path || args.path}</code>
            {args.all ? t(" (همهٔ موارد)") : ""}
          </p>
          <Diff text={buildEditDiff({ old_string: args.old, new_string: args.new })} />
        </div>
      );
    case "repo_write":
      return (
        <div className="space-y-1.5">
          <p className="text-sm" dir="auto">
            نوشته شد: <code className="ltr font-mono text-xs">{result?.path || args.path}</code>
            {result?.written != null ? ` · ${Number(result.written).toLocaleString("fa-IR")} بایت` : ""}
          </p>
          <Diff text={buildEditDiff({ content: args.content })} />
        </div>
      );
    case "repo_read":
      return result?.binary
        ? <p className="text-sm text-muted-foreground" dir="auto">فایل باینری است ({Number(result.bytes || 0).toLocaleString("fa-IR")} بایت)؛ متن ندارد.</p>
        : <Code text={result?.text} footer={`${result?.path || args.path}${result?.shown ? ` · خط ${result.shown[0]} تا ${result.shown[1]} از ${result.lines}` : ""}${result?.cutAtBytes ? t(" · ادامهٔ فایل بریده شد") : ""}`} />;
    case "repo_list":
      return <List items={result?.files} total={result?.total} />;
    case "repo_search":
      return result?.matches?.length
        ? <List items={result.matches} total={result.total} unit={t("نتیجه")} />
        : <p className="text-sm text-muted-foreground" dir="auto">{t("چیزی پیدا نشد.")}</p>;
    case "repo_git":
      return (
        <div className="space-y-1">
          <Code text={`git ${(args.args || []).join(" ")}`} />
          <Code text={result?.output} />
        </div>
      );
    case "gitlab_version":
      return <p className="ltr font-mono">{result?.version} <span className="text-muted-foreground">({result?.revision})</span></p>;
    default:
      return <GenericDetail args={args} result={result} />;
  }
}

// What went (or was held back) to a colleague; tell_person only hands it to their mother chat.
function SentText({ text, result, toPerson }) {
  const status = sentStatus(result, toPerson);
  return (
    <div className="space-y-1.5">
      {text ? <p className="whitespace-pre-wrap break-words rounded-lg bg-muted/50 px-3 py-2 text-sm leading-6" dir="auto">{text}</p> : null}
      {status ? <p className={`text-xs ${status.warn ? "text-warn" : "text-muted-foreground"}`}>{status.text}</p> : null}
    </div>
  );
}

function GrafanaResults({ value }) {
  const results = value?.results || [];
  if (value?.datasources) return <Table rows={value.datasources} columns={["name", "type", "uid", "database"]} />;
  return (
    <div className="space-y-3">
      {value?.panel ? <p className="text-xs text-muted-foreground">{value.dashboard} · {value.panel.title} · <span className="ltr">{value.range?.from} → {value.range?.to}</span></p> : null}
      {results.map((r, i) =>
        r.error ? (
          <p key={i} className="ltr text-bad">{r.refId}: {r.error}</p>
        ) : (
          <Table key={i} rows={r.rows} footer={[r.name || r.refId, t("{n} ردیف", { n: num(r.rowCount) }), r.truncated].filter(Boolean).join(" · ")} />
        ),
      )}
    </div>
  );
}

// Secret values: hidden behind a reveal so they are not shoulder-surfed; each can be copied.
function SecretBody({ data, note }) {
  const entries = Object.entries(data || {});
  if (!entries.length) return <p className="text-sm text-muted-foreground">{t("مقداری برنگشت.")}</p>;
  return (
    <div className="space-y-1.5">
      {note ? <p className="ltr text-xs text-muted-foreground">{note}</p> : null}
      {entries.map(([key, value]) => <SecretRow key={key} name={key} value={String(value)} />)}
    </div>
  );
}

function SecretRow({ name, value }) {
  const [shown, setShown] = useState(false);
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center gap-2 rounded-md border px-2 py-1.5">
      <span className="ltr shrink-0 font-mono text-xs text-muted-foreground">{name}</span>
      <code className="ltr min-w-0 flex-1 truncate font-mono text-xs">{shown ? value : "•".repeat(Math.min(value.length, 16))}</code>
      <button type="button" onClick={() => setShown(!shown)} className="press shrink-0 text-muted-foreground hover:text-foreground" aria-label={t("نمایش")}>
        {shown ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
      </button>
      <button type="button" onClick={() => navigator.clipboard?.writeText(value).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }, () => {})} className="press shrink-0 text-muted-foreground hover:text-foreground" aria-label={t("کپی")}>
        {copied ? <Check className="size-3.5 text-ok" /> : <Copy className="size-3.5" />}
      </button>
    </div>
  );
}

function HttpCheckBody({ value }) {
  if (!value) return null;
  if (value.error && value.status == null) {
    return <p className="ltr text-bad">{value.error}</p>;
  }
  const ok = value.status >= 200 && value.status < 400;
  const headerRows = value.headers ? [value.headers] : [];
  return (
    <div className="space-y-2">
      <p className={`ltr font-mono text-sm ${ok ? "text-ok" : "text-bad"}`}>
        {value.status} {value.statusText || ""}
        {value.error ? ` · ${value.error}` : ""}
      </p>
      {headerRows.length ? <Table rows={headerRows} /> : null}
      {value.timings ? (
        <div className="flex flex-wrap gap-2">
          <Stat label="dns" value={value.timings.dns != null ? `${value.timings.dns}ms` : "—"} />
          <Stat label="connect" value={value.timings.connect != null ? `${value.timings.connect}ms` : "—"} />
          <Stat label="tls" value={value.timings.tls != null ? `${value.timings.tls}ms` : "—"} />
          <Stat label="ttfb" value={value.timings.firstByte != null ? `${value.timings.firstByte}ms` : "—"} />
          <Stat label="total" value={value.timings.total != null ? `${value.timings.total}ms` : "—"} />
        </div>
      ) : null}
      {value.redirects?.length ? (
        <List items={value.redirects.map((r) => `${r.status} → ${r.location}`)} total={value.redirects.length} />
      ) : null}
    </div>
  );
}

function S3Object({ value }) {
  // Old events stored { image: { mediaId } }; new ones { media }.
  const media = value?.media || (value?.image?.mediaId ? { ...value.image, name: value.key?.split("/").pop(), bytes: value.image.bytes ?? value.size } : null);
  return (
    <div className="space-y-2">
      <MediaView media={media} />
      <p className="ltr break-all font-mono text-xs text-muted-foreground">
        {value?.bucket}/{value?.key}{value?.lastModified ? ` · ${value.lastModified}` : ""}
      </p>
      {value?.note ? <p className="text-xs text-muted-foreground">{value.note}</p> : null}
    </div>
  );
}

function ErrorBody({ result }) {
  const attempts = result?.attempts || [];
  return (
    <div className="space-y-2">
      <p className="ltr text-bad">{result?.error || result?.text || t("خطا")}</p>
      {attempts.length ? (
        <ul className="space-y-1 text-xs">
          {attempts.map((a, i) => (
            <li key={i} className="flex items-center gap-2">
              {a.ok ? <Check className="size-3 text-ok" /> : <X className="size-3 text-bad" />}
              <span>{a.path === "public-api" ? t("API عمومی") : t("مسیر اضطراری SSH")}</span>
              {a.error ? <span className="ltr truncate text-muted-foreground">{a.error}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function KubeStatus({ value }) {
  if (!value) return null;
  const phases = Object.entries(value.counts?.by_phase || {});
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <Stat label={t("کل پادها")} value={value.counts?.total} />
        {phases.map(([phase, count]) => (
          <Stat key={phase} label={phase} value={count} tone={phase === "Running" || phase === "Succeeded" ? "ok" : "bad"} />
        ))}
      </div>
      {value.pods?.length ? (
        <>
          <p className="text-xs text-muted-foreground">{value.scope === "cluster" ? t("پادهایی که نیاز به توجه دارند") : t("پادها")}</p>
          <Table rows={value.pods} columns={["namespace", "name", "phase", "reason", "ready", "restarts", "node"]} />
        </>
      ) : value.scope === "cluster" ? (
        <p className="text-ok">{t("پاد ناسالمی دیده نشد.")}</p>
      ) : null}
      {value.cnpg?.length ? <Table rows={value.cnpg} /> : null}
    </div>
  );
}

function KubeDf({ value }) {
  const rows = value?.df || [];
  if (!rows.length) return <Code text={value?.raw} />;
  return (
    <div className="space-y-3">
      {rows.map((row) => {
        const percent = Number.parseInt(row.usePercent, 10) || 0;
        const tone = percent >= 90 ? "bg-bad" : percent >= 75 ? "bg-warn" : "bg-ok";
        return (
          <div key={row.mount} className="space-y-1">
            <div className="flex items-baseline justify-between gap-2">
              <span className="ltr font-mono text-xs">{row.mount}</span>
              <span className="ltr text-xs text-muted-foreground">
                <b className="text-foreground">{row.available}</b> free · {row.used} / {row.size}
              </span>
            </div>
            <div className="ltr h-2 overflow-hidden rounded-full bg-muted">
              <div className={`h-full ${tone}`} style={{ width: `${percent}%` }} />
            </div>
            <div className="ltr text-end text-[11px] text-muted-foreground">{row.usePercent}</div>
          </div>
        );
      })}
    </div>
  );
}

function Stat({ label, value, tone }) {
  const color = tone === "ok" ? "text-ok" : tone === "bad" ? "text-bad" : "text-foreground";
  return (
    <div className="rounded-md bg-muted px-3 py-1.5">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className={`ltr text-base font-semibold ${color}`}>{value ?? "—"}</div>
    </div>
  );
}

function Todos({ todos }) {
  return (
    <ul className="space-y-1.5">
      {todos.map((todo, i) => {
        const cancelled = /cancel/i.test(todo.status);
        const done = cancelled || /complete|done/i.test(todo.status);
        const active = /progress/i.test(todo.status);
        return (
          <li key={i} className="flex items-start gap-2">
            {cancelled ? <X className="mt-0.5 size-4 text-muted-foreground" /> : done ? <Check className="mt-0.5 size-4 text-ok" /> : active ? <Loader2 className="mt-0.5 size-4 animate-spin text-primary" /> : <CircleDashed className="mt-0.5 size-4 text-muted-foreground" />}
            <span className={done ? "text-muted-foreground line-through" : ""}>{todo.content}</span>
          </li>
        );
      })}
    </ul>
  );
}

function Diff({ text }) {
  return (
    <pre className="ltr scrollbar-thin max-h-96 overflow-auto rounded-md bg-muted p-2 font-mono text-xs leading-5">
      {String(text).split("\n").map((line, i) => {
        const tone = line.startsWith("+") && !line.startsWith("+++")
          ? "bg-ok/15 text-ok"
          : line.startsWith("-") && !line.startsWith("---")
            ? "bg-bad/15 text-bad"
            : line.startsWith("@@") ? "text-primary" : "";
        return <div key={i} className={tone}>{line || " "}</div>;
      })}
    </pre>
  );
}

function Code({ text, footer }) {
  return (
    <div>
      <pre className="ltr scrollbar-thin max-h-96 overflow-auto whitespace-pre rounded-md bg-muted p-2 font-mono text-xs leading-5">{text || t("(خالی)")}</pre>
      {footer ? <p className="mt-1 text-xs text-muted-foreground">{footer}</p> : null}
    </div>
  );
}

function List({ items = [], total, unit = t("فایل") }) {
  return (
    <div>
      <ul className="ltr scrollbar-thin max-h-72 overflow-auto font-mono text-xs leading-5">
        {items.map((item) => <li key={item}>{item}</li>)}
      </ul>
      {total ? <p className="mt-1 text-xs text-muted-foreground">{num(total)} {unit}</p> : null}
    </div>
  );
}

function Table({ rows = [], columns, footer }) {
  if (!rows.length) return <p className="text-muted-foreground">{t("موردی نیست.")}</p>;
  const keys = columns || [...new Set(rows.flatMap((row) => Object.keys(row)))].slice(0, 8);
  return (
    <div>
      <div className="ltr scrollbar-thin max-h-96 overflow-auto rounded-md border">
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-muted">
            <tr>{keys.map((k) => <th key={k} className="px-2 py-1 text-start font-medium whitespace-nowrap">{k}</th>)}</tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={i} className="border-t">
                {keys.map((k) => <td key={k} className="px-2 py-1 font-mono whitespace-nowrap">{format(row[k])}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {footer ? <p className="mt-1 text-xs text-muted-foreground">{footer}</p> : null}
    </div>
  );
}

function Json({ value }) {
  return <Code text={JSON.stringify(value, null, 2)} />;
}

// The body of a tool without its own view: what was asked, then what came back, each field with a
// Persian name and its natural shape. The raw JSON stays one click away for whoever wants it.
function GenericDetail({ args, result }) {
  const payload = unwrapPeerFact(result);
  const asked = factEntries(args).length > 0;
  const empty = !hasValue(payload) || (isRecord(payload) && !factEntries(payload).length) || (Array.isArray(payload) && !payload.length);
  return (
    <div className="space-y-3">
      {asked ? (
        <section className="space-y-1">
          <h4 className="text-[11px] font-medium text-muted-foreground">{t("درخواست")}</h4>
          <Facts data={args} />
        </section>
      ) : null}
      <section className="space-y-1">
        <h4 className="text-[11px] font-medium text-muted-foreground">{t("نتیجه")}</h4>
        {empty ? <p className="text-sm text-muted-foreground" dir="auto">{t("چیزی برنگشت.")}</p> : isRecord(payload) ? <Facts data={payload} /> : <FactValue value={payload} depth={0} />}
      </section>
      <details>
        <summary className="cursor-pointer text-[11px] text-muted-foreground">{t("نمایش خام (JSON)")}</summary>
        <Json value={{ args, result }} />
      </details>
    </div>
  );
}

// An object as «name: value» lines. A short value sits beside its name; a long one, a list or a
// nested object sits under it. Fields that are empty are left out.
function Facts({ data, depth = 0 }) {
  const entries = factEntries(data);
  if (!entries.length) return <p className="text-sm text-muted-foreground">{t("موردی نیست.")}</p>;
  return (
    <dl className={`space-y-1.5 ${depth ? "border-s ps-3" : ""}`}>
      {entries.map(([key, value]) => {
        const inline = isScalar(value) && !isLongText(value) && !isUrl(value);
        return (
          <div key={key} className={inline ? "flex flex-wrap items-baseline gap-x-2" : "space-y-0.5"}>
            <dt className="shrink-0 text-xs text-muted-foreground">{keyLabel(key)}{inline ? ":" : ""}</dt>
            <dd className="min-w-0 text-sm"><FactValue value={value} depth={depth} /></dd>
          </div>
        );
      })}
    </dl>
  );
}

function FactValue({ value, depth }) {
  if (Array.isArray(value)) {
    if (!value.length) return <span className="text-muted-foreground">{t("خالی")}</span>;
    if (value.every(isRecord)) return <Table rows={value} footer={`${value.length.toLocaleString("fa-IR")} مورد`} />;
    return (
      <ul className="list-disc space-y-0.5 ps-5">
        {value.map((item, i) => <li key={i}><FactValue value={item} depth={depth + 1} /></li>)}
      </ul>
    );
  }
  if (isRecord(value)) return depth >= 2 ? <Json value={value} /> : <Facts data={value} depth={depth + 1} />;
  if (isUrl(value)) return <a href={value} target="_blank" rel="noreferrer" className="ltr break-all text-primary underline">{value}</a>;
  if (isLongText(value)) return <pre dir="auto" className="scrollbar-thin max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-2 text-xs leading-5">{value}</pre>;
  return <span dir="auto" className="break-words">{scalarText(value) ?? "—"}</span>;
}

function format(value) {
  if (value === null || value === undefined || value === "") return "—";
  if (Array.isArray(value)) return value.join(", ");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function safe(fn) {
  try {
    return fn() || "";
  } catch {
    return "";
  }
}
