import { useEffect, useState } from "react";
import { Check, Loader2, RotateCw } from "lucide-react";
import { toast } from "sonner";
import { api } from "../api.js";
import { BRAND } from "../brand.js";
import { t } from "../i18n.js";

// Settings → Configuration: everything that used to need an env edit and a redeploy. A value set
// here wins over the env; «بعد از ری‌استارت» ones apply once Griffin restarts (button below).
export function ConfigSection() {
  const [data, setData] = useState(null);
  const [draft, setDraft] = useState({});
  const [accounts, setAccounts] = useState([]);
  const [saving, setSaving] = useState(false);
  const [needsRestart, setNeedsRestart] = useState(false);
  const load = () => api("/api/config").then((d) => { setData(d); setDraft({}); }).catch((e) => toast.error(e.message));
  useEffect(() => {
    load();
    api("/api/providers").then((d) => setAccounts(d.providers || [])).catch(() => {});
  }, []);

  if (!data) return <div className="flex justify-center py-10 text-muted-foreground"><Loader2 className="size-5 animate-spin" /></div>;
  const dirty = Object.keys(draft).length > 0;
  const field = "w-full rounded-lg border bg-background px-3 py-2 text-sm";

  const save = async () => {
    setSaving(true);
    try {
      const r = await api("/api/config", { method: "PATCH", body: draft });
      if (r.restart) setNeedsRestart(true);
      toast.success(t("ذخیره شد"));
      load();
    } catch (e) {
      toast.error(e.message);
    }
    setSaving(false);
  };
  const restart = async (force = false) => {
    try {
      await api("/api/admin/restart", { method: "POST", body: { force } });
      toast.message(t("در حال ری‌استارت… صفحه چند ثانیه بعد دوباره وصل می‌شود."));
      setTimeout(() => window.location.reload(), 8000);
    } catch (e) {
      if (/runs are in progress/.test(e.message) && window.confirm(t("ران‌هایی در جریان‌اند و قطع می‌شوند. باز هم ری‌استارت شود؟"))) restart(true);
      else toast.error(e.message);
    }
  };

  return (
    <div className="space-y-4">
      {data.settings.map((s) => {
        const value = s.key in draft ? draft[s.key] : s.value;
        const set = (v) => setDraft((d) => ({ ...d, [s.key]: v }));
        return (
          <label key={s.key} className="block">
            <span className="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
              {t(s.label)}
              {!s.live ? <span className="rounded bg-muted px-1.5 py-0.5 text-[10px]">{t("بعد از ری‌استارت")}</span> : null}
            </span>
            {s.options ? (
              <select className={field} value={value} onChange={(e) => set(e.target.value)}>
                <option value="">{s.effective && !s.value ? t("پیش‌فرض ({value})", { value: s.effective }) : t("پیش‌فرض")}</option>
                {s.options.filter(Boolean).map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
            ) : s.kind === "account" ? (
              <select className={field} value={value} onChange={(e) => set(e.target.value)}>
                <option value="">{s.effective && !s.value ? t("پیش‌فرض ({value})", { value: s.effective }) : t("— مثل ایجنت —")}</option>
                {accounts.map((a) => <option key={a.id} value={a.id}>{a.label || a.id}</option>)}
              </select>
            ) : s.multiline ? (
              <textarea className={`${field} min-h-20`} dir="auto" value={value} onChange={(e) => set(e.target.value)} placeholder={s.effective || ""} />
            ) : (
              <input className={field} dir="auto" value={value} onChange={(e) => set(e.target.value)} placeholder={s.effective || ""} />
            )}
          </label>
        );
      })}
      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={save} disabled={!dirty || saving} className="press inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50">
          {saving ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />} {t("ذخیره")}
        </button>
        <button type="button" onClick={() => restart()} className={`press inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-sm ${needsRestart ? "border-primary text-primary" : ""}`}>
          <RotateCw className="size-4" /> {t("ری‌استارت {name}", { name: BRAND.name })}{data.activeRuns ? t(" ({n} ران در جریان)", { n: data.activeRuns }) : ""}
        </button>
      </div>
      <p className="text-xs leading-6 text-muted-foreground">{t("خالی = مقدار متغیر محیطی یا پیش‌فرض. مسیرها، پورت‌ها و سوکت کارگزار عمداً فقط هنگام نصب تعیین می‌شوند.")}</p>
    </div>
  );
}
