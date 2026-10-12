import { useEffect, useState } from "react";
import { Check, Cpu, KeyRound, Loader2, Pencil, X } from "lucide-react";
import { toast } from "sonner";
import { api } from "../api.js";
import { Group, Item } from "./SettingsParts.jsx";
import { Pill } from "./Health.jsx";
import { t } from "../i18n.js";

const LABEL = { cursor: "Cursor", claude: "Claude", openai: "OpenAI-compatible" };

export function ProvidersSection() {
  const [data, setData] = useState(null);
  const [editing, setEditing] = useState(null);
  const load = () => api("/api/providers").then(setData).catch((e) => toast.error(e.message));
  useEffect(() => { load(); }, []);

  if (!data) return <div className="flex justify-center py-10 text-muted-foreground"><Loader2 className="size-5 animate-spin" /></div>;

  return (
    <div className="space-y-6">
      {data.providers.map((p) => (
        <Group key={p.id} title={LABEL[p.id] || p.id} action={<Pill state={p.health?.ok ? "ok" : "bad"} title={p.health?.ok ? `${t("سالم")}${p.health.ms ? ` · ${p.health.ms}ms` : ""}` : p.health?.error || t("خطا")}>{p.health?.ok ? t("سالم") : t("خطا")}</Pill>}>
          {editing === p.id ? (
            <EditRow provider={p} presets={data.presets} onDone={() => { setEditing(null); load(); }} onCancel={() => setEditing(null)} />
          ) : (
            <>
              <Item icon={Cpu} title={t("مدل پیش‌فرض")} subtitle={p.defaultModel || "—"} trailing={<button type="button" onClick={() => setEditing(p.id)} className="press rounded-lg p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground" aria-label={t("ویرایش")}><Pencil className="size-4" /></button>} />
              {p.baseUrl != null ? <Item title={t("آدرس سرویس")} subtitle={p.baseUrl || t("پیش‌فرض")} /> : null}
              <Item icon={KeyRound} title={t("کلید API")} subtitle={p.hasKey ? t("تنظیم شده ({file})", { file: p.keyFile }) : t("تنظیم نشده")} trailing={p.hasKey ? <Check className="size-4 text-ok" /> : <X className="size-4 text-bad" />} />
              <Item title={t("ایجنت‌ها")} subtitle={p.agents.length ? p.agents.map((a) => t(a.label) + (a.model ? ` · ${a.model}` : "")).join(t("، ")) : t("هیچ ایجنتی از این موتور استفاده نمی‌کند")} />
              {p.models.length ? <Item title={t("مدل‌های موجود ({n})", { n: p.models.length })} subtitle={p.models.slice(0, 12).map((m) => m.name).join(t("، ")) + (p.models.length > 12 ? " …" : "")} /> : null}
            </>
          )}
        </Group>
      ))}
    </div>
  );
}

function EditRow({ provider, presets, onDone, onCancel }) {
  const [model, setModel] = useState(provider.defaultModel || "");
  const [baseUrl, setBaseUrl] = useState(provider.baseUrl || "");
  const [effort, setEffort] = useState(provider.reasoningEffort || "");
  const [apiKey, setApiKey] = useState("");
  const [preset, setPreset] = useState("");
  const [saving, setSaving] = useState(false);
  const isOpenai = provider.id === "openai";

  const save = async () => {
    setSaving(true);
    try {
      const body = { model };
      if (isOpenai) {
        if (preset) body.preset = preset;
        else body.baseUrl = baseUrl;
        body.reasoningEffort = effort;
      }
      if (apiKey.trim()) body.apiKey = apiKey.trim();
      await api(`/api/providers/${provider.id}`, { method: "PATCH", body });
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
      {isOpenai ? (
        <label className="block">
          <span className="mb-1 block text-xs text-muted-foreground">{t("سرویس آماده")}</span>
          <select className={field} value={preset} onChange={(e) => { const id = e.target.value; setPreset(id); const pr = presets.find((x) => x.id === id); if (pr) setBaseUrl(pr.baseUrl); }}>
            <option value="">{t("— سفارشی —")}</option>
            {presets.map((pr) => <option key={pr.id} value={pr.id}>{t(pr.label)}{pr.hasKey ? t(" (کلید موجود)") : ""}</option>)}
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
        <span className="mb-1 block text-xs text-muted-foreground">{t("کلید API")} {provider.hasKey ? t("(خالی = بدون تغییر)") : ""}</span>
        <input className={field} dir="ltr" type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={provider.hasKey ? "••••••••" : t("کلید را بگذار")} autoComplete="off" />
      </label>
      <div className="flex gap-2">
        <button type="button" onClick={save} disabled={saving} className="press inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-60">
          {saving ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />} {t("ذخیره")}
        </button>
        <button type="button" onClick={onCancel} className="press rounded-lg border px-3 py-2 text-sm">{t("انصراف")}</button>
      </div>
    </div>
  );
}
