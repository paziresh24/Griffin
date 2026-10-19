import { useEffect, useRef, useState } from "react";
import { Dialog } from "radix-ui";
import { Download, Loader2, RotateCw, X } from "lucide-react";
import { toast } from "sonner";
import { api } from "../api.js";
import { BRAND } from "../brand.js";
import { describeUpdate, formatSize, formatWhen, offerState, readableChanges } from "../update.js";
import { onNewVersion, reloadNow } from "../new-version.js";
import { t } from "../i18n.js";

const GLOWED = "griffin.updateGlowed"; // the release whose arrival the sidebar item already lit up

// Bottom of the sidebar: a newer release, its Persian changes and details. The host downloads it on
// its own; «ری‌استارت و اعمال» only switches to it (owner 2026-10-18: «خودکار آپدیت رو اعمال کنه
// منتظر نمونه، فقط یوزرا دکمه ری‌استارت رو بزنن… توی صفحه آپدیتا جزئیات بیشتری ارائه بده»).
// Nothing opens by itself in the middle of work (owner, later the same day: «پاپ آپ نسخهٔ تازه میاد
// تو چش آدم وسط کار»): the item has its own «اعمال», a click on it opens the details, and a new
// release only lights the item up softly a few times.

export function UpdateNotice() {
  const [update, setUpdate] = useState(null);
  const [open, setOpen] = useState(false);
  const [pressedAt, setPressedAt] = useState(0);
  const [busy, setBusy] = useState(false);
  const startedOn = useRef(null);
  // This tab still runs the old page after the server moved on (new-version.js): said here, quietly,
  // instead of a notice over the page.
  const [stalePage, setStalePage] = useState(false);
  useEffect(() => onNewVersion(() => setStalePage(true)), []);

  useEffect(() => {
    let live = true;
    const ask = () =>
      api("/api/update").then((u) => {
        if (!live) return;
        // The server we talk to now runs another commit than when we pressed: the update is in.
        if (startedOn.current && u?.current && u.current !== startedOn.current) return window.location.reload();
        setUpdate(u);
      }, () => {});
    ask();
    // While the server is still putting the lines into Persian (update.mjs), look again soon.
    // While the host downloads, look every half minute so «آماده» shows without a reload.
    const busyHost = ["downloading", "installing"].includes(update?.status?.state) || update?.requested;
    const every = setInterval(ask, pressedAt ? 5_000 : update?.translating ? 15_000 : busyHost || !update?.status ? 15_000 : 10 * 60_000);
    return () => {
      live = false;
      clearInterval(every);
    };
  }, [pressedAt, Boolean(update?.translating), update?.status?.state, Boolean(update?.requested)]);

  const state = offerState(update, pressedAt);
  // A release not seen here yet: the item glows a few times (styles.css .g-update-glow), once.
  const offered = ["offered", "downloading", "ready"].includes(state) ? update.available.commit : null;
  const [glow, setGlow] = useState(false);
  useEffect(() => {
    if (!offered) return;
    try {
      if (localStorage.getItem(GLOWED) === offered) return;
      localStorage.setItem(GLOWED, offered);
    } catch {
      return; // private mode: no glow rather than one on every page load
    }
    setGlow(true);
  }, [offered]);
  if (!state && stalePage) {
    return (
      <div className="g-update mx-2 mt-2 flex items-center gap-1 rounded-xl border bg-muted/50 text-sm text-muted-foreground">
        <span className="flex min-w-0 flex-1 items-center gap-2 py-2 ps-3"><RotateCw className="size-4 shrink-0" /><span className="truncate font-medium">{t("صفحهٔ تازه آماده است")}</span></span>
        <button type="button" onClick={reloadNow} className="press m-1.5 shrink-0 rounded-lg bg-foreground/80 px-2.5 py-1 text-xs font-medium text-background" title={t("بارگذاری دوباره؛ پیش‌نویس پیام‌ها می‌ماند")}>{t("بارگذاری")}</button>
      </div>
    );
  }
  if (!state) return null;
  const { user, technical, technicalLines } = readableChanges(update.available.changes);
  const working = state === "waiting" || state === "installing";

  const press = async () => {
    setBusy(true);
    try {
      const out = await api("/api/update", { method: "POST", body: { commit: update.available.commit } });
      startedOn.current = update.current;
      setPressedAt(Date.now());
      toast("ری‌استارت ثبت شد", { description: describeUpdate(update, "waiting").sub });
    } catch (error) {
      toast.error(t("آپدیت شروع نشد"), { description: String(error?.message || error) });
    } finally {
      setBusy(false);
    }
  };

  const { label, sub } = describeUpdate(update, state);
  const size = formatSize(update.status?.size);
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <div
        className={`g-update mx-2 mt-2 flex items-center gap-1 rounded-xl border text-sm ${state === "failed" ? "border-warn/40 text-warn" : "bg-muted/50 text-muted-foreground"} ${glow ? "g-update-glow" : ""}`}
        onAnimationEnd={() => setGlow(false)}
      >
        <Dialog.Trigger asChild>
          <button type="button" className="press flex min-w-0 flex-1 items-center gap-2 py-2 ps-3 text-start" title={t("جزئیات و تغییرهای نسخهٔ تازه")}>
            {working || state === "downloading" ? <Loader2 className="size-4 shrink-0 animate-spin" /> : state === "ready" ? <RotateCw className="size-4 shrink-0" /> : <Download className="size-4 shrink-0" />}
            <span className="min-w-0 flex-1">
              <span className={`block truncate font-medium ${state === "failed" ? "" : "text-foreground"}`}>{label}</span>
              {sub ? <span className="line-clamp-2 text-[11px] font-normal leading-snug">{sub}</span> : null}
            </span>
            {!working && user.length ? <span className="shrink-0 text-xs opacity-75">{user.length} تغییر</span> : null}
          </button>
        </Dialog.Trigger>
        {working ? null : (
          <button type="button" onClick={press} disabled={busy} className="press m-1.5 shrink-0 rounded-lg bg-foreground/80 px-2.5 py-1 text-xs font-medium text-background disabled:opacity-60" title={t("ری‌استارت و اعمال نسخهٔ تازه")}>
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : t("اعمال")}
          </button>
        )}
      </div>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/40 backdrop-blur-[2px] overlay" />
        <Dialog.Content dir="rtl" className="pop fixed left-1/2 top-1/2 z-50 max-h-[85dvh] w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-2xl border bg-card p-5 shadow-2xl">
          <div className="mb-3 flex items-center">
            <Dialog.Title className="font-semibold">نسخهٔ تازهٔ {BRAND.name}</Dialog.Title>
            <Dialog.Close className="press ms-auto rounded-full p-1.5 hover:bg-muted" aria-label={t("بستن")}><X className="size-4" /></Dialog.Close>
          </div>
          <Dialog.Description className="mb-1 text-sm font-medium">{label}</Dialog.Description>
          <p className="mb-3 text-sm text-muted-foreground">{sub}</p>
          <dl className="mb-4 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-xl bg-muted/50 p-3 text-xs">
            <dt className="text-muted-foreground">{t("نسخهٔ فعلی")}</dt>
            <dd dir="ltr" className="text-end font-mono">{update.current || t("؟")}</dd>
            <dt className="text-muted-foreground">{t("نسخهٔ تازه")}</dt>
            <dd dir="ltr" className="text-end font-mono">{update.available.commit}</dd>
            {update.available.at ? (<><dt className="text-muted-foreground">{t("منتشر شده")}</dt><dd className="text-end">{formatWhen(update.available.at)}</dd></>) : null}
            {size ? (<><dt className="text-muted-foreground">{t("حجم دانلود")}</dt><dd className="text-end">{size}</dd></>) : null}
            {update.status?.at ? (<><dt className="text-muted-foreground">{t("آخرین تغییر وضعیت")}</dt><dd className="text-end">{formatWhen(update.status.at)}</dd></>) : null}
            {update.live ? (<><dt className="text-muted-foreground">{t("همین الان")}</dt><dd className="text-end">{update.live.working ? `${update.live.working.toLocaleString("fa-IR")} گفتگو در حال کار` : update.live.active ? `${update.live.active.toLocaleString("fa-IR")} گفتگو باز (منتظر پاسخ)` : t("هیچ گفتگویی کار نمی‌کند")}</dd></>) : null}
            {update.checkedAt ? (<><dt className="text-muted-foreground">{t("آخرین بررسی")}</dt><dd className="text-end">{formatWhen(update.checkedAt)}</dd></>) : null}
          </dl>
          <h3 className="mb-2 text-sm font-medium">{t("تغییرها")}</h3>
          {user.length ? (
            <ul className="mb-3 space-y-2 text-sm leading-relaxed" dir="auto">
              {user.map((c) => (
                <li key={c.commit} className="border-s-2 border-primary/30 ps-3">
                  <div>{c.text}</div>
                  <div className="text-[11px] text-muted-foreground">{formatWhen(c.at)} · <span dir="ltr" className="font-mono">{String(c.commit).slice(0, 7)}</span></div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mb-3 text-sm">{t("تغییر تازه‌ای برای کاربر ندارد؛ فقط رفع اشکال و بهبودهای فنی.")}</p>
          )}
          {technical ? (
            <details className="mb-4 text-xs text-muted-foreground">
              <summary className="cursor-pointer">{technical} بهبود فنی دیگر</summary>
              <ul className="mt-2 space-y-1 ps-3" dir="auto">
                {technicalLines.map((c) => <li key={c.commit}>{c.text} <span dir="ltr" className="font-mono">{String(c.commit).slice(0, 7)}</span></li>)}
              </ul>
            </details>
          ) : null}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={press}
              disabled={busy || working}
              className="press inline-flex items-center gap-2 rounded-xl bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-60"
            >
              {working ? <Loader2 className="size-4 animate-spin" /> : <RotateCw className="size-4" />}
              {working ? t("در حال اعمال…") : state === "failed" ? t("دوباره امتحان کن") : t("ری‌استارت و اعمال")}
            </button>
            <Dialog.Close className="press rounded-xl px-4 py-2 text-sm hover:bg-muted">{t("بعداً")}</Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
