import { useState } from "react";
import { Check, Loader2, Pencil, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { api, usePolling } from "../api.js";
import { formatTokens } from "../tokens-format.js";
import { exactTime } from "../elapsed.js";
import { num, t } from "../i18n.js";

// Settings → usage accounting, on the hub install only (accounting.mjs; GET /api/accounting is
// 404 everywhere else and the section stays hidden): every install's usage from its own database,
// the shared Claude accounts with their plan windows, and the alerts the owner was sent.

// Tokens that load a plan: a cache read is cheap, the rest is not (accounting.mjs fresh).
const fresh = (p) => Number(p?.total || 0) - Number(p?.cacheRead || 0);
const pct = (x) => `${num(Math.round((x || 0) * 100))}%`;
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

function AccountCard({ account, onSaved }) {
  const windows = Object.entries(account.windows || {}).filter(([k]) => WINDOW_LABELS[k]);
  return (
    <div className="space-y-3 rounded-2xl border bg-card p-4">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <AccountName account={account} onSaved={onSaved} />
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            {t("{n} نصب", { n: num(account.installs.length) })}
            {account.inferred ? ` · ${t("از هم‌زمانی ریست هفتگی یکی دانسته شد")}` : ""}
            {" · "}
            <bdi className="ltr" title={account.org ? t("شناسهٔ اکانت در Anthropic: {org}", { org: account.org }) : t("شناسهٔ اکانت هنوز گزارش نشده")}>{account.org ? account.org.slice(0, 8) : account.fingerprints.map((f) => f.slice(0, 6)).join(" ")}</bdi>
          </p>
        </div>
        <div className="text-end text-xs">
          <div><bdi className="ltr font-semibold">{formatTokens(fresh(account.last24h))}</bdi> <span className="text-muted-foreground">{t("۲۴ ساعت")}</span></div>
          <div><bdi className="ltr">{formatTokens(fresh(account.last7d))}</bdi> <span className="text-muted-foreground">{t("۷ روز")}</span></div>
        </div>
      </div>
      {windows.length ? (
        <div className="space-y-2">
          {windows.map(([key, w]) => (
            <div key={key} className="space-y-1">
              <div className="flex text-xs">
                <span>{WINDOW_LABELS[key]}</span>
                <span className="ms-auto text-muted-foreground" title={w.resetsAt ? exactTime(w.resetsAt) : ""}>
                  {num(w.percent)}%{w.resetsAt ? ` · ${t("ریست {at}", { at: exactTime(w.resetsAt) })}` : ""}
                </span>
              </div>
              <Bar percent={w.percent} />
            </div>
          ))}
          <p className="text-[11px] text-muted-foreground">{t("از آخرین اجرای یکی از نصب‌ها، {at}", { at: account.windowsAt ? exactTime(account.windowsAt) : "?" })}</p>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">{t("پنجره‌های سقف هنوز دیده نشده (بعد از اولین اجرای Claude روی یکی از نصب‌ها می‌آید).")}</p>
      )}
      {account.limited.length ? <p className="text-xs text-red-600">{t("به سقف خورده: {list}", { list: account.limited.map((l) => t("{install} تا {until}", { install: l.install, until: exactTime(l.until) })).join(t("، ")) })}</p> : null}
      <div className="divide-y rounded-xl border text-xs">
        {account.installs.map((m) => (
          <div key={`${m.install}|${m.accountId}`} className="flex items-center gap-2 px-3 py-1.5">
            <span className="min-w-0 flex-1 truncate">{m.owner || m.install}</span>
            <bdi className="ltr text-muted-foreground">{formatTokens(fresh(m.last24h))} / {formatTokens(fresh(m.last7d))}</bdi>
            <span className="w-10 text-end text-muted-foreground">{pct(fresh(account.last7d) ? fresh(m.last7d) / fresh(account.last7d) : 0)}</span>
          </div>
        ))}
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
  const { totals, accounts = [], installs = [], alerts = [], history = [] } = data;
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-2">
        <div className="rounded-xl border bg-card px-3 py-2">
          <div className="text-[11px] text-muted-foreground">{t("همهٔ نصب‌ها، ۲۴ ساعت")}</div>
          <bdi className="ltr text-sm font-semibold">{formatTokens(fresh(totals?.last24h))}</bdi>
        </div>
        <div className="rounded-xl border bg-card px-3 py-2">
          <div className="text-[11px] text-muted-foreground">{t("همهٔ نصب‌ها، ۷ روز")}</div>
          <bdi className="ltr text-sm font-semibold">{formatTokens(fresh(totals?.last7d))}</bdi>
        </div>
        <div className="rounded-xl border bg-card px-3 py-2">
          <div className="text-[11px] text-muted-foreground">{t("نصب‌هایی که گزارش داده‌اند")}</div>
          <span className="text-sm font-semibold">{num(installs.length)}</span>
        </div>
        <button type="button" onClick={refresh} disabled={busy} className="press ms-auto flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm hover:bg-muted">
          <RefreshCw className={`size-3.5 ${busy ? "animate-spin" : ""}`} /> {t("تازه کردن")}
        </button>
      </div>
      <p className="text-xs text-muted-foreground">{t("Anthropic ایمیل اکانت را به توکن اشتراک نمی‌دهد؛ اکانت‌ها با شناسهٔ سازمانشان در Anthropic یکی می‌شوند. اسم یا ایمیل هر اکانت را یک بار با مداد کنار اسمش بگذارید. توکن‌ها بدون خواندن از کش شمرده شده‌اند (کش برای سقف پلن ارزان است). هر نصب هر ۱۵ دقیقه از دیتابیس خودش گزارش می‌دهد.")}</p>

      {alerts.length ? (
        <div className="space-y-2">
          <h3 className="text-sm font-semibold">{t("هشدارهای الان")}</h3>
          {alerts.map((a) => <div key={a.key} className={`rounded-xl border px-3 py-2 text-sm ${LEVEL[a.level] || LEVEL.info}`}>{a.text}</div>)}
        </div>
      ) : null}

      <div className="space-y-3">
        <h3 className="text-sm font-semibold">{t("اکانت‌های Claude")}</h3>
        {accounts.length ? accounts.map((a) => <AccountCard key={a.key} account={a} onSaved={reload} />) : <p className="text-sm text-muted-foreground">{t("هنوز هیچ نصبی اکانت Claude گزارش نکرده.")}</p>}
      </div>

      <div className="space-y-3">
        <h3 className="text-sm font-semibold">{t("مصرف هر نصب")}</h3>
        <div className="scrollbar-thin overflow-x-auto rounded-2xl border bg-card">
          <table className="w-full text-xs">
            <thead className="text-muted-foreground">
              <tr>
                {[t("نصب"), t("اکانت"), t("۲۴ ساعت"), t("۷ روز"), t("سهم ۷ روز"), t("۱۴ روز"), t("آخرین گزارش")].map((h) => <th key={h} className="px-3 py-2 text-start font-medium">{h}</th>)}
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
                      <div key={a.id} className="whitespace-nowrap">{a.account || a.id} <bdi className="ltr text-muted-foreground">{formatTokens(fresh(a.last7d))}</bdi></div>
                    ))}
                  </td>
                  <td className="px-3 py-2"><bdi className="ltr">{formatTokens(fresh(i.last24h))}</bdi></td>
                  <td className="px-3 py-2"><bdi className="ltr">{formatTokens(fresh(i.last7d))}</bdi></td>
                  <td className="px-3 py-2">{pct(i.share7d)}</td>
                  <td className="px-3 py-2"><Spark days={i.days} /></td>
                  <td className="whitespace-nowrap px-3 py-2 text-muted-foreground" title={exactTime(i.reportAt)}>{exactTime(i.reportAt)}{i.stale ? ` (${t("قطع")})` : ""}</td>
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
