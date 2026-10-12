import { useEffect, useState } from "react";
import { KeyRound, Loader2, Plus, Trash2, Wrench } from "lucide-react";
import { toast } from "sonner";
import { api } from "../api.js";
import { Group, Item } from "./SettingsParts.jsx";
import { BRAND } from "../brand.js";
import { locale, t } from "../i18n.js";

// Settings → Secrets: Griffin's own encrypted store ("app": engine keys and anything the app uses)
// and the tools broker's vault ("tools": GitLab, Kubernetes, SSH …). A value goes in and never comes
// back: the list shows names, the last four characters and when it changed.
export function SecretsSection() {
  const [data, setData] = useState(null);
  const [form, setForm] = useState(null);
  const load = () => api("/api/secrets").then(setData).catch((e) => toast.error(e.message));
  useEffect(() => { load(); }, []);

  const remove = async (scope, name) => {
    if (!window.confirm(t("«{name}» پاک شود؟ ابزار یا موتوری که از آن استفاده می‌کند از کار می‌افتد.", { name }))) return;
    try {
      await api(`/api/secrets?scope=${scope}&name=${encodeURIComponent(name)}`, { method: "DELETE" });
      load();
    } catch (e) {
      toast.error(e.message);
    }
  };

  if (!data) return <div className="flex justify-center py-10 text-muted-foreground"><Loader2 className="size-5 animate-spin" /></div>;
  const toolNames = new Set(data.tools.items.map((i) => i.name));
  const missing = data.catalog.filter((c) => !toolNames.has(c.name));

  return (
    <div className="space-y-6">
      {form ? <SecretForm initial={form} onDone={() => { setForm(null); load(); }} /> : null}

      <Group
        title={t("سکرت‌های ابزارها (کارگزار)")}
        action={<button type="button" onClick={() => setForm({ scope: "tools", name: "" })} className="press inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-muted-foreground hover:bg-muted"><Plus className="size-3.5" /> {t("افزودن")}</button>}
      >
        {data.tools.error ? <Item icon={Wrench} title={t("کارگزار ابزارها در دسترس نیست")} subtitle={data.tools.error} /> : null}
        {data.tools.items.map((i) => (
          <Item
            key={i.name}
            icon={KeyRound}
            title={i.name}
            subtitle={[i.source === "openbao" ? t("در OpenBao") : t("در گاوصندوق کارگزار"), i.last4 ? `…${i.last4}` : "", i.updatedAt ? new Date(i.updatedAt).toLocaleString(locale) : ""].filter(Boolean).join(" · ")}
            trailing={
              <>
                <button type="button" onClick={() => setForm({ scope: "tools", name: i.name, fixed: true })} className="press rounded-lg border px-2 py-1 text-xs">{t("عوض کردن")}</button>
                <button type="button" onClick={() => remove("tools", i.name)} className="press rounded-lg p-1.5 text-muted-foreground hover:bg-bad/10 hover:text-bad" aria-label={t("حذف")}><Trash2 className="size-4" /></button>
              </>
            }
          />
        ))}
        {missing.map((c) => (
          <Item
            key={c.name}
            title={c.name}
            subtitle={t("تنظیم نشده — {note}", { note: t(c.note) })}
            trailing={<button type="button" onClick={() => setForm({ scope: "tools", name: c.name, fixed: true })} className="press rounded-lg border px-2 py-1 text-xs">{t("تنظیم")}</button>}
          />
        ))}
      </Group>

      <Group
        title={t("سکرت‌های خود {name}", { name: BRAND.name })}
        action={<button type="button" onClick={() => setForm({ scope: "app", name: "" })} className="press inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-muted-foreground hover:bg-muted"><Plus className="size-3.5" /> {t("افزودن")}</button>}
      >
        {data.app.length ? data.app.map((i) => (
          <Item
            key={i.name}
            icon={KeyRound}
            title={i.name}
            subtitle={[i.note, i.last4 ? `…${i.last4}` : "", i.updatedAt ? new Date(i.updatedAt).toLocaleString(locale) : ""].filter(Boolean).join(" · ")}
            trailing={
              <>
                <button type="button" onClick={() => setForm({ scope: "app", name: i.name, fixed: true })} className="press rounded-lg border px-2 py-1 text-xs">{t("عوض کردن")}</button>
                <button type="button" onClick={() => remove("app", i.name)} className="press rounded-lg p-1.5 text-muted-foreground hover:bg-bad/10 hover:text-bad" aria-label={t("حذف")}><Trash2 className="size-4" /></button>
              </>
            }
          />
        )) : <Item title={t("هنوز سکرتی نیست")} subtitle={t("کلید موتورها از صفحهٔ «موتورها» هم همین‌جا ذخیره می‌شود.")} />}
      </Group>
      <p className="px-1 text-xs leading-6 text-muted-foreground">
        {t("همه رمزنگاری‌شده (AES-256-GCM) روی همین سرور می‌مانند. هیچ ایجنتی مقدارها را نمی‌بیند؛ فقط ابزاری که لازمشان دارد هنگام کار می‌خواند. از ترمینال:")} <span dir="ltr">griffin secrets set NAME</span>.
      </p>
    </div>
  );
}

function SecretForm({ initial, onDone }) {
  const [name, setName] = useState(initial.name || "");
  const [value, setValue] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const field = "w-full rounded-lg border bg-background px-3 py-2 text-sm";
  const save = async () => {
    setBusy(true);
    try {
      await api("/api/secrets", { method: "PUT", body: { scope: initial.scope, name: name.trim(), value, note } });
      toast.success(t("ذخیره شد"));
      onDone();
    } catch (e) {
      toast.error(e.message);
      setBusy(false);
    }
  };
  return (
    <div className="space-y-3 rounded-2xl border bg-card p-4">
      <p className="text-sm font-medium">{initial.scope === "tools" ? t("سکرت ابزار") : t("سکرت {name}", { name: BRAND.name })}</p>
      <input className={field} dir="ltr" value={name} disabled={initial.fixed} onChange={(e) => setName(e.target.value)} placeholder="name (e.g. gitlab__token)" />
      <textarea className={`${field} min-h-24 font-mono`} dir="ltr" value={value} onChange={(e) => setValue(e.target.value)} placeholder="value" autoComplete="off" spellCheck={false} />
      {initial.scope === "app" ? <input className={field} value={note} onChange={(e) => setNote(e.target.value)} placeholder={t("توضیح (اختیاری)")} /> : null}
      <div className="flex gap-2">
        <button type="button" onClick={save} disabled={busy || !name.trim() || !value.trim()} className="press inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-60">
          {busy ? <Loader2 className="size-4 animate-spin" /> : null} {t("ذخیره")}
        </button>
        <button type="button" onClick={onDone} className="press rounded-lg border px-3 py-2 text-sm">{t("انصراف")}</button>
      </div>
    </div>
  );
}
