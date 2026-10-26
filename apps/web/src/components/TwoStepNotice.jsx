import { useEffect, useState } from "react";
import { ShieldCheck } from "lucide-react";
import { api } from "../api.js";
import { readSetting, writeSetting } from "../brand.js";
import { NUDGE_LATER_KEY, TWO_STEP_EVENT, showNudge } from "../two-step-nudge.js";
import { t } from "../i18n.js";

// Bottom of the sidebar, beside the host and update lines: two-step sign-in offered, not forced
// (owner 2026-10-25). A click opens Settings → حساب, where it is set up (TwoStep.jsx).
export function TwoStepNotice() {
  const [state, setState] = useState(null);
  const [laterAt, setLaterAt] = useState(() => readSetting(NUDGE_LATER_KEY, ""));
  useEffect(() => {
    let live = true;
    // No sign-in on this install (AUTH=off) answers 404: nothing to offer.
    const load = () => api("/api/auth/2fa").then((s) => live && setState(s), () => live && setState(null));
    load();
    const onChange = (e) => setState(e.detail || null);
    window.addEventListener(TWO_STEP_EVENT, onChange);
    return () => {
      live = false;
      window.removeEventListener(TWO_STEP_EVENT, onChange);
    };
  }, []);
  if (!showNudge(state, laterAt)) return null;
  const open = () => {
    writeSetting("griffin.settings.section", "account");
    window.location.hash = "/settings";
  };
  const later = () => {
    const at = String(Date.now());
    writeSetting(NUDGE_LATER_KEY, at);
    setLaterAt(at);
  };
  return (
    <div className="g-two-step-notice mx-2 mt-2 flex items-start gap-1 rounded-xl border border-primary/30 bg-primary/5 text-sm">
      <button type="button" onClick={open} className="press flex min-w-0 flex-1 items-start gap-2 py-2 ps-3 text-start">
        <ShieldCheck className="mt-0.5 size-4 shrink-0 text-primary" />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="font-medium">{t("ورود دومرحله‌ای را روشن کنید")}</span>
          <span className="text-xs leading-5 text-muted-foreground">{t("تا توکن لورفته به‌تنهایی کسی را وارد نکند")}</span>
        </span>
      </button>
      <button type="button" onClick={later} className="press m-1.5 shrink-0 self-end rounded-lg border px-2 py-1 text-xs text-muted-foreground hover:bg-muted" title={t("یک هفتهٔ دیگر دوباره یادآوری می‌شود")}>
        {t("بعداً")}
      </button>
    </div>
  );
}
