import { Gauge } from "lucide-react";
import { useState } from "react";
import { usePolling } from "../api.js";
import { BRAND } from "../brand.js";
import { num, t } from "../i18n.js";
import { useSkin } from "../skin.js";

const fa = (n) => num(Number(n || 0));
const pct = (n) => num(Number(n || 0) / 100, { style: "percent" });

function tokens(n) {
  n = Number(n) || 0;
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`;
  return String(n);
}

function resetIn(at) {
  if (!at) return null;
  const ms = new Date(typeof at === "number" ? at : at).getTime() - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const h = Math.floor(ms / 3600_000);
  const m = Math.round((ms % 3600_000) / 60_000);
  return h >= 24 ? t("{n} روز", { n: fa(Math.floor(h / 24)) }) : h ? t("{h} ساعت و {m} دقیقه", { h: fa(h), m: fa(m) }) : t("{n} دقیقه", { n: fa(m) });
}

function percentOf(w) {
  if (w.percentage != null) return Math.round(Number(w.percentage));
  if (w.limit) return Math.round((Number(w.used) / Number(w.limit)) * 100);
  return null;
}

// "Token usage" in the sidebar's settings menu (it left the chat header): the provider
// plan windows (5-hour / weekly) at a glance, details unfold in place on click (a popover inside the
// menu would close with it).
export function UsageBadge() {
  const [open, setOpen] = useState(false);
  const data = usePolling("/api/usage", 60_000);
  // The Karsara skin warns from 75%, the default skin from 70%; both turn red at 90%.
  const warnAt = useSkin() === "karsara" ? 75 : 70;
  const windows = (data?.providers || []).flatMap((p) => (p.windows || []).map((w) => ({ ...w, provider: p.id })));
  const worst = windows.reduce((max, w) => Math.max(max, percentOf(w) ?? 0), 0);
  const tone = worst >= 90 ? "text-bad" : worst >= warnAt ? "text-warn" : "text-muted-foreground";
  const summary = windows.length ? windows.map((w) => `${t(w.label)} ${pct(percentOf(w) ?? 0)}`).join(" · ") : data ? tokens(data.local?.last5h?.input + data.local?.last5h?.output) + " tok/5h" : "…";

  return (
    <div>
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className={`g-menu-row flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2.5 text-sm hover:bg-muted ${open ? "bg-muted" : ""}`}>
        <Gauge className="size-4 text-muted-foreground" />
        <span className="flex-1 text-start">{t("مصرف توکن")}</span>
        <span className={`text-[11px] ${tone}`}>{summary}</span>
      </button>
      {open ? (
        <div className="px-2.5 py-2 text-xs">
          <div className="mb-2 font-medium">{t("سهمیهٔ پلن")}</div>
          {windows.length ? (
            windows.map((w, i) => {
              const p = percentOf(w);
              return (
                <div key={i} className="mb-2">
                  <div className="flex justify-between">
                    <span>{t(w.label)} <span className="text-muted-foreground" dir="ltr">({w.provider})</span></span>
                    <span>{p == null ? "—" : pct(p)}</span>
                  </div>
                  <div className="g-usage-bar mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
                    <div className={`h-full ${p >= 90 ? "bg-bad" : p >= warnAt ? "bg-warn" : "bg-ok"}`} style={{ width: `${Math.min(100, p || 0)}%` }} />
                  </div>
                  {resetIn(w.resetAt) ? <div className="mt-0.5 text-muted-foreground">{t("ریست تا {time}", { time: resetIn(w.resetAt) })}</div> : null}
                </div>
              );
            })
          ) : (
            <div className="mb-2 text-muted-foreground">
              {(data?.providers || []).find((p) => p.error)?.error || t("پروایدر فعلی سهمیهٔ پلن گزارش نمی‌دهد.")}
            </div>
          )}
          <div className="mb-1 mt-3 font-medium">{t("مصرف خود {name}", { name: BRAND.name })}</div>
          {[[t("۵ ساعت اخیر"), data?.local?.last5h], [t("۷ روز اخیر"), data?.local?.last7d]].map(([label, u]) => (
            <div key={label} className="flex justify-between py-0.5">
              <span>{label}</span>
              <span dir="ltr" title={u ? `in ${fa(u.input)} · cached ${fa(u.cached)} · out ${fa(u.output)}` : ""}>
                {u ? `${tokens(u.input)} in · ${tokens(u.output)} out · ${fa(u.requests)} req` : "…"}
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
