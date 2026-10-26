import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowRight, ChevronDown, Copy, Database, Loader2, MessageSquare, Plus, Radar, Search, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { api, navigate } from "../api.js";
import { BRAND } from "../brand.js";
import { clockLabel, exactTime } from "../elapsed.js";
import { t } from "../i18n.js";

// Griffin's incident layer: alerts from this install's data sources (Grafana-style: the broker's clusters,
// Alertmanager/Grafana/Prometheus, a webhook, a Telegram alert channel) grouped into incidents, sorted
// into buckets by what they need (owner 2026-10-25: «دی‌نویز شده و مرتب ببینم»), and tied to workspace
// chats — assigned to one, or suggested as a new one.

const SEVERITY = {
  critical: "bg-bad",
  warning: "bg-warn",
  info: "bg-muted-foreground",
  none: "bg-muted-foreground",
};

// Order and wording of the buckets (incidents/index.mjs incidentBucket). `closed` = folded at first.
export const BUCKET_INFO = {
  attention: { title: t("نیاز به توجه"), hint: t("بحرانی، تازه و بدون چت") },
  tracking: { title: t("در حال پیگیری"), hint: t("به یک چت اساین شده") },
  watch: { title: t("هشدارها"), hint: t("زیر نظر؛ معمولاً اقدامی لازم نیست") },
  chronic: { title: t("مزمن"), hint: t("بیش از ۳ روز باز؛ یا کارش را به چتی بسپارید یا «عمدی» بزنید"), closed: true },
  noise: { title: t("نویز و عمدی"), hint: t("تشخیص نویز یا ثبت «عمدی»"), closed: true },
  people: { title: t("پیام همکاران"), hint: t("سیگنال انسانی"), closed: true },
  resolved: { title: t("رفع‌شده"), hint: "" },
};
const BUCKET_ORDER = Object.keys(BUCKET_INFO);

const time = (iso) => (iso ? new Date(iso).toLocaleString("fa-IR", { dateStyle: "short", timeStyle: "short" }) : "—");
const ago = (iso) => (iso ? clockLabel(iso) : "—");
const input = "w-full rounded-lg border bg-background px-3 py-2 text-sm outline-none focus:border-primary";
const chip = (on) => `press rounded-full px-3 py-1 text-sm ${on ? "bg-primary text-primary-foreground" : "hover:bg-muted"}`;

const FILTERS = [
  ["open", t("باز")],
  ["resolved", t("رفع‌شده")],
  ["all", t("همه")],
];

/** Incidents of one bucket, those sharing an alert name folded into one group (a storm reads as one line). */
export function groupByAlert(items) {
  const groups = new Map();
  for (const i of items) {
    const key = i.alertname;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(i);
  }
  return [...groups.values()];
}

export function IncidentsPage({ onBack }) {
  const [tab, setTab] = useState("incidents");
  return (
    <div className="scrollbar-thin h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl px-4 pb-16 pt-4 sm:px-6">
        <div className="mb-4 flex items-center gap-2">
          <button type="button" onClick={onBack} className="press flex size-8 items-center justify-center rounded-full hover:bg-muted" aria-label={t("بازگشت")}>
            <ArrowRight className="rtl-mirror size-4" />
          </button>
          <h1 className="text-lg font-semibold">{t("حادثه‌ها")}</h1>
          <div className="ms-3 flex gap-1">
            <button type="button" onClick={() => setTab("incidents")} className={chip(tab === "incidents")}>
              {t("حادثه‌ها")}
            </button>
            <button type="button" onClick={() => setTab("sources")} className={chip(tab === "sources")}>
              {t("منابع داده")}
            </button>
          </div>
        </div>
        {tab === "incidents" ? <IncidentsTab onSources={() => setTab("sources")} /> : <SourcesTab />}
      </div>
    </div>
  );
}

function IncidentsTab({ onSources }) {
  const [status, setStatus] = useState("open");
  const [data, setData] = useState(null);
  const [expanded, setExpanded] = useState(null);
  const [source, setSource] = useState("");
  const [query, setQuery] = useState("");

  const load = useCallback(() => api(`/api/incidents?status=${status}&limit=${status === "open" ? 300 : 500}`).then(setData, (e) => toast.error(e.message)), [status]);
  useEffect(() => {
    load();
    const timer = setInterval(load, 10_000);
    return () => clearInterval(timer);
  }, [load]);

  const all = data?.incidents || [];
  const sources = data?.sources || [];
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return all.filter((i) => (!source || (i.source || i.cluster) === source || i.cluster === source) && (!q || `${i.alertname} ${i.cluster} ${i.scope} ${i.summary} ${i.triage?.cause || ""} ${i.owner || ""}`.toLowerCase().includes(q)));
  }, [all, source, query]);
  const byBucket = useMemo(() => {
    const out = Object.fromEntries(BUCKET_ORDER.map((b) => [b, []]));
    for (const i of filtered) (out[i.bucket] || out.watch).push(i);
    return out;
  }, [filtered]);
  const intake = data?.intake;

  if (data && !sources.length) {
    return (
      <div className="rounded-xl border bg-card px-4 py-8 text-center">
        <Database className="mx-auto mb-3 size-6 text-muted-foreground" />
        <p className="mb-1 font-medium">{t("هنوز منبع داده‌ای وصل نیست")}</p>
        <p className="mb-4 text-sm leading-6 text-muted-foreground">
          {t("آلارم‌ها از منبع‌ها می‌آیند: کانال یا گروه آلارم تلگرام، Grafana، Alertmanager، Prometheus یا یک وبهوک. از همین‌جا اضافه کنید یا در چت به {name} بگویید، مثلاً «کانال آلارم‌های ما را به منابع حادثه اضافه کن».", { name: BRAND.name })}
        </p>
        <button type="button" onClick={onSources} className="press inline-flex items-center gap-1.5 rounded-full bg-primary px-4 py-2 text-sm text-primary-foreground">
          <Plus className="size-4" /> {t("افزودن منبع")}
        </button>
      </div>
    );
  }

  return (
    <>
      {intake ? (
        <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-xl border bg-card px-3 py-2 text-xs text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <Radar className="size-3.5" /> {t("آخرین خواندن:")} <span title={exactTime(intake.lastPollAt)}>{ago(intake.lastPollAt)}</span>
          </span>
          {sources.map((s) => (
            <button
              type="button"
              key={s.id}
              onClick={() => setSource(source === s.id ? "" : s.id)}
              className={`flex items-center gap-1 rounded-full px-1.5 ${source === s.id ? "bg-muted text-foreground" : ""} ${s.enabled ? "" : "opacity-50"}`}
              title={s.status?.error || s.name}
            >
              <span className={`size-2 rounded-full ${!s.enabled ? "bg-muted-foreground" : s.status?.ok === false ? "bg-bad" : "bg-ok"}`} />
              {s.name}
              {s.status?.count != null ? ` (${s.status.count})` : ""}
            </button>
          ))}
          {intake.error ? <span className="text-bad">{intake.error}</span> : null}
        </div>
      ) : null}

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="flex gap-1">
          {FILTERS.map(([value, label]) => (
            <button key={value} type="button" onClick={() => setStatus(value)} className={chip(status === value)}>
              {label}
            </button>
          ))}
        </div>
        <label className="relative ms-auto min-w-40 flex-1 sm:max-w-64">
          <Search className="pointer-events-none absolute start-2.5 top-2.5 size-4 text-muted-foreground" />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("جستجو")} className={`${input} ps-8`} />
        </label>
      </div>

      {!data ? (
        <div className="flex justify-center py-16">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      ) : filtered.length === 0 ? (
        <p className="py-12 text-center text-sm text-muted-foreground">{t("حادثه‌ای نیست.")}</p>
      ) : (
        BUCKET_ORDER.map((b) => (byBucket[b].length ? <Bucket key={`${b}:${status}`} bucket={b} items={byBucket[b]} expanded={expanded} setExpanded={setExpanded} onChanged={load} /> : null))
      )}
    </>
  );
}

function Bucket({ bucket, items, expanded, setExpanded, onChanged }) {
  const info = BUCKET_INFO[bucket];
  const [open, setOpen] = useState(!info.closed);
  const groups = groupByAlert(items);
  return (
    <section className="mb-5">
      <button type="button" onClick={() => setOpen(!open)} className="mb-2 flex w-full items-center gap-2 text-start">
        <h2 className="text-sm font-medium">{info.title}</h2>
        <span className="rounded-full bg-muted px-2 text-xs text-muted-foreground">{items.length}</span>
        {info.hint ? <span className="truncate text-xs text-muted-foreground">{info.hint}</span> : null}
        <ChevronDown className={`ms-auto size-4 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open ? (
        <ul className="space-y-2">
          {groups.map((g) =>
            g.length === 1 ? (
              <IncidentRow key={g[0].id} incident={g[0]} open={expanded === g[0].id} onToggle={() => setExpanded(expanded === g[0].id ? null : g[0].id)} onChanged={onChanged} />
            ) : (
              <AlertGroup key={g[0].alertname} items={g} expanded={expanded} setExpanded={setExpanded} onChanged={onChanged} />
            ),
          )}
        </ul>
      ) : null}
    </section>
  );
}

function AlertGroup({ items, expanded, setExpanded, onChanged }) {
  const [open, setOpen] = useState(false);
  const worst = items.some((i) => i.severity === "critical") ? "critical" : items[0].severity;
  const where = [...new Set(items.map((i) => i.scope || i.cluster))].slice(0, 5).join(t("، "));
  return (
    <li className="rounded-xl border bg-card">
      <button type="button" onClick={() => setOpen(!open)} className="flex w-full items-start gap-2 px-3 py-2.5 text-start">
        <span className={`mt-1.5 size-2 shrink-0 rounded-full ${items[0].status === "open" ? SEVERITY[worst] : "bg-ok"}`} />
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-x-2 text-sm font-medium" dir="ltr">
            <span>{items[0].alertname}</span>
            <span className="rounded-full bg-muted px-2 text-xs font-normal text-muted-foreground">×{items.length}</span>
          </span>
          <span className="mt-0.5 block truncate text-xs text-muted-foreground" dir="auto">
            {where}
            {items.length > 5 ? t("، …") : ""}
          </span>
        </span>
        <ChevronDown className={`mt-1 size-4 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open ? (
        <ul className="space-y-2 border-t p-2">
          {items.map((i) => (
            <IncidentRow key={i.id} incident={i} open={expanded === i.id} onToggle={() => setExpanded(expanded === i.id ? null : i.id)} onChanged={onChanged} />
          ))}
        </ul>
      ) : null}
    </li>
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
      const member = i.members.length > 1 ? window.prompt(t("کدام مورد عمدی است؟ خالی = کل حادثه\n{join}", { join: i.members.slice(0, 10).join("\n") }), "") : "";
      if (member === null) return;
      const reason = window.prompt(t("چرا عمدی است؟ ({name} دیگر برای این بیدار نمی‌شود)", { name: BRAND.name }), "");
      if (!reason) return;
      const days = window.prompt(t("تا چند روز؟ خالی = تا وقتی برش دارید"), "");
      if (days === null) return;
      body = { member: member.trim(), reason, ...(Number(days) > 0 ? { days: Number(days) } : {}) };
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

function AssignControls({ incident: i, onDone }) {
  const [picking, setPicking] = useState(false);
  const [chats, setChats] = useState(null);
  const [busy, setBusy] = useState(false);

  async function pick() {
    setPicking(true);
    if (!chats) api("/api/chats").then((d) => setChats((d.chats || []).slice(0, 40)), (e) => toast.error(e.message));
  }
  async function assign(chatId) {
    setBusy(true);
    try {
      await api(`/api/incidents/${i.id}/assign`, { method: "POST", body: { chatId } });
      toast.success(chatId ? t("به چت اساین شد") : t("از چت جدا شد"));
      setPicking(false);
      onDone?.();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function suggest() {
    setBusy(true);
    try {
      await api(`/api/incidents/${i.id}/suggest`, { method: "POST" });
      toast.success(t("کارتش روی فضای کار گذاشته شد"));
      onDone?.();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  }

  if (i.chatId) {
    return (
      <>
        <button type="button" onClick={() => navigate(i.chatId)} className="press flex items-center gap-1 rounded-full border px-3 py-1 text-xs hover:bg-muted">
          <MessageSquare className="size-3.5" /> {i.chatTitle || t("چت")}
        </button>
        <button type="button" disabled={busy} onClick={() => assign(null)} className="press rounded-full border px-3 py-1 text-xs hover:bg-muted">
          {t("جدا کردن از چت")}
        </button>
      </>
    );
  }
  return (
    <>
      {picking ? (
        <select disabled={busy || !chats} defaultValue="" onChange={(e) => e.target.value && assign(e.target.value)} className="max-w-56 rounded-full border bg-background px-2 py-1 text-xs">
          <option value="">{chats ? t("انتخاب چت…") : t("در حال خواندن…")}</option>
          {(chats || []).map((c) => (
            <option key={c.id} value={c.id}>
              {c.title || t("بی‌عنوان")}
            </option>
          ))}
        </select>
      ) : (
        <button type="button" onClick={pick} className="press rounded-full border px-3 py-1 text-xs hover:bg-muted">
          {t("اساین به چت")}
        </button>
      )}
      {i.suggestion?.status === "open" ? (
        <span className="rounded-full bg-muted px-3 py-1 text-xs text-muted-foreground">{t("کارتش روی فضای کار است")}</span>
      ) : (
        <button type="button" disabled={busy} onClick={suggest} className="press rounded-full border px-3 py-1 text-xs hover:bg-muted">
          {t("پیشنهاد در فضای کار")}
        </button>
      )}
    </>
  );
}

function IncidentRow({ incident: i, open, onToggle, onChanged }) {
  const tri = i.triage;
  // The headline is what it means (triage), the alert name stays as the technical label.
  const headline = tri?.cause || "";
  const state = i.ack ? t("عمدی") : tri ? (tri.noise ? (tri.inherited ? t("نویز (مثل دفعهٔ قبل)") : t("نویز")) : tri.missed ? t("جا ماند") : tri.coveredBy ? t("پوشش داشت") : t("تشخیص داده شد")) : t("بدون تشخیص");
  return (
    <li className="rounded-xl border bg-card">
      <button type="button" onClick={onToggle} className="flex w-full items-start gap-2 px-3 py-2.5 text-start">
        <span className={`mt-1.5 size-2 shrink-0 rounded-full ${i.status === "open" ? SEVERITY[i.severity] || "bg-muted-foreground" : "bg-ok"}`} />
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-x-2 text-sm font-medium" dir="ltr">
            <span>{i.alertname}</span>
            <span className="text-xs font-normal text-muted-foreground">
              @{i.cluster}
              {i.scope ? ` · ${i.scope}` : ""}
            </span>
          </span>
          <span className="mt-0.5 block text-xs text-muted-foreground">
            {t("{v}از {time}{v2} · {state}{v3}", { v: i.members.length > 1 ? t("{length} مورد · ", { length: i.members.length }) : "", time: time(i.startsAt || i.firstSeen), v2: i.flaps ? t(" · {flaps} بار قطع‌ووصل", { flaps: i.flaps }) : "", state, v3: i.chatId ? t(" · چت: {v}", { v: i.chatTitle || "…" }) : "" })}
          </span>
          {headline ? (
            <span dir="auto" className="mt-1 block text-sm leading-6">
              {headline}
            </span>
          ) : i.summary ? (
            <span dir="auto" className="mt-1 line-clamp-2 block text-sm leading-6 text-muted-foreground">
              {i.summary}
            </span>
          ) : null}
        </span>
        <ChevronDown className={`mt-1 size-4 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open ? (
        <div className="space-y-2 border-t px-3 py-2.5 text-sm leading-6" dir="auto">
          {i.summary && headline ? <p className="text-muted-foreground">{i.summary}</p> : null}
          {tri ? (
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
              {[
                [t("اثر"), tri.impact],
                [t("مالک"), tri.owner],
                [t("چه کسی می‌پرسید"), tri.whoWouldAsk],
                [t("اقدام"), tri.action],
                [t("برگشت‌پذیر"), tri.reversible === undefined ? null : tri.reversible ? t("بله") : t("خیر")],
                [t("اطمینان"), tri.confidence],
                [t("پوشش"), tri.coveredBy],
              ]
                .filter(([, v]) => v)
                .map(([k, v]) => (
                  <div key={k} className="contents">
                    <dt className="text-muted-foreground">{k}</dt>
                    <dd className="whitespace-pre-line">{v}</dd>
                  </div>
                ))}
            </dl>
          ) : null}
          {i.members.length ? (
            <p className="text-xs text-muted-foreground" dir="ltr">
              {i.members.slice(0, 30).join(" · ")}
              {i.members.length > 30 ? " …" : ""}
            </p>
          ) : null}
          {i.ack ? <p className="text-xs text-muted-foreground">{t("عمدی: {join}", { join: i.ack.map((a) => `${a.member || t("کل حادثه")} — ${a.reason}${a.until ? t(" (تا {time})", { time: time(a.until) }) : ""}`).join(t("؛ ")) })}</p> : null}
          {i.cluster !== "human" ? (
            <div className="flex flex-wrap gap-2">
              <AssignControls incident={i} onDone={onChanged} />
              <AckButton incident={i} onDone={onChanged} />
            </div>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

// ——— data sources ———

function SourcesTab() {
  const [data, setData] = useState(null);
  const [adding, setAdding] = useState(false);
  const load = useCallback(() => api("/api/incidents/sources").then(setData, (e) => toast.error(e.message)), []);
  useEffect(() => {
    load();
    const timer = setInterval(load, 15_000);
    return () => clearInterval(timer);
  }, [load]);

  if (!data) {
    return (
      <div className="flex justify-center py-16">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }
  return (
    <>
      <p className="mb-4 text-sm leading-6 text-muted-foreground">
        {t("هر منبع آلارم‌هایش را به این نصب می‌دهد و این‌جا به حادثه تجمیع می‌شود. از چت هم می‌شود: «گروه آلارم‌های فلان را به منابع حادثه اضافه کن» یا «Grafana ما را به‌عنوان منبع وصل کن».")}
      </p>
      <ul className="mb-4 space-y-2">
        {data.sources.map((s) => (
          <SourceCard key={s.id} source={s} onChanged={load} />
        ))}
      </ul>
      {adding ? (
        <SourceForm kinds={data.kinds.filter((k) => k.addable)} onDone={() => (setAdding(false), load())} onCancel={() => setAdding(false)} />
      ) : (
        <button type="button" onClick={() => setAdding(true)} className="press inline-flex items-center gap-1.5 rounded-full bg-primary px-4 py-2 text-sm text-primary-foreground">
          <Plus className="size-4" /> {t("افزودن منبع")}
        </button>
      )}
    </>
  );
}

function SourceCard({ source: s, onChanged }) {
  const [busy, setBusy] = useState(false);
  const [test, setTest] = useState(null);
  const st = s.status;
  async function call(path, method, body) {
    setBusy(true);
    try {
      const out = await api(path, { method, body });
      onChanged();
      return out;
    } catch (e) {
      toast.error(e.message);
      return null;
    } finally {
      setBusy(false);
    }
  }
  const builtin = ["clusters", "business", "vault"].includes(s.kind);
  return (
    <li className="rounded-xl border bg-card px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className={`size-2 rounded-full ${!s.enabled ? "bg-muted-foreground" : st?.ok === false ? "bg-bad" : st ? "bg-ok" : "bg-warn"}`} />
        <span className="font-medium">{s.name}</span>
        <span className="text-xs text-muted-foreground">
          {s.kindLabel} · <span dir="ltr">{s.id}</span>
        </span>
        <span className="ms-auto flex gap-1.5">
          <button type="button" disabled={busy} onClick={async () => setTest(await call(`/api/incidents/sources/${s.id}/test`, "POST"))} className="press rounded-full border px-3 py-1 text-xs hover:bg-muted">
            {t("تست")}
          </button>
          <button type="button" disabled={busy} onClick={() => call(`/api/incidents/sources/${s.id}`, "PATCH", { enabled: !s.enabled })} className="press rounded-full border px-3 py-1 text-xs hover:bg-muted">
            {s.enabled ? t("خاموش") : t("روشن")}
          </button>
          {builtin ? null : (
            <button type="button" disabled={busy} onClick={() => window.confirm(t("منبع «{name}» حذف شود؟ حادثه‌های بازش در خواندن بعدی بسته می‌شوند.", { name: s.name })) && call(`/api/incidents/sources/${s.id}`, "DELETE")} className="press rounded-full border px-2 py-1 text-xs hover:bg-muted" aria-label={t("حذف")}>
              <Trash2 className="size-3.5" />
            </button>
          )}
        </span>
      </div>
      <div className="mt-1 space-y-1 text-xs text-muted-foreground">
        {s.config?.url ? <div dir="ltr">{s.config.url}</div> : null}
        {s.config?.chatTitle ? <div>{t("چت تلگرام: {chatTitle}", { chatTitle: s.config.chatTitle })}</div> : null}
        {s.webhookUrl ? (
          <div className="flex items-center gap-1.5">
            <code dir="ltr" className="truncate rounded bg-muted px-1.5 py-0.5">
              {s.webhookUrl}
            </code>
            <button type="button" onClick={() => navigator.clipboard.writeText(s.webhookUrl).then(() => toast.success(t("کپی شد")))} className="press rounded p-1 hover:bg-muted" aria-label={t("کپی")}>
              <Copy className="size-3.5" />
            </button>
          </div>
        ) : null}
        {st ? (
          <div>
            {st.ok === false ? <span className="text-bad">{st.error || t("خطا")}</span> : <span>{t("{v} آلارم فعال", { v: st.count ?? 0 })}</span>}
            {st.at ? <span title={exactTime(st.at)}> {t("· خوانده‌شده {ago}", { ago: ago(st.at) })}</span> : null}
            {st.lastEventAt ? <span title={exactTime(st.lastEventAt)}> {t("· آخرین پیام {ago}", { ago: ago(st.lastEventAt) })}</span> : null}
          </div>
        ) : s.enabled ? (
          <div>{t("هنوز خوانده نشده")}</div>
        ) : null}
        {test ? <div className={test.ok ? "" : "text-bad"}>{t("تست: {v}", { v: test.ok ? t("سالم، {v} آلارم فعال{v2}{v3}", { v: test.firing ?? 0, v2: test.sample?.length ? ` (${test.sample.join(t("، "))})` : "", v3: test.note ? ` — ${test.note}` : "" }) : test.error })}</div> : null}
      </div>
    </li>
  );
}

function SourceForm({ kinds, onDone, onCancel }) {
  const [form, setForm] = useState({ kind: kinds[0]?.id || "telegram", name: "", id: "", url: "", auth: "bearer", header: "", secretValue: "", watchdog: false, ttlHours: "", everyMessage: false, personId: "", chatTitle: "" });
  const [busy, setBusy] = useState(false);
  const [q, setQ] = useState("");
  const [chats, setChats] = useState([]);
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));
  const kind = kinds.find((k) => k.id === form.kind);

  useEffect(() => {
    if (form.kind !== "telegram") return undefined;
    const timer = setTimeout(() => api(`/api/incidents/telegram-chats?q=${encodeURIComponent(q)}`).then((d) => setChats(d.chats || []), () => {}), 250);
    return () => clearTimeout(timer);
  }, [q, form.kind]);

  async function submit(e) {
    e.preventDefault();
    const config = {};
    if (kind?.url) Object.assign(config, { url: form.url, auth: form.auth, header: form.header || null, watchdog: form.watchdog });
    if (form.kind === "telegram") Object.assign(config, { personId: form.personId, chatTitle: form.chatTitle, everyMessage: form.everyMessage });
    if (form.ttlHours) config.ttlHours = Number(form.ttlHours);
    setBusy(true);
    try {
      const out = await api("/api/incidents/sources", { method: "POST", body: { kind: form.kind, name: form.name || form.chatTitle, id: form.id || undefined, config, ...(form.secretValue ? { secretValue: form.secretValue } : {}) } });
      toast[out.test?.ok === false ? "error" : "success"](out.test?.ok === false ? t("اضافه شد ولی تست خطا داد: {error}", { error: out.test.error }) : t("منبع اضافه شد"));
      onDone();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3 rounded-xl border bg-card p-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="space-y-1 text-sm">
          <span className="text-muted-foreground">{t("نوع")}</span>
          <select value={form.kind} onChange={(e) => set({ kind: e.target.value })} className={input}>
            {kinds.map((k) => (
              <option key={k.id} value={k.id}>
                {k.label}
              </option>
            ))}
          </select>
        </label>
        <label className="space-y-1 text-sm">
          <span className="text-muted-foreground">{t("نام")}</span>
          <input value={form.name} onChange={(e) => set({ name: e.target.value })} placeholder={form.kind === "telegram" ? t("همان نام چت") : t("Grafana تیم ما")} className={input} />
        </label>
      </div>
      <label className="block space-y-1 text-sm">
        <span className="text-muted-foreground">{t("شناسه (حروف انگلیسی کوچک، اختیاری)")}</span>
        <input value={form.id} onChange={(e) => set({ id: e.target.value })} placeholder="team-grafana" dir="ltr" className={input} />
      </label>

      {kind?.url ? (
        <>
          <label className="block space-y-1 text-sm">
            <span className="text-muted-foreground">{t("آدرس")}</span>
            <input value={form.url} onChange={(e) => set({ url: e.target.value })} required placeholder={form.kind === "grafana" ? "https://grafana.example.com" : form.kind === "prometheus" ? "https://prometheus.example.com" : "https://alertmanager.example.com"} dir="ltr" className={input} />
          </label>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="space-y-1 text-sm">
              <span className="text-muted-foreground">{t("احراز هویت")}</span>
              <select value={form.auth} onChange={(e) => set({ auth: e.target.value })} className={input}>
                <option value="bearer">{t("Bearer توکن")}</option>
                <option value="basic">Basic (user:password)</option>
                <option value="header">{t("هدر دلخواه")}</option>
              </select>
            </label>
            {form.auth === "header" ? (
              <label className="space-y-1 text-sm">
                <span className="text-muted-foreground">{t("نام هدر")}</span>
                <input value={form.header} onChange={(e) => set({ header: e.target.value })} placeholder="X-API-Key" dir="ltr" className={input} />
              </label>
            ) : null}
          </div>
          <label className="block space-y-1 text-sm">
            <span className="text-muted-foreground">{t("توکن یا رمز (اختیاری؛ در خزانهٔ همین نصب ذخیره می‌شود و دیگر نشان داده نمی‌شود)")}</span>
            <input type="password" autoComplete="off" value={form.secretValue} onChange={(e) => set({ secretValue: e.target.value })} dir="ltr" className={input} />
          </label>
          {form.kind === "alertmanager" ? (
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={form.watchdog} onChange={(e) => set({ watchdog: e.target.checked })} /> {t("آلارم Watchdog دارد (نبودنش یعنی مسیر آلارم کور شده)")}
            </label>
          ) : null}
        </>
      ) : null}

      {form.kind === "telegram" ? (
        <>
          <label className="block space-y-1 text-sm">
            <span className="text-muted-foreground">{t("گروه، کانال یا باتی که آلارم‌ها در آن می‌آید")}</span>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("جستجوی نام یا @username")} className={input} />
          </label>
          <ul className="max-h-48 space-y-1 overflow-y-auto">
            {chats.map((c) => (
              <li key={c.id}>
                <button type="button" onClick={() => set({ personId: c.id, chatTitle: c.title })} className={`w-full rounded-lg px-2 py-1 text-start text-sm ${form.personId === c.id ? "bg-primary text-primary-foreground" : "hover:bg-muted"}`}>
                  {c.title} <span className="text-xs opacity-70">{c.type === "channel" ? t("کانال") : c.type === "group" ? t("گروه") : c.username?.toLowerCase().endsWith("bot") ? t("بات") : t("شخص")}{c.username ? ` · @${c.username}` : ""}</span>
                </button>
              </li>
            ))}
            {!chats.length ? <li className="text-xs text-muted-foreground">{t("چتی پیدا نشد؛ یک گروه یا کانال وقتی این‌جا می‌آید که دست‌کم یک پیامش به این اکانت رسیده باشد.")}</li> : null}
          </ul>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={form.everyMessage} onChange={(e) => set({ everyMessage: e.target.checked })} /> {t("هر پیام این چت آلارم است (حتی بدون 🔴 یا FIRING)")}
          </label>
        </>
      ) : null}

      {form.kind === "telegram" || form.kind === "webhook" ? (
        <label className="block space-y-1 text-sm">
          <span className="text-muted-foreground">{t("آلارمی که تکرار یا رفع نشود بعد از چند ساعت بسته شود")}</span>
          <input type="number" min={1} max={168} value={form.ttlHours} onChange={(e) => set({ ttlHours: e.target.value })} placeholder={form.kind === "telegram" ? "6" : "24"} dir="ltr" className={`${input} w-28`} />
        </label>
      ) : null}
      {form.kind === "webhook" ? <p className="text-xs leading-5 text-muted-foreground">{t("بعد از ساختن، آدرس وبهوک روی کارت منبع می‌آید؛ آن را در Alertmanager یا Grafana به‌عنوان webhook بگذارید.")}</p> : null}

      <div className="flex gap-2">
        <button type="submit" disabled={busy || (form.kind === "telegram" && !form.personId)} className="press rounded-full bg-primary px-4 py-2 text-sm text-primary-foreground disabled:opacity-50">
          {busy ? t("در حال افزودن…") : t("افزودن و تست")}
        </button>
        <button type="button" onClick={onCancel} className="press rounded-full border px-4 py-2 text-sm hover:bg-muted">
          {t("انصراف")}
        </button>
      </div>
    </form>
  );
}
