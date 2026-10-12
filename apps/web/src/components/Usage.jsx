import { Gauge } from "lucide-react";
import { Popover } from "radix-ui";
import { usePolling } from "../api.js";
import { BRAND } from "../brand.js";
import { isRtl, num, t } from "../i18n.js";

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

// Header pill: the provider plan windows (5-hour / weekly) at a glance, details on click.
export function UsageBadge() {
  const data = usePolling("/api/usage", 60_000);
  const windows = (data?.providers || []).flatMap((p) => (p.windows || []).map((w) => ({ ...w, provider: p.id })));
  const worst = windows.reduce((max, w) => Math.max(max, percentOf(w) ?? 0), 0);
  const tone = worst >= 90 ? "text-bad" : worst >= 70 ? "text-warn" : "text-muted-foreground";

  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button type="button" className={`flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] hover:bg-muted ${tone}`} title={t("مصرف")}>
          <Gauge className="size-3.5" />
          {windows.length ? windows.map((w) => `${t(w.label)} ${pct(percentOf(w) ?? 0)}`).join(" · ") : data ? tokens(data.local?.last5h?.input + data.local?.last5h?.output) + " tok/5h" : "…"}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align="end" sideOffset={6} className="z-50 w-80 rounded-xl border bg-background p-3 text-xs shadow-lg" dir={isRtl ? "rtl" : "ltr"}>
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
                  <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
                    <div className={`h-full ${p >= 90 ? "bg-bad" : p >= 70 ? "bg-warn" : "bg-ok"}`} style={{ width: `${Math.min(100, p || 0)}%` }} />
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
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
