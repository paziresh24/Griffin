import { useEffect, useState } from "react";
import { Bell, Loader2, X } from "lucide-react";
import { toast } from "sonner";
import { api } from "../api.js";
import { readSetting, writeSetting } from "../brand.js";
import { PUSH_NUDGE_LATER_KEY, enablePush, pushSupportIssue, showPushNudge } from "../push.js";
import { t } from "../i18n.js";

// «اعلان را روشن کنید» (owner 2026-11-04: «یه ساجسشن بزار پایین سمت راست که فعالش کنن بچه‌ها»). Offered on
// every device until it is on; the permission prompt fires only from the «روشن کن» tap. «بعداً» puts it
// away for a week, the browser's own «block» ends it for good. A line at the sidebar's foot (the drawer's
// on a phone): as a floating card it covered the box or the answers on every page.
export function PushNudge() {
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    (async () => {
      const issue = pushSupportIssue();
      if (issue) return;
      try {
        const registration = await navigator.serviceWorker.ready;
        const subscribed = Boolean(await registration.pushManager.getSubscription());
        if (live) setShow(showPushNudge({ issue, permission: window.Notification.permission, subscribed, laterAt: readSetting(PUSH_NUDGE_LATER_KEY, "") }));
      } catch {
        /* no service worker yet: nothing to offer */
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  if (!show) return null;
  const later = () => {
    writeSetting(PUSH_NUDGE_LATER_KEY, String(Date.now()));
    setShow(false);
  };
  const enable = async () => {
    setBusy(true);
    try {
      if ((await enablePush({ api })) === "granted") {
        toast.success(t("اعلان‌ها روشن شد"));
        setShow(false);
      } else {
        toast.error(t("اجازهٔ اعلان داده نشد"));
        later();
      }
    } catch (error) {
      toast.error(error.message || t("روشن کردن اعلان نشد"));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="g-push-nudge mx-2 mb-2 flex items-center gap-2 rounded-xl border bg-card px-2.5 py-2 text-xs" role="region" aria-label={t("اعلان")} title={t("تا وقتی کار تمام شد یا سؤالی منتظر جواب بود، حتی با صفحهٔ بسته خبردار شوید.")}>
      <Bell className="size-3.5 shrink-0 text-primary" />
      <span className="min-w-0 flex-1 truncate font-medium">{t("اعلان را روشن کنید")}</span>
      <button type="button" onClick={enable} disabled={busy} className="press inline-flex shrink-0 items-center gap-1 rounded-lg bg-primary px-2 py-1 font-medium text-primary-foreground disabled:opacity-60 pointer-coarse:min-h-9 pointer-coarse:px-3">
        {busy ? <Loader2 className="size-3 animate-spin" /> : null}
        {t("روشن کن")}
      </button>
      <button type="button" onClick={later} className="press shrink-0 rounded-full p-1 text-muted-foreground hover:bg-muted pointer-coarse:p-2.5" aria-label={t("بعداً")} title={t("یک هفتهٔ دیگر دوباره یادآوری می‌شود")}>
        <X className="size-3.5" />
      </button>
    </div>
  );
}
