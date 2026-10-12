import { useEffect, useState } from "react";
import { Switch } from "radix-ui";
import { Check, Cpu, KeyRound, Loader2, Pencil, Plus, Stethoscope, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { api } from "../api.js";
import { Group, Item } from "./SettingsParts.jsx";
import { Pill } from "./Health.jsx";
import { t, locale } from "../i18n.js";
import { BRAND } from "../brand.js";
import { ProbeResult } from "./Setup.jsx";

export const KIND_LABEL = { cursor: "Cursor", claude: "Claude", openai: "OpenAI-compatible" };
export const accountLabel = (p) => p.label || (p.id === p.kind ? KIND_LABEL[p.kind] || p.id : `${KIND_LABEL[p.kind] || p.kind} · ${p.id.slice(p.kind.length + 1)}`);

// Settings → Engines: every engine account (a second Claude subscription, an OpenRouter key next
// to Z.ai …), each with its own key, default model and an on/off switch. Keys go to the secret store.
export function ProvidersSection() {
  const [data, setData] = useState(null);
  const [editing, setEditing] = useState(null);
  const [adding, setAdding] = useState(false);
  const load = () => api("/api/providers").then(setData).catch((e) => toast.error(e.message));
  useEffect(() => { load(); }, []);

  if (!data) return <div className="flex justify-center py-10 text-muted-foreground"><Loader2 className="size-5 animate-spin" /></div>;

  const toggle = async (p, enabled) => {
    try {
      await api(`/api/providers/${p.id}`, { method: "PATCH", body: { enabled } });
      load();
    } catch (e) {
      toast.error(e.message);
    }
  };
  const remove = async (p) => {
    if (!window.confirm(t("حساب «{name}» و کلیدش حذف شود؟", { name: accountLabel(p) }))) return;
    try {
      await api(`/api/providers/${p.id}`, { method: "DELETE" });
      load();
    } catch (e) {
      toast.error(e.message);
    }
  };

  return (
    <div className="space-y-6">
      <p className="px-1 text-xs leading-6 text-muted-foreground">
        {t("هر ایجنت به ترتیبِ «مدل‌ها به ترتیب اولویت» (صفحهٔ ایجنت‌ها) روی اولین حسابِ روشن و سالم کار می‌کند؛ اگر حسابی به سقف خورد، کار خودکار به حساب بعدی می‌رود.")}
      </p>
      {data.providers.map((p) => (
        <Group
          key={p.id}
          title={accountLabel(p)}
          action={
            <span className="flex items-center gap-2">
              {p.enabled ? <Pill state={p.health?.ok && p.hasKey ? "ok" : "bad"} title={p.health?.ok ? `${t("سالم")}${p.health.ms ? ` · ${p.health.ms}ms` : ""}` : p.health?.error || ""}>{!p.hasKey ? t("بی‌کلید") : p.limitedUntil ? t("سقف پر") : p.health?.ok ? t("سالم") : t("خطا")}</Pill> : <Pill state="off">{t("خاموش")}</Pill>}
              <Switch.Root checked={p.enabled} onCheckedChange={(v) => toggle(p, v)} className="relative h-5 w-9 rounded-full bg-muted data-[state=checked]:bg-primary" aria-label={t("روشن/خاموش")}>
                <Switch.Thumb className="block size-4 translate-x-0.5 rounded-full bg-white transition-transform data-[state=checked]:translate-x-[18px] rtl:data-[state=checked]:-translate-x-[18px]" />
              </Switch.Root>
            </span>
          }
        >
          {editing === p.id ? (
            <EditRow provider={p} presets={data.presets} onDone={() => { setEditing(null); load(); }} onCancel={() => setEditing(null)} />
          ) : (
            <>
              <Item
                icon={Cpu}
                title={t("مدل پیش‌فرض")}
                subtitle={p.defaultModel || "—"}
                trailing={
                  <>
                    <button type="button" onClick={() => setEditing(p.id)} className="press rounded-lg p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground" aria-label={t("ویرایش")}><Pencil className="size-4" /></button>
                    {p.removable ? <button type="button" onClick={() => remove(p)} className="press rounded-lg p-1.5 text-muted-foreground hover:bg-bad/10 hover:text-bad" aria-label={t("حذف")}><Trash2 className="size-4" /></button> : null}
                  </>
                }
              />
              {p.baseUrl != null ? <Item title={t("آدرس سرویس")} subtitle={p.baseUrl || t("پیش‌فرض")} /> : null}
              <Item icon={KeyRound} title={t("کلید")} subtitle={p.hasKey ? (p.keyIn === "secrets" ? t("در سکرت‌منیجر {name}", { name: BRAND.name }) : t("از فایل/متغیر محیطی قدیمی")) : t("تنظیم نشده")} trailing={p.hasKey ? <Check className="size-4 text-ok" /> : <X className="size-4 text-bad" />} />
              {p.limitedUntil ? (
                <Item
                  title={t("سقف مصرف")}
                  subtitle={t("تا {time} کنار گذاشته شده", { time: new Date(p.limitedUntil).toLocaleString(locale) })}
                  trailing={<button type="button" onClick={() => api(`/api/providers/${p.id}`, { method: "PATCH", body: { clearLimit: true } }).then(load)} className="press rounded-lg border px-2 py-1 text-xs">{t("برداشتن")}</button>}
                />
              ) : null}
              <Item title={t("ایجنت‌ها")} subtitle={p.agents.length ? p.agents.map((a) => t(a.label) + (a.model ? ` · ${a.model}` : "")).join(t("، ")) : t("هیچ ایجنتی از این حساب استفاده نمی‌کند")} />
              {p.models.length ? <Item title={t("مدل‌های موجود ({n})", { n: p.models.length })} subtitle={p.models.slice(0, 12).map((m) => m.name).join(t("، ")) + (p.models.length > 12 ? " …" : "")} /> : null}
            </>
          )}
        </Group>
      ))}
      {adding ? (
        <AddAccount kinds={data.kinds} presets={data.presets} onDone={(id) => { setAdding(false); load(); if (id) setEditing(id); }} />
      ) : (
        <button type="button" onClick={() => setAdding(true)} className="press inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-sm">
          <Plus className="size-4" /> {t("افزودن حساب (مثلاً اکانت دوم Claude)")}
        </button>
      )}
    </div>
  );
}

function AddAccount({ kinds, presets, onDone }) {
  const [kind, setKind] = useState("claude");
  const [label, setLabel] = useState("");
  const [preset, setPreset] = useState("");
  const [busy, setBusy] = useState(false);
  const field = "w-full rounded-lg border bg-background px-3 py-2 text-sm";
  const create = async () => {
    setBusy(true);
    try {
      const { id } = await api("/api/providers", { method: "POST", body: { kind, label: label.trim(), preset: kind === "openai" ? preset : "" } });
      if (kind === "openai" && preset) await api(`/api/providers/${id}`, { method: "PATCH", body: { preset } });
      onDone(id);
    } catch (e) {
      toast.error(e.message);
      setBusy(false);
    }
  };
  return (
    <div className="space-y-3 rounded-2xl border bg-card p-4">
      <select className={field} value={kind} onChange={(e) => setKind(e.target.value)}>
        {kinds.map((k) => <option key={k} value={k}>{KIND_LABEL[k] || k}</option>)}
      </select>
      {kind === "openai" ? (
        <select className={field} value={preset} onChange={(e) => setPreset(e.target.value)}>
          <option value="">{t("— سفارشی —")}</option>
          {presets.map((pr) => <option key={pr.id} value={pr.id}>{t(pr.label)}</option>)}
        </select>
      ) : null}
      <input className={field} value={label} onChange={(e) => setLabel(e.target.value)} placeholder={t("نام (مثلاً Claude شخصی)")} />
      <div className="flex gap-2">
        <button type="button" onClick={create} disabled={busy} className="press inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-60">
          {busy ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />} {t("بساز و کلیدش را بگذار")}
        </button>
        <button type="button" onClick={() => onDone(null)} className="press rounded-lg border px-3 py-2 text-sm">{t("انصراف")}</button>
      </div>
    </div>
  );
}

function EditRow({ provider, presets, onDone, onCancel }) {
  const [label, setLabel] = useState(provider.label || "");
  const [model, setModel] = useState(provider.defaultModel || "");
  const [baseUrl, setBaseUrl] = useState(provider.baseUrl || "");
  const [effort, setEffort] = useState(provider.reasoningEffort || "");
  const [apiKey, setApiKey] = useState("");
  const [preset, setPreset] = useState("");
  const [saving, setSaving] = useState(false);
  const [probe, setProbe] = useState(null);
  const isOpenai = provider.kind === "openai";

  const save = async ({ test = false } = {}) => {
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
      if (test) {
        const r = await api(`/api/doctor/engine/${provider.id}`);
        setProbe(r);
        setSaving(false);
        if (!r.ok) return;
      }
      toast.success(t("ذخیره شد"));
      onDone();
    } catch (e) {
      toast.error(e.message);
      setSaving(false);
    }
  };

  const field = "w-full rounded-lg border bg-background px-3 py-2 text-sm";
  return (
    <div className="space-y-3 p-4">
      <label className="block">
        <span className="mb-1 block text-xs text-muted-foreground">{t("نام")}</span>
        <input className={field} value={label} onChange={(e) => setLabel(e.target.value)} placeholder={KIND_LABEL[provider.kind]} />
      </label>
      {isOpenai ? (
        <label className="block">
          <span className="mb-1 block text-xs text-muted-foreground">{t("سرویس آماده")}</span>
          <select className={field} value={preset} onChange={(e) => { const id = e.target.value; setPreset(id); const pr = presets.find((x) => x.id === id); if (pr) setBaseUrl(pr.baseUrl); }}>
            <option value="">{t("— سفارشی —")}</option>
            {presets.map((pr) => <option key={pr.id} value={pr.id}>{t(pr.label)}</option>)}
          </select>
        </label>
      ) : null}
      {isOpenai ? (
        <label className="block">
          <span className="mb-1 block text-xs text-muted-foreground">{t("آدرس سرویس (base URL)")}</span>
          <input className={field} dir="ltr" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.example.com/v1" />
        </label>
      ) : null}
      <label className="block">
        <span className="mb-1 block text-xs text-muted-foreground">{t("مدل پیش‌فرض")}</span>
        <input className={field} dir="ltr" value={model} onChange={(e) => setModel(e.target.value)} list={`m-${provider.id}`} placeholder={provider.defaultModel || ""} />
        <datalist id={`m-${provider.id}`}>{provider.models.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</datalist>
      </label>
      {isOpenai ? (
        <label className="block">
          <span className="mb-1 block text-xs text-muted-foreground">{t("عمق استدلال")}</span>
          <select className={field} value={effort} onChange={(e) => setEffort(e.target.value)}>
            <option value="">{t("پیش‌فرض سرویس")}</option>
            <option value="low">{t("کم")}</option>
            <option value="medium">{t("متوسط")}</option>
            <option value="high">{t("زیاد")}</option>
          </select>
        </label>
      ) : null}
      <label className="block">
        <span className="mb-1 block text-xs text-muted-foreground">
          {provider.kind === "claude" ? t("کلید API یا توکن اشتراک (claude setup-token → sk-ant-oat…)") : t("کلید API")} {provider.hasKey ? t("(خالی = بدون تغییر)") : ""}
        </span>
        <input className={field} dir="ltr" type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={provider.hasKey ? "••••••••" : t("کلید را بگذار")} autoComplete="off" />
      </label>
      {provider.kind === "claude" ? <ClaudeSignin id={provider.id} onDone={onDone} /> : null}
      {probe ? <ProbeResult result={probe} /> : null}
      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={() => save({ test: true })} disabled={saving} className="press inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-60">
          {saving ? <Loader2 className="size-4 animate-spin" /> : <Stethoscope className="size-4" />} {t("ذخیره و تست")}
        </button>
        <button type="button" onClick={() => save()} disabled={saving} className="press inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-sm">
          <Check className="size-4" /> {t("فقط ذخیره")}
        </button>
        <button type="button" onClick={onCancel} className="press rounded-lg border px-3 py-2 text-sm">{t("انصراف")}</button>
      </div>
    </div>
  );
}

// Sign in with a Claude subscription without leaving the page: Griffin runs Claude's own
// `setup-token`, the owner opens the address, signs in and pastes the code shown there.
export function ClaudeSignin({ id, onDone }) {
  const [url, setUrl] = useState(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const start = async () => {
    setBusy(true);
    try {
      const r = await api(`/api/providers/${id}/signin`, { method: "POST" });
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
      await api(`/api/providers/${id}/signin/code`, { method: "POST", body: { code: code.trim() } });
      toast.success(t("حساب Claude وصل شد"));
      onDone();
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
