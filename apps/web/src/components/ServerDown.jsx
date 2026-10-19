import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { BRAND } from "../brand.js";
import { isRtl, t } from "../i18n.js";
import { createDownWatch } from "../server-down.js";

// Covers the page while the server is away (server-down.js); goes away by itself when it is back,
// and new-version.js then moves the tab to the new bundle if the restart was an update.
export function ServerDown() {
  const [down, setDown] = useState(false);
  useEffect(() => {
    let live = true;
    let timer;
    const tick = createDownWatch({
      ping: () => fetch("/healthz", { cache: "no-store" }).then((r) => r.status),
      onDown: () => live && setDown(true),
      onBack: () => live && setDown(false),
    });
    const loop = async () => {
      // A hidden tab does not ping; it looks again as soon as it is shown.
      const wait = document.hidden ? 5_000 : await tick();
      if (live) timer = setTimeout(loop, wait);
    };
    loop();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, []);
  if (!down) return null;
  return (
    <div role="alertdialog" aria-live="assertive" dir={isRtl ? "rtl" : "ltr"} className="fixed inset-0 z-[100] flex items-center justify-center bg-background/85 p-6 backdrop-blur-sm">
      <div className="max-w-sm rounded-2xl border bg-card p-6 text-center shadow-2xl">
        <Loader2 className="mx-auto mb-3 size-8 animate-spin text-primary" />
        <p className="mb-2 font-semibold">{t("{name} در حال آپدیت یا ری‌استارت است", { name: BRAND.name })}</p>
        <p className="text-sm leading-relaxed text-muted-foreground">
          {t("معمولاً کمتر از یک دقیقه طول می‌کشد. گفتگوها و پیام‌هایتان سر جایشان می‌مانند؛ این صفحه خودش برمی‌گردد.")}
        </p>
      </div>
    </div>
  );
}
