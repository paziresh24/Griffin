import { useState } from "react";
import { AlertTriangle, Check, ChevronDown, CircleDashed, Copy, ExternalLink, GitBranch, Loader2, Pause, Terminal, X } from "lucide-react";
import { clockLabel, exactTime } from "../elapsed.js";
import { isUrl } from "../tool-detail.js";
import {
  changesTotals, clipLines, durationText, failureText, groupJobsByStage, jobsSummary, mrOutcome, projectName, refLabel,
  roleName, secondsBetween, shellOutput, shellPlace, shortSha, statusInfo, tailLines,
} from "../tool-views.js";
import { t } from "../i18n.js";

// Purpose-built bodies for the tool cards that were a «key: value» list or a raw dump: a shell step
// reads like a terminal, a GitLab call like the merge request / pipeline / diff it is about.

const fa = (n) => Number(n).toLocaleString("fa-IR");

const TONES = {
  ok: "bg-ok/15 text-ok",
  bad: "bg-bad/15 text-bad",
  warn: "bg-warn/15 text-warn",
  info: "bg-signal/15 text-signal",
  muted: "bg-muted text-muted-foreground",
};

export function StatusChip({ status, label, tone }) {
  const info = statusInfo(status);
  if (!info && !label) return null;
  const shown = label || info.label;
  const use = tone || info?.tone || "muted";
  return (
    <span className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${TONES[use]}`}>
      {status === "running" ? <Loader2 className="size-3 animate-spin" /> : null}
      {shown}
    </span>
  );
}

function CopyButton({ text, label = t("کپی") }) {
  const [copied, setCopied] = useState(false);
  if (!text) return null;
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={() => navigator.clipboard?.writeText(String(text)).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }, () => {})}
      className="press shrink-0 text-muted-foreground hover:text-foreground"
    >
      {copied ? <Check className="size-3.5 text-ok" /> : <Copy className="size-3.5" />}
    </button>
  );
}

function LinkButton({ href, children }) {
  if (!isUrl(href)) return null;
  return (
    <a href={href} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs hover:bg-muted">
      <ExternalLink className="size-3" />
      {children}
    </a>
  );
}

// A block of output: a slim header (name · line count · copy), the text wrapped (never a sideways
// scroll), and «show N more lines» when it is long. fromEnd keeps the last lines (a job log's end).
function OutputBox({ title, text, tone, limit = 14, fromEnd = false, empty = t("بدون خروجی") }) {
  const [all, setAll] = useState(false);
  const body = String(text ?? "");
  const clip = fromEnd ? tailLines(body, limit) : clipLines(body, limit);
  return (
    <div className="overflow-hidden rounded-md border">
      <div className="flex items-center gap-2 border-b bg-muted/60 px-2 py-1 text-[11px] text-muted-foreground">
        <span className={tone === "bad" ? "font-medium text-bad" : "font-medium"}>{title}</span>
        {body ? <span>{t("· {fa} خط", { fa: fa(clip.total) })}</span> : null}
        <span className="ms-auto"><CopyButton text={body} /></span>
      </div>
      {body ? (
        <>
          {clip.hidden && !all && fromEnd ? <p className="border-b bg-muted/30 px-2 py-0.5 text-[11px] text-muted-foreground">{t("… {fa} خط قبل‌تر", { fa: fa(clip.hidden) })}</p> : null}
          <pre className={`ltr scrollbar-thin max-h-80 overflow-auto whitespace-pre-wrap break-words bg-muted/20 p-2 font-mono text-xs leading-5 ${tone === "bad" ? "text-bad" : ""}`}>
            {all ? body : clip.shown}
          </pre>
          {clip.hidden && !all ? (
            <button type="button" onClick={() => setAll(true)} className="w-full border-t py-1 text-[11px] text-muted-foreground hover:bg-muted">
              {t("نمایش {fa} خط {v}", { fa: fa(clip.hidden), v: fromEnd ? t("قبل‌تر") : t("دیگر") })}
            </button>
          ) : null}
        </>
      ) : (
        <p className="px-2 py-1.5 text-xs italic text-muted-foreground">{empty}</p>
      )}
    </div>
  );
}

// The command line of a shell step: «$ …», wrapped, copyable; long scripts fold after a few lines.
export function ShellCommand({ command }) {
  const [all, setAll] = useState(false);
  if (!command) return null;
  const clip = clipLines(command, 6);
  return (
    <div className="ltr overflow-hidden rounded-md border bg-muted/40">
      <div className="flex items-start gap-2 px-2 py-1.5 font-mono text-xs leading-5">
        <span aria-hidden className="select-none text-muted-foreground">$</span>
        <pre className="min-w-0 flex-1 whitespace-pre-wrap break-all">{all ? command : clip.shown}</pre>
        <CopyButton text={command} />
      </div>
      {clip.hidden && !all ? (
        <button type="button" onClick={() => setAll(true)} className="w-full border-t py-0.5 text-[11px] text-muted-foreground hover:bg-muted">
          {t("نمایش {fa} خط دیگر از دستور", { fa: fa(clip.hidden) })}
        </button>
      ) : null}
    </div>
  );
}

// debug_exec / ssh_exec / kube_exec / mikrotik_exec / Bash: where it ran, the command, then the
// output and (separately) the error stream.
export function ShellBody({ toolName, args = {}, result }) {
  const place = shellPlace(toolName, args, result || {});
  const { stdout, stderr } = shellOutput(result);
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
        <Terminal className="size-3.5" />
        <span dir="auto">{place}</span>
        {stderr && !stdout ? <StatusChip label={t("خروجی خطا")} tone="bad" /> : null}
      </div>
      <ShellCommand command={args.command} />
      <OutputBox title={t("خروجی")} text={stdout} empty={stderr ? t("خروجی عادی نداشت") : t("بدون خروجی")} />
      {stderr ? <OutputBox title={t("خروجی خطا")} text={stderr} tone="bad" limit={10} /> : null}
    </div>
  );
}

// ── GitLab ──────────────────────────────────────────────────────────────────────────────────

function Banner({ tone, children }) {
  const color = tone === "ok" ? "text-ok" : tone === "bad" ? "text-bad" : "text-warn";
  return (
    <p className={`flex items-center gap-1.5 text-sm font-medium ${color}`} dir="auto">
      {tone === "ok" ? <Check className="size-4" /> : tone === "bad" ? <X className="size-4" /> : <AlertTriangle className="size-4" />}
      {children}
    </p>
  );
}

function Branches({ source, target }) {
  if (!source && !target) return null;
  return (
    <p className="ltr flex flex-wrap items-center gap-1 font-mono text-xs text-muted-foreground">
      <GitBranch className="size-3.5" />
      <span className="break-all">{source}</span>
      {target ? <><span aria-hidden>→</span><span className="break-all">{target}</span></> : null}
    </p>
  );
}

// gitlab_mr: view, ready, merge.
export function GitlabMrBody({ args = {}, result = {} }) {
  const outcome = mrOutcome(args, result);
  const state = result.state;
  const showMergeStatus = (state || "opened") === "opened" && result.detailedMergeStatus;
  return (
    <div className="space-y-2">
      {outcome ? <Banner tone={outcome.tone}>{outcome.text}</Banner> : null}
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="ltr font-mono text-xs text-muted-foreground">{projectName(result.project || args.project)}!{result.iid ?? args.iid}</span>
        {outcome && state === "merged" ? null : <StatusChip status={state} />}
        {result.draft ? <StatusChip label={t("پیش‌نویس")} tone="warn" /> : null}
        {result.pipeline?.status ? (
          <>
            <span className="text-[11px] text-muted-foreground">{t("پایپ‌لاین")}</span>
            <StatusChip status={result.pipeline.status} />
          </>
        ) : null}
        {showMergeStatus ? <StatusChip status={result.detailedMergeStatus} /> : null}
      </div>
      {result.title ? <p className="text-sm font-medium leading-6" dir="auto">{result.title}</p> : null}
      <Branches source={result.sourceBranch} target={result.targetBranch} />
      {result.description ? (
        <details className="rounded-md border">
          <summary className="cursor-pointer px-2 py-1 text-xs text-muted-foreground">{t("توضیحات MR")}</summary>
          <p className="scrollbar-thin max-h-60 overflow-auto whitespace-pre-wrap break-words border-t px-2 py-1.5 text-xs leading-5" dir="auto">{result.description}</p>
        </details>
      ) : null}
      <LinkButton href={result.webUrl}>{t("باز کردن در GitLab")}</LinkButton>
    </div>
  );
}

function JobIcon({ status }) {
  if (status === "success") return <Check className="size-3.5 shrink-0 text-ok" />;
  if (status === "failed") return <X className="size-3.5 shrink-0 text-bad" />;
  if (status === "running") return <Loader2 className="size-3.5 shrink-0 animate-spin text-signal" />;
  if (status === "manual") return <Pause className="size-3.5 shrink-0 text-warn" />;
  return <CircleDashed className="size-3.5 shrink-0 text-muted-foreground" />;
}

function JobRow({ job }) {
  const [open, setOpen] = useState(Boolean(job.status === "failed" && job.logTail));
  const reason = failureText(job.failureReason);
  return (
    <div className="rounded-md border">
      <button
        type="button"
        disabled={!job.logTail}
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 px-2 py-1.5 text-start text-xs enabled:hover:bg-muted/60"
      >
        <JobIcon status={job.status} />
        <span className="ltr min-w-0 flex-1 truncate font-mono" title={job.name}>{job.name}</span>
        {reason ? <span className="shrink-0 text-bad" dir="auto">{reason}</span> : null}
        {job.status && job.status !== "success" && job.status !== "failed" ? <StatusChip status={job.status} /> : null}
        {job.duration != null ? <span className="shrink-0 text-muted-foreground">{durationText(job.duration)}</span> : null}
        {job.logTail ? <ChevronDown className={`size-3.5 shrink-0 text-muted-foreground ${open ? "rotate-180" : ""}`} /> : null}
      </button>
      {open && job.logTail ? (
        <div className="border-t p-1.5">
          <OutputBox title={t("پایان لاگ")} text={job.logTail} limit={16} fromEnd />
        </div>
      ) : null}
    </div>
  );
}

// gitlab_pipeline: the recent list, one pipeline with its jobs by stage, a retry, a played job.
export function GitlabPipelineBody({ args = {}, result = {} }) {
  if (Array.isArray(result.pipelines)) {
    if (!result.pipelines.length) return <p className="text-sm text-muted-foreground">{t("پایپ‌لاینی نیست.")}</p>;
    return (
      <div className="space-y-1.5">
        <p className="text-xs text-muted-foreground" dir="auto">{t("پایپ‌لاین‌های اخیر {projectName}", { projectName: projectName(result.project || args.project) })}</p>
        <ul className="divide-y rounded-md border">
          {result.pipelines.map((p) => {
            const took = secondsBetween(p.createdAt, p.updatedAt);
            return (
              <li key={p.id} className="flex flex-wrap items-center gap-2 px-2 py-1.5 text-xs">
                <StatusChip status={p.status} />
                <span className="ltr font-mono">#{p.id}</span>
                <span className="ltr min-w-0 flex-1 truncate font-mono text-muted-foreground" title={p.ref}>{refLabel(p.ref)}</span>
                <span className="ltr font-mono text-muted-foreground">{shortSha(p.sha)}</span>
                {took != null && took >= 1 ? <span className="text-muted-foreground">{durationText(took)}</span> : null}
                <span className="text-muted-foreground" title={exactTime(p.createdAt)}>{clockLabel(p.createdAt)}</span>
              </li>
            );
          })}
        </ul>
      </div>
    );
  }
  if (Array.isArray(result.retried)) {
    return (
      <div className="space-y-1.5">
        <Banner tone={result.retried.length ? "ok" : "warn"}>
          {result.retried.length ? t("{fa} کار دوباره اجرا شد", { fa: fa(result.retried.length) }) : t("کار شکست‌خوردهٔ قابل تکرار نبود")}
        </Banner>
        {result.retried.length ? <ul className="ltr space-y-0.5 font-mono text-xs text-muted-foreground">{result.retried.map((name) => <li key={name}>{name}</li>)}</ul> : null}
      </div>
    );
  }
  if (result.played) {
    return (
      <div className="space-y-1.5">
        <Banner tone="ok">{t("کار دستی شروع شد")}</Banner>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="ltr font-mono">{result.played.name}</span>
          <StatusChip status={result.played.status} />
          <LinkButton href={result.played.webUrl}>{t("باز کردن کار")}</LinkButton>
        </div>
      </div>
    );
  }
  const jobs = result.jobs || [];
  const stages = groupJobsByStage(jobs);
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <StatusChip status={result.status} />
        <span className="ltr font-mono">#{result.id ?? args.id}</span>
        {result.ref ? <span className="ltr font-mono text-muted-foreground" title={result.ref}>{refLabel(result.ref)}</span> : null}
        {result.sha ? <span className="ltr font-mono text-muted-foreground">{shortSha(result.sha)}</span> : null}
        <span className="ms-auto"><LinkButton href={result.webUrl}>{t("باز کردن در GitLab")}</LinkButton></span>
      </div>
      {jobs.length ? <p className="text-xs text-muted-foreground" dir="auto">{jobsSummary(jobs)}</p> : null}
      {stages.map(({ stage, jobs: list }) => (
        <div key={stage} className="space-y-1">
          <p className="ltr text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{stage}</p>
          {list.map((job) => <JobRow key={job.id ?? job.name} job={job} />)}
        </div>
      ))}
    </div>
  );
}

// gitlab_mrs: one row per merge request.
export function GitlabMrsBody({ result = {} }) {
  const list = result.mergeRequests || [];
  if (!list.length) return <p className="text-sm text-muted-foreground">{t("Merge Requestی پیدا نشد.")}</p>;
  return (
    <ul className="divide-y rounded-md border">
      {list.map((m) => (
        <li key={`${m.project}!${m.iid}`} className="space-y-1 px-2 py-1.5">
          <div className="flex flex-wrap items-start gap-1.5">
            <span className="ltr shrink-0 font-mono text-xs text-muted-foreground">{projectName(m.project)}!{m.iid}</span>
            {isUrl(m.webUrl)
              ? <a href={m.webUrl} target="_blank" rel="noreferrer" className="min-w-0 flex-1 text-sm leading-6 hover:underline" dir="auto">{m.title}</a>
              : <span className="min-w-0 flex-1 text-sm leading-6" dir="auto">{m.title}</span>}
          </div>
          <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
            <StatusChip status={m.state} />
            {m.draft ? <StatusChip label={t("پیش‌نویس")} tone="warn" /> : null}
            {m.pipeline ? <StatusChip status={m.pipeline} /> : null}
            {m.hasConflicts ? <StatusChip label={t("تداخل")} tone="bad" /> : null}
            {m.author ? <span className="ltr font-mono">{m.author}</span> : null}
            <span title={exactTime(m.updatedAt)}>{clockLabel(m.updatedAt)}</span>
          </div>
        </li>
      ))}
    </ul>
  );
}

function DiffLines({ text }) {
  return (
    <pre className="ltr scrollbar-thin max-h-80 overflow-auto whitespace-pre-wrap break-words bg-muted/20 p-2 font-mono text-xs leading-5">
      {String(text).split("\n").map((line, i) => {
        const tone = line.startsWith("+") && !line.startsWith("+++")
          ? "bg-ok/15 text-ok"
          : line.startsWith("-") && !line.startsWith("---")
            ? "bg-bad/15 text-bad"
            : line.startsWith("@@") ? "text-signal" : "";
        return <div key={i} className={tone}>{line || " "}</div>;
      })}
    </pre>
  );
}

function FileChange({ file, defaultOpen }) {
  const [open, setOpen] = useState(defaultOpen);
  const can = typeof file.diff === "string" && file.diff.length > 0;
  return (
    <div className="overflow-hidden rounded-md border">
      <button type="button" disabled={!can} onClick={() => setOpen(!open)} className="flex w-full items-center gap-2 px-2 py-1.5 text-start text-xs enabled:hover:bg-muted/60">
        <span className="ltr min-w-0 flex-1 truncate font-mono" title={file.path}>{file.path}</span>
        {file.newFile ? <StatusChip label={t("جدید")} tone="ok" /> : null}
        {file.deleted ? <StatusChip label={t("حذف")} tone="bad" /> : null}
        {file.renamed ? <StatusChip label={t("تغییر نام")} tone="info" /> : null}
        <span className="ltr shrink-0 font-mono text-ok">+{fa(file.added || 0)}</span>
        <span className="ltr shrink-0 font-mono text-bad">−{fa(file.removed || 0)}</span>
        {can ? <ChevronDown className={`size-3.5 shrink-0 text-muted-foreground ${open ? "rotate-180" : ""}`} /> : null}
      </button>
      {open && can ? <div className="border-t"><DiffLines text={file.diff} /></div> : null}
      {file.diffOmitted ? <p className="border-t px-2 py-1 text-[11px] text-muted-foreground" dir="auto">{t("diff این فایل نیامد؛ با path جداگانه خوانده می‌شود.")}</p> : null}
      {file.tooLargeForGitlab ? <p className="border-t px-2 py-1 text-[11px] text-warn" dir="auto">{t("GitLab diff این فایل را بسیار بزرگ می‌داند.")}</p> : null}
    </div>
  );
}

// gitlab_mr_changes: the change at a glance (files, +/−) and each file's diff on demand.
export function GitlabChangesBody({ args = {}, result = {} }) {
  const files = result.files || [];
  const totals = changesTotals(files);
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-1.5">
        {result.iid != null ? <span className="ltr font-mono text-xs text-muted-foreground">{projectName(result.project || args.project)}!{result.iid}</span> : null}
        <StatusChip status={result.state} />
      </div>
      {result.title ? <p className="text-sm font-medium leading-6" dir="auto">{result.title}</p> : null}
      <Branches source={result.sourceBranch || result.from} target={result.targetBranch || result.to} />
      <p className="text-xs text-muted-foreground" dir="auto">
        {t("{fa} فایل · ", { fa: fa(result.fileCount ?? totals.files) })}
        <span className="ltr font-mono text-ok">+{fa(totals.added)}</span>{" "}
        <span className="ltr font-mono text-bad">−{fa(totals.removed)}</span>
      </p>
      {files.map((file) => <FileChange key={file.path} file={file} defaultOpen={files.length === 1} />)}
      {result.note ? <p className="text-xs text-muted-foreground" dir="auto">{result.note}</p> : null}
      <LinkButton href={result.webUrl}>{t("باز کردن در GitLab")}</LinkButton>
    </div>
  );
}

// gitlab_commits: sha · title · who and when.
export function GitlabCommitsBody({ args = {}, result = {} }) {
  const list = result.commits || [];
  if (!list.length) return <p className="text-sm text-muted-foreground">{t("کامیتی پیدا نشد.")}</p>;
  return (
    <div className="space-y-1.5">
      <p className="ltr text-xs text-muted-foreground">{[projectName(result.project || args.project), result.path].filter(Boolean).join(" / ")}</p>
      <ul className="divide-y rounded-md border">
        {list.map((c) => (
          <li key={c.id} className="space-y-0.5 px-2 py-1.5">
            <div className="flex items-start gap-2">
              <span className="ltr shrink-0 font-mono text-xs text-muted-foreground">{c.id}</span>
              <span className="min-w-0 flex-1 text-sm leading-6" dir="auto">{c.title}</span>
            </div>
            <p className="text-[11px] text-muted-foreground">
              <span dir="auto">{c.author}</span> · <span title={exactTime(c.at)}>{clockLabel(c.at)}</span>
            </p>
          </li>
        ))}
      </ul>
    </div>
  );
}

// gitlab_propose and the push tools: what was pushed and the merge request it opened.
export function GitlabPushBody({ result = {} }) {
  const mr = result.mergeRequest || null;
  const url = result.webUrl || mr?.webUrl || result.mergeRequestUrl || "";
  const iid = result.iid ?? mr?.iid;
  const updated = result.updated === true;
  return (
    <div className="space-y-2">
      <Banner tone="ok">
        {updated ? t("کامیت تازه به همان شاخه اضافه شد") : iid != null ? (mr?.existing ? t("MR از قبل باز بود") : t("Merge Request باز شد")) : t("شاخه پوش شد")}
      </Banner>
      <div className="flex flex-wrap items-center gap-1.5">
        {iid != null ? <span className="ltr font-mono text-xs text-muted-foreground">!{iid}</span> : null}
        {result.state ? <StatusChip status={result.state} /> : null}
        {mr?.draft || (iid != null && !updated && !mr) ? <StatusChip label={t("پیش‌نویس")} tone="warn" /> : null}
        {result.commit ? <span className="ltr font-mono text-xs text-muted-foreground">{shortSha(result.commit)}</span> : null}
      </div>
      <Branches source={result.branch} target={result.targetBranch} />
      <LinkButton href={url}>{t("باز کردن Merge Request")}</LinkButton>
      {result.output ? (
        <details className="rounded-md border">
          <summary className="cursor-pointer px-2 py-1 text-xs text-muted-foreground">{t("خروجی git")}</summary>
          <pre className="ltr scrollbar-thin max-h-48 overflow-auto whitespace-pre-wrap break-words border-t bg-muted/20 p-2 font-mono text-xs leading-5">{result.output}</pre>
        </details>
      ) : null}
    </div>
  );
}

// gitlab_project_member: the role given (or already held).
export function GitlabMemberBody({ args = {}, result = {} }) {
  const role = roleName(result.accessLevel);
  return (
    <Banner tone="ok">
      <span dir="auto">
        {result.changed === false ? t("از قبل دسترسی داشت: ") : t("دسترسی داده شد: ")}
        <span className="ltr font-mono">{result.username || args.username}</span> {t("← {role} روی ", { role })}
        <span className="ltr font-mono">{result.project || args.project}</span>
      </span>
    </Banner>
  );
}
