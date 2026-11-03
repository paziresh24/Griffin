import { useCallback, useEffect, useState } from "react";
import { ExternalLink, Globe, Loader2, MonitorPlay, Power } from "lucide-react";
import { api } from "../api.js";
import { Group, Item } from "./SettingsParts.jsx";
import { t } from "../i18n.js";

// Settings → «مرورگر سرور»: the live browser in the sandbox (server live-browser.mjs). A real Chrome on a
// virtual screen, shared by the owner's chats and the owner himself: watch the agent work, take over with
// mouse and keyboard, log in once by hand. The screen is noVNC, served through the app (owner only).
export function ServerBrowserSection() {
  const [state, setState] = useState(null);
  const [busy, setBusy] = useState(false);
  const [shown, setShown] = useState(false);

  const load = useCallback(() => api("/api/livebrowser").then(setState).catch(() => {}), []);
  useEffect(() => { load(); }, [load]);

  const setConfig = async (body) => {
    setBusy(true);
    try { await api("/api/config", { method: "PATCH", body }); await load(); } finally { setBusy(false); }
  };

  if (!state) return <div className="flex justify-center p-8"><Loader2 className="size-5 animate-spin text-muted-foreground" /></div>;

  return (
    <div className="space-y-6">
      <Group>
        <Item
          icon={MonitorPlay}
          tint={state.enabled ? "bg-emerald-500/12 text-emerald-500" : "bg-muted text-muted-foreground"}
          title={state.enabled ? t("مرورگر سرور روشن است") : t("مرورگر سرور خاموش است")}
          subtitle={state.enabled ? t("ایجنت در چت‌های شما در همین مرورگر کار می‌کند.") : t("چت‌های شما الان مرورگر بی‌صفحهٔ جدا دارند.")}
          trailing={
            <button type="button" disabled={busy} className={`inline-flex items-center gap-1 rounded-lg px-3 py-1.5 text-sm disabled:opacity-50 ${state.enabled ? "border hover:bg-muted" : "bg-primary text-primary-foreground"}`} onClick={() => setConfig({ LIVE_BROWSER: state.enabled ? "off" : "on" })}>
              {busy ? <Loader2 className="size-4 animate-spin" /> : <Power className="size-4" />} {state.enabled ? t("خاموش") : t("روشن")}
            </button>
          }
        />
        {state.enabled ? (
          <Item
            icon={Globe}
            title={t("از VPN برو")}
            subtitle={state.proxy ? t("سایت‌ها از پراکسی تنظیم‌شده باز می‌شوند.") : t("سایت‌ها با IP خود سرور باز می‌شوند؛ پراکسی را در پیکربندی (LIVE_BROWSER_PROXY) بگذارید.")}
          />
        ) : null}
      </Group>

      {state.enabled ? (
        <Group
          title={t("صفحهٔ مرورگر")}
          action={
            <a href="/api/livebrowser/open" target="_blank" rel="noopener" className="inline-flex items-center gap-1 text-xs text-primary hover:underline">
              <ExternalLink className="size-3.5" /> {t("باز کردن در تب جدا")}
            </a>
          }
        >
          {shown ? (
            <iframe title={t("مرورگر سرور")} src="/api/livebrowser/open" className="block h-[70vh] w-full bg-black" allow="clipboard-read; clipboard-write" />
          ) : (
            <button type="button" className="flex h-48 w-full items-center justify-center gap-2 text-sm text-muted-foreground hover:bg-muted/50" onClick={() => setShown(true)}>
              <MonitorPlay className="size-5" /> {t("نمایش زنده")}
            </button>
          )}
        </Group>
      ) : null}

      <Group title={t("چطور")}>
        <div className="space-y-2 px-4 py-3 text-sm leading-7 text-muted-foreground">
          <p>{t("یک Chrome واقعی روی سرور که شما و ایجنت هم‌زمان در آن کار می‌کنید: هر وقت ایجنت گیر کرد (کپچا، کد پیامکی) همین‌جا خودتان بزنید و کار را به او برگردانید.")}</p>
          <p>{t("لاگین‌ها و تب‌ها می‌مانند، حتی وقتی لپ‌تاپ شما خاموش است. تست‌های ایجنت هم همین‌جا اجرا می‌شود و می‌توانید تماشا کنید.")}</p>
          <p>{t("فقط برای خود شماست؛ چت همکاران و کارهای زمان‌بندی‌شده مرورگر جدای خودشان را دارند.")}</p>
        </div>
      </Group>
    </div>
  );
}
