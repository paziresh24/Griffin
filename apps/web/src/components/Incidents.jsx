import { useCallback, useEffect, useState } from "react";
import { ArrowRight, ChevronDown, Loader2, MessageSquare, Radar } from "lucide-react";
import { toast } from "sonner";
import { api, navigate } from "../api.js";
import { BRAND } from "../brand.js";
import { locale, num, t } from "../i18n.js";
import { clockLabel, exactTime } from "../elapsed.js";

// Griffin's incident layer: alerts of every cluster grouped into incidents, plus human signals
// (a teammate asking the owner). Shadow mode: Griffin triages in its ops room and records here.

const SEVERITY = {
  critical: "bg-bad",
  warning: "bg-warn",
  info: "bg-muted-foreground",
  none: "bg-muted-foreground",
};

const time = (iso) => (iso ? new Date(iso).toLocaleString(locale, { dateStyle: "short", timeStyle: "short" }) : "—");
const ago = (iso) => (iso ? clockLabel(iso) : "—");

const FILTERS = [
  ["open", t("باز")],
  ["resolved", t("رفع‌شده")],
  ["all", t("همه")],
];

export function IncidentsPage({ onBack }) {
  const [status, setStatus] = useState("open");
  const [data, setData] = useState(null);
  const [expanded, setExpanded] = useState(null);

  const load = useCallback(() => api(`/api/incidents?status=${status}&limit=200`).then(setData, (e) => toast.error(e.message)), [status]);
  useEffect(() => {
    load();
    const timer = setInterval(load, 10_000);
    return () => clearInterval(timer);
  }, [load]);

  const incidents = data?.incidents || [];
  const humans = incidents.filter((i) => i.cluster === "human");
  const machine = incidents.filter((i) => i.cluster !== "human");
  const intake = data?.intake;

  return (
    <div className="scrollbar-thin h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl px-4 pb-16 pt-4 sm:px-6">
        <div className="mb-4 flex items-center gap-2">
          <button type="button" onClick={onBack} className="press flex size-8 items-center justify-center rounded-full hover:bg-muted" aria-label={t("بازگشت")}>
            <ArrowRight className="size-4 rtl-mirror" />
          </button>
          <h1 className="text-lg font-semibold">{t("حادثه‌ها")}</h1>
          {data?.room ? (
            <button type="button" onClick={() => navigate(data.room)} className="press ms-auto flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm hover:bg-muted">
              <MessageSquare className="size-4" /> {t("اتاق عملیات")}
            </button>
          ) : null}
        </div>
        <p className="mb-4 text-sm leading-6 text-muted-foreground">
          {t("آلارم‌های سیستم‌هایی که وصل کرده‌ای بدون LLM به حادثه تجمیع می‌شوند؛ پیام کاری همکاران هم «سیگنال انسانی» است. {name} در اتاق عملیات تشخیص می‌دهد و اینجا ثبت می‌کند — فعلاً در حالت سایه، بدون پیام به کسی.", { name: BRAND.name })}
        </p>

        {intake ? (
          <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-xl border bg-card px-3 py-2 text-xs text-muted-foreground">
            <span className="flex items-center gap-1.5" title={exactTime(intake.lastPollAt)}><Radar className="size-3.5" /> {t("آخرین خواندن: {when}", { when: ago(intake.lastPollAt) })}</span>
            {Object.entries(intake.clusters || {}).map(([name, c]) => (
              <span key={name} className="flex items-center gap-1" title={c.ok ? c.source : c.error}>
                <span className={`size-2 rounded-full ${c.ok ? "bg-ok" : "bg-bad"}`} />
                {name}{c.ok ? ` (${num(c.count)})` : ""}
              </span>
            ))}
            {intake.error ? <span className="text-bad">{intake.error}</span> : null}
          </div>
        ) : null}

        <div className="mb-4 flex gap-1">
          {FILTERS.map(([value, label]) => (
            <button
              key={value}
              type="button"
              onClick={() => setStatus(value)}
              className={`press rounded-full px-3 py-1 text-sm ${status === value ? "bg-primary text-primary-foreground" : "hover:bg-muted"}`}
            >
              {label}
            </button>
          ))}
        </div>

        {!data ? (
          <div className="flex justify-center py-16"><Loader2 className="size-5 animate-spin text-muted-foreground" /></div>
        ) : incidents.length === 0 ? (
          <p className="py-12 text-center text-sm text-muted-foreground">{t("حادثه‌ای نیست.")}</p>
        ) : (
          <>
            {humans.length ? <Section title={t("سیگنال انسانی (پیام همکاران)")} items={humans} expanded={expanded} setExpanded={setExpanded} onChanged={load} /> : null}
            <Section title={t("آلارم‌ها")} items={machine} expanded={expanded} setExpanded={setExpanded} onChanged={load} />
          </>
        )}
      </div>
    </div>
  );
}

function Section({ title, items, expanded, setExpanded, onChanged }) {
  if (!items.length) return null;
  return (
    <section className="mb-6">
      <h2 className="mb-2 text-sm font-medium text-muted-foreground">{title} · {num(items.length)}</h2>
      <ul className="space-y-2">
        {items.map((i) => (
          <IncidentRow key={i.id} incident={i} open={expanded === i.id} onToggle={() => setExpanded(expanded === i.id ? null : i.id)} onChanged={onChanged} />
        ))}
      </ul>
    </section>
  );
}

function AckButton({ incident: i, onDone }) {
  const [busy, setBusy] = useState(false);
  const acked = Boolean(i.ack);
  async function run() {
    let body;
    if (acked) {
      body = { remove: true, member: i.ack[0]?.member || "" };
    } else {
      const member = i.members.length > 1 ? window.prompt(`${t("کدام مورد عمدی است؟ خالی = کل حادثه")}\n${i.members.slice(0, 10).join("\n")}`, "") : "";
      if (member === null) return;
      const reason = window.prompt(t("چرا عمدی است؟ ({name} دیگر برای این هشدار بیدار نمی‌شود)", { name: BRAND.name }), "");
      if (!reason) return;
      body = { member: member.trim(), reason };
    }
    setBusy(true);
    try {
      await api(`/api/incidents/${i.id}/ack`, { method: "POST", body });
      toast.success(acked ? t("برداشته شد") : t("ثبت شد: عمدی"));
      onDone?.();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <button type="button" disabled={busy} onClick={run} className="press rounded-full border px-3 py-1 text-xs hover:bg-muted">
      {acked ? t("برداشتن «عمدی»") : t("عمدی است")}
    </button>
  );
}

function IncidentRow({ incident: i, open, onToggle, onChanged }) {
  const tr = i.triage;
  return (
    <li className="rounded-xl border bg-card">
      <button type="button" onClick={onToggle} className="flex w-full items-start gap-2 px-3 py-2.5 text-start">
        <span className={`mt-1.5 size-2 shrink-0 rounded-full ${i.status === "open" ? SEVERITY[i.severity] || "bg-muted-foreground" : "bg-ok"}`} />
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-x-2 text-sm font-medium" dir="ltr">
            <span>{i.alertname}</span>
            <span className="text-xs font-normal text-muted-foreground">@{i.cluster}{i.scope ? ` · ${i.scope}` : ""}</span>
          </span>
          <span className="mt-0.5 block text-xs text-muted-foreground">
            {i.members.length > 1 ? `${t("{n} مورد", { n: num(i.members.length) })} · ` : ""}{t("از {when}", { when: time(i.startsAt || i.firstSeen) })}
            {i.flaps ? ` · flap×${i.flaps}` : ""}
            {i.ack ? ` · ${t("عمدی (Owner)")}` : tr ? ` · ${tr.noise ? t("نویز") : tr.missed ? t("جا ماند") : tr.coveredBy ? t("پوشش داشت") : t("تشخیص داده شد")}` : ` · ${t("بدون تشخیص")}`}
          </span>
          {tr?.cause ? <span dir="auto" className="mt-1 block text-sm leading-6">{tr.cause}</span> : null}
        </span>
        <ChevronDown className={`mt-1 size-4 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open ? (
        <div className="space-y-2 border-t px-3 py-2.5 text-sm leading-6" dir="auto">
          {i.summary ? <p className="text-muted-foreground">{i.summary}</p> : null}
          {tr ? (
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
              {[
                [t("اثر"), tr.impact],
                [t("مالک"), tr.owner],
                [t("چه کسی می‌پرسید"), tr.whoWouldAsk],
                [t("اقدام"), tr.action],
                [t("برگشت‌پذیر"), tr.reversible === undefined ? null : tr.reversible ? t("بله") : t("خیر")],
                [t("اطمینان"), tr.confidence],
                [t("پوشش"), tr.coveredBy],
              ]
                .filter(([, v]) => v)
                .map(([k, v]) => (
                  <div key={k} className="contents">
                    <dt className="text-muted-foreground">{k}</dt>
                    <dd>{v}</dd>
                  </div>
                ))}
            </dl>
          ) : null}
          {i.members.length ? (
            <p className="text-xs text-muted-foreground" dir="ltr">{i.members.slice(0, 30).join(" · ")}{i.members.length > 30 ? " …" : ""}</p>
          ) : null}
          {i.ack ? (
            <p className="text-xs text-muted-foreground">{t("عمدی: {list}", { list: i.ack.map((a) => `${a.member || t("کل حادثه")} — ${a.reason}`).join(t("؛ ")) })}</p>
          ) : null}
          {i.cluster !== "human" ? <AckButton incident={i} onDone={onChanged} /> : null}
        </div>
      ) : null}
    </li>
  );
}
