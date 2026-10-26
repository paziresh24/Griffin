import { useEffect, useState, useSyncExternalStore } from "react";
import { Loader2, Smartphone, Unplug } from "lucide-react";
import { api } from "../api.js";
import { connectPhone, disconnectPhone, phoneState, subscribePhone } from "../phone.js";
import { usbSupported } from "../phone-usb.js";
import { Group, Item } from "./SettingsParts.jsx";
import { t } from "../i18n.js";

// Settings → «گوشی»: the Android phone plugged into this computer, bridged to the agent over WebUSB
// (phone.js, phone-usb.js; server phone-bridge.mjs). The agent then runs real adb against it.
const TINT = { on: "bg-emerald-500/12 text-emerald-500", connecting: "bg-amber-500/12 text-amber-500", error: "bg-red-500/12 text-red-500", off: "bg-muted text-muted-foreground" };

export function PhoneSection() {
  const s = useSyncExternalStore(subscribePhone, phoneState);
  const [server, setServer] = useState(null);
  useEffect(() => {
    let alive = true;
    const load = () => api("/api/phone").then((r) => alive && setServer(r)).catch(() => {});
    load();
    const t = setInterval(load, 4000);
    return () => { alive = false; clearInterval(t); };
  }, [s.status]);

  const title = s.status === "on" ? s.label || t("گوشی وصل است") : s.status === "connecting" ? t("در حال اتصال…") : t("گوشی وصل نیست");
  const subtitle = s.status === "on"
    ? server?.adbClient ? t("ایجنت با adb به گوشی وصل است.") : t("آماده؛ ایجنت هر وقت لازم باشد با adb وصل می‌شود.")
    : s.message || (server?.connected ? `از یک صفحهٔ دیگر وصل است: ${server.phone?.label || ""}` : t("گوشی را با کابل به همین کامپیوتر وصل کنید."));

  return (
    <div className="space-y-6">
      <Group>
        <Item
          icon={s.status === "connecting" ? Loader2 : Smartphone}
          tint={TINT[s.status] || TINT.off}
          title={title}
          subtitle={subtitle}
          trailing={
            s.status === "on" || s.status === "connecting" ? (
              <button type="button" className="inline-flex items-center gap-1 rounded-lg border px-3 py-1.5 text-sm hover:bg-muted" onClick={disconnectPhone}>
                <Unplug className="size-4" /> قطع
              </button>
            ) : (
              <button type="button" disabled={!usbSupported()} className="rounded-lg bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:opacity-50" onClick={connectPhone}>
                اتصال گوشی
              </button>
            )
          }
        />
      </Group>
      <Group title={t("چطور")}>
        <div className="space-y-2 px-4 py-3 text-sm leading-7 text-muted-foreground">
          <p>{t("۱. روی گوشی «گزینه‌های برنامه‌نویسی» و «اشکال‌زدایی USB» را روشن کنید و گوشی را با کابل به همین کامپیوتر بزنید.")}</p>
          <p>{t("۲. اگر adb، Android Studio یا scrcpy روی این کامپیوتر باز است ببندید (")}<span dir="ltr">adb kill-server</span>{t(")؛ وگرنه مرورگر به گوشی نمی‌رسد.")}</p>
          <p>{t("۳. «اتصال گوشی» را بزنید و گوشی را از فهرست مرورگر انتخاب کنید. بار اول روی گوشی «اجازهٔ اشکال‌زدایی USB» می‌آید؛ «همیشه اجازه بده» را بزنید.")}</p>
          <p>{t("تا این تب باز است گوشی در دسترس ایجنت است (نصب، لاگ، اسکرین‌شات، باز کردن نسخهٔ در حال توسعه روی گوشی). صفحه را رفرش کنید یا کابل را دوباره بزنید، خودش وصل می‌شود.")}</p>
          {!usbSupported() ? <p className="text-red-500">{t("این مرورگر WebUSB ندارد؛ Chrome یا Edge روی کامپیوتر لازم است (روی گوشی و Firefox و Safari کار نمی‌کند).")}</p> : null}
        </div>
      </Group>
    </div>
  );
}
