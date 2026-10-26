import { useEffect, useState } from "react";
import { Dialog } from "radix-ui";
import { Bug, Info, LifeBuoy, Loader2, LogOut, MessageSquareHeart, Send, UserRound, X } from "lucide-react";
import { toast } from "sonner";
import { api } from "../api.js";
import { BRAND } from "../brand.js";
import { isRtl, locale, num, t } from "../i18n.js";
import { ABOUT_EVENT, FEEDBACK_EVENT, feedbackPayload, openAbout, openFeedback, recentErrors } from "../feedback.js";

// The feedback / support form and the «درباره» (about) card, mounted once (App.jsx) and opened from
// the profile menu and the chat's corner button.

const TITLES = { feedback: t("ارسال بازخورد"), support: t("درخواست پشتیبانی") };
const HINTS = {
  feedback: t("هر چه به نظرتان خوب یا بد است، یا اشکالی که دیدید، بنویسید."),
  support: t("مشکلتان را بنویسید؛ همراه تصویر صفحه و جزئیات زیر مستقیم به پشتیبانی می‌رسد."),
};
// The web bundle this page runs (assets/index-<hash>.js): the page's own version.
const pageVersion = () => document.querySelector('script[type="module"][src*="/assets/index-"]')?.getAttribute("src")?.split("/").pop() || "dev";

// A picture of the page as it is (html-to-image, loaded on first use), without this dialog and any
// open menu; null when it cannot be taken in 10 s. The person sees it and can take it out.
async function capturePage() {
  const { toJpeg } = await import("html-to-image");
  const keep = (node) => !(node instanceof Element) || !node.closest("[data-feedback-ui],[data-radix-popper-content-wrapper]");
  const shot = toJpeg(document.body, { quality: 0.7, pixelRatio: Math.min(window.devicePixelRatio || 1, 1.5), filter: keep, backgroundColor: getComputedStyle(document.body).backgroundColor });
  return Promise.race([shot, new Promise((resolve) => setTimeout(() => resolve(null), 10_000))]);
}

const panel = "pop fixed left-1/2 top-1/2 z-50 max-h-[85dvh] w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-2xl border bg-card p-5 shadow-2xl";

export function FeedbackDialogs() {
  const [kind, setKind] = useState(null);
  const [about, setAbout] = useState(false);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [shot, setShot] = useState(null); // "busy" | a data URL | null
  useEffect(() => {
    const onFeedback = (e) => {
      setKind(e.detail?.kind === "support" ? "support" : "feedback");
      setShot("busy");
      capturePage().then((url) => setShot((now) => (now === "busy" ? url : now)), () => setShot((now) => (now === "busy" ? null : now)));
    };
    const onAbout = () => setAbout(true);
    window.addEventListener(FEEDBACK_EVENT, onFeedback);
    window.addEventListener(ABOUT_EVENT, onAbout);
    return () => {
      window.removeEventListener(FEEDBACK_EVENT, onFeedback);
      window.removeEventListener(ABOUT_EVENT, onAbout);
    };
  }, []);
  const details = kind ? feedbackPayload({ text, kind, version: pageVersion() }) : null;
  const send = async () => {
    setSending(true);
    try {
      const picture = typeof shot === "string" && shot.startsWith("data:image/") ? shot : undefined;
      const r = await api("/api/feedback", { method: "POST", body: { ...details, screenshot: picture } });
      toast.success(r.told ? t("به تلگرام پشتیبانی رسید؛ ممنون.") : r.sent ? t("فرستاده شد؛ ممنون.") : t("ثبت شد؛ ممنون."), { description: r.sent ? undefined : t("پشتیبانی الان در دسترس نبود؛ روی همین نصب نگه داشته شد.") });
      setText("");
      setKind(null);
    } catch (error) {
      toast.error(t("فرستاده نشد"), { description: String(error?.message || error) });
    } finally {
      setSending(false);
    }
  };
  return (
    <>
      <Dialog.Root open={Boolean(kind)} onOpenChange={(open) => !open && setKind(null)}>
        <Dialog.Portal>
          <Dialog.Overlay data-feedback-ui="" className="fixed inset-0 z-40 bg-black/40 backdrop-blur-[2px] overlay" />
          <Dialog.Content data-feedback-ui="" dir={isRtl ? "rtl" : "ltr"} className={panel}>
            <div className="mb-3 flex items-center">
              <Dialog.Title className="font-semibold">{TITLES[kind] || TITLES.feedback}</Dialog.Title>
              <Dialog.Close className="press ms-auto rounded-full p-1.5 hover:bg-muted" aria-label={t("بستن")}><X className="size-4" /></Dialog.Close>
            </div>
            <Dialog.Description className="mb-3 text-sm text-muted-foreground">{HINTS[kind] || HINTS.feedback}</Dialog.Description>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={5}
              dir="auto"
              autoFocus
              placeholder={t("بنویسید…")}
              className="w-full rounded-xl border bg-background p-3 text-sm outline-none focus:ring-2 focus:ring-primary/30"
            />
            <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
              {shot === "busy" ? (
                <><Loader2 className="size-3.5 animate-spin" /> {t("در حال گرفتن تصویر صفحه…")}</>
              ) : shot ? (
                <>
                  <a href={shot} target="_blank" rel="noreferrer" title={t("تصویر صفحه که همراه بازخورد می‌رود")}><img src={shot} alt={t("تصویر صفحه")} className="h-16 rounded-md border object-cover object-top" /></a>
                  <span className="flex-1">{t("تصویر صفحه همراهش می‌رود.")}</span>
                  <button type="button" onClick={() => setShot(null)} className="press rounded-lg border px-2 py-1 hover:bg-muted">{t("حذف تصویر")}</button>
                </>
              ) : (
                <span>{t("بدون تصویر صفحه")}</span>
              )}
            </div>
            {details ? (
              <details className="mt-2 text-xs text-muted-foreground">
                <summary className="cursor-pointer">{t("جزئیاتی که همراهش فرستاده می‌شود")}</summary>
                <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-xl bg-muted/50 p-3">
                  <dt>{t("نسخه")}</dt>
                  <dd dir="ltr" className="break-all text-end font-mono">{details.version}</dd>
                  <dt>{t("مرورگر")}</dt>
                  <dd dir="ltr" className="break-all text-end">{details.browser} ({details.viewport})</dd>
                  <dt>{t("صفحه")}</dt>
                  <dd dir="ltr" className="break-all text-end font-mono">{details.page}</dd>
                  {details.chatId ? (<><dt>{t("گفتگو")}</dt><dd dir="ltr" className="break-all text-end font-mono">{details.chatId}</dd></>) : null}
                  <dt>{t("خطاهای اخیر")}</dt>
                  <dd className="text-end">{details.errors.length ? t("{n} خطای صفحه، به‌علاوهٔ خطاهای اخیر سرور", { n: num(details.errors.length) }) : t("خطایی در صفحه نبود؛ خطاهای اخیر سرور می‌رود")}</dd>
                </dl>
                {details.errors.length ? <pre dir="ltr" className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-muted/50 p-2 text-[11px]">{recentErrors().join("\n")}</pre> : null}
              </details>
            ) : null}
            <div className="mt-4 flex items-center gap-2">
              <button type="button" onClick={send} disabled={sending || !text.trim()} className="press inline-flex items-center gap-2 rounded-xl bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-60">
                {sending ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4 rtl:-scale-x-100" />} {t("فرستادن")}
              </button>
              <Dialog.Close className="press rounded-xl px-4 py-2 text-sm hover:bg-muted">{t("انصراف")}</Dialog.Close>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
      <AboutDialog open={about} onOpenChange={setAbout} />
    </>
  );
}

function AboutDialog({ open, onOpenChange }) {
  const [health, setHealth] = useState(null);
  useEffect(() => {
    if (!open) return;
    fetch("/healthz").then((r) => r.json()).then(setHealth, () => setHealth({}));
  }, [open]);
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/40 backdrop-blur-[2px] overlay" />
        <Dialog.Content dir={isRtl ? "rtl" : "ltr"} className={panel}>
          <div className="mb-3 flex items-center">
            <Dialog.Title className="font-semibold">{t("درباره {name}", { name: BRAND.name })}</Dialog.Title>
            <Dialog.Close className="press ms-auto rounded-full p-1.5 hover:bg-muted" aria-label={t("بستن")}><X className="size-4" /></Dialog.Close>
          </div>
          <Dialog.Description className="mb-3 text-sm text-muted-foreground">{t("دستیاری که روی سرور خودتان کار می‌کند؛ گفتگوها و کلیدها همین‌جا می‌مانند.")}</Dialog.Description>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-xl bg-muted/50 p-3 text-xs">
            <dt className="text-muted-foreground">{t("نسخهٔ سرور")}</dt>
            <dd dir="ltr" className="text-end font-mono">{health?.commit || health?.version || "…"}</dd>
            <dt className="text-muted-foreground">{t("نسخهٔ صفحه")}</dt>
            <dd dir="ltr" className="break-all text-end font-mono">{pageVersion()}</dd>
          </dl>
          <div className="mt-4 flex flex-wrap gap-2">
            <button type="button" onClick={() => { onOpenChange(false); openFeedback("feedback"); }} className="press inline-flex items-center gap-1.5 rounded-xl border px-3 py-2 text-sm hover:bg-muted"><MessageSquareHeart className="size-4" /> {t("ارسال بازخورد")}</button>
            <button type="button" onClick={() => { onOpenChange(false); openFeedback("support"); }} className="press inline-flex items-center gap-1.5 rounded-xl border px-3 py-2 text-sm hover:bg-muted"><LifeBuoy className="size-4" /> {t("پشتیبانی")}</button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** The profile menu's rows (UserBar, UserMenu): its own place, not Settings. */
// «خروج» is the menu's last row (a colleague 2026-10-24: nobody had used the logout button at the foot
// of the list; its place went to «ارسال بازخورد», FeedbackBarButton).
export const PROFILE_ITEMS = [
  { id: "profile", icon: UserRound, label: t("ویرایش پروفایل") },
  { id: "about", icon: Info, label: t("درباره") },
  { id: "support", icon: LifeBuoy, label: t("پشتیبانی") },
  { id: "logout", icon: LogOut, label: t("خروج"), rule: true },
];
const logout = () => api("/api/auth/logout", { method: "POST" }).finally(() => window.location.reload());
/** What a profile row does; editProfile opens Settings → Account. */
export function profileAction(id, { editProfile }) {
  if (id === "profile") return editProfile();
  if (id === "about") return openAbout();
  if (id === "logout") return logout();
  return openFeedback(id);
}

/** The foot of the sidebar, where «خروج» was: feedback or a bug report, one tap away. */
export function FeedbackBarButton({ className }) {
  return (
    <button type="button" onClick={() => openFeedback("feedback")} className={className} title={t("ارسال بازخورد یا گزارش مشکل")} aria-label={t("ارسال بازخورد یا گزارش مشکل")}>
      <Bug className="size-4" />
    </button>
  );
}

/** The page's bottom-left corner, small and out of the way, still plainly «feedback». */
export function FeedbackButton() {
  return (
    <button
      type="button"
      onClick={() => openFeedback("feedback")}
      className="g-feedback-btn press fixed bottom-1 left-1 z-30 flex size-6 items-center justify-center rounded-full text-muted-foreground opacity-60 hover:bg-muted hover:text-foreground hover:opacity-100"
      title={t("ارسال بازخورد یا گزارش مشکل")}
      aria-label={t("ارسال بازخورد")}
    >
      <MessageSquareHeart className="size-3.5" />
    </button>
  );
}

/** Settings → Feedback: each report that reached this install, newest first, with its
 *  page picture, sender, install, version, page and time. */
export function FeedbackInbox() {
  const [items, setItems] = useState(null);
  useEffect(() => {
    api("/api/feedback/inbox").then((r) => setItems(r.items || []), (e) => { toast.error(e.message); setItems([]); });
  }, []);
  if (!items) return <div className="flex justify-center py-10 text-muted-foreground"><Loader2 className="size-5 animate-spin" /></div>;
  if (!items.length) return <p className="rounded-2xl border border-dashed p-6 text-center text-sm text-muted-foreground">{t("هنوز بازخوردی نرسیده.")}</p>;
  return (
    <ul className="space-y-3">
      {items.map((f) => (
        <li key={f.id} className="rounded-2xl border bg-card p-4 text-sm">
          <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span className={`rounded-full px-2 py-0.5 ${f.kind === "support" ? "bg-warn/15 text-warn" : "bg-primary/10 text-primary"}`}>{f.kind === "support" ? t("پشتیبانی") : t("بازخورد")}</span>
            <span className="font-medium text-foreground" dir="auto">{f.owner || f.from || "?"}</span>
            {f.from && f.from !== f.owner ? <span dir="auto">{f.from}</span> : null}
            <span dir="ltr">{f.install}</span>
            <span className="ms-auto">{new Date(f.at).toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" })}</span>
          </div>
          <p className="whitespace-pre-wrap leading-7" dir="auto">{f.text}</p>
          {f.shot ? (
            <a href={`/api/feedback/inbox/${f.id}/shot`} target="_blank" rel="noreferrer" className="mt-2 block">
              <img src={`/api/feedback/inbox/${f.id}/shot`} alt={t("تصویر صفحه")} loading="lazy" className="max-h-56 rounded-lg border object-cover object-top" />
            </a>
          ) : null}
          <details className="mt-2 text-xs text-muted-foreground">
            <summary className="cursor-pointer">{t("جزئیات")}</summary>
            <dl dir="ltr" className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 break-all rounded-xl bg-muted/50 p-3 font-mono">
              <dt>server</dt><dd>{f.commit || "?"}</dd>
              <dt>page build</dt><dd>{f.client?.version || "?"}</dd>
              <dt>page</dt><dd>{f.client?.page || "?"}{f.client?.chatId ? ` · chat ${f.client.chatId}` : ""}</dd>
              <dt>browser</dt><dd>{f.client?.browser || "?"} ({f.client?.viewport || "?"})</dd>
            </dl>
            {f.clientErrors?.length || f.serverErrors?.length ? (
              <pre dir="ltr" className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-muted/50 p-2 text-[11px]">{[...(f.clientErrors || []).map((e) => `page: ${e}`), ...(f.serverErrors || []).map((e) => `server: ${e}`)].join("\n")}</pre>
            ) : null}
          </details>
        </li>
      ))}
    </ul>
  );
}
