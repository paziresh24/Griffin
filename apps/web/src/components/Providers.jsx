import { useCallback, useEffect, useState } from "react";
import { Switch } from "radix-ui";
import { AnimatePresence, motion } from "motion/react";
import {
  AlertCircle,
  ArrowLeftRight,
  Building2,
  Check,
  ChevronDown,
  Copy,
  Cpu,
  ExternalLink,
  Gauge,
  KeyRound,
  Loader2,
  Mail,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  ShieldAlert,
  SlidersHorizontal,
  Star,
  Trash2,
  User,
} from "lucide-react";
import { toast } from "sonner";
import { api } from "../api.js";
import { ProbeResult } from "./Setup.jsx";
import { CustomEndpointCard, ZaiQuota } from "./PlanLimits.jsx";
import { EngineLogo } from "./EngineLogo.jsx";
import { DEFAULT_ENGINE_EVENT } from "../engine-events.js";
import { locale, t } from "../i18n.js";

export const KIND_LABEL = { claude: "Claude", openai: "OpenAI-compatible", cursor: "Cursor" };
const KIND_NAME = { claude: "Claude", openai: "OpenAI", cursor: "Cursor" };
export const PLAN_LABEL = { codex: "Codex", antigravity: "Antigravity" };
const PROVIDER_LIMIT_MIN = 30;
const BASE_MODEL_HINT = { claude: "claude-opus-4-6", openai: "gpt-4o", cursor: "auto" };
export { DEFAULT_ENGINE_EVENT };

export const resetLabel = (at) => new Date(at).toLocaleString(locale, { timeZone: "Asia/Tehran", hour: "2-digit", minute: "2-digit", ...(at - Date.now() > 20 * 60 * 60_000 ? { weekday: "long" } : {}) });

export function LoadFailed({ message, onRetry }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-2xl border border-dashed px-4 py-8 text-center text-sm text-muted-foreground" role="alert">
      <p>{t("بارگذاری نشد:")} <span dir="auto">{message}</span></p>
      <button type="button" onClick={onRetry} className="press rounded-lg border px-3 py-1.5 text-xs hover:bg-muted">{t("دوباره")}</button>
    </div>
  );
}

function formatPlanLabel(plan, kind) {
  if (!plan) return null;
  const key = String(plan).trim().toLowerCase();
  if (key === "free") return t("رایگان");
  if (kind === "claude") {
    if (key.includes("ultra") || key.includes("20x")) return "Claude Ultra";
    if (key.includes("max")) return "Claude Max";
    if (key.includes("pro")) return "Claude Pro";
    if (key.includes("team")) return "Claude Team";
    if (key.includes("enterprise")) return "Claude Enterprise";
  }
  return plan;
}

function formatAuthMethod(method) {
  if (!method) return null;
  const key = String(method).trim().toLowerCase();
  if (key === "claude.ai" || key === "claudeai" || key === "oauth") return t("ورود با اکانت");
  if (key === "oauth_token") return t("توکن اشتراک");
  if (key === "apikey" || key === "api_key") return t("کلید API");
  return method;
}

function formatTehranTime(iso) {
  if (!iso) return "";
  const ms = typeof iso === "number" ? iso : Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  try {
    const now = new Date();
    const target = new Date(ms);
    const dayFmt = new Intl.DateTimeFormat(locale, { timeZone: "Asia/Tehran", year: "numeric", month: "2-digit", day: "2-digit" });
    const timeStr = new Intl.DateTimeFormat(locale, { timeZone: "Asia/Tehran", hour: "2-digit", minute: "2-digit", hour12: false }).format(target);
    if (dayFmt.format(now) === dayFmt.format(target)) return t("ساعت {time}", { time: timeStr });
    const weekday = new Intl.DateTimeFormat(locale, { timeZone: "Asia/Tehran", weekday: "short" }).format(target);
    return `${weekday} ${timeStr}`;
  } catch {
    return "";
  }
}

function formatUsageLabel(row) {
  if (!row) return "";
  const id = String(row.id || "");
  if (id === "five_hour") return t("پنجرهٔ ۵ ساعته");
  if (id === "seven_day") return t("سهمیهٔ هفتگی");
  if (id === "seven_day_sonnet") return t("هفتگی Sonnet");
  if (id === "seven_day_opus") return t("هفتگی Opus");
  return row.label || id;
}

export function accountLabel(p) {
  if (p.label) return p.label;
  if (p.name) return p.name;
  const base = PLAN_LABEL[p.plan] || KIND_NAME[p.kind] || p.kind;
  return p.id === p.kind ? base : `${base} · ${p.id.slice(p.kind.length + 1)}`;
}

function kindBadgeLabel(p) {
  if (p.plan) return PLAN_LABEL[p.plan] || p.plan;
  if (p.endpointLabel) return p.endpointLabel;
  return KIND_NAME[p.kind] || p.kind;
}

function computeStatus(p, { checking, probe }) {
  if (!p.enabled) return { tone: "muted", text: t("خاموش"), spin: false };
  if (!p.hasKey) return { tone: "warn", text: t("بدون ورود / کلید"), spin: false };
  if (checking) return { tone: "checking", text: t("در حال بررسی…"), spin: true };
  if (p.state === "limited") {
    const mins = p.limitedUntil ? Math.max(1, Math.ceil((p.limitedUntil - Date.now()) / 60_000)) : PROVIDER_LIMIT_MIN;
    return { tone: "warn", text: t("سقف موقت ({m} دقیقه)", { m: mins.toLocaleString(locale) }), spin: false };
  }
  if (p.state === "credit") return { tone: "bad", text: t("اعتبار تمام شده"), spin: false };
  if (p.state === "auth") return { tone: "bad", text: t("نیاز به ورود دوباره"), spin: false };
  if (probe && !probe.ok) return { tone: "bad", text: t("خطا در اتصال"), spin: false };
  if (!p.health?.ok) return { tone: "bad", text: t("پاسخ نداد"), spin: false };
  return { tone: "ok", text: t("فعال و آماده"), spin: false };
}

const STATUS_STYLE = {
  ok: "bg-ok/12 text-ok border-ok/25",
  warn: "bg-warn/12 text-warn border-warn/25",
  bad: "bg-bad/12 text-bad border-bad/25",
  checking: "bg-primary/10 text-primary border-primary/20",
  muted: "bg-muted text-muted-foreground border-border/60",
};

function ProvidersSkeleton() {
  return (
    <div className="space-y-4" aria-label={t("در حال بارگذاری موتورها")}>
      <div className="flex items-center justify-between gap-3 rounded-2xl border bg-card/60 p-4">
        <div className="space-y-2">
          <div className="h-4 w-36 animate-pulse rounded-md bg-muted" />
          <div className="h-3 w-56 animate-pulse rounded-md bg-muted/70" />
        </div>
        <div className="h-9 w-28 animate-pulse rounded-xl bg-muted" />
      </div>
      {[0, 1, 2].map((i) => (
        <div key={i} className="space-y-3 rounded-2xl border bg-card p-4">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <div className="size-9 animate-pulse rounded-xl bg-muted" />
              <div className="space-y-1.5">
                <div className="h-4 w-32 animate-pulse rounded bg-muted" />
                <div className="h-3 w-20 animate-pulse rounded bg-muted/70" />
              </div>
            </div>
            <div className="flex items-center gap-2">
              <div className="h-6 w-24 animate-pulse rounded-full bg-muted" />
              <div className="h-5 w-9 animate-pulse rounded-full bg-muted" />
            </div>
          </div>
          <div className="h-14 animate-pulse rounded-xl bg-muted/40" />
          <div className="flex gap-2 border-t pt-3">
            <div className="h-7 w-20 animate-pulse rounded-lg bg-muted/70" />
            <div className="h-7 w-24 animate-pulse rounded-lg bg-muted/70" />
            <div className="h-7 w-16 animate-pulse rounded-lg bg-muted/70" />
          </div>
        </div>
      ))}
    </div>
  );
}

export function ProvidersSection() {
  const [data, setData] = useState(null);
  const [failed, setFailed] = useState(null);
  const [editing, setEditing] = useState(null);
  const [showOff, setShowOff] = useState(false);

  const load = useCallback((silent = false) => {
    if (!silent) setFailed(null);
    return api("/api/providers").then((res) => {
      setData(res);
      setFailed(null);
    }).catch((e) => {
      if (!silent) {
        toast.error(e.message);
        setFailed(e.message || t("بارگذاری نشد"));
      }
    });
  }, []);

  useEffect(() => {
    load();
    const onChanged = (ev) => {
      const kind = ev?.detail?.kind || "all";
      if (kind === "providers" || kind === "settings" || kind === "all") load(true);
    };
    window.addEventListener("griffin:settings-changed", onChanged);
    return () => window.removeEventListener("griffin:settings-changed", onChanged);
  }, [load]);

  if (!data && failed) return <LoadFailed message={failed} onRetry={() => load(false)} />;
  if (!data) return <ProvidersSkeleton />;

  const providers = data.providers || [];
  const on = providers.filter((p) => p.enabled);
  const off = providers.filter((p) => !p.enabled);
  const activeCount = on.filter((p) => p.hasKey && p.state === "ok").length;
  const defaultItem = providers.find((p) => p.isDefault);
  const openWizard = () => { window.location.hash = "/setup/engine"; };

  const toggleSameKind = async (sameKind) => {
    setData((d) => ({ ...d, switchSameKind: sameKind }));
    try {
      await api("/api/engine-switch", { method: "PUT", body: { sameKind } });
      await load(true);
    } catch (e) {
      setData((d) => ({ ...d, switchSameKind: !sameKind }));
      toast.error(e.message);
    }
  };

  return (
    <div className="space-y-4">
      {/* Top overview + controls */}
      <div className="rounded-2xl border bg-card p-4 shadow-xs">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-sm font-semibold">{t("موتورهای هوش مصنوعی")}</h3>
              <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground tabular-nums">
                {t("{ok} آماده از {all}", { ok: activeCount.toLocaleString(locale), all: providers.length.toLocaleString(locale) })}
              </span>
            </div>
            <p className="text-xs leading-6 text-muted-foreground">
              {defaultItem
                ? t("موتور پیش‌فرض فعلی «{name}» است؛ در صورت محدودیت یا خطا، به‌صورت خودکار به موتور آمادهٔ بعدی می‌رود.", { name: accountLabel(defaultItem) })
                : t("گفتگوها و ایجنت‌ها روی اولین موتور آماده اجرا می‌شوند؛ با انتخاب «پیش‌فرض» اولویت اصلی را مشخص کنید.")}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => load(false)}
              className="press inline-flex items-center gap-1.5 rounded-xl border px-3 py-2 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
              title={t("به‌روزرسانی فهرست")}
            >
              <RefreshCw className="size-3.5" />
              {t("به‌روزرسانی")}
            </button>
            <button
              type="button"
              onClick={openWizard}
              className="press inline-flex items-center gap-1.5 rounded-xl bg-primary px-3.5 py-2 text-xs font-medium text-primary-foreground shadow-xs hover:opacity-95"
            >
              <Plus className="size-3.5" /> {t("افزودن موتور")}
            </button>
          </div>
        </div>

        <div className="mt-3.5 flex items-center justify-between gap-3 border-t border-border/60 pt-3">
          <div className="flex items-start gap-2 text-xs text-muted-foreground">
            <ArrowLeftRight className="mt-0.5 size-3.5 shrink-0" />
            <span>{t("جابه‌جایی خودکار فقط بین حساب‌های همان نوع (مثلاً کلاد به کلاد) انجام شود")}</span>
          </div>
          <Switch.Root
            checked={Boolean(data.switchSameKind)}
            onCheckedChange={toggleSameKind}
            aria-label={t("فقط حساب‌های همان نوع")}
            className="h-5 w-9 shrink-0 rounded-full bg-muted p-0.5 transition-colors data-[state=checked]:bg-primary"
          >
            <Switch.Thumb className="block size-4 rounded-full bg-background shadow transition-transform data-[state=checked]:-translate-x-4" />
          </Switch.Root>
        </div>
      </div>

      {on.length === 0 ? (
        <div className="rounded-2xl border border-dashed bg-card/40 p-8 text-center">
          <Cpu className="mx-auto size-8 text-muted-foreground/60" />
          <p className="mt-2 text-sm font-medium">{providers.length === 0 ? t("هنوز موتوری اضافه نشده است") : t("هیچ موتور روشنی نیست")}</p>
          <p className="mt-1 text-xs text-muted-foreground">{t("برای شروع، یک حساب Claude، Codex یا کلید OpenAI اضافه کنید.")}</p>
          <button
            type="button"
            onClick={openWizard}
            className="press mt-4 inline-flex items-center gap-1.5 rounded-xl bg-primary px-4 py-2 text-xs font-medium text-primary-foreground"
          >
            <Plus className="size-3.5" /> {t("افزودن موتور")}
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          {on.map((p) => (
            <EngineCard
              key={p.id}
              p={p}
              presets={data.presets || []}
              claudeEndpoints={data.claudeEndpoints || []}
              editing={editing === p.id}
              onEdit={() => setEditing(editing === p.id ? null : p.id)}
              onClose={() => setEditing(null)}
              reload={() => load(true)}
            />
          ))}
        </div>
      )}

      {off.length ? (
        <div>
          <button
            type="button"
            onClick={() => setShowOff((v) => !v)}
            className="press inline-flex items-center gap-1.5 px-1 text-xs font-medium text-muted-foreground hover:text-foreground"
          >
            <ChevronDown className={`size-3.5 transition-transform duration-200 ${showOff ? "" : "-rotate-90 rtl:rotate-90"}`} />
            {t("خاموش‌ها ({length})", { length: off.length.toLocaleString(locale) })}
          </button>
          <AnimatePresence initial={false}>
            {showOff ? (
              <motion.div
                key="off-list"
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: "auto", opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.2 }}
                className="overflow-hidden"
              >
                <div className="mt-2.5 space-y-3">
                  {off.map((p) => (
                    <EngineCard
                      key={p.id}
                      p={p}
                      presets={data.presets || []}
                      claudeEndpoints={data.claudeEndpoints || []}
                      editing={editing === p.id}
                      onEdit={() => setEditing(editing === p.id ? null : p.id)}
                      onClose={() => setEditing(null)}
                      reload={() => load(true)}
                    />
                  ))}
                </div>
              </motion.div>
            ) : null}
          </AnimatePresence>
        </div>
      ) : null}

      <CustomEndpointCard current={providers.find((p) => p.endpoint === "custom")} onSaved={() => load(true)} />
      {providers.some((p) => p.endpoint === "zai" || /\bz\.ai\b/.test(p.baseUrl || "")) ? (
        <section className="rounded-2xl border bg-card p-4 text-xs">
          <ZaiQuota title={<h3 className="mb-2 text-sm font-semibold">{t("حساب Z.ai")}</h3>} />
        </section>
      ) : null}
    </div>
  );
}

// The default for every chat and agent; new chats drop the model this browser kept from the picker,
// so they follow it too (App.jsx listens).
async function makeDefault(id, reload) {
  try {
    await api(`/api/providers/${id}`, { method: "PATCH", body: { default: true } });
    try {
      localStorage.removeItem("griffin:model");
      window.dispatchEvent(new CustomEvent(DEFAULT_ENGINE_EVENT));
    } catch {}
    toast.success(t("موتور پیش‌فرض ذخیره شد"));
    await reload();
  } catch (e) {
    toast.error(e.message);
  }
}

function UsageBar({ row }) {
  const pct = Math.max(0, Math.min(100, Math.round(Number(row.percent) || 0)));
  const barTone = pct >= 90 ? "bg-bad" : pct >= 70 ? "bg-warn" : "bg-ok";
  const textTone = pct >= 90 ? "text-bad" : pct >= 70 ? "text-warn" : "text-foreground";
  const reset = formatTehranTime(row.resetsAt);
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2 text-[11px]">
        <span className="font-medium text-muted-foreground">{formatUsageLabel(row)}</span>
        <div className="flex items-center gap-2 tabular-nums">
          {reset ? <span className="text-muted-foreground">{t("ریست {time}", { time: reset })}</span> : null}
          <span className={`font-semibold ${textTone}`}>{t("{n}٪", { n: pct.toLocaleString(locale) })}</span>
        </div>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div className={`h-full rounded-full transition-all duration-300 ${barTone}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function EngineCard({ p, presets, claudeEndpoints, editing, onEdit, onClose, reload }) {
  const shouldProbeOnMount = Boolean(p.enabled && p.hasKey);
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(shouldProbeOnMount);
  const [probe, setProbe] = useState(null);
  const [renaming, setRenaming] = useState(false);
  const [draftLabel, setDraftLabel] = useState(p.label || "");
  const [usage, setUsage] = useState(p.usage || null);
  const [loadingUsage, setLoadingUsage] = useState(false);

  useEffect(() => { setDraftLabel(p.label || ""); }, [p.label]);
  useEffect(() => { if (p.usage) setUsage(p.usage); }, [p.usage]);

  // Run the live doctor check on mount / when key or enabled changes, WITH an explicit loading state
  // so status or errors never pop in out of nowhere after looking green.
  useEffect(() => {
    if (!p.enabled || !p.hasKey) {
      setChecking(false);
      setProbe(null);
      return;
    }
    let live = true;
    setChecking(true);
    // Passive by default: reports the account's own recorded state; only probes when the install
    // turned phone-home-on-open on (CLAUDE_PROBE=on). «تست» always probes.
    api(`/api/doctor/engine/${p.id}`)
      .then((r) => {
        if (!live) return;
        setProbe(r);
        setChecking(false);
        const now = r.state || (r.ok ? "ok" : null);
        if (now && now !== p.state && (now !== "ok" || p.state === "limited" || p.state === "credit" || p.state === "auth")) {
          reload();
        }
      })
      .catch((e) => {
        if (!live) return;
        setProbe({ ok: false, detail: e.message || t("بررسی انجام نشد") });
        setChecking(false);
      });
    return () => { live = false; };
  }, [p.id, p.enabled, p.hasKey]);

  const status = computeStatus(p, { checking, probe });

  const run = (fn) => async () => {
    setBusy(true);
    try {
      await fn();
      await reload();
    } catch (e) {
      toast.error(e.message);
    }
    setBusy(false);
  };

  const testNow = async () => {
    setChecking(true);
    setProbe(null);
    try {
      const r = await api(`/api/doctor/engine/${p.id}?fresh=1`);
      setProbe(r);
      if (r.ok) toast.success(t("اتصال «{name}» سالم است", { name: accountLabel(p) }));
      await reload();
    } catch (e) {
      setProbe({ ok: false, detail: e.message });
      toast.error(e.message);
    }
    setChecking(false);
  };

  const refreshUsage = async () => {
    setLoadingUsage(true);
    try {
      const r = await api(`/api/providers/${p.id}/usage`, { method: "POST" });
      if (r?.usage) {
        setUsage(r.usage);
        toast.success(t("سهمیه به‌روزرسانی شد"));
      } else {
        toast.message(t("اطلاعات سهمیه برای این حساب در دسترس نبود"));
      }
    } catch (e) {
      toast.error(e.message);
    }
    setLoadingUsage(false);
  };

  const saveLabel = async () => {
    setRenaming(false);
    const next = draftLabel.trim();
    if (next === (p.label || "")) return;
    setBusy(true);
    try {
      await api(`/api/providers/${p.id}`, { method: "PATCH", body: { label: next } });
      await reload();
    } catch (e) {
      toast.error(e.message);
      setDraftLabel(p.label || "");
    }
    setBusy(false);
  };

  const toggle = (enabled) => run(() => api(`/api/providers/${p.id}`, { method: "PATCH", body: { enabled } }))();
  const clearLimit = run(() => api(`/api/providers/${p.id}`, { method: "PATCH", body: { clearLimit: true } }));
  const remove = run(async () => {
    if (!window.confirm(t("حساب «{name}» و کلیدش حذف شود؟", { name: accountLabel(p) }))) return;
    await api(`/api/providers/${p.id}`, { method: "DELETE" });
  });

  const isPlainClaude = p.kind === "claude" && !p.endpoint;
  const planChip = formatPlanLabel(p.signedInAs?.plan, p.kind);
  const authChip = formatAuthMethod(p.signedInAs?.method);
  const showErrorBanner = !checking && (
    (probe && !probe.ok) ||
    p.state === "credit" ||
    p.state === "auth" ||
    p.state === "limited" ||
    (!probe && p.enabled && p.hasKey && p.health && !p.health.ok)
  );
  const actionBtn = "press inline-flex items-center gap-1.5 rounded-lg border bg-background px-2.5 py-1.5 text-xs font-medium text-foreground/90 transition-colors hover:bg-muted disabled:opacity-50";

  return (
    <div className={`rounded-2xl border bg-card transition-colors ${p.isDefault ? "border-primary/35 shadow-xs" : "border-border/80"} ${!p.enabled ? "opacity-75" : ""}`}>
      {/* Header row */}
      <div className="flex flex-wrap items-start justify-between gap-3 p-4 pb-3">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <div className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-xl border bg-muted/40">
            <EngineLogo id={p.plan || p.kind} className="size-5" bare />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              {renaming ? (
                <input
                  autoFocus
                  value={draftLabel}
                  onChange={(e) => setDraftLabel(e.target.value)}
                  onBlur={saveLabel}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") saveLabel();
                    if (e.key === "Escape") { setDraftLabel(p.label || ""); setRenaming(false); }
                  }}
                  placeholder={p.name || p.id}
                  className="w-48 rounded-lg border bg-background px-2.5 py-0.5 text-sm font-semibold"
                  aria-label={t("نام نمایشی موتور")}
                />
              ) : (
                <button
                  type="button"
                  onClick={() => setRenaming(true)}
                  className="group inline-flex min-w-0 items-center gap-1.5 text-right text-sm font-semibold hover:text-primary"
                  title={t("تغییر نام نمایشی")}
                >
                  <span className="truncate">{accountLabel(p)}</span>
                  <Pencil className="size-3 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
                </button>
              )}

              <span className="rounded-md bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground" dir="ltr">
                {kindBadgeLabel(p)}
              </span>

              {p.isDefault ? (
                <span className="inline-flex items-center gap-1 rounded-full bg-primary/12 px-2 py-0.5 text-[11px] font-medium text-primary">
                  <Star className="size-3 fill-current" /> {t("پیش‌فرض")}
                </span>
              ) : null}

              {p.enabled && p.auto === false ? (
                <span className="rounded-full border px-2 py-0.5 text-[10px] text-muted-foreground">
                  {t("فقط انتخاب دستی")}
                </span>
              ) : null}
            </div>

            <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
              <span>{t("شناسه:")} <bdi dir="ltr" className="font-mono text-foreground/80">{p.id}</bdi></span>
              <span aria-hidden="true">·</span>
              <span>{t("مدل:")} <bdi dir="ltr" className="font-mono text-foreground/90">{p.defaultModel || BASE_MODEL_HINT[p.kind] || t("خودکار")}</bdi></span>
              {p.baseUrl ? (
                <>
                  <span aria-hidden="true">·</span>
                  <bdi dir="ltr" className="max-w-[220px] truncate font-mono text-muted-foreground">{p.baseUrl}</bdi>
                </>
              ) : null}
            </div>
          </div>
        </div>

        {/* Status badge (with explicit loading spinner) + Enable toggle */}
        <div className="flex shrink-0 items-center gap-2.5">
          <span
            className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors ${STATUS_STYLE[status.tone]}`}
            aria-live="polite"
          >
            {status.spin ? <Loader2 className="size-3 animate-spin" /> : (
              <span className={`size-1.5 rounded-full ${
                status.tone === "ok" ? "bg-ok" : status.tone === "warn" ? "bg-warn" : status.tone === "bad" ? "bg-bad" : "bg-muted-foreground/60"
              }`} />
            )}
            {status.text}
          </span>
          <Switch.Root
            checked={p.enabled}
            onCheckedChange={toggle}
            disabled={busy}
            aria-label={t("روشن کردن {name}", { name: accountLabel(p) })}
            className="h-5 w-9 rounded-full bg-muted p-0.5 transition-colors data-[state=checked]:bg-primary"
          >
            <Switch.Thumb className="block size-4 rounded-full bg-background shadow transition-transform data-[state=checked]:-translate-x-4" />
          </Switch.Root>
        </div>
      </div>

      {/* Account identity + Claude quota panel */}
      {(p.signedInAs || isPlainClaude) ? (
        <div className="mx-4 mb-3 space-y-2.5 rounded-xl border border-border/60 bg-muted/25 p-3">
          {p.signedInAs ? (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs">
              {p.signedInAs.email ? (
                <div className="flex min-w-0 items-center gap-1.5">
                  <Mail className="size-3.5 shrink-0 text-muted-foreground" />
                  <bdi dir="ltr" className="truncate font-mono text-foreground">{p.signedInAs.email}</bdi>
                  {p.signedInAs.cached ? (
                    <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{t("ذخیره‌شده")}</span>
                  ) : null}
                </div>
              ) : null}

              {p.signedInAs.name && !(p.signedInAs.email && p.signedInAs.name.toLowerCase().includes(p.signedInAs.email.toLowerCase())) ? (
                <div className="flex items-center gap-1.5 text-muted-foreground">
                  <User className="size-3.5 shrink-0" />
                  <bdi dir="auto" className="text-foreground/90">{p.signedInAs.name}</bdi>
                </div>
              ) : null}

              {p.signedInAs.org && !/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(String(p.signedInAs.org).trim()) ? (
                <div className="flex items-center gap-1.5 text-muted-foreground">
                  <Building2 className="size-3.5 shrink-0" />
                  <bdi dir="auto" className="text-foreground/90">{p.signedInAs.org}</bdi>
                </div>
              ) : null}

              <div className="flex flex-wrap items-center gap-1.5">
                {planChip ? (
                  <span className="rounded-md bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary" dir="auto">
                    {planChip}
                  </span>
                ) : null}
                {authChip ? (
                  <span className="rounded-md border bg-background px-2 py-0.5 text-[11px] text-muted-foreground">
                    {authChip}
                  </span>
                ) : null}
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <KeyRound className="size-3.5 shrink-0" />
              <span>
                {p.hasKey
                  ? t("متصل است، اما اطلاعات ایمیل و پلن این حساب هنوز از Claude خوانده نشده است.")
                  : t("هنوز وارد حساب Claude نشده‌اید؛ دکمهٔ «ورود به حساب» را بزنید.")}
              </span>
            </div>
          )}

          {/* Claude 5h & 7d quota bars */}
          {isPlainClaude && p.enabled && p.hasKey ? (
            <div className="border-t border-border/50 pt-2.5">
              {usage?.rows?.length ? (
                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
                      <Gauge className="size-3.5" />
                      {t("مصرف سهمیهٔ اشتراک")}
                      {usage.updatedAt ? (
                        <span className="text-[10px] opacity-75">
                          ({t("آخرین بررسی {time}", { time: formatTehranTime(usage.updatedAt) })})
                        </span>
                      ) : null}
                    </span>
                    <button
                      type="button"
                      onClick={refreshUsage}
                      disabled={loadingUsage}
                      className="press inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
                    >
                      <RefreshCw className={`size-3 ${loadingUsage ? "animate-spin" : ""}`} />
                      {t("به‌روزرسانی")}
                    </button>
                  </div>
                  <div className="grid gap-2.5 sm:grid-cols-2">
                    {usage.rows.slice(0, 4).map((row) => <UsageBar key={row.id || row.label} row={row} />)}
                  </div>
                </div>
              ) : (
                <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                  <span className="inline-flex items-center gap-1.5">
                    <Gauge className="size-3.5" />
                    {t("سهمیهٔ ۵ ساعته و هفتگی هنوز خوانده نشده است.")}
                  </span>
                  <button
                    type="button"
                    onClick={refreshUsage}
                    disabled={loadingUsage}
                    className="press inline-flex items-center gap-1.5 rounded-lg border bg-background px-2.5 py-1 text-[11px] font-medium text-foreground hover:bg-muted disabled:opacity-50"
                  >
                    {loadingUsage ? <Loader2 className="size-3 animate-spin" /> : <RefreshCw className="size-3" />}
                    {t("خواندن سهمیه")}
                  </button>
                </div>
              )}
            </div>
          ) : null}
        </div>
      ) : null}

      {/* Smooth status / error banner — only AFTER live check finishes */}
      <AnimatePresence initial={false}>
        {showErrorBanner ? (
          <motion.div
            key="status-banner"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.18 }}
            className="overflow-hidden px-4 pb-3"
          >
            {probe && !probe.ok ? (
              <ProbeResult result={probe} />
            ) : p.state === "limited" ? (
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-warn/30 bg-warn/10 px-3 py-2 text-xs text-warn">
                <div className="flex items-center gap-2">
                  <AlertCircle className="size-4 shrink-0" />
                  <span>
                    {p.limitedUntil
                      ? t("این حساب موقتاً به سقف مصرف رسیده (تا {time}).", { time: formatTehranTime(p.limitedUntil) })
                      : t("این حساب موقتاً به سقف مصرف رسیده است.")}
                  </span>
                </div>
                <button type="button" onClick={clearLimit} disabled={busy} className="press inline-flex items-center gap-1 rounded-lg border border-warn/40 bg-background px-2.5 py-1 text-[11px] font-medium text-foreground hover:bg-muted">
                  <RotateCcw className="size-3" /> {t("رفع محدودیت و امتحان دوباره")}
                </button>
              </div>
            ) : (
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-bad/25 bg-bad/8 px-3 py-2 text-xs text-bad">
                <div className="flex min-w-0 items-center gap-2">
                  <AlertCircle className="size-4 shrink-0" />
                  <span className="truncate">
                    {p.state === "auth"
                      ? t("نشست یا کلید این موتور معتبر نیست؛ دوباره وارد شوید.")
                      : p.state === "credit"
                        ? t("اعتبار این حساب تمام شده است.")
                        : t("موتور پاسخ نداد: {err}", { err: p.health?.error || "error" })}
                  </span>
                </div>
                <button type="button" onClick={onEdit} className="press shrink-0 rounded-lg border border-bad/30 bg-background px-2.5 py-1 text-[11px] font-medium text-foreground hover:bg-muted">
                  {p.kind === "claude" || p.plan ? t("ورود دوباره") : t("بررسی کلید")}
                </button>
              </div>
            )}
          </motion.div>
        ) : null}
      </AnimatePresence>

      {/* Account health (owner 2026-11-25): the shapes that preceded the bans we saw — a repeated
          login, an exit that moved, a plan always at its ceiling, a «region» answer. Read-only
          bookkeeping, shown so a person can act before the account does; never a verdict. */}
      {p.risk && p.risk.notes?.length ? (
        <div className="mx-4 mb-3 rounded-xl border border-warn/25 bg-warn/8 px-3 py-2 text-[11px] leading-relaxed text-warn">
          <div className="mb-1 flex items-center gap-1.5 font-medium">
            <ShieldAlert className="size-3.5 shrink-0" />
            {t("سلامت این اکانت (پنجرهٔ {days} روز)", { days: p.risk.windowDays })}
          </div>
          <ul className="list-disc space-y-0.5 ps-4">
            {p.risk.notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* Footer actions */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/60 px-4 py-2.5">
        <div className="flex flex-wrap items-center gap-2">
          {!p.isDefault && p.enabled && p.hasKey ? (
            <button type="button" onClick={() => makeDefault(p.id, reload)} disabled={busy} className={actionBtn}>
              <Star className="size-3.5" /> {t("پیش‌فرض کن")}
            </button>
          ) : null}

          {p.enabled && p.hasKey ? (
            <button type="button" onClick={testNow} disabled={checking || busy} className={actionBtn}>
              {checking ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
              {t("آزمایش اتصال")}
            </button>
          ) : null}

          <button type="button" onClick={onEdit} className={`${actionBtn} ${editing ? "border-primary/40 bg-primary/8 text-primary" : ""}`}>
            {!p.hasKey ? <KeyRound className="size-3.5" /> : <SlidersHorizontal className="size-3.5" />}
            {!p.hasKey ? (p.kind === "claude" || p.plan ? t("ورود به حساب") : t("تنظیم کلید")) : t("تنظیمات و ورود")}
            <ChevronDown className={`size-3.5 transition-transform ${editing ? "rotate-180" : ""}`} />
          </button>

          {(p.state === "limited" || p.state === "credit" || p.state === "auth") ? (
            <button type="button" onClick={clearLimit} disabled={busy} className={actionBtn}>
              <RotateCcw className="size-3.5" /> {t("پاک کردن خطا")}
            </button>
          ) : null}
        </div>

        {p.removable ? (
          <button
            type="button"
            onClick={remove}
            disabled={busy}
            className="press inline-flex items-center gap-1 rounded-lg px-2 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-bad/10 hover:text-bad disabled:opacity-50"
            title={t("حذف این موتور")}
          >
            <Trash2 className="size-3.5" /> {t("حذف")}
          </button>
        ) : null}
      </div>

      {/* Expandable editor drawer */}
      <AnimatePresence initial={false}>
        {editing ? (
          <motion.div
            key="editor"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.18 }}
            className="overflow-hidden border-t border-border/60 bg-muted/20"
          >
            <div className="p-4">
              <ProviderEditor
                provider={p}
                presets={presets}
                claudeEndpoints={claudeEndpoints}
                onDone={async () => {
                  onClose();
                  await reload();
                }}
                onCancel={onClose}
              />
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

function ProviderEditor({ provider, presets, claudeEndpoints, onDone, onCancel }) {
  const isPlan = Boolean(provider.plan);
  const [label, setLabel] = useState(provider.label || "");
  const [auto, setAuto] = useState(provider.auto !== false);
  const [endpoint, setEndpoint] = useState(provider.endpoint || "");
  const [baseUrl, setBaseUrl] = useState(provider.baseUrl || "");
  const [model, setModel] = useState(provider.defaultModel || "");
  // This account's own exit and clock (claude-safety plan, 2026-11-25): one fixed IP per account is
  // what keeps a subscription looking like one person. Empty = share the install's path, as before.
  const [proxyUrl, setProxyUrl] = useState(provider.proxyUrl || "");
  const [timezone, setTimezone] = useState(provider.timezone || "");
  const [effort, setEffort] = useState(provider.reasoningEffort || "");
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [probe, setProbe] = useState(null);

  const presetOfUrl = presets.find((p) => p.baseUrl === baseUrl)?.id || "";
  const isCustomClaude = provider.kind === "claude" && Boolean(endpoint);
  const needsTest = Boolean(apiKey.trim()) || baseUrl.trim() !== (provider.baseUrl || "") || endpoint !== (provider.endpoint || "");

  const save = async () => {
    setSaving(true);
    setProbe(null);
    try {
      const body = {
        label: label.trim(),
        auto,
        model: model.trim(),
        ...(provider.kind === "claude" ? { endpoint, proxyUrl: proxyUrl.trim(), timezone: timezone.trim() } : {}),
        ...(provider.kind === "openai" && !isPlan ? { baseUrl: baseUrl.trim() } : {}),
        ...(provider.kind === "openai" ? { reasoningEffort: effort } : {}),
        ...(apiKey.trim() && !isPlan ? { apiKey: apiKey.trim() } : {}),
      };
      await api(`/api/providers/${provider.id}`, { method: "PATCH", body });
      if (needsTest) {
        const r = await api(`/api/doctor/engine/${provider.id}`).catch((e) => ({ ok: false, detail: e.message }));
        setProbe(r);
        if (!r.ok) {
          toast.error(t("تنظیمات ذخیره شد ولی تست اتصال خطا داد"));
          setSaving(false);
          return;
        }
      }
      toast.success(t("تنظیمات موتور ذخیره شد"));
      await onDone();
    } catch (e) {
      toast.error(e.message);
    }
    setSaving(false);
  };

  const field = "w-full rounded-xl border bg-background px-3 py-2 text-sm";
  const labelText = "mb-1 block text-xs font-medium text-muted-foreground";

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className={labelText}>{t("نام نمایشی")}</span>
          <input className={field} value={label} onChange={(e) => setLabel(e.target.value)} placeholder={provider.name || provider.id} />
        </label>

        <label className="block">
          <span className={labelText}>{t("مدل پیش‌فرض")}</span>
          {provider.models?.length ? (
            <select className={field} dir="ltr" value={model} onChange={(e) => setModel(e.target.value)}>
              <option value="">{t("خودکار (پیشنهادی)")}</option>
              {provider.models.map((m) => <option key={m.id} value={m.id}>{m.name || m.id}</option>)}
            </select>
          ) : (
            <input className={field} dir="ltr" value={model} onChange={(e) => setModel(e.target.value)} placeholder={BASE_MODEL_HINT[provider.kind] || ""} />
          )}
        </label>

        {provider.kind === "claude" && claudeEndpoints.length && provider.id !== "claude" ? (
          <label className="block sm:col-span-2">
            <span className={labelText}>{t("سرویس‌دهنده")}</span>
            <select className={field} value={endpoint} onChange={(e) => setEndpoint(e.target.value)}>
              <option value="">{t("حساب رسمی Claude")}</option>
              {claudeEndpoints.map((ep) => <option key={ep.id} value={ep.id}>{ep.label}</option>)}
            </select>
          </label>
        ) : null}

        {provider.kind === "claude" ? (
          <>
            <label className="block">
              <span className={labelText}>{t("آی‌پی ثابت همین اکانت (پروکسی)")}</span>
              <input
                className={field}
                dir="ltr"
                value={proxyUrl}
                onChange={(e) => setProxyUrl(e.target.value)}
                placeholder="socks5://127.0.0.1:1080"
              />
              <span className="mt-1 block text-[11px] text-muted-foreground">
                {t("خالی = مسیر مشترک نصب. پر شود، همهٔ درخواست‌های همین اکانت فقط از این خروجی می‌روند و اگر پروکسی قطع شود ارسال متوقف می‌شود، نه اینکه از آی‌پی سرور بیرون بزند.")}
              </span>
            </label>
            <label className="block">
              <span className={labelText}>{t("منطقهٔ زمانی هم‌راستا با همان آی‌پی")}</span>
              <input
                className={field}
                dir="ltr"
                value={timezone}
                onChange={(e) => setTimezone(e.target.value)}
                placeholder="America/Toronto"
              />
              <span className="mt-1 block text-[11px] text-muted-foreground">
                {t("ساعت محیط اجرا با لوکیشن همان خروجی یکی می‌شود؛ خالی = ساعت پیش‌فرض سرور.")}
              </span>
            </label>
          </>
        ) : null}

        {provider.kind === "openai" && !isPlan ? (
          <>
            <label className="block">
              <span className={labelText}>{t("سرویس آماده")}</span>
              <select
                className={field}
                value={presetOfUrl}
                onChange={(e) => {
                  const found = presets.find((pr) => pr.id === e.target.value);
                  setBaseUrl(found ? found.baseUrl : "");
                }}
              >
                <option value="">{t("آدرس دلخواه")}</option>
                {presets.map((pr) => <option key={pr.id} value={pr.id}>{pr.label}</option>)}
              </select>
            </label>
            <label className="block">
              <span className={labelText}>{t("آدرس API (Base URL)")}</span>
              <input className={field} dir="ltr" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.openai.com/v1" />
            </label>
          </>
        ) : null}

        {provider.kind === "openai" ? (
          <label className="block">
            <span className={labelText}>{t("عمق استدلال (Reasoning effort)")}</span>
            <select className={field} value={effort} onChange={(e) => setEffort(e.target.value)}>
              <option value="">{t("پیش‌فرض مدل")}</option>
              <option value="low">{t("سبک (low)")}</option>
              <option value="medium">{t("متوسط (medium)")}</option>
              <option value="high">{t("عمیق (high)")}</option>
            </select>
          </label>
        ) : null}

        {!isPlan ? (
          <label className="block sm:col-span-2">
            <span className={labelText}>{provider.kind === "claude" && !isCustomClaude ? t("کلید API یا توکن اشتراک (اختیاری اگر با دکمهٔ پایین وارد می‌شوید)") : t("کلید API")}</span>
            <input className={field} dir="ltr" type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={provider.hasKey ? t("خالی بگذارید تا کلید فعلی بماند") : t("کلید را اینجا بچسبانید")} autoComplete="off" />
          </label>
        ) : null}
      </div>

      <label className="flex items-center justify-between gap-3 rounded-xl border bg-background px-3 py-2.5 text-xs">
        <span className="text-muted-foreground">{t("شرکت در جابه‌جایی خودکار وقتی موتور اصلی به محدودیت می‌خورد")}</span>
        <Switch.Root
          checked={auto}
          onCheckedChange={setAuto}
          className="h-5 w-9 shrink-0 rounded-full bg-muted p-0.5 transition-colors data-[state=checked]:bg-primary"
        >
          <Switch.Thumb className="block size-4 rounded-full bg-background shadow transition-transform data-[state=checked]:-translate-x-4" />
        </Switch.Root>
      </label>

      {provider.kind === "claude" && !isCustomClaude ? <ClaudeSignin id={provider.id} onDone={onDone} /> : null}
      {isPlan ? <PlanSignin id={provider.id} plan={provider.plan} signedIn={provider.hasKey} onDone={onDone} /> : null}
      {provider.hasKey && provider.keyIn === "legacy" ? (
        <p className="text-xs text-muted-foreground">{t("کلید فعلی از فایل قدیمی سرور خوانده می‌شود؛ با ثبت کلید تازه به خزانهٔ امن منتقل می‌شود.")}</p>
      ) : null}
      {probe ? <ProbeResult result={probe} /> : null}

      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={save} disabled={saving} className="press inline-flex items-center gap-1.5 rounded-xl bg-primary px-4 py-2 text-xs font-medium text-primary-foreground disabled:opacity-60">
          {saving ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />} {needsTest ? t("ذخیره و آزمایش") : t("ذخیره تغییرات")}
        </button>
        <button type="button" onClick={onCancel} className="press rounded-xl border bg-background px-3.5 py-2 text-xs">{t("بستن")}</button>
      </div>
    </div>
  );
}

// Sign in with a Claude subscription without leaving the page: three numbered steps.
function SigninStep({ n, title, active = true, done = false, children = null }) {
  return (
    <li className={`flex gap-3 transition-opacity duration-200 ${active ? "" : "opacity-45"}`}>
      <span className={`mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-medium tabular-nums ${done ? "bg-ok/15 text-ok" : "bg-primary/10 text-primary"}`}>
        {done ? <Check className="size-3.5" /> : n.toLocaleString(locale)}
      </span>
      <div className="min-w-0 flex-1 space-y-2">
        <p className="text-sm font-medium leading-7">{title}</p>
        {children}
      </div>
    </li>
  );
}

export function ClaudeSignin({ id, onDone }) {
  const [target, setTarget] = useState(null);
  const [url, setUrl] = useState(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const start = async () => {
    setBusy(true);
    setProblem("");
    try {
      const account = typeof id === "function" ? await id() : id;
      const r = await api(`/api/providers/${account}/signin`, { method: "POST" });
      setTarget(account);
      setUrl(r.url);
      setCode("");
    } catch (e) {
      setProblem(e.message);
    }
    setBusy(false);
  };
  const submit = async () => {
    setBusy(true);
    setProblem("");
    try {
      await api(`/api/providers/${target}/signin/code`, { method: "POST", body: { code: code.trim() } });
      toast.success(t("حساب Claude وصل شد"));
      onDone(target);
    } catch (e) {
      if (e.body?.restarted && e.body.url) {
        setUrl(e.body.url);
        setCode("");
        setProblem(t("ورود قبلی تمام شده بود؛ لینک تازه ساخته شد. «باز کردن لینک» یا «کپی لینک» را بزنید و کد تازه را بگذارید."));
      } else {
        setProblem(t("کد پذیرفته نشد؛ «شروع دوباره» را بزنید و کد تازه بگیرید. پاسخ Claude: {message}", { message: e.message }));
      }
    }
    setBusy(false);
  };
  const copyLink = () => navigator.clipboard?.writeText(url).then(() => toast.success(t("لینک کپی شد")), () => toast.error(t("کپی نشد؛ لینک را با دست انتخاب کنید")));
  const field = "w-full rounded-xl border bg-background px-3 py-2 text-sm";
  const small = "press inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs hover:bg-muted";
  return (
    <div className="space-y-3 rounded-xl border bg-background p-4">
      <ol className="space-y-4">
        <SigninStep n={1} title={t("صفحهٔ ورود Claude را باز کنید")} done={Boolean(url)}>
          {url ? (
            <div className="flex flex-wrap items-center gap-2">
              <a href={url} target="_blank" rel="noreferrer" className={small}><ExternalLink className="size-3.5" /> {t("باز کردن لینک")}</a>
              <button type="button" onClick={copyLink} className={small}><Copy className="size-3.5" /> {t("کپی لینک")}</button>
              <button type="button" onClick={() => { setUrl(null); setCode(""); setProblem(""); }} className={`${small} text-muted-foreground`}>{t("شروع دوباره")}</button>
            </div>
          ) : (
            <button type="button" onClick={start} disabled={busy} className="press inline-flex items-center gap-1.5 rounded-xl bg-primary px-4 py-2 text-xs font-medium text-primary-foreground disabled:opacity-60">
              {busy ? <Loader2 className="size-4 animate-spin" /> : <KeyRound className="size-4" />} {t("ورود با اکانت Claude")}
            </button>
          )}
        </SigninStep>
        <SigninStep n={2} title={t("در آن صفحه وارد حساب Claude شوید و دکمهٔ تأیید (Authorize) را بزنید")} active={Boolean(url)}>
          <p className="text-xs leading-6 text-muted-foreground">{t("در پایان صفحه یک کد بلند نشان می‌دهد. همهٔ آن را کپی کنید.")}</p>
        </SigninStep>
        <SigninStep n={3} title={t("کد را این‌جا بگذارید")} active={Boolean(url)}>
          <div className="flex gap-2">
            <input className={field} dir="ltr" value={code} onChange={(e) => setCode(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && code.trim() && !busy) submit(); }} disabled={!url} placeholder={t("کد را این‌جا بچسبانید")} autoComplete="off" aria-label={t("کد ورود")} />
            <button type="button" onClick={submit} disabled={!url || busy || !code.trim()} className="press shrink-0 rounded-xl bg-primary px-4 py-2 text-xs font-medium text-primary-foreground disabled:opacity-60">{busy && url ? <Loader2 className="size-4 animate-spin" /> : t("وصل کن")}</button>
          </div>
        </SigninStep>
      </ol>
      {problem ? <p className="rounded-lg bg-bad/10 px-3 py-2 text-xs leading-6 text-bad" role="alert">{problem}</p> : null}
      <p className="border-t pt-3 text-xs leading-6 text-muted-foreground">
        {t("اشتراک مال شخص دیگری است؟ «کپی لینک» را برای خودش بفرستید؛ او لینک را باز می‌کند، وارد می‌شود و کدِ آخر را برایتان می‌فرستد. این لینک و کد فقط چند دقیقه کار می‌کنند و فقط باید به صاحب اشتراک برسند.")}
      </p>
    </div>
  );
}

const PLAN_COPY = {
  codex: {
    button: t("ورود با حساب ChatGPT"),
    open: t("صفحهٔ ورود OpenAI را باز کنید"),
    enter: t("وارد حساب ChatGPT شوید و این کد را بزنید"),
    hint: t("اگر OpenAI گفت ورود با کد دستگاه بسته است: در ChatGPT به Settings ← Security بروید و «Device code authorization for Codex» را روشن کنید، بعد دوباره امتحان کنید."),
  },
  antigravity: {
    button: t("ورود با حساب Google"),
    open: t("صفحهٔ ورود Google را باز کنید"),
    enter: t("وارد حسابی شوید که اشتراک Antigravity (Google AI Pro/Ultra) دارد و «Allow» را بزنید"),
    hint: t("گوگل استفاده از اشتراک Antigravity بیرون از خود برنامه را مجاز نمی‌داند و چند حساب را به همین دلیل محدود کرده است. اگر می‌شود، با حسابی وارد شوید که از دست دادنش سخت نیست."),
  },
};

export function PlanSignin({ id, plan, signedIn = false, onDone }) {
  const copy = PLAN_COPY[plan] || PLAN_COPY.codex;
  const [target, setTarget] = useState(null);
  const [flow, setFlow] = useState(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const name = PLAN_LABEL[plan] || plan;

  useEffect(() => {
    if (plan !== "codex" || !target || flow?.status !== "pending") return undefined;
    let live = true;
    const timer = setInterval(async () => {
      const r = await api(`/api/providers/${target}/plan-signin`).catch(() => null);
      if (!live || !r) return;
      if (r.status === "ready") {
        setFlow(r);
        toast.success(t("حساب {name} وصل شد", { name }));
        onDone(target);
      } else if (r.status === "failed") {
        setFlow(null);
        setProblem(r.error || t("ورود انجام نشد؛ دوباره شروع کنید."));
      }
    }, 3_000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [plan, target, flow?.status]);

  const start = async () => {
    setBusy(true);
    setProblem("");
    try {
      const account = typeof id === "function" ? await id() : id;
      const r = await api(`/api/providers/${account}/plan-signin`, { method: "POST" });
      setTarget(account);
      setFlow(r);
      setCode("");
    } catch (e) {
      setProblem(e.message);
    }
    setBusy(false);
  };
  const submit = async () => {
    setBusy(true);
    setProblem("");
    try {
      const r = await api(`/api/providers/${target}/plan-signin/code`, { method: "POST", body: { code: code.trim() } });
      setFlow(r);
      toast.success(t("حساب {name} وصل شد", { name }));
      onDone(target);
    } catch (e) {
      setProblem(e.message);
    }
    setBusy(false);
  };
  const restart = () => {
    if (target) api(`/api/providers/${target}/plan-signin`, { method: "DELETE" }).catch(() => {});
    setFlow(null);
    setCode("");
    setProblem("");
  };
  const copyText = (text, done) => navigator.clipboard?.writeText(text).then(() => toast.success(done), () => toast.error(t("کپی نشد؛ با دست انتخاب کنید")));
  const started = Boolean(flow && flow.status !== "idle");
  const link = flow?.verificationUrl || flow?.url || null;
  const field = "w-full rounded-xl border bg-background px-3 py-2 text-sm";
  const small = "press inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs hover:bg-muted";
  return (
    <div className="space-y-3 rounded-xl border bg-background p-4">
      {signedIn && !started ? <p className="text-xs leading-6 text-muted-foreground">{t("این حساب وصل است. برای ورود با حساب دیگر دوباره وارد شوید.")}</p> : null}
      <ol className="space-y-4">
        <SigninStep n={1} title={copy.open} done={started}>
          {started && link ? (
            <div className="flex flex-wrap items-center gap-2">
              <a href={link} target="_blank" rel="noreferrer" className={small}><ExternalLink className="size-3.5" /> {t("باز کردن لینک")}</a>
              <button type="button" onClick={() => copyText(link, t("لینک کپی شد"))} className={small}><Copy className="size-3.5" /> {t("کپی لینک")}</button>
              <button type="button" onClick={restart} className={`${small} text-muted-foreground`}>{t("شروع دوباره")}</button>
            </div>
          ) : (
            <button type="button" onClick={start} disabled={busy} className="press inline-flex items-center gap-1.5 rounded-xl bg-primary px-4 py-2 text-xs font-medium text-primary-foreground disabled:opacity-60">
              {busy ? <Loader2 className="size-4 animate-spin" /> : <EngineLogo id={plan} className="size-4" bare />} {copy.button}
            </button>
          )}
        </SigninStep>
        <SigninStep n={2} title={copy.enter} active={started}>
          {plan === "codex" && flow?.userCode ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className="ltr rounded-lg border bg-muted/40 px-3 py-1.5 font-mono text-base font-semibold tracking-widest">{flow.userCode}</span>
              <button type="button" onClick={() => copyText(flow.userCode, t("کد کپی شد"))} className={small}><Copy className="size-3.5" /> {t("کپی کد")}</button>
            </div>
          ) : plan === "antigravity" ? (
            <p className="text-xs leading-6 text-muted-foreground">{t("در پایان، مرورگر صفحه‌ای با خطای «باز نمی‌شود» (localhost) نشان می‌دهد. این عادی است.")}</p>
          ) : null}
        </SigninStep>
        {plan === "codex" ? (
          <SigninStep n={3} title={t("منتظر تأیید OpenAI")} active={started}>
            {flow?.status === "pending" ? <p className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="size-3.5 animate-spin" /> {t("بعد از زدن کد، خودش وصل می‌شود؛ این کد ۱۵ دقیقه اعتبار دارد.")}</p> : null}
          </SigninStep>
        ) : (
          <SigninStep n={3} title={t("آدرس همان صفحهٔ خطا را از نوار آدرس کپی کنید و این‌جا بگذارید")} active={started}>
            <div className="flex gap-2">
              <input className={field} dir="ltr" value={code} onChange={(e) => setCode(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && code.trim() && !busy) submit(); }} disabled={!started} placeholder="http://localhost:51121/oauth-callback?…" autoComplete="off" aria-label={t("آدرس صفحهٔ آخر")} />
              <button type="button" onClick={submit} disabled={!started || busy || !code.trim()} className="press shrink-0 rounded-xl bg-primary px-4 py-2 text-xs font-medium text-primary-foreground disabled:opacity-60">{busy && started ? <Loader2 className="size-4 animate-spin" /> : t("وصل کن")}</button>
            </div>
          </SigninStep>
        )}
      </ol>
      {problem ? <p className="rounded-lg bg-bad/10 px-3 py-2 text-xs leading-6 text-bad" role="alert">{problem}</p> : null}
      <p className="border-t pt-3 text-xs leading-6 text-muted-foreground">{copy.hint}</p>
    </div>
  );
}
