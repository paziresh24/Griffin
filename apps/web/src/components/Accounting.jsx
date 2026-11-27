import { useState } from "react";
import { Check, Loader2, Minus, Pencil, Plus, RefreshCw, X } from "lucide-react";
import { toast } from "sonner";
import { api, usePolling } from "../api.js";
import { formatTokens } from "../tokens-format.js";
import { exactTime } from "../elapsed.js";
import { locale, t } from "../i18n.js";

// Settings → «حسابداری مصرف», on the maintainer's install only (accounting.mjs; GET /api/accounting is
// 404 everywhere else and the section stays hidden): every install's usage from its own database,
// the shared Claude accounts with their plan windows, and the alerts the owner was sent.

// Tokens that load a plan: a cache read is cheap, the rest is not (accounting.mjs fresh).
const fresh = (p) => Number(p?.total || 0) - Number(p?.cacheRead || 0);
// USD at API list price (apps/server/src/pricing.mjs): the one scale for Opus, Sonnet, Haiku, cache and output.
const usd = (n) => `$${Math.round(Number(n) || 0).toLocaleString("en-US")}`;
const pct = (x) => t("{toLocaleString}٪", { toLocaleString: Math.round((x || 0) * 100).toLocaleString(locale) });
const WINDOW_LABELS = { five_hour: t("۵ ساعته"), seven_day: t("هفتگی"), seven_day_opus: t("هفتگی Opus"), seven_day_sonnet: t("هفتگی Sonnet") };
const LEVEL = { critical: "border-red-500/40 bg-red-500/8", warning: "border-amber-500/40 bg-amber-500/8", info: "border-border bg-muted/40" };

function Bar({ percent }) {
  const tone = percent >= 95 ? "bg-red-500" : percent >= 80 ? "bg-amber-500" : "bg-primary";
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
      <div className={`h-full ${tone}`} style={{ width: `${Math.min(100, percent)}%` }} />
    </div>
  );
}

function Spark({ days }) {
  const values = (days || []).map(fresh);
  const max = Math.max(1, ...values);
  return (
    <div className="flex h-6 w-24 items-end gap-px" dir="ltr" aria-hidden>
      {values.map((v, i) => <span key={i} className="flex-1 rounded-t-[1px] bg-primary/70" style={{ height: `${Math.max(v ? 8 : 0, (v / max) * 100)}%` }} />)}
    </div>
  );
}

function AccountName({ account, onSaved }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(account.name || "");
  const save = async () => {
    try {
      await api("/api/accounting/labels", { method: "PUT", body: account.org ? { org: account.org, name } : { fingerprints: account.fingerprints, name } });
      setEditing(false);
      onSaved();
    } catch (error) {
      toast.error(t("ذخیره نشد"), { description: String(error?.message || error) });
    }
  };
  if (editing) {
    return (
      <form className="flex items-center gap-1" onSubmit={(e) => { e.preventDefault(); save(); }}>
        <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder={t("مثلاً ایمیل اکانت")} className="h-7 w-36 rounded-md border bg-background px-2 text-sm" />
        <button type="submit" className="press rounded-md p-1 hover:bg-muted" aria-label={t("ذخیره")}><Check className="size-4" /></button>
      </form>
    );
  }
  return (
    <button type="button" onClick={() => setEditing(true)} className="press flex items-center gap-1.5 font-semibold" title={t("نام این اکانت")}>
      {account.title}
      <Pencil className="size-3 text-muted-foreground" />
    </button>
  );
}

// Which install has which company account (accounting.mjs installCoverage): one row per install, one
// column per account the company handed out; the other Claude slots of the install named for what they are.
const SHORT = (a) => a.email?.split("@")[0] || a.name;
const CELL = {
  ok: { icon: Check, tone: "text-ok", label: t("وصل") },
  broken: { icon: X, tone: "text-bad", label: t("ورود خراب") },
  missing: { icon: Minus, tone: "text-amber-600", label: t("وارد نشده") },
};
const EXTRA = { other: t("اکانت دیگر"), noid: t("اکانت نامعلوم"), off: t("خاموش"), empty: t("خالی") };

function Coverage({ roster, coverage, candidates, onSaved }) {
  if (!roster?.length) return null;
  const setRoster = async (org, include) => {
    try {
      await api("/api/accounting/roster", { method: "PUT", body: { org, include } });
      onSaved();
    } catch (error) {
      toast.error(t("ذخیره نشد"), { description: String(error?.message || error) });
    }
  };
  const full = coverage.filter((c) => c.have === c.total).length;
  return (
    <div className="space-y-3">
      <h3 className="text-sm font-semibold">{t("اکانت‌های Claude شرکت روی هر نصب")}</h3>
      <p className="text-xs text-muted-foreground">
        {t("{full} از {all} نصب همهٔ {n} اکانت را دارند. اکانت شرکت = اکانتی با ایمیل که روی دست‌کم سه نصب وارد شده، یا اکانتی که این‌جا اضافه کرده‌اید. هر نصب همین را در «چک و تعمیر» خودش به صاحبش نشان می‌دهد.", { full: full.toLocaleString(locale), all: coverage.length.toLocaleString(locale), n: roster.length.toLocaleString(locale) })}
      </p>
      <div className="flex flex-wrap gap-1.5">
        {roster.map((r) => (
          <span key={r.org} className="inline-flex items-center gap-1 rounded-full border bg-card px-2.5 py-1 text-xs" title={r.org}>
            <bdi className="ltr">{r.email || r.name}</bdi>
            <span className="text-muted-foreground">· {t("{n} نصب", { n: r.installs.toLocaleString(locale) })}</span>
            <button type="button" onClick={() => setRoster(r.org, r.pinned ? null : false)} className="press rounded-full p-0.5 hover:bg-muted" aria-label={t("بیرون از اکانت‌های شرکت")} title={t("بیرون از اکانت‌های شرکت")}><X className="size-3" /></button>
          </span>
        ))}
        {(candidates || []).map((c) => (
          <button key={c.org} type="button" onClick={() => setRoster(c.org, true)} className="press inline-flex items-center gap-1 rounded-full border border-dashed px-2.5 py-1 text-xs text-muted-foreground hover:bg-muted" title={c.installs.join(t("، "))}>
            <Plus className="size-3" /> <bdi className="ltr">{c.email || c.org.slice(0, 8)}</bdi> · {t("{n} نصب", { n: c.installs.length.toLocaleString(locale) })}
          </button>
        ))}
      </div>
      <div className="scrollbar-thin overflow-x-auto rounded-2xl border bg-card">
        <table className="w-full text-xs">
          <thead className="text-muted-foreground">
            <tr>
              <th className="px-3 py-2 text-start font-medium">{t("نصب")}</th>
              <th className="px-3 py-2 text-start font-medium">{t("دارد")}</th>
              {roster.map((r) => <th key={r.org} className="px-2 py-2 text-center font-medium"><bdi className="ltr">{SHORT(r)}</bdi></th>)}
              <th className="px-3 py-2 text-start font-medium">{t("بقیهٔ موتورهای Claude")}</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {coverage.map((c) => (
              <tr key={c.install}>
                <td className="px-3 py-2"><div className="font-medium">{c.owner || c.install}</div><div className="text-[11px] text-muted-foreground"><bdi className="ltr">{c.install}</bdi></div></td>
                <td className={`px-3 py-2 font-semibold ${c.have === c.total ? "text-ok" : c.have <= c.total / 2 ? "text-bad" : "text-amber-600"}`}>{t("{have} از {total}", { have: c.have.toLocaleString(locale), total: c.total.toLocaleString(locale) })}</td>
                {roster.map((r) => {
                  const a = c.accounts.find((x) => x.org === r.org);
                  const cell = CELL[a?.state || "missing"];
                  const Icon = cell.icon;
                  return (
                    <td key={r.org} className="px-2 py-2 text-center" title={`${cell.label}${a?.ids?.length ? ` · ${a.ids.join(", ")}` : ""}${a?.slots > 1 ? t(" · {n} بار وارد شده", { n: a.slots }) : ""}`}>
                      <Icon className={`mx-auto size-4 ${cell.tone}`} />
                    </td>
                  );
                })}
                <td className="px-3 py-2 text-muted-foreground">
                  {c.extras.filter((e) => e.why !== "empty" && e.why !== "off").map((e) => (
                    <div key={e.id} className="whitespace-nowrap"><bdi className="ltr">{e.id}</bdi>: {EXTRA[e.why]}{e.email ? <> <bdi className="ltr">{e.email}</bdi></> : null}{e.broken ? t(" (خراب)") : ""}</div>
                  ))}
                  {c.extras.some((e) => e.why === "empty" || e.why === "off") ? <div className="text-[11px]">{t("{n} جای خالی یا خاموش", { n: c.extras.filter((e) => e.why === "empty" || e.why === "off").length.toLocaleString(locale) })}</div> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function AccountCard({ account, company, onSaved }) {
  const windows = Object.entries(account.windows || {}).filter(([k]) => WINDOW_LABELS[k]);
  return (
    <div className="space-y-3 rounded-2xl border bg-card p-4">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <AccountName account={account} onSaved={onSaved} />
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            {company ? t("اکانت شرکت") : account.org ? t("بیرون از اکانت‌های شرکت") : t("اکانت نامعلوم: ورود قدیمی با توکن که شناسهٔ اکانت را نمی‌دهد")}
          </p>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            {t("{toLocaleString} نصب{v} · ", { toLocaleString: account.installs.length.toLocaleString(locale), v: account.inferred ? t(" · از هم‌زمانی ریست هفتگی یکی دانسته شد") : "" })}
            <bdi className="ltr" title={account.org ? t("شناسهٔ اکانت در Anthropic: {org}", { org: account.org }) : t("شناسهٔ اکانت هنوز گزارش نشده")}>{account.org ? account.org.slice(0, 8) : account.fingerprints.map((f) => f.slice(0, 6)).join(" ")}</bdi>
          </p>
        </div>
        <div className="text-end text-xs">
          <div><bdi className="ltr font-semibold">{usd(account.cost?.last24h)}</bdi> <span className="text-muted-foreground">{t("۲۴ ساعت")}</span></div>
          <div><bdi className="ltr">{usd(account.cost?.last7d)}</bdi> <span className="text-muted-foreground">{t("۷ روز")}</span></div>
          <div className="text-[11px] text-muted-foreground"><bdi className="ltr">{formatTokens(fresh(account.last7d))}</bdi> {t("تازه")} · <bdi className="ltr">{formatTokens(account.last7d?.total)}</bdi> {t("با کش")}</div>
        </div>
      </div>
      {windows.length ? (
        <div className="space-y-2">
          {windows.map(([key, w]) => (
            <div key={key} className="space-y-1">
              <div className="flex text-xs">
                <span>{WINDOW_LABELS[key]}</span>
                <span className="ms-auto text-muted-foreground" title={w.resetsAt ? exactTime(w.resetsAt) : ""}>
                  {t("{toLocaleString}٪{v}", { toLocaleString: w.percent.toLocaleString(locale), v: w.resetsAt ? t(" · ریست {exactTime}", { exactTime: exactTime(w.resetsAt) }) : "" })}
                </span>
              </div>
              <Bar percent={w.percent} />
            </div>
          ))}
          <p className="text-[11px] text-muted-foreground">{t("از آخرین اجرای یکی از نصب‌ها، {v}", { v: account.windowsAt ? exactTime(account.windowsAt) : t("؟") })}</p>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">{t("پنجره‌های سقف هنوز دیده نشده (بعد از اولین اجرای Claude روی یکی از نصب‌ها می‌آید).")}</p>
      )}
      {account.limited.length ? <p className="text-xs text-red-600">{t("به سقف خورده: {join}", { join: account.limited.map((l) => t("{install} تا {exactTime}", { install: l.install, exactTime: exactTime(l.until) })).join(t("، ")) })}</p> : null}
      <div className="divide-y rounded-xl border text-xs">
        {account.installs.map((m) => (
          <div key={`${m.install}|${m.accountId}`} className="flex items-center gap-2 px-3 py-1.5">
            <span className="min-w-0 flex-1 truncate">{m.owner || m.install}</span>
            <bdi className="ltr text-muted-foreground">{usd(m.cost?.last24h)} / {usd(m.cost?.last7d)}</bdi>
            <span className="w-10 text-end text-muted-foreground">{pct(account.cost?.last7d ? (m.cost?.last7d || 0) / account.cost.last7d : 0)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// Per model over the fleet: price weight («ضریب» = output price relative to Sonnet 5.5), the tokens as a
// plan sees them (fresh) and as the API counts them (with cache), and the list-price cost.
function ModelTable({ models, totalCost }) {
  if (!models?.length) return null;
  return (
    <div className="space-y-3">
      <h3 className="text-sm font-semibold">{t("مصرف به تفکیک مدل")}</h3>
      <div className="scrollbar-thin overflow-x-auto rounded-2xl border bg-card">
        <table className="w-full text-xs">
          <thead className="text-muted-foreground">
            <tr>
              {[t("مدل"), t("ضریب"), t("تازه، ۷ روز"), t("با کش، ۷ روز"), t("خروجی، ۷ روز"), t("هزینه ۲۴ ساعت"), t("هزینه ۷ روز"), t("سهم")].map((h) => <th key={h} className="px-3 py-2 text-start font-medium">{h}</th>)}
            </tr>
          </thead>
          <tbody className="divide-y">
            {models.map((m) => (
              <tr key={m.model}>
                <td className="px-3 py-2"><bdi className="ltr font-medium">{m.model}</bdi>{m.label ? <span className="text-muted-foreground"> · {m.label}</span> : <span className="text-muted-foreground"> · {t("بدون قیمت")}</span>}</td>
                <td className="px-3 py-2"><bdi className="ltr">{m.weight == null ? "—" : `×${m.weight}`}</bdi></td>
                <td className="px-3 py-2"><bdi className="ltr">{formatTokens(fresh(m.last7d))}</bdi></td>
                <td className="px-3 py-2"><bdi className="ltr">{formatTokens(m.last7d?.total)}</bdi></td>
                <td className="px-3 py-2"><bdi className="ltr">{formatTokens(m.last7d?.output)}</bdi></td>
                <td className="px-3 py-2"><bdi className="ltr">{usd(m.cost?.last24h)}</bdi></td>
                <td className="px-3 py-2"><bdi className="ltr font-semibold">{usd(m.cost?.last7d)}</bdi></td>
                <td className="px-3 py-2">{pct(totalCost ? (m.cost?.last7d || 0) / totalCost : 0)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// The announcement every install shows as a bar on top (accounting.mjs KV_ANNOUNCEMENT): written here, on the hub.
const DURATIONS = [
  { hours: 0, label: t("تا وقتی بردارم") },
  { hours: 24, label: t("۲۴ ساعت") },
  { hours: 72, label: t("۳ روز") },
  { hours: 168, label: t("یک هفته") },
];
function AnnouncementEditor() {
  const [tick, setTick] = useState(0);
  const data = usePolling(`/api/announcement?t=${tick}`, 60_000);
  const [text, setText] = useState("");
  const [level, setLevel] = useState("info");
  const [hours, setHours] = useState(0);
  const [busy, setBusy] = useState(false);
  const current = data?.announcement;
  const send = async (method) => {
    setBusy(true);
    try {
      const r = await api("/api/announcement", method === "PUT" ? { method, body: { text, level, hours } } : { method });
      toast.success(method === "PUT" ? t("اعلان فرستاده شد") : t("اعلان برداشته شد"), { description: t("همین الان به {sent} از {members} نصب وصل رسید؛ بقیه تا ۱۵ دقیقه می‌گیرند.", { sent: String(r.sent ?? 0), members: String(r.members ?? 0) }) });
      if (method === "PUT") setText("");
      setTick((n) => n + 1);
    } catch (error) {
      toast.error(t("ذخیره نشد"), { description: String(error?.message || error) });
    }
    setBusy(false);
  };
  return (
    <div className="space-y-3 rounded-2xl border bg-card p-4">
      <h3 className="text-sm font-semibold">{t("اعلان برای همهٔ گریفین‌ها")}</h3>
      <p className="text-xs text-muted-foreground">{t("متنی که این‌جا بفرستید روی همهٔ نصب‌ها، بالای همهٔ صفحه‌ها، به‌صورت یک کادر دیده می‌شود. هر کس می‌تواند آن را برای خودش ببندد؛ اعلان تازه دوباره دیده می‌شود.")}</p>
      {current ? (
        <div className="flex items-start gap-2 rounded-xl border bg-muted/40 px-3 py-2 text-sm">
          <p dir="auto" className="min-w-0 flex-1 whitespace-pre-line">{current.text}</p>
          <span className="shrink-0 text-[11px] text-muted-foreground">{current.until ? t("تا {when}", { when: exactTime(current.until) }) : t("بی‌پایان")}</span>
          <button type="button" disabled={busy} onClick={() => send("DELETE")} className="press shrink-0 rounded-lg border px-2.5 py-1 text-xs hover:bg-muted">{t("برداشتن")}</button>
        </div>
      ) : null}
      <textarea dir="auto" value={text} onChange={(e) => setText(e.target.value)} rows={3} maxLength={600} placeholder={t("مثلاً: اکانت team-a فعلاً از کار افتاده؛ لطفاً سراغ ورود دوباره‌اش نروید.")} className="w-full rounded-xl border bg-background px-3 py-2 text-sm" />
      <div className="flex flex-wrap items-center gap-2">
        <select value={level} onChange={(e) => setLevel(e.target.value)} className="h-8 rounded-lg border bg-background px-2 text-xs" aria-label={t("اهمیت")}>
          <option value="info">{t("اطلاع")}</option>
          <option value="warn">{t("هشدار")}</option>
          <option value="critical">{t("مهم")}</option>
        </select>
        <select value={hours} onChange={(e) => setHours(Number(e.target.value))} className="h-8 rounded-lg border bg-background px-2 text-xs" aria-label={t("مدت")}>
          {DURATIONS.map((d) => <option key={d.hours} value={d.hours}>{d.label}</option>)}
        </select>
        <button type="button" disabled={busy || !text.trim()} onClick={() => send("PUT")} className="press ms-auto inline-flex items-center gap-1.5 rounded-full bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:opacity-50">
          {busy ? <Loader2 className="size-3.5 animate-spin" /> : null} {current ? t("جایگزین و ارسال") : t("ارسال به همه")}
        </button>
      </div>
    </div>
  );
}

export function AccountingSection() {
  const [tick, setTick] = useState(0);
  const data = usePolling(`/api/accounting?t=${tick}`, 60_000);
  const [busy, setBusy] = useState(false);
  const reload = () => setTick((n) => n + 1);
  const refresh = async () => {
    setBusy(true);
    try {
      await api("/api/accounting/refresh", { method: "POST" });
      reload();
    } finally {
      setBusy(false);
    }
  };
  if (!data) return <Loader2 className="size-4 animate-spin text-muted-foreground" />;
  const { totals, models = [], plan, accounts = [], installs = [], alerts = [], history = [], roster = [], coverage = [], candidates = [] } = data;
  const companyOrgs = new Set(roster.map((r) => r.org));
  const weekUsd = totals?.cost?.last7d || 0;
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-2">
        <div className="rounded-xl border bg-card px-3 py-2">
          <div className="text-[11px] text-muted-foreground">{t("همهٔ نصب‌ها، ۲۴ ساعت")}</div>
          <bdi className="ltr text-sm font-semibold">{usd(totals?.cost?.last24h)}</bdi>
          <div className="text-[11px] text-muted-foreground"><bdi className="ltr">{formatTokens(fresh(totals?.last24h))}</bdi> {t("تازه")} · <bdi className="ltr">{formatTokens(totals?.last24h?.total)}</bdi> {t("با کش")}</div>
        </div>
        <div className="rounded-xl border bg-card px-3 py-2">
          <div className="text-[11px] text-muted-foreground">{t("همهٔ نصب‌ها، ۷ روز")}</div>
          <bdi className="ltr text-sm font-semibold">{usd(weekUsd)}</bdi>
          <div className="text-[11px] text-muted-foreground"><bdi className="ltr">{formatTokens(fresh(totals?.last7d))}</bdi> {t("تازه")} · <bdi className="ltr">{formatTokens(totals?.last7d?.total)}</bdi> {t("با کش")}</div>
        </div>
        {plan?.weeklyUsd ? (
          <div className="rounded-xl border bg-card px-3 py-2">
            <div className="text-[11px] text-muted-foreground">{t("هزینهٔ پلن‌ها در هفته")}</div>
            <bdi className="ltr text-sm font-semibold">{usd(plan.weeklyUsd)}</bdi>
            <div className="text-[11px] text-muted-foreground">{t("{n} اکانت × {usd}؛ مصرف ≈ {x} برابر", { n: plan.accounts.toLocaleString(locale), usd: usd(plan.perAccountUsd), x: (weekUsd / plan.weeklyUsd).toFixed(1) })}</div>
          </div>
        ) : null}
        <div className="rounded-xl border bg-card px-3 py-2">
          <div className="text-[11px] text-muted-foreground">{t("نصب‌هایی که گزارش داده‌اند")}</div>
          <span className="text-sm font-semibold">{installs.length.toLocaleString(locale)}</span>
        </div>
        <button type="button" onClick={refresh} disabled={busy} className="press ms-auto flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm hover:bg-muted">
          <RefreshCw className={`size-3.5 ${busy ? "animate-spin" : ""}`} /> {t("تازه کردن")}
        </button>
      </div>
      <p className="text-xs text-muted-foreground">{t("اکانت‌ها با ایمیل یا شناسهٔ اکانتشان در Anthropic یکی می‌شوند؛ اکانتی که فقط با توکن وصل است ایمیل ندارد و می‌توانید با مداد اسمش را بگذارید. «تازه» توکن بدون خواندن از کش است؛ «با کش» همان چیزی است که API و ابزارهایی مثل ccusage می‌شمارند. هزینه با قیمت لیست API حساب می‌شود (خواندن از کش، نوشتن در کش، خروجی و ورودی هرکدام با نرخ خودشان؛ ضریب = قیمت خروجی نسبت به Sonnet). پلن‌ها ثابت‌اند، پس هزینه مقیاس مقایسه است، نه صورتحساب. هر نصب هر ۱۵ دقیقه از دیتابیس خودش گزارش می‌دهد؛ گزارشِ قدیمی‌تر از یک روز در جمع‌ها و اکانت‌ها حساب نمی‌شود.")}</p>

      {alerts.length ? (
        <div className="space-y-2">
          <h3 className="text-sm font-semibold">{t("هشدارهای الان")}</h3>
          {alerts.map((a) => <div key={a.key} className={`rounded-xl border px-3 py-2 text-sm ${LEVEL[a.level] || LEVEL.info}`}>{a.text}</div>)}
        </div>
      ) : null}

      <AnnouncementEditor />

      <Coverage roster={roster} coverage={coverage} candidates={candidates} onSaved={reload} />

      <ModelTable models={models} totalCost={weekUsd} />

      <div className="space-y-3">
        <h3 className="text-sm font-semibold">{t("اکانت‌های Claude")}</h3>
        {accounts.length ? accounts.map((a) => <AccountCard key={a.key} account={a} company={Boolean(a.org && companyOrgs.has(a.org))} onSaved={reload} />) : <p className="text-sm text-muted-foreground">{t("هنوز هیچ نصبی اکانت Claude گزارش نکرده.")}</p>}
      </div>

      <div className="space-y-3">
        <h3 className="text-sm font-semibold">{t("مصرف هر نصب")}</h3>
        <div className="scrollbar-thin overflow-x-auto rounded-2xl border bg-card">
          <table className="w-full text-xs">
            <thead className="text-muted-foreground">
              <tr>
                {[t("نصب"), t("اکانت"), t("مدل‌ها"), t("۲۴ ساعت"), t("۷ روز"), t("سهم ۷ روز"), t("۱۴ روز"), t("آخرین گزارش")].map((h) => <th key={h} className="px-3 py-2 text-start font-medium">{h}</th>)}
              </tr>
            </thead>
            <tbody className="divide-y">
              {installs.map((i) => (
                <tr key={i.install} className={i.stale ? "opacity-60" : ""}>
                  <td className="px-3 py-2">
                    <div className="font-medium">{i.owner || i.install}</div>
                    <div className="text-[11px] text-muted-foreground"><bdi className="ltr">{i.install}</bdi>{i.assistant ? ` · ${i.assistant}` : ""}</div>
                  </td>
                  <td className="px-3 py-2">
                    {i.accounts.slice(0, 3).map((a) => (
                      <div key={a.id} className="whitespace-nowrap">{a.account || a.id} <bdi className="ltr text-muted-foreground">{usd(a.cost?.last7d)}</bdi></div>
                    ))}
                  </td>
                  <td className="px-3 py-2">
                    {i.models.slice(0, 3).map((m) => (
                      <div key={m.model} className="whitespace-nowrap"><bdi className="ltr">{m.model}</bdi> <bdi className="ltr text-muted-foreground">{usd(m.cost?.last7d)}</bdi></div>
                    ))}
                  </td>
                  <td className="px-3 py-2"><bdi className="ltr">{usd(i.cost?.last24h)}</bdi></td>
                  <td className="px-3 py-2"><div><bdi className="ltr font-semibold">{usd(i.cost?.last7d)}</bdi></div><div className="text-[11px] text-muted-foreground"><bdi className="ltr">{formatTokens(fresh(i.last7d))} / {formatTokens(i.last7d?.total)}</bdi></div></td>
                  <td className="px-3 py-2">{pct(weekUsd ? (i.cost?.last7d || 0) / weekUsd : 0)}</td>
                  <td className="px-3 py-2"><Spark days={i.days} /></td>
                  <td className="whitespace-nowrap px-3 py-2 text-muted-foreground" title={exactTime(i.reportAt)}>{exactTime(i.reportAt)}{i.stale ? t(" (قطع)") : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {history.length ? (
        <div className="space-y-2">
          <h3 className="text-sm font-semibold">{t("هشدارهایی که فرستاده شد")}</h3>
          <div className="divide-y rounded-2xl border bg-card text-xs">
            {history.map((a) => (
              <div key={`${a.key}|${a.at}`} className="flex gap-3 px-3 py-2">
                <span className="shrink-0 text-muted-foreground">{exactTime(a.at)}</span>
                <span>{a.text}</span>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
