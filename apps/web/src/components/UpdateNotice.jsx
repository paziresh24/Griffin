import { useEffect, useRef, useState } from "react";
import { Dialog } from "radix-ui";
import { ChevronLeft, Download, Loader2, RotateCw, X } from "lucide-react";
import { toast } from "sonner";
import { api } from "../api.js";
import { BRAND } from "../brand.js";
import { byDay, describeUpdate, formatSize, formatWhen, offerState } from "../update.js";
import { onNewVersion, reloadNow } from "../new-version.js";
import { t } from "../i18n.js";
import { useFlag } from "../ui-prefs.js";

const GLOWED = "griffin.updateGlowed"; // the release whose arrival the sidebar item already lit up

// Bottom of the sidebar: a newer release, its Persian changes and details. The host downloads it on
// its own; «ری‌استارت و اعمال» only switches to it (owner 2026-10-18: «خودکار آپدیت رو اعمال کنه
// منتظر نمونه، فقط یوزرا دکمه ری‌استارت رو بزنن… توی صفحه آپدیتا جزئیات بیشتری ارائه بده»).
// Nothing opens by itself in the middle of work (owner, later the same day: «پاپ آپ نسخهٔ تازه میاد
// تو چش آدم وسط کار»): the item has its own «اعمال», a click on it opens the details, and a new
// release only lights the item up softly a few times.
// One slim line, like Claude Code's «Update available →» (owner 2026-10-24, after a colleague: «در دست‌وپاست؛
// چرا باید جلوی پرکاربردترین بخش بیاید؟»); with «آپدیت فقط در تنظیمات» (ui-prefs.js updateInSettings) the
// sidebar has none, a dot marks the Settings button (useUpdateDot) and the same line sits in Settings.
// «دکمهٔ آپدیت بالای صفحه» (updateTopButton, a colleague's idea the same day: «با اومدن آپدیت روشن میشه و
// بازدنش ریستارت انجام بشه»): one icon at the top of the page that lights up with a release; a click applies it.

export function UpdateNotice({ place = "sidebar" }) {
  const inSettings = useFlag("updateInSettings");
  const top = useFlag("updateTopButton");
  if (place === "sidebar" && (inSettings || top)) return null;
  if (place === "top" && !top) return null;
  return <UpdateLine place={place} />;
}

/** Whether an update waits for the owner's «اعمال», for the dot on Settings while the line lives there. */
export function useUpdateDot() {
  const inSettings = useFlag("updateInSettings") && !useFlag("updateTopButton");
  const [waiting, setWaiting] = useState(false);
  useEffect(() => {
    if (!inSettings) return undefined;
    let live = true;
    const ask = () => api("/api/update").then((u) => live && setWaiting(["offered", "ready", "failed", "download-failed"].includes(offerState(u))), () => {});
    ask();
    const every = setInterval(ask, 10 * 60_000);
    return () => {
      live = false;
      clearInterval(every);
    };
  }, [inSettings]);
  return inSettings && waiting;
}

function UpdateLine({ place }) {
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
  const lineClass = place === "settings" ? "g-update mb-4 flex h-9 items-center gap-2 rounded-lg border bg-muted/40 px-3 text-[13px]" : "g-update mx-2 mt-1.5 flex h-8 items-center gap-2 rounded-lg bg-muted/60 px-2.5 text-[13px]";
  if (!state && stalePage) {
    return (
      <button type="button" onClick={reloadNow} className={`press w-[calc(100%-1rem)] text-start text-muted-foreground hover:text-foreground ${lineClass}`} title={t("بارگذاری دوباره؛ پیش‌نویس پیام‌ها می‌ماند")}>
        <RotateCw className="size-3.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate">{t("صفحهٔ تازه آماده است")}</span>
        <ChevronLeft className="size-3.5 shrink-0 opacity-70" />
      </button>
    );
  }
  if (!state) return null;
  const changes = update.available.changes || [];
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
  if (place === "top") {
    return (
      <button
        type="button"
        onClick={press}
        disabled={busy || working}
        onAnimationEnd={() => setGlow(false)}
        className={`press relative flex size-8 shrink-0 items-center justify-center rounded-lg hover:bg-muted disabled:opacity-70 ${state === "failed" ? "text-warn" : "text-primary"} ${glow ? "g-update-glow" : ""}`}
        title={`${label}${sub ? `\n${sub}` : ""}${working ? "" : t("\nبا کلیک ری‌استارت و اعمال می‌شود (جزئیات: تنظیمات ← سلامت).")}`}
        aria-label={working ? label : t("ری‌استارت و اعمال نسخهٔ تازه")}
      >
        {busy || working || state === "downloading" ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />}
        {working ? null : <span className="absolute end-1 top-1 size-1.5 rounded-full bg-primary" aria-hidden />}
      </button>
    );
  }
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <div
        className={`${lineClass} ${state === "failed" ? "text-warn" : "text-muted-foreground"} ${glow ? "g-update-glow" : ""}`}
        onAnimationEnd={() => setGlow(false)}
      >
        <Dialog.Trigger asChild>
          <button type="button" className="press flex h-full min-w-0 flex-1 items-center gap-2 text-start hover:text-foreground" title={sub ? `${sub}\nجزئیات و تغییرها` : t("جزئیات و تغییرهای نسخهٔ تازه")}>
            {working || state === "downloading" ? <Loader2 className="size-3.5 shrink-0 animate-spin" /> : state === "ready" ? <RotateCw className="size-3.5 shrink-0" /> : <Download className="size-3.5 shrink-0" />}
            <span className="min-w-0 flex-1 truncate">{label}{!working && changes.length ? <span className="opacity-70"> · {changes.length.toLocaleString("fa-IR")} تغییر</span> : null}</span>
          </button>
        </Dialog.Trigger>
        {working ? null : (
          <button type="button" onClick={press} disabled={busy} className="press flex shrink-0 items-center gap-0.5 font-medium text-foreground/80 hover:text-foreground disabled:opacity-60" title={t("ری‌استارت و اعمال نسخهٔ تازه")}>
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : <>{t("اعمال")}<ChevronLeft className="size-3.5" /></>}
          </button>
        )}
      </div>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/40 backdrop-blur-[2px] overlay" />
        <Dialog.Content dir="rtl" className="pop fixed left-1/2 top-1/2 z-50 max-h-[85dvh] w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-2xl border bg-card p-5 shadow-2xl">
          <div className="mb-3 flex items-center">
            <Dialog.Title className="font-semibold">نسخهٔ تازهٔ {BRAND.name}{changes.length ? <span className="font-normal text-muted-foreground"> · {changes.length.toLocaleString("fa-IR")} تغییر</span> : null}</Dialog.Title>
            <Dialog.Close className="press ms-auto rounded-full p-1.5 hover:bg-muted" aria-label={t("بستن")}><X className="size-4" /></Dialog.Close>
          </div>
          {/* What changes comes first, in plain lines by day; versions and sizes are folded away at the
              bottom (owner 2026-10-24: «ui ش خیلی بده» — a table of hashes led, the lines hid under «فنی»). */}
          <Dialog.Description className="mb-4 rounded-xl bg-muted/50 px-3 py-2 text-sm">
            <span className="font-medium">{label}</span>
            {sub ? <span className="block text-xs text-muted-foreground">{sub}</span> : null}
          </Dialog.Description>
          {changes.length ? (
            <div className="mb-4 space-y-4">
              {byDay(changes).map(({ day, items }) => (
                <section key={day}>
                  <h3 className="mb-1.5 text-xs font-medium text-muted-foreground">{day}</h3>
                  <ul className="space-y-1.5 text-sm leading-relaxed" dir="auto">
                    {items.map((c) => (
                      <li key={c.commit} className="flex gap-2">
                        <span className="mt-2 size-1.5 shrink-0 rounded-full bg-primary/60" aria-hidden />
                        <span className="min-w-0">{c.text}</span>
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
              {update.translating ? <p className="text-xs text-muted-foreground">{t("چند خط هنوز به فارسی برگردانده می‌شود…")}</p> : null}
            </div>
          ) : (
            <p className="mb-4 text-sm text-muted-foreground">{t("فهرست تغییرهای این نسخه در دسترس نیست.")}</p>
          )}
          <details className="mb-4 text-xs text-muted-foreground">
            <summary className="cursor-pointer select-none">{t("جزئیات فنی")}</summary>
            <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-xl bg-muted/50 p-3">
              <dt>{t("نسخهٔ فعلی")}</dt>
              <dd dir="ltr" className="text-end font-mono">{update.current || t("؟")}</dd>
              <dt>{t("نسخهٔ تازه")}</dt>
              <dd dir="ltr" className="text-end font-mono">{update.available.commit}</dd>
              {update.available.at ? (<><dt>{t("منتشر شده")}</dt><dd className="text-end">{formatWhen(update.available.at)}</dd></>) : null}
              {size ? (<><dt>{t("حجم دانلود")}</dt><dd className="text-end">{size}</dd></>) : null}
              {update.live ? (<><dt>{t("همین الان")}</dt><dd className="text-end">{update.live.working ? `${update.live.working.toLocaleString("fa-IR")} گفتگو در حال کار` : update.live.active ? `${update.live.active.toLocaleString("fa-IR")} گفتگو باز (منتظر پاسخ)` : t("هیچ گفتگویی کار نمی‌کند")}</dd></>) : null}
              {update.checkedAt ? (<><dt>{t("آخرین بررسی")}</dt><dd className="text-end">{formatWhen(update.checkedAt)}</dd></>) : null}
            </dl>
          </details>
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
