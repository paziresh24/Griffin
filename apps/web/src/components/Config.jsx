import { useCallback, useEffect, useState } from "react";
import { Check, Loader2, RotateCw, Store } from "lucide-react";
import { toast } from "sonner";
import { api } from "../api.js";
import { BRAND } from "../brand.js";
import { t } from "../i18n.js";

// Settings → Configuration: everything that used to need an env edit and a redeploy. A value set
// here wins over the env; «بعد از ری‌استارت» ones apply once Griffin restarts (button below).
// A setting that belongs to a module (the server says which: `modules`) is not here: it is on that
// module's card in «بازارچه» (owner 2026-10-20: «تنظیماتش هم یکپارچه بشه»). Both draw ConfigFields.

/** /api/config and the engine accounts (for the «حساب موتور» fields), with a reload. */
export function useConfigData() {
  const [data, setData] = useState(null);
  const [accounts, setAccounts] = useState([]);
  const load = useCallback(() => api("/api/config").then(setData).catch((e) => toast.error(e.message)), []);
  useEffect(() => {
    load();
    api("/api/providers").then((d) => setAccounts(d.providers || [])).catch(() => {});
  }, [load]);
  return { data, accounts, reload: load };
}

export async function restartGriffin(force = false) {
  try {
    await api("/api/admin/restart", { method: "POST", body: { force } });
    toast.message(t("در حال ری‌استارت… صفحه چند ثانیه بعد دوباره وصل می‌شود."));
    setTimeout(() => window.location.reload(), 8000);
  } catch (e) {
    if (/runs are in progress/.test(e.message) && window.confirm(t("ران‌هایی در جریان‌اند و قطع می‌شوند. باز هم ری‌استارت شود؟"))) restartGriffin(true);
    else toast.error(e.message);
  }
}

/** A list of settings to edit and one «ذخیره». `settings` are rows of /api/config (or a module's own, with `save`). */
export function ConfigFields({ settings, accounts = [], onSaved, save: saveWith, activeRuns = 0, restartButton = false }) {
  const [draft, setDraft] = useState({});
  const [saving, setSaving] = useState(false);
  const [needsRestart, setNeedsRestart] = useState(false);
  const dirty = Object.keys(draft).length > 0;
  const field = "w-full rounded-lg border bg-background px-3 py-2 text-sm";

  const save = async () => {
    setSaving(true);
    try {
      const r = saveWith ? await saveWith(draft) : await api("/api/config", { method: "PATCH", body: draft });
      if (r?.restart) setNeedsRestart(true);
      toast.success(r?.restart ? t("ذخیره شد؛ بعد از ری‌استارت اعمال می‌شود") : t("ذخیره شد"));
      setDraft({});
      await onSaved?.();
    } catch (e) {
      toast.error(e.message);
    }
    setSaving(false);
  };

  return (
    <div className="space-y-4">
      {settings.map((s) => {
        const value = s.key in draft ? draft[s.key] : s.value;
        const set = (v) => setDraft((d) => ({ ...d, [s.key]: v }));
        const fallback = s.default || s.effective || "";
        return (
          <label key={s.key} className="block">
            <span className="mb-1 flex items-center gap-2 text-xs leading-5 text-muted-foreground">
              {t(s.label || s.description || s.key)}
              {s.live === false ? <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px]">{t("بعد از ری‌استارت")}</span> : null}
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
              <textarea className={`${field} min-h-20`} dir="auto" value={value} onChange={(e) => set(e.target.value)} placeholder={fallback} />
            ) : (
              <input className={field} dir="auto" value={value} onChange={(e) => set(e.target.value)} placeholder={fallback} />
            )}
          </label>
        );
      })}
      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={save} disabled={!dirty || saving} className="press inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50">
          {saving ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />} {t("ذخیره")}
        </button>
        {restartButton || needsRestart ? (
          <button type="button" onClick={() => restartGriffin()} className={`press inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-sm ${needsRestart ? "border-primary text-primary" : ""}`}>
            <RotateCw className="size-4" /> {t("ری‌استارت {name}", { name: BRAND.name })}{activeRuns ? t(" ({n} ران در جریان)", { n: activeRuns }) : ""}
          </button>
        ) : null}
      </div>
    </div>
  );
}

export function ConfigSection({ onSection }) {
  const { data, accounts, reload } = useConfigData();
  if (!data) return <div className="flex justify-center py-10 text-muted-foreground"><Loader2 className="size-5 animate-spin" /></div>;
  const own = data.settings.filter((s) => !s.modules?.length);
  const moved = data.settings.length - own.length;
  return (
    <div className="space-y-4">
      {moved ? (
        <button type="button" onClick={() => onSection?.("market")} className="flex w-full items-center gap-2.5 rounded-xl border bg-card px-3 py-2.5 text-start text-xs leading-5 text-muted-foreground hover:bg-muted/60">
          <Store className="size-4 shrink-0 text-primary" />
          <span className="min-w-0 flex-1">{t("تنظیمات تلگرام، حادثه‌ها، ایجنت‌های همکاران و بقیهٔ بخش‌ها روی کارت همان بخش در «بازارچه» است.")}</span>
          <span className="shrink-0 text-primary">{t("بازارچه")}</span>
        </button>
      ) : null}
      <ConfigFields settings={own} accounts={accounts} onSaved={reload} activeRuns={data.activeRuns} restartButton />
      <p className="text-xs leading-6 text-muted-foreground">{t("خالی = مقدار متغیر محیطی یا پیش‌فرض. مسیرها، پورت‌ها و سوکت کارگزار عمداً فقط هنگام نصب تعیین می‌شوند.")}</p>
    </div>
  );
}
