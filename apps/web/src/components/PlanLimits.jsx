import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, LogIn, LogOut, Mic, RotateCcw, Server } from "lucide-react";
import { toast } from "sonner";
import { api } from "../api.js";
import { locale, num, t } from "../i18n.js";
import { useFlag, useLook } from "../ui-prefs.js";
import { formatReset, formatTokens, limitLabel, limitsProblem, planName } from "../tokens-format.js";

// Account and plan pieces: exact Claude plan limits (GET /api/usage/limits), the Z.ai coding-plan
// quota with its reset cards and the one-time "sign in with Z.ai" (GET /api/usage/zai, /api/auth/zai), a custom
// Anthropic-compatible endpoint, and the speech-to-text key. No value of a key ever comes back.

const field = "w-full rounded-lg border bg-background px-3 py-2 text-sm";
const button = "press inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs hover:bg-muted disabled:opacity-50";

function Bar({ percent, warnAt }) {
  const p = Math.max(0, Math.min(100, Number(percent) || 0));
  return (
    <div className="g-usage-bar mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
      <div className={`h-full ${p >= 90 ? "bg-bad" : p >= warnAt ? "bg-warn" : "bg-ok"}`} style={{ width: `${p}%` }} />
    </div>
  );
}

function Row({ label, value, percent, resetsAt, warnAt }) {
  return (
    <div className="mb-2">
      <div className="flex justify-between gap-2">
        <span>{label}</span>
        <span className="ltr">{value}</span>
      </div>
      <Bar percent={percent} warnAt={warnAt} />
      {resetsAt ? <div className="mt-0.5 text-muted-foreground">{formatReset(resetsAt)}</div> : null}
    </div>
  );
}

/** Exact Claude plan limits, as the Claude app's /usage shows them. */
export function ClaudeLimits() {
  const [limits, setLimits] = useState(null);
  const warnAt = useLook() === "karsara" ? 75 : 70;
  useEffect(() => {
    api("/api/usage/limits").then(setLimits, () => setLimits({ available: false }));
  }, []);
  if (!limits) return <div className="text-muted-foreground">{t("در حال خواندن…")}</div>;
  if (!limits.available) return <div className="text-muted-foreground">{limitsProblem(limits.reason)}</div>;
  return (
    <div>
      {limits.plan ? <div className="mb-1 text-muted-foreground">{t("اشتراک {plan}", { plan: planName(limits.plan) })}</div> : null}
      {limits.stale ? <div className="mb-1 text-muted-foreground">{t("خواندن تازه نشد؛ این عددها مال ساعت {time} است.", { time: new Date(limits.fetchedAt).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" }) })}</div> : null}
      {limits.rows.map((row) => <Row key={row.id} label={limitLabel(row)} value={`${row.percent}%`} percent={row.percent} resetsAt={row.resetsAt} warnAt={warnAt} />)}
    </div>
  );
}

// Spending a reset card is deliberate: the first click arms it, a second within 4 s fires.
function ResetButton({ label, count, resetType, onFire, busy }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return undefined;
    const timer = setTimeout(() => setArmed(false), 4_000);
    return () => clearTimeout(timer);
  }, [armed]);
  const usable = count > 0;
  return (
    <button
      type="button"
      className={`${button} ${armed ? "border-warn text-warn" : ""}`}
      disabled={!usable || busy}
      title={usable ? (armed ? t("دوباره بزن تا ریست شود") : t("{n} فرصت ریست", { n: num(count) })) : t("فرصت ریستی برای این پنجره نداری")}
      onClick={async () => {
        if (!armed) return setArmed(true);
        setArmed(false);
        await onFire(resetType);
      }}
    >
      {busy ? <Loader2 className="size-3.5 animate-spin" /> : <RotateCcw className="size-3.5" />}
      {armed ? t("تأیید ریست؟") : label} <span className="text-muted-foreground">{num(count)}</span>
    </button>
  );
}

const ZAI_LABELS = { five_hour: () => t("پنجرهٔ ۵ ساعته"), weekly: () => t("سقف هفتگی") };
const RESET_ERRORS = { not_connected: () => t("برای ریست اول «ورود با Z.ai» را بزن."), no_reset_available: () => t("فرصت ریستی برای این پنجره نداری.") };

/** Z.ai coding-plan credit, its reset cards and the account sign-in. */
export function ZaiQuota({ title = null, hideWhenUnused = false } = {}) {
  const [zai, setZai] = useState(null);
  const [busy, setBusy] = useState(null); // "FIVE_HOUR" | "WEEK" | "signin" | null
  const poll = useRef(null);
  const warnAt = useLook() === "karsara" ? 75 : 70;
  const load = useCallback(() => api("/api/usage/zai").then(setZai, () => setZai({ available: false, resets: { connected: false } })), []);
  const stop = useCallback(() => {
    clearInterval(poll.current);
    poll.current = null;
    setBusy((b) => (b === "signin" ? null : b));
  }, []);
  useEffect(() => {
    load();
    return () => clearInterval(poll.current);
  }, [load]);

  const signIn = async () => {
    if (poll.current) return;
    try {
      const { authorizeUrl } = await api("/api/auth/zai/start", { method: "POST" });
      window.open(authorizeUrl, "_blank", "noopener");
      setBusy("signin");
      poll.current = setInterval(async () => {
        const r = await api("/api/auth/zai/poll").catch(() => ({ status: "pending" }));
        if (r.status === "ready") {
          stop();
          toast.success(r.name ? t("وارد Z.ai شدی: {name}", { name: r.name }) : t("وارد Z.ai شدی"));
          load();
        } else if (r.status === "failed" || r.status === "idle") {
          stop();
          toast.error(t("ورود انجام نشد ({error})؛ دوباره «ورود با Z.ai» را بزن.", { error: r.error || t("نامعلوم") }));
        }
      }, 3_000);
    } catch (e) {
      toast.error(e.message);
    }
  };
  const signOut = async () => {
    stop();
    await api("/api/auth/zai", { method: "DELETE" }).catch((e) => toast.error(e.message));
    load();
  };
  const fire = async (resetType) => {
    setBusy(resetType);
    try {
      await api("/api/usage/zai/reset", { method: "POST", body: { resetType } });
      toast.success(t("ریست انجام شد"));
      await load();
    } catch (e) {
      toast.error(RESET_ERRORS[e.message]?.() || t("ریست انجام نشد ({error})؛ کمی بعد دوباره امتحان کن.", { error: e.message }));
    }
    setBusy(null);
  };

  if (!zai) return hideWhenUnused ? null : <div className="text-muted-foreground">{t("در حال خواندن…")}</div>;
  const resets = zai.resets || { connected: false };
  // An install with no Z.ai key and no Z.ai sign-in has nothing to show here.
  if (hideWhenUnused && !zai.available && !resets.connected && busy !== "signin") return null;
  return (
    <div>
      {title}
      {zai.available ? (
        zai.rows.map((row) => {
          const pct = row.total > 0 ? (row.used / row.total) * 100 : 0;
          return <Row key={row.id} label={ZAI_LABELS[row.id]?.() || row.id} value={`${formatTokens(row.used)} / ${formatTokens(row.total)} (${Math.round(pct)}%)`} percent={pct} resetsAt={row.resetsAt} warnAt={warnAt} />;
        })
      ) : (
        <div className="mb-2 text-muted-foreground">{t("سهمیهٔ Z.ai خوانده نشد؛ کلید Z.ai را در «موتورها» بگذار.")}</div>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {resets.connected ? (
          <>
            <ResetButton label={t("ریست ۵ ساعته")} count={resets.fiveHour ?? 0} resetType="FIVE_HOUR" onFire={fire} busy={busy === "FIVE_HOUR"} />
            <ResetButton label={t("ریست هفتگی")} count={resets.week ?? 0} resetType="WEEK" onFire={fire} busy={busy === "WEEK"} />
            <button type="button" className={`${button} ms-auto`} onClick={signOut}><LogOut className="size-3.5" /> {t("خروج از Z.ai")}</button>
          </>
        ) : busy === "signin" ? (
          <>
            <span className="text-muted-foreground">{t("منتظر تأیید در صفحهٔ Z.ai…")}</span>
            <button type="button" className={button} onClick={stop}>{t("انصراف")}</button>
          </>
        ) : (
          <>
            <span className="text-muted-foreground">{t("برای ریست سهمیه یک‌بار وارد حساب Z.ai شو.")}</span>
            <button type="button" className={button} onClick={signIn}><LogIn className="size-3.5" /> {t("ورود با Z.ai")}</button>
          </>
        )}
      </div>
      {resets.connected && resets.error ? <div className="mt-1 text-muted-foreground">{t("شمارش فرصت‌ها خوانده نشد ({error})؛ کمی بعد دوباره باز کن.", { error: resets.error })}</div> : null}
    </div>
  );
}

/** Settings → Engines: a custom Anthropic-compatible endpoint (Claude Code runs on it). */
export function CustomEndpointCard({ current, onSaved }) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ baseUrl: current?.baseUrl || "", model: current?.defaultModel || "", smallModel: "", key: "" });
  const [saving, setSaving] = useState(false);
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  const save = async () => {
    setSaving(true);
    try {
      await api("/api/providers/custom/config", { method: "PUT", body: { baseUrl: form.baseUrl, model: form.model, smallModel: form.smallModel } });
      if (form.key.trim()) await api("/api/providers/custom/key", { method: "PUT", body: { key: form.key.trim() } });
      toast.success(t("اندپوینت ذخیره شد"));
      setOpen(false);
      onSaved?.();
    } catch (e) {
      toast.error(e.message);
    }
    setSaving(false);
  };
  return (
    <section className="rounded-2xl border bg-card p-4 text-sm">
      <div className="flex items-center gap-3">
        <Server className="size-4 text-muted-foreground" />
        <p className="min-w-0 flex-1 text-xs leading-6 text-muted-foreground">
          {t("سرویس سازگار با Anthropic (مثل یک پراکسی یا سرور خودت): Claude Code با همهٔ ابزارهایش روی آن کار می‌کند.")}
          {current ? <span className="ltr ms-1 font-mono text-foreground">{current.baseUrl || "—"}</span> : null}
        </p>
        <button type="button" className={button} onClick={() => setOpen(!open)} aria-expanded={open}>{current ? t("تنظیم") : t("افزودن")}</button>
      </div>
      {open ? (
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <input className={field} dir="ltr" value={form.baseUrl} onChange={set("baseUrl")} placeholder="https://api.example.com/anthropic" />
          <input className={field} dir="ltr" value={form.model} onChange={set("model")} placeholder="model id" />
          <input className={field} dir="ltr" value={form.smallModel} onChange={set("smallModel")} placeholder="small model id (optional)" />
          <input className={field} dir="ltr" type="password" value={form.key} onChange={set("key")} placeholder={current?.hasKey ? t("خالی بگذار تا همان کلید بماند") : t("کلید API")} autoComplete="off" />
          <div className="sm:col-span-2">
            <button type="button" onClick={save} disabled={saving || !form.baseUrl.trim()} className="press inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-60">
              {saving ? <Loader2 className="size-4 animate-spin" /> : null} {t("ذخیره")}
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

/** Settings → Chat: speech to text (the composer's microphone). */
export function SttSection() {
  const [stt, setStt] = useState(null);
  const [form, setForm] = useState(null);
  const [key, setKey] = useState("");
  const [saving, setSaving] = useState(false);
  const load = () => api("/api/stt").then((s) => {
    setStt(s);
    setForm({ baseUrl: s.baseUrl || "", model: s.model || "", language: s.language || "" });
  }, (e) => toast.error(e.message));
  useEffect(() => {
    load();
  }, []);
  if (!stt || !form) return null;
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  const save = async () => {
    setSaving(true);
    try {
      await api("/api/stt/config", { method: "PUT", body: form });
      if (key.trim()) await api("/api/stt/key", { method: "PUT", body: { key: key.trim() } });
      setKey("");
      toast.success(t("تبدیل صدا به متن ذخیره شد"));
      await load();
    } catch (e) {
      toast.error(e.message);
    }
    setSaving(false);
  };
  const removeKey = async () => {
    await api("/api/stt/key", { method: "DELETE" }).catch((e) => toast.error(e.message));
    load();
  };
  return (
    <section className="rounded-2xl border bg-card p-4 text-sm">
      <div className="mb-3 flex items-center gap-2">
        <Mic className="size-4 text-muted-foreground" />
        <h3 className="flex-1 font-medium">{t("تبدیل صدا به متن")}</h3>
        <span className="text-xs text-muted-foreground">{stt.key?.set ? (stt.key.last4 ? t("کلید ذخیره شده (…{last4})", { last4: stt.key.last4 }) : t("کلید ذخیره شده")) : t("کلید ندارد؛ میکروفون کادر پیام پنهان است")}</span>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <input className={field} dir="ltr" value={form.baseUrl} onChange={set("baseUrl")} placeholder="https://openrouter.ai/api/v1" aria-label={t("آدرس سرویس")} />
        <input className={field} dir="ltr" value={form.model} onChange={set("model")} placeholder="google/gemini-2.5-flash" aria-label={t("مدل")} />
        <input className={field} dir="ltr" value={form.language} onChange={set("language")} placeholder="fa" aria-label={t("زبان")} />
        <input className={field} dir="ltr" type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder={stt.key?.set ? t("خالی بگذار تا همان کلید بماند") : t("کلید سرویس")} autoComplete="off" />
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" onClick={save} disabled={saving} className="press inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-60">
          {saving ? <Loader2 className="size-4 animate-spin" /> : null} {t("ذخیره")}
        </button>
        {stt.key?.set ? <button type="button" onClick={removeKey} className="press rounded-lg border px-3 py-2 text-sm text-bad">{t("حذف کلید")}</button> : null}
      </div>
    </section>
  );
}
