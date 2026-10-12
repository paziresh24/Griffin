import { useEffect, useState } from "react";
import { Switch } from "radix-ui";
import { Check, ChevronDown, KeyRound, Loader2, Plus, Settings2, Stethoscope, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { api } from "../api.js";
import { Pill } from "./Health.jsx";
import { t, num, locale } from "../i18n.js";
import { BRAND } from "../brand.js";
import { ProbeResult } from "./Setup.jsx";

export const KIND_LABEL = { cursor: "Cursor", claude: "Claude", openai: "OpenAI-compatible" };
export const accountLabel = (p) => p.label || (p.id === p.kind ? KIND_LABEL[p.kind] || p.id : `${KIND_LABEL[p.kind] || p.kind} · ${p.id.slice(p.kind.length + 1)}`);

const KIND_BADGE = {
  claude: { letter: "C", tone: "bg-[#d97757]/15 text-[#c4623f]" },
  openai: { letter: "AI", tone: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400" },
  cursor: { letter: "▲", tone: "bg-foreground/10 text-foreground" },
};

// One plain sentence for where an account stands, and the pill tone that goes with it.
function status(p) {
  if (!p.enabled) return { tone: "off", pill: t("خاموش"), line: t("خاموش است؛ هیچ کاری به آن نمی‌رود.") };
  if (!p.hasKey) return { tone: "bad", pill: t("وصل نیست"), line: p.kind === "claude" ? t("هنوز وارد اکانت Claude نشده‌ای یا کلیدی نگذاشته‌ای.") : t("کلید ندارد؛ «تنظیمات» را بزن و کلید را بگذار.") };
  if (p.limitedUntil) return { tone: "warn", pill: t("سقف پر"), line: t("به سقف مصرف خورده؛ تا {time} کار به موتور بعدی می‌رود.", { time: new Date(p.limitedUntil).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" }) }) };
  if (p.health?.ok) return { tone: "ok", pill: t("آماده"), line: t("وصل است و جواب می‌دهد.") };
  return { tone: "bad", pill: t("جواب نمی‌دهد"), line: t("وصل نمی‌شود؛ «تست» بزن تا علتش را بگوید.") };
}

// Settings → Engines: the accounts agents think with (a second Claude subscription, an OpenRouter
// key next to another OpenAI-compatible one …). Adding one is the engine wizard (#/setup/engine); each card here shows where
// the account stands in one line and opens its settings, a live test, or removal.
export function ProvidersSection() {
  const [data, setData] = useState(null);
  const [showOff, setShowOff] = useState(false);
  const load = () => api("/api/providers").then(setData).catch((e) => toast.error(e.message));
  useEffect(() => { load(); }, []);

  if (!data) return <div className="flex justify-center py-10 text-muted-foreground"><Loader2 className="size-5 animate-spin" /></div>;
  const on = data.providers.filter((p) => p.enabled);
  const off = data.providers.filter((p) => !p.enabled);

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 rounded-2xl border bg-card p-4 sm:flex-row sm:items-center">
        <p className="min-w-0 flex-1 text-sm leading-7 text-muted-foreground">
          {t("موتورها حساب‌هایی‌اند که ایجنت‌ها با آن‌ها فکر می‌کنند. اگر یکی به سقف بخورد یا جواب ندهد، کار خودکار به بعدی می‌رود؛ ترتیبش را در صفحهٔ «ایجنت‌ها» بچین.")}
        </p>
        <button type="button" onClick={() => { window.location.hash = "/setup/engine"; }} className="press inline-flex shrink-0 items-center justify-center gap-1.5 self-start rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground sm:self-auto">
          <Plus className="size-4" /> {t("افزودن موتور")}
        </button>
      </div>
      {on.length ? on.map((p) => <EngineCard key={p.id} p={p} presets={data.presets} reload={load} />) : (
        <p className="rounded-2xl border border-dashed p-6 text-center text-sm text-muted-foreground">{t("هیچ موتور روشنی نیست؛ ایجنت‌ها نمی‌توانند جواب بدهند. «افزودن موتور» را بزن.")}</p>
      )}
      {off.length ? (
        <div>
          <button type="button" onClick={() => setShowOff(!showOff)} className="press inline-flex items-center gap-1 px-1 text-xs text-muted-foreground">
            <ChevronDown className={`size-3.5 transition-transform ${showOff ? "" : "-rotate-90 rtl:rotate-90"}`} /> {t("خاموش‌ها ({n})", { n: num(off.length) })}
          </button>
          {showOff ? <div className="mt-2 space-y-3">{off.map((p) => <EngineCard key={p.id} p={p} presets={data.presets} reload={load} />)}</div> : null}
        </div>
      ) : null}
    </div>
  );
}

function EngineCard({ p, presets, reload }) {
  const [open, setOpen] = useState(false);
  const [probe, setProbe] = useState(null);
  const [testing, setTesting] = useState(false);
  const s = status(p);
  const badge = KIND_BADGE[p.kind] || KIND_BADGE.openai;
  const act = (fn) => async () => {
    try {
      await fn();
      reload();
    } catch (e) {
      toast.error(e.message);
    }
  };
  const test = async () => {
    setTesting(true);
    setProbe(null);
    setProbe(await api(`/api/doctor/engine/${p.id}`).catch((e) => ({ ok: false, cause: "other", detail: e.message })));
    setTesting(false);
  };
  const remove = act(async () => {
    if (!window.confirm(t("موتور «{name}» و کلیدش حذف شود؟", { name: accountLabel(p) }))) return;
    await api(`/api/providers/${p.id}`, { method: "DELETE" });
  });
  const button = "press inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs hover:bg-muted";

  return (
    <section className={`rounded-2xl border bg-card ${p.enabled ? "" : "opacity-75"}`}>
      <div className="flex items-start gap-3 p-4">
        <span className={`flex size-10 shrink-0 items-center justify-center rounded-xl text-sm font-bold ${badge.tone}`} aria-hidden>{badge.letter}</span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="truncate text-sm font-semibold" dir="auto">{accountLabel(p)}</h3>
            <Pill state={s.tone} title={p.health?.ok ? `${t("سالم")}${p.health.ms ? ` · ${p.health.ms}ms` : ""}` : p.health?.error || ""}>{s.pill}</Pill>
          </div>
          <p className="mt-1 text-xs leading-6 text-muted-foreground">{s.line}</p>
          <p className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span>{t("مدل:")} <span className="ltr font-mono text-foreground">{p.defaultModel || t("پیش‌فرض")}</span></span>
            <span>{p.agents.length ? t("{n} ایجنت: {list}", { n: num(p.agents.length), list: p.agents.map((a) => t(a.label) + (a.model ? ` · ${a.model}` : "")).join(t("، ")) }) : t("هیچ ایجنتی رویش نیست")}</span>
          </p>
        </div>
        <Switch.Root checked={p.enabled} onCheckedChange={(v) => act(() => api(`/api/providers/${p.id}`, { method: "PATCH", body: { enabled: v } }))()} className="relative mt-1 h-5 w-9 shrink-0 rounded-full bg-muted data-[state=checked]:bg-primary" aria-label={t("روشن/خاموش")}>
          <Switch.Thumb className="block size-4 translate-x-0.5 rounded-full bg-white transition-transform data-[state=checked]:translate-x-[18px] rtl:data-[state=checked]:-translate-x-[18px]" />
        </Switch.Root>
      </div>
      {p.limitedUntil ? (
        <div className="mx-4 mb-3 flex items-center gap-2 rounded-lg bg-warn/10 px-3 py-2 text-xs">
          <span className="flex-1">{t("اگر سقف زودتر باز شده، دوباره امتحانش کن.")}</span>
          <button type="button" onClick={act(() => api(`/api/providers/${p.id}`, { method: "PATCH", body: { clearLimit: true } }))} className={button}>{t("دوباره امتحان کن")}</button>
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-2 border-t px-4 py-2.5">
        <button type="button" onClick={() => setOpen(!open)} className={button} aria-expanded={open}><Settings2 className="size-3.5" /> {t("تنظیمات")}</button>
        <button type="button" onClick={test} disabled={testing || !p.enabled} className={`${button} disabled:opacity-50`}>{testing ? <Loader2 className="size-3.5 animate-spin" /> : <Stethoscope className="size-3.5" />} {t("تست")}</button>
        {p.removable ? <button type="button" onClick={remove} className={`${button} ms-auto text-bad hover:bg-bad/10`}><Trash2 className="size-3.5" /> {t("حذف")}</button> : null}
      </div>
      {probe ? <div className="px-4 pb-3"><ProbeResult result={probe} /></div> : null}
      {open ? <EditEngine provider={p} presets={presets} onDone={() => { setOpen(false); reload(); }} onCancel={() => setOpen(false)} /> : null}
    </section>
  );
}

function EditEngine({ provider, presets, onDone, onCancel }) {
  const [label, setLabel] = useState(provider.label || "");
  const [model, setModel] = useState(provider.defaultModel || "");
  const [baseUrl, setBaseUrl] = useState(provider.baseUrl || "");
  const [effort, setEffort] = useState(provider.reasoningEffort || "");
  const [apiKey, setApiKey] = useState("");
  const [preset, setPreset] = useState("");
  const [saving, setSaving] = useState(false);
  const [probe, setProbe] = useState(null);
  const isOpenai = provider.kind === "openai";

  const save = async () => {
    setSaving(true);
    setProbe(null);
    try {
      const body = { model, label };
      if (isOpenai) {
        if (preset) body.preset = preset;
        else body.baseUrl = baseUrl;
        body.reasoningEffort = effort;
      }
      if (apiKey.trim()) body.apiKey = apiKey.trim();
      await api(`/api/providers/${provider.id}`, { method: "PATCH", body });
      const r = await api(`/api/doctor/engine/${provider.id}`);
      setProbe(r);
      setSaving(false);
      if (r.ok) {
        toast.success(t("ذخیره شد و جواب داد"));
        onDone();
      }
    } catch (e) {
      toast.error(e.message);
      setSaving(false);
    }
  };

  const field = "w-full rounded-lg border bg-background px-3 py-2 text-sm";
  const labelText = "mb-1 block text-xs text-muted-foreground";
  return (
    <div className="space-y-3 border-t bg-muted/20 p-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className={labelText}>{t("نام")}</span>
          <input className={field} value={label} onChange={(e) => setLabel(e.target.value)} placeholder={KIND_LABEL[provider.kind]} />
        </label>
        <label className="block">
          <span className={labelText}>{t("مدل پیش‌فرض")}</span>
          <input className={field} dir="ltr" value={model} onChange={(e) => setModel(e.target.value)} list={`m-${provider.id}`} placeholder={provider.defaultModel || "model"} />
          <datalist id={`m-${provider.id}`}>{provider.models.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</datalist>
        </label>
        {isOpenai ? (
          <label className="block">
            <span className={labelText}>{t("سرویس")}</span>
            <select className={field} value={preset} onChange={(e) => { const id = e.target.value; setPreset(id); const pr = presets.find((x) => x.id === id); if (pr) setBaseUrl(pr.baseUrl); }}>
              <option value="">{t("آدرس دلخواه")}</option>
              {presets.map((pr) => <option key={pr.id} value={pr.id}>{t(pr.label)}</option>)}
            </select>
          </label>
        ) : null}
        {isOpenai ? (
          <label className="block">
            <span className={labelText}>{t("آدرس سرویس")}</span>
            <input className={field} dir="ltr" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.example.com/v1" />
          </label>
        ) : null}
        {isOpenai ? (
          <label className="block">
            <span className={labelText}>{t("میزان فکر کردن")}</span>
            <select className={field} value={effort} onChange={(e) => setEffort(e.target.value)}>
              <option value="">{t("پیش‌فرض سرویس")}</option>
              <option value="low">{t("کم (سریع‌تر، ارزان‌تر)")}</option>
              <option value="medium">{t("متوسط")}</option>
              <option value="high">{t("زیاد (کندتر، دقیق‌تر)")}</option>
            </select>
          </label>
        ) : null}
        <label className="block">
          <span className={labelText}>{provider.kind === "claude" ? t("کلید API یا توکن اشتراک") : t("کلید API")}</span>
          <input className={field} dir="ltr" type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={provider.hasKey ? t("خالی بگذار تا همان کلید بماند") : t("کلید را بگذار")} autoComplete="off" />
        </label>
      </div>
      {provider.kind === "claude" ? <ClaudeSignin id={provider.id} onDone={onDone} /> : null}
      {provider.hasKey && provider.keyIn === "legacy" ? <p className="text-xs text-muted-foreground">{t("کلید فعلی از فایل قدیمی سرور خوانده می‌شود؛ با گذاشتن کلید این‌جا به سکرت‌منیجر {name} می‌رود.", { name: BRAND.name })}</p> : null}
      {probe ? <ProbeResult result={probe} /> : null}
      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={save} disabled={saving} className="press inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-60">
          {saving ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />} {t("ذخیره و تست")}
        </button>
        <button type="button" onClick={onCancel} className="press rounded-lg border px-3 py-2 text-sm">{t("بستن")}</button>
      </div>
    </div>
  );
}

// Sign in with a Claude subscription without leaving the page: Griffin runs Claude's own
// `setup-token`, the owner opens the address, signs in and pastes the code shown there. `id` may be
// a function that makes the account first (the engine wizard creates it only when sign-in starts).
export function ClaudeSignin({ id, onDone }) {
  const [target, setTarget] = useState(null);
  const [url, setUrl] = useState(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const start = async () => {
    setBusy(true);
    try {
      const account = typeof id === "function" ? await id() : id;
      const r = await api(`/api/providers/${account}/signin`, { method: "POST" });
      setTarget(account);
      setUrl(r.url);
      window.open(r.url, "_blank", "noopener");
    } catch (e) {
      toast.error(e.message);
    }
    setBusy(false);
  };
  const submit = async () => {
    setBusy(true);
    try {
      await api(`/api/providers/${target}/signin/code`, { method: "POST", body: { code: code.trim() } });
      toast.success(t("حساب Claude وصل شد"));
      onDone(target);
    } catch (e) {
      toast.error(e.message);
      setBusy(false);
    }
  };
  const field = "w-full rounded-lg border bg-background px-3 py-2 text-sm";
  return (
    <div className="space-y-2 rounded-xl border border-dashed p-3">
      {url ? (
        <>
          <p className="text-xs leading-6 text-muted-foreground">{t("صفحهٔ ورود Claude باز شد (اگر نشد {link}). وارد شو و کدی را که نشان می‌دهد این‌جا بگذار.").split("{link}").flatMap((part, i) => (i ? [<a key={i} href={url} target="_blank" rel="noreferrer" className="text-primary underline">{t("این‌جا")}</a>, part] : [part]))}</p>
          <div className="flex gap-2">
            <input className={field} dir="ltr" value={code} onChange={(e) => setCode(e.target.value)} placeholder="code#state" autoComplete="off" />
            <button type="button" onClick={submit} disabled={busy || !code.trim()} className="press shrink-0 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-60">{busy ? <Loader2 className="size-4 animate-spin" /> : t("وصل کن")}</button>
          </div>
        </>
      ) : (
        <button type="button" onClick={start} disabled={busy} className="press inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-sm">
          {busy ? <Loader2 className="size-4 animate-spin" /> : <KeyRound className="size-4" />} {t("ورود با اکانت Claude (بدون کپی توکن)")}
        </button>
      )}
    </div>
  );
}
