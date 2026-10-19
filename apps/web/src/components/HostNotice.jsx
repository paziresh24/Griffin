import { useEffect, useRef, useState } from "react";
import { Popover } from "radix-ui";
import { AlertTriangle, Loader2, MessageCircleQuestion } from "lucide-react";
import { toast } from "sonner";
import { BRAND } from "../brand.js";
import { isRtl, t } from "../i18n.js";
import { api, navigate } from "../api.js";
import { HostDetails, useHost } from "./ComposerStats.jsx";
import { dismissAlerts, engineAlerts, explainPrompt, hostAlerts, pruneDismissed, unseenAlerts } from "../host-health.js";

const DISMISSED = "griffin.alerts.dismissed";
const readDismissed = () => {
  try {
    return JSON.parse(localStorage.getItem(DISMISSED) || "[]") || [];
  } catch {
    return [];
  }
};
const writeDismissed = (list) => {
  try {
    localStorage.setItem(DISMISSED, JSON.stringify(list));
  } catch { /* storage blocked: dismissed for this page only */ }
};
// When each dismissed engine alert was last active (host-health.js pruneDismissed).
const SEEN = "griffin.alerts.seen";
const readSeen = () => {
  try {
    return JSON.parse(localStorage.getItem(SEEN) || "{}") || {};
  } catch {
    return {};
  }
};

// Bottom of the sidebar, beside the update line: what needs a look now — an engine at its 5-hour or
// weekly limit or out of credit, the server very busy, its disk filling. Nothing shows while all is
// fine; a click opens the details, «متوجه شدم» (got it) puts the alerts away until they change (host-health.js alertSig).
function useEngineAlerts() {
  const [data, setData] = useState(null);
  useEffect(() => {
    const load = () => document.visibilityState !== "hidden" && api("/api/engines/alerts").then(setData, () => {});
    load();
    const timer = setInterval(load, 60_000);
    return () => clearInterval(timer);
  }, []);
  return data;
}

export function HostNotice() {
  const [open, setOpen] = useState(false);
  const host = useHost(open, 30_000);
  const engines = useEngineAlerts();
  const streak = useRef({ at: null, n: 0 });
  // Readings in a row with the CPU at 90٪ or more (a short spike is not worth a line).
  if (host && host !== streak.current.at) {
    streak.current = { at: host, n: Number(host.cpu?.percent) >= 90 ? streak.current.n + 1 : 0 };
  }
  const [dismissed, setDismissed] = useState(readDismissed);
  const [asking, setAsking] = useState(null);
  // An alert whose cause is over is forgotten, so the next time it happens it shows again; while the
  // cause lasts it stays dismissed (host-health.js pruneDismissed).
  useEffect(() => {
    const before = readSeen();
    const out = pruneDismissed(dismissed, { engines, host, seen: before });
    if (JSON.stringify(out.seen) !== JSON.stringify(before)) {
      try {
        localStorage.setItem(SEEN, JSON.stringify(out.seen));
      } catch { /* storage blocked */ }
    }
    if (out.dismissed.length === dismissed.length) return;
    setDismissed(out.dismissed);
    writeDismissed(out.dismissed);
  }, [engines, host]);
  const engineLines = unseenAlerts(engineAlerts(engines), dismissed);
  const hostLines = unseenAlerts(hostAlerts(host, { cpuStreak: streak.current.n }), dismissed);
  const alerts = [...engineLines, ...hostLines];
  if (!alerts.length) return null;
  // «برام توضیحش بده»: a new chat on this install, its first message the alert and its details.
  const explain = async (a) => {
    setAsking(a.key);
    try {
      const { chat } = await api("/api/chats", { method: "POST", body: { text: explainPrompt(a, BRAND.name) } });
      setOpen(false);
      if (chat?.id) navigate(chat.id);
    } catch (error) {
      toast.error(t("گفتگو شروع نشد"), { description: String(error?.message || error) });
    } finally {
      setAsking(null);
    }
  };
  const gotIt = () => {
    const next = dismissAlerts(alerts, dismissed);
    setDismissed(next);
    setOpen(false);
    writeDismissed(next);
  };
  const danger = alerts.some((a) => a.level === "danger");
  const openEngines = () => {
    setOpen(false);
    try {
      localStorage.setItem("griffin.settings.section", "providers");
    } catch { /* storage blocked: Settings opens on its first section */ }
    window.location.hash = "/settings";
  };
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <div className={`g-host-notice mx-2 mt-2 flex items-start gap-1 rounded-xl border text-sm ${danger ? "border-bad/40 bg-bad/5 text-bad" : "border-warn/40 bg-warn/5 text-warn"}`}>
        <Popover.Trigger asChild>
          <button type="button" className="press flex min-w-0 flex-1 items-start gap-2 py-2 ps-3 text-start">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              {[...new Set(alerts.map((a) => a.text))].map((text) => <span key={text} className="font-medium">{text}</span>)}
            </span>
          </button>
        </Popover.Trigger>
        <button type="button" onClick={gotIt} className="press m-1.5 shrink-0 self-end rounded-lg border border-current/30 px-2 py-1 text-xs hover:bg-current/10" title={t("این هشدار تا وقتی عوض نشود دوباره نشان داده نمی‌شود")}>
          {t("متوجه شدم")}
        </button>
      </div>
      <Popover.Portal>
        <Popover.Content side="top" align="start" sideOffset={6} collisionPadding={16} className="g-menu pop kc-usage z-50 max-w-80 rounded-xl border bg-card shadow-xl" dir={isRtl ? "rtl" : "ltr"}>
          {alerts.map((a) => (
            <section key={a.key} className="mb-2.5 border-b pb-2.5 last:border-b-0">
              <div className="kc-usage-title">{a.text}</div>
              <div className="kc-note">{a.detail || a.text}</div>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                <button type="button" onClick={() => explain(a)} disabled={Boolean(asking)} className="press inline-flex items-center gap-1 rounded-lg border px-2.5 py-1 text-xs hover:bg-muted disabled:opacity-60">
                  {asking === a.key ? <Loader2 className="size-3.5 animate-spin" /> : <MessageCircleQuestion className="size-3.5" />} {t("برام توضیحش بده")}
                </button>
                {a.key.startsWith("engine") ? <button type="button" onClick={openEngines} className="press rounded-lg border px-2.5 py-1 text-xs hover:bg-muted">{t("موتورها")}</button> : null}
              </div>
            </section>
          ))}
          {hostLines.length ? <HostDetails host={host} /> : null}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
