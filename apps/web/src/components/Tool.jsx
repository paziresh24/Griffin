import { createContext, useContext, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Streamdown } from "streamdown";
import { code } from "@streamdown/code";
import { agentMeta } from "../brand.js";
import { textDir } from "../dir.js";
import { api, navigate, useRoute } from "../api.js";
import { AskCard } from "./Ask.jsx";
import { MediaView } from "./Media.jsx";
import { ChartCard } from "./Chart.jsx";
import { AgentGlyph } from "./Controls.jsx";
import { t, num } from "../i18n.js";
import { useSkin } from "../skin.js";
import {
  AlertTriangle, Boxes, Check, ChevronDown, CircleDashed, Cloud, Copy, Database, Eye, EyeOff, ExternalLink, FileText, FolderTree, GitBranch,
  Globe, HardDrive, KeyRound, Lock, Network, Send, ListChecks, Loader2, PencilLine, Router, ScrollText, Search, Server, ShieldAlert, Terminal, Trash2, Workflow, X,
  Square, Activity, AlarmClock, CalendarClock, BookOpen,
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
  telegram_dialogs: { icon: Send, label: t("گفتگوهای تلگرام"), subtitle: (a) => a.query },
  telegram_read: { icon: Send, label: t("خواندن تلگرام"), subtitle: (a) => a.chat, open: true },
  telegram_send: { icon: Send, label: t("ارسال در تلگرام"), subtitle: (a) => a.chat, open: true },
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
  gitlab_mr: { icon: GitBranch, label: t("Merge Request گیت‌لب"), subtitle: (a) => `${a.project}!${a.iid} · ${a.action || "view"}`, open: true },
  infisical_projects: { icon: FolderTree, label: t("پروژه‌های Infisical") },
  infisical_list: { icon: FolderTree, label: t("فهرست Infisical"), subtitle: (a) => a.path },
  infisical_upsert: { icon: KeyRound, label: t("ذخیره در Infisical"), subtitle: (a) => a.name, open: true },
  arvan_domains: { icon: Cloud, label: t("دامنه‌های آروان"), subtitle: (a) => a.search },
  arvan_dns_records: { icon: Globe, label: t("رکوردهای DNS آروان"), subtitle: (a) => [a.domain, a.type, a.name].filter(Boolean).join(" / "), open: true },
  arvan_dns_export: { icon: FileText, label: t("خروجی BIND آروان"), subtitle: (a) => a.domain },
  arvan_dnssec: { icon: Lock, label: t("وضعیت DNSSEC"), subtitle: (a) => a.domain },
  arvan_cache_settings: { icon: Cloud, label: t("تنظیمات کش آروان"), subtitle: (a) => a.domain, open: true },
  arvan_purge_tags: { icon: Cloud, label: t("تگ‌های purge"), subtitle: (a) => a.domain },
  arvan_cache_purge: { icon: Cloud, label: t("پاک‌کردن کش آروان"), subtitle: (a) => [a.domain, a.scope].filter(Boolean).join(" · "), open: true },
  dns_lookup: { icon: Network, label: t("جست‌وجوی DNS"), subtitle: (a) => `${a.type || "A"} ${a.name || ""}`.trim(), open: true },
  http_check: { icon: Globe, label: t("بررسی HTTP"), subtitle: (a) => a.url, open: true },
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
  if (props.toolName === "ask_owner") return <AskCard {...props} />;
  if (props.toolName === "visualize") return <ChartCard {...props} />;
  if (props.toolName === "ask_agent") return <PeerCard {...props} />;
  if (props.toolName === "task") return <TaskCard {...props} />;
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
  const karsara = useSkin() === "karsara";

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

function PeerMarkdown({ text }) {
  const dir = textDir(text) === "ltr" ? "ltr" : "rtl";
  return (
    <div className="sd-block chat-text leading-7 [&_pre]:my-2 [&_table]:my-2" dir={dir}>
      <Streamdown dir={dir} plugins={mdPlugins} shikiTheme={["github-light", "github-dark"]}>
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
  const karsara = useSkin() === "karsara";

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
          <Workflow className={`mt-0.5 size-4 shrink-0 ${running ? "animate-pulse text-primary" : "text-muted-foreground"}`} />
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

function GenericToolCard({ toolName, args = {}, result, isError, status }) {
  const meta = TOOLS[toolName] || { icon: Server, label: toolName };
  const running = status?.type === "running" || result === undefined;
  const [open, setOpen] = useState(null);
  const expanded = open ?? (!result?.cancelled && (isError || (!running && Boolean(meta.open))));
  const Icon = meta.icon;
  const plain = stepTitle(toolName, args);
  const subtitle = plain ? (running || isError ? args.command : "") : safe(() => meta.subtitle?.(args));
  const karsara = useSkin() === "karsara";

  if (karsara) {
    // Karsara: no card — a flat row (icon · name · «·» · short target), no ✓ on success, a ring while
    // running; the opened body is its own box. Claude Code's tools keep their English name.
    const name = /^[A-Z]/.test(toolName || "") ? toolName : meta.label;
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
              <span className="ltr min-w-0 truncate font-mono text-xs" title={String(target)}>{shortTarget(target)}</span>
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
      <div className="space-y-1">
        <Code text={args.command} />
        <ErrorBody result={result} />
      </div>
    );
  }
  if (isError) return <ErrorBody result={result} />;
  // Any tool may return a file; show it the same way everywhere.
  if (result?.media?.mediaId && toolName !== "s3_get") {
    return <MediaView media={result.media} caption={result.title || args?.title} />;
  }
  switch (toolName) {
    case "edit":
      return result?.diffString ? <Diff text={result.diffString} /> : <Json value={result} />;
    case "read":
      return <Code text={result?.content} footer={result?.totalLines ? t("{n} خط", { n: num(result.totalLines) }) : null} />;
    case "updateTodos":
    case "readTodos":
    case "TodoWrite":
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
      return (
        <div className="space-y-1">
          <Code text={args.command} />
          <Code text={typeof result === "string" ? result : result?.output ?? [result?.stdout, result?.stderr].filter(Boolean).join("\n")} />
        </div>
      );
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
    case "gitlab_version":
      return <p className="ltr font-mono">{result?.version} <span className="text-muted-foreground">({result?.revision})</span></p>;
    default:
      return (
        <details open>
          <summary className="cursor-pointer text-xs text-muted-foreground">{t("جزئیات")}</summary>
          <Json value={{ args, result }} />
        </details>
      );
  }
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
        const done = /complete|done/i.test(todo.status);
        const active = /progress/i.test(todo.status);
        return (
          <li key={i} className="flex items-start gap-2">
            {done ? <Check className="mt-0.5 size-4 text-ok" /> : active ? <Loader2 className="mt-0.5 size-4 animate-spin text-primary" /> : <CircleDashed className="mt-0.5 size-4 text-muted-foreground" />}
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

function List({ items = [], total }) {
  return (
    <div>
      <ul className="ltr scrollbar-thin max-h-72 overflow-auto font-mono text-xs leading-5">
        {items.map((item) => <li key={item}>{item}</li>)}
      </ul>
      {total ? <p className="mt-1 text-xs text-muted-foreground">{t("{n} فایل", { n: num(total) })}</p> : null}
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
