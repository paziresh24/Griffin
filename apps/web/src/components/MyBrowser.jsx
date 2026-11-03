import { useCallback, useEffect, useState } from "react";
import { AppWindow, Check, Copy, Download, Loader2, Trash2 } from "lucide-react";
import { api } from "../api.js";
import { Group, Item } from "./SettingsParts.jsx";
import { t } from "../i18n.js";

// Settings → «مرورگر من»: the owner's own Chrome through the Griffin extension (server my-browser.mjs,
// extension apps/server/assets/chrome-extension). The page talks to the extension's content script with
// window.postMessage: it sees whether the extension is in THIS browser, and pairs it with one click (a
// fresh code from the server goes straight to the extension; nothing to type). The download carries this
// install's address, so a fresh install opens this page by itself.

let seq = 0;
function askExtension(type, extra = {}, timeout = 1500) {
  return new Promise((resolve) => {
    const id = `g${Date.now()}-${++seq}`;
    let timer;
    const on = (e) => {
      if (e.source !== window || e.data?.source !== "griffin-ext" || e.data.id !== id) return;
      window.removeEventListener("message", on);
      clearTimeout(timer);
      resolve(e.data);
    };
    window.addEventListener("message", on);
    timer = setTimeout(() => { window.removeEventListener("message", on); resolve(null); }, timeout);
    window.postMessage({ source: "griffin-page", type, id, ...extra }, window.location.origin);
  });
}

const EXTENSIONS_URL = "chrome://extensions";

export function MyBrowserSection() {
  const [data, setData] = useState(null);
  const [ext, setExt] = useState(undefined); // undefined: checking, null: not installed, {…}: installed
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [code, setCode] = useState(null);
  const [copied, setCopied] = useState("");

  const load = useCallback(async () => {
    api("/api/mybrowser").then(setData).catch(() => {});
    setExt(await askExtension("hello"));
  }, []);
  useEffect(() => {
    load();
    const timer = setInterval(load, 3000);
    return () => clearInterval(timer);
  }, [load]);

  const connect = async () => {
    setBusy(true);
    setError("");
    try {
      const { code: fresh } = await api("/api/mybrowser/code", { method: "POST" });
      const r = await askExtension("pair", { code: fresh }, 120_000);
      if (!r?.ok) setError(r?.error === "not confirmed" ? t("اتصال تأیید نشد.") : r?.error || t("افزونه جواب نداد."));
      await load();
    } finally {
      setBusy(false);
    }
  };
  const remove = async (id) => {
    await api(`/api/mybrowser/devices/${id}`, { method: "DELETE" });
    await load();
  };
  const copy = (value, what) => {
    navigator.clipboard?.writeText(value).then(() => { setCopied(what); setTimeout(() => setCopied(""), 1500); }).catch(() => {});
  };

  const devices = data?.devices || [];
  const here = ext?.paired;
  const live = here && ext.state === "on";

  return (
    <div className="space-y-6">
      <Group title={t("همین مرورگر")}>
        {ext === undefined ? (
          <Item icon={Loader2} title={t("در حال بررسی…")} />
        ) : !ext ? (
          <Item
            icon={AppWindow}
            title={t("افزونهٔ گریفین روی این مرورگر نصب نیست")}
            subtitle={t("یک بار نصب می‌شود؛ بعدش همه‌چیز با یک کلیک است.")}
            trailing={
              <a href="/api/mybrowser/extension.zip" download className="inline-flex items-center gap-1 rounded-lg bg-primary px-3 py-1.5 text-sm text-primary-foreground">
                <Download className="size-4" /> {t("دانلود افزونه")}
              </a>
            }
          />
        ) : (
          <Item
            icon={live ? Check : AppWindow}
            tint={live ? "bg-emerald-500/12 text-emerald-500" : "bg-muted text-muted-foreground"}
            title={live ? t("این مرورگر وصل است") : here ? t("جفت شده، ولی الان وصل نیست") : t("افزونه نصب است")}
            subtitle={live ? t("ایجنت در چت‌های شما می‌تواند در این مرورگر کار کند.") : here ? t("از پنجرهٔ افزونه «روشن» را بزنید.") : t("یک کلیک تا اتصال.")}
            trailing={here ? null : (
              <button type="button" disabled={busy} className="inline-flex items-center gap-1 rounded-lg bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:opacity-50" onClick={connect}>
                {busy ? <Loader2 className="size-4 animate-spin" /> : null} {t("اتصال همین مرورگر")}
              </button>
            )}
          />
        )}
        {error ? <div className="px-4 pb-3 text-sm text-red-500">{error}</div> : null}
        {ext?.version && data?.extensionVersion && ext.version !== data.extensionVersion ? (
          <div className="space-y-1 px-4 pb-3 text-sm leading-7 text-amber-600">
            <p>{t("نسخهٔ تازهٔ افزونه آمده ({v}).", { v: data.extensionVersion })}{" "}
              <a href="/api/mybrowser/extension.zip" download className="text-primary hover:underline">{t("دانلود افزونه")}</a>
            </p>
            <p>{t("فایل را روی همان پوشهٔ قبلی باز کنید (جایگزین شود) و در chrome://extensions روی «Reload» افزونه بزنید؛ اتصال سر جایش می‌ماند.")}</p>
          </div>
        ) : null}
        {ext === null ? (
          <div className="space-y-2 px-4 py-3 text-sm leading-7 text-muted-foreground">
            <p>{t("۱. «دانلود افزونه» را بزنید و فایل را باز کنید (پوشهٔ griffin-chrome).")}</p>
            <p>
              {t("۲. صفحهٔ افزونه‌ها را باز کنید")}{" "}
              <button type="button" className="inline-flex items-center gap-1 rounded-md border px-2 py-0.5 font-mono text-xs text-foreground hover:bg-muted" dir="ltr" onClick={() => copy(EXTENSIONS_URL, "ext")}>
                {EXTENSIONS_URL} <Copy className="size-3.5" />
              </button>
              {copied === "ext" ? <span className="ms-2 text-xs text-emerald-500">{t("کپی شد")}</span> : null}
              {" "}{t("، «Developer mode» را روشن کنید و پوشه را با «Load unpacked» انتخاب کنید.")}
            </p>
            <p>{t("۳. همین صفحه خودش باز می‌شود؛ «اتصال همین مرورگر» را بزنید. تمام.")}</p>
          </div>
        ) : null}
      </Group>

      {devices.length ? (
        <Group title={t("مرورگرهای وصل")}>
          {devices.map((d) => (
            <Item
              key={d.id}
              icon={AppWindow}
              tint={d.connected ? "bg-emerald-500/12 text-emerald-500" : "bg-muted text-muted-foreground"}
              title={d.label}
              subtitle={d.connected ? t("وصل است؛ ایجنت در این مرورگر کار می‌کند.") : t("الان وصل نیست؛ با باز شدن مرورگر خودش وصل می‌شود.")}
              trailing={
                <button type="button" title={t("حذف")} className="rounded-lg border p-1.5 hover:bg-muted" onClick={() => remove(d.id)}>
                  <Trash2 className="size-4" />
                </button>
              }
            />
          ))}
        </Group>
      ) : null}

      <Group title={t("چه می‌کند")}>
        <div className="space-y-2 px-4 py-3 text-sm leading-7 text-muted-foreground">
          <p>{t("ایجنت در چت‌های خود شما تب باز می‌کند، صفحه را می‌خواند، کلیک و تایپ می‌کند، تب‌ها را می‌بندد و گروه می‌کند، و کنسول و درخواست‌های شبکهٔ هر تب را برای دیباگ می‌بیند؛ با همان لاگین‌هایی که در مرورگرتان دارید.")}</p>
          <p>{t("هر تبی که ایجنت در آن کار می‌کند بالایش نوشته «گریفین در حال کنترل این تب است» و دکمهٔ «توقف» دارد؛ توقف همهٔ کنترل را تا وقتی خودتان در افزونه «روشن» بزنید قطع می‌کند. تب‌هایی که خودش باز می‌کند در گروه «گریفین» می‌روند.")}</p>
          <p>{t("همکاران و کارهای زمان‌بندی‌شده به این مرورگر دسترسی ندارند.")}</p>
        </div>
      </Group>

      <details className="rounded-2xl border bg-card px-4 py-3 text-sm text-muted-foreground">
        <summary className="cursor-pointer">{t("اتصال یک مرورگر دیگر با کد")}</summary>
        <div className="mt-3 space-y-3 leading-7">
          <p>{t("برای مرورگری که این صفحه در آن باز نیست: در پنجرهٔ افزونه آدرس و این کد را وارد کنید. کد ۱۰ دقیقه و فقط یک بار کار می‌کند.")}</p>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className="rounded-lg border px-3 py-1.5 hover:bg-muted" onClick={async () => setCode(await api("/api/mybrowser/code", { method: "POST" }))}>{t("ساخت کد اتصال")}</button>
            {code ? (
              <button type="button" className="inline-flex items-center gap-2 rounded-lg border px-3 py-1.5 font-mono text-base tracking-widest text-foreground hover:bg-muted" dir="ltr" onClick={() => copy(code.code, "code")}>
                {code.code} <Copy className="size-4" />
              </button>
            ) : null}
            {copied === "code" ? <span className="text-xs text-emerald-500">{t("کپی شد")}</span> : null}
          </div>
          {data?.server ? (
            <div className="flex items-center gap-2">
              <span>{t("آدرس:")}</span>
              <button type="button" className="inline-flex items-center gap-1 rounded-md border px-2 py-0.5 font-mono text-xs text-foreground hover:bg-muted" dir="ltr" onClick={() => copy(data.server, "server")}>
                {data.server} <Copy className="size-3.5" />
              </button>
              {copied === "server" ? <span className="text-xs text-emerald-500">{t("کپی شد")}</span> : null}
            </div>
          ) : null}
        </div>
      </details>
    </div>
  );
}
