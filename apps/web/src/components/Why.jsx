import { useEffect, useState } from "react";
import { ChevronDown, Loader2, Route } from "lucide-react";
import { api } from "../api.js";
import { formatDuration } from "./Work.jsx";
import { changeLabel, whyRows } from "../why.js";
import { isRtl, num, t } from "../i18n.js";

// "Why?": under a finished reply, how it came about — fetched when opened, never before.
const fa = (n) => num(n);
const DIR = isRtl ? "rtl" : "ltr";
const seconds = (ms) => (ms == null ? null : formatDuration(Math.max(1, Math.round(ms / 1000)), { compact: true }));

export function WhyButton({ open, onToggle }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      title={t("چرا این جواب؟")}
      aria-label={t("چرا این جواب؟")}
      className={`rounded-full p-1.5 transition-colors hover:bg-muted hover:text-foreground ${open ? "text-foreground" : "text-muted-foreground"}`}
    >
      <Route className="size-3.5" />
    </button>
  );
}

export function WhyPanel({ chatId, runId }) {
  const [state, setState] = useState({ loading: true, data: null, error: null });
  useEffect(() => {
    let alive = true;
    api(`/api/chats/${chatId}/runs/${runId}/why`)
      .then((data) => alive && setState({ loading: false, data, error: null }))
      .catch((error) => alive && setState({ loading: false, data: null, error: error.message }));
    return () => {
      alive = false;
    };
  }, [chatId, runId]);
  if (state.loading) {
    return (
      <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground" dir={DIR}>
        <Loader2 className="size-3.5 animate-spin" /> {t("در حال خواندن…")}
      </div>
    );
  }
  if (state.error) return <div className="mt-2 text-xs text-bad" dir={DIR}>{t("خوانده نشد: {error}", { error: state.error })}</div>;
  const { steps, run, tools, manifest } = state.data;
  const rows = whyRows(steps);
  const changes = manifest?.changes || [];
  return (
    <div className="mt-2 space-y-2 rounded-xl border bg-muted/30 px-3 py-2 text-sm" dir={DIR}>
      <RunLine run={run} />
      {rows.length ? (
        <ol className="space-y-0.5">
          {rows.map((row, i) => <WhyRow key={i} row={row} />)}
        </ol>
      ) : (
        <div className="text-xs text-muted-foreground">{t("فقط فکر کرد و جواب داد؛ ابزاری در کار نبود.")}</div>
      )}
      {changes.length ? (
        <div className="text-xs">
          <span className="text-muted-foreground">{t("از جلسهٔ قبلی:")} </span>
          {changes.map(changeLabel).join(t("، "))}
        </div>
      ) : null}
      <Fold label={t("با چه چیزهایی اجرا شد")}>
        <ManifestView manifest={manifest} tools={tools} />
      </Fold>
    </div>
  );
}

// What the reply ran on: engine and model, effort, tokens, and a fallback or a retry.
function RunLine({ run }) {
  if (!run) return null;
  const bits = [
    [run.provider, run.model].filter(Boolean).join(" · "),
    run.effort ? t("فکر: {effort}", { effort: run.effort }) : "",
    run.usage ? t("{requests} درخواست · کانتکست {context} توکن", { requests: fa(run.usage.requests), context: fa(run.usage.context) }) : "",
  ].filter(Boolean);
  return (
    <div className="space-y-0.5 text-xs text-muted-foreground">
      <div>{bits.map((bit, i) => <span key={i} dir="auto">{i ? " · " : ""}{bit}</span>)}</div>
      {run.fallback ? <div className="text-bad">{t("موتور قبلی به سقف خورد؛ همین پیام روی این موتور دوباره اجرا شد.")}</div> : null}
      {run.retry ? <div>{t("«ارسال دوباره»ی پیامی که قبلاً نرسیده بود.")}</div> : null}
    </div>
  );
}

function WhyRow({ row }) {
  const [open, setOpen] = useState(false);
  const opens = Boolean(row.text || row.items?.length);
  const time = seconds(row.durationMs);
  return (
    <li>
      <button
        type="button"
        disabled={!opens}
        onClick={() => setOpen(!open)}
        className="flex w-full items-baseline gap-2 rounded px-1 py-0.5 text-start hover:bg-muted disabled:cursor-default disabled:hover:bg-transparent"
      >
        <span className={`mt-1.5 size-1.5 shrink-0 rounded-full ${row.tone === "bad" ? "bg-bad" : "bg-muted-foreground/50"}`} aria-hidden />
        <span className={`min-w-0 flex-1 ${row.tone === "bad" ? "text-bad" : ""}`}>
          {row.label}
          {row.detail ? <span className="text-xs text-muted-foreground"> — <span dir="auto">{row.detail}</span></span> : null}
        </span>
        {time ? <span className="shrink-0 text-xs text-muted-foreground">{time}</span> : null}
        {opens ? <ChevronDown className={`size-3 shrink-0 self-center opacity-60 transition-transform ${open ? "rotate-180" : ""}`} /> : null}
      </button>
      {open && row.text ? <Evidence text={row.text} /> : null}
      {open && row.items ? (
        <ul className="ms-4 mt-0.5 space-y-0.5 border-s ps-3 text-xs text-muted-foreground">
          {row.items.map((item, i) => (
            <li key={i} className="flex gap-2">
              <span className="flex-1" dir="ltr">{item.count > 1 ? `${item.name} ×${item.count}` : item.name}</span>
              {seconds(item.durationMs) ? <span>{seconds(item.durationMs)}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function Evidence({ text }) {
  return <div dir="auto" className="ms-4 mt-0.5 max-h-60 overflow-auto whitespace-pre-wrap border-s ps-3 text-xs leading-6 text-muted-foreground">{text}</div>;
}

function Fold({ label, children }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button type="button" onClick={() => setOpen(!open)} className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground" aria-expanded={open}>
        {label}
        <ChevronDown className={`size-3 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open ? <div className="mt-1.5">{children}</div> : null}
    </div>
  );
}

const GUARD = { ask: t("کار برگشت‌ناپذیر با تأیید شما"), refuse: t("کار برگشت‌ناپذیر رد می‌شود (کسی برای تأیید نیست)"), team: t("رشتهٔ همکار: گارد همکار") };

function ManifestView({ manifest, tools }) {
  if (!manifest) return <div className="text-xs text-muted-foreground">{t("برای این جواب شناسنامه‌ای ثبت نشده (پیش از این امکان).")}</div>;
  const used = new Set(tools?.used || []);
  return (
    <div className="space-y-2 text-xs">
      <Section title={t("موتور و ایجنت")}>
        <div className="text-muted-foreground" dir="auto">
          {manifest.agent} · {t("به درخواست {caller}", { caller: manifest.caller })}{manifest.rootCaller && manifest.rootCaller !== manifest.caller ? ` ${t("(ریشه: {root})", { root: manifest.rootCaller })}` : ""} ·{" "}
          <span dir="ltr">{[manifest.engine?.provider, manifest.engine?.model, manifest.engine?.effort].filter(Boolean).join(" · ")}</span>
        </div>
        {manifest.repo ? <div className="text-muted-foreground">{t("ریپو:")} <span dir="ltr">{manifest.repo}</span></div> : null}
        {manifest.seeded ? <div className="text-muted-foreground">{t("جلسه با {n} پیامِ قبلی گفتگو شروع شد", { n: fa(manifest.seeded) })}</div> : null}
      </Section>
      <Section title={t("قاعده‌ها و دانش")}>
        <BlobRow name={t("قاعده‌های این جلسه ({n} نویسه)", { n: fa(manifest.rules?.chars || 0) })} hash={manifest.rules?.hash} />
        {manifest.knowledge?.length ? <div className="text-muted-foreground" dir="ltr">{manifest.knowledge.join(", ")}</div> : <div className="text-muted-foreground">{t("یادداشت دانش تأییدشده‌ای نبود")}</div>}
        {manifest.playbook ? <div className="text-muted-foreground">{t("فهرست playbook: {n} یادداشت", { n: fa(manifest.playbook) })}</div> : null}
      </Section>
      <Section title={t("گاردها")}>
        <div className="text-muted-foreground">
          {[manifest.guards?.approval ? GUARD[manifest.guards.approval] || manifest.guards.approval : t("چت خود شما: بدون تأیید"), manifest.guards?.review ? t("هر تغییر پیش از اجرا دو بازبین دارد") : "", manifest.guards?.sim ? t("شبیه‌سازی: اثری اجرا نمی‌شود") : ""].filter(Boolean).join(" · ")}
        </div>
      </Section>
      <Section title={t("ابزارها: {used} از {total} به کار رفت", { used: fa(used.size), total: fa(manifest.tools?.length || 0) })}>
        <div className="flex flex-wrap gap-1" dir="ltr">
          {(manifest.tools || []).map((name) => (
            <span key={name} className={`rounded px-1.5 py-0.5 ${used.has(name) ? "bg-primary/12 text-primary" : "bg-muted text-muted-foreground"}`}>{name}</span>
          ))}
        </div>
      </Section>
    </div>
  );
}

function Section({ title, children }) {
  return (
    <div>
      <div className="mb-0.5 font-medium text-muted-foreground">{title}</div>
      <div className="space-y-0.5">{children}</div>
    </div>
  );
}

// The rules exactly as that session read them (masked); fetched when opened.
function BlobRow({ name, hash }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(null);
  const toggle = async () => {
    const next = !open;
    setOpen(next);
    if (next && text == null && hash) {
      try {
        const response = await fetch(`/api/blobs/${hash}`, { credentials: "same-origin" });
        setText(response.ok ? await response.text() : t("خوانده نشد"));
      } catch {
        setText(t("خوانده نشد"));
      }
    }
  };
  return (
    <div>
      <button type="button" onClick={toggle} disabled={!hash} className="flex w-full items-baseline gap-2 rounded px-1 py-0.5 text-start hover:bg-muted disabled:opacity-60">
        <span className="min-w-0 flex-1 truncate">{name}</span>
        <ChevronDown className={`size-3 shrink-0 self-center opacity-60 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open ? <pre className="ms-1 mt-0.5 max-h-80 overflow-auto whitespace-pre-wrap rounded border px-2 py-1 text-[11px] leading-5" dir="auto">{text ?? "…"}</pre> : null}
    </div>
  );
}
