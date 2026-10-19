import { useEffect, useState } from "react";
import { BRAND } from "./brand.js";
import { isRtl, locale, num, t } from "./i18n.js";

export function peerStatusToken(hash = window.location.hash) {
  return hash.match(/^#\/ps\/([A-Za-z0-9_-]{32})$/)?.[1] || null;
}

const fa = (n) => num(n);
const STATE = {
  completed: { label: t("انجام شد"), cls: "bg-ok/15 text-ok" },
  failed: { label: t("ناموفق"), cls: "bg-bad/15 text-bad" },
  canceled: { label: t("لغو شد"), cls: "bg-muted text-muted-foreground" },
  rejected: { label: t("رد شد"), cls: "bg-bad/15 text-bad" },
  working: { label: t("در جریان"), cls: "bg-warn/15 text-warn" },
  submitted: { label: t("در صف"), cls: "bg-muted text-muted-foreground" },
  "input-required": { label: t("منتظر جواب شما"), cls: "bg-warn/15 text-warn" },
  "auth-required": { label: t("منتظر تأیید شما"), cls: "bg-warn/15 text-warn" },
};

function when(iso) {
  return new Date(iso).toLocaleString(locale, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

// A colleague's scoreboard: their requests to Griffin over the last 7 days. No login, no content.
export function PeerStatus({ token }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    let alive = true;
    let timer;
    const load = async () => {
      try {
        const r = await fetch(`/api/public/peer-status/${token}`, { credentials: "omit" });
        if (!r.ok) throw new Error(r.status === 404 ? t("این لینک وجود ندارد یا غیرفعال شده است.") : t("خطا {status}", { status: r.status }));
        const body = await r.json();
        if (!alive) return;
        setData(body);
        document.title = `${BRAND.title} · ${body.label}`;
      } catch (e) {
        if (alive) setError(e.message);
      }
      if (alive) timer = setTimeout(load, 30_000);
    };
    load();
    return () => { alive = false; clearTimeout(timer); };
  }, [token]);

  if (error) return <div className="flex min-h-dvh items-center justify-center p-6 text-muted-foreground" dir={isRtl ? "rtl" : "ltr"}>{error}</div>;
  if (!data) return <div className="flex min-h-dvh items-center justify-center text-muted-foreground" dir={isRtl ? "rtl" : "ltr"}>…</div>;
  const s = data.stats;
  const tiles = [
    [t("درخواست‌ها (۷ روز)"), fa(s.total)],
    [t("انجام شد"), fa(s.completed)],
    [t("ناموفق/لغو"), fa(s.failed)],
    [t("میانهٔ زمان"), s.medianMinutes == null ? "—" : t("{n} دقیقه", { n: fa(s.medianMinutes) })],
    [t("تا ۵ دقیقه"), s.completed + s.failed ? num((s.within5 / (s.completed + s.failed)), { style: "percent" }) : "—"],
  ];
  return (
    <div className="min-h-dvh bg-background px-4 py-8 text-foreground" dir={isRtl ? "rtl" : "ltr"}>
      <div className="mx-auto max-w-3xl">
        <h1 className="text-lg font-semibold">{t("کارهای {label} با {name}", { label: data.label, name: BRAND.name })}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t("هفت روز اخیر. هر ۳۰ ثانیه تازه می‌شود. فقط عنوان و نتیجه، نه محتوای گفتگو.")}</p>
        <div className="mt-5 grid grid-cols-2 gap-2 sm:grid-cols-5">
          {tiles.map(([label, value]) => (
            <div key={label} className="rounded-xl border bg-card p-3">
              <div className="text-xs text-muted-foreground">{label}</div>
              <div className="mt-1 text-lg font-semibold">{value}</div>
            </div>
          ))}
        </div>
        <div className="mt-6 divide-y overflow-hidden rounded-2xl border bg-card">
          {data.tasks.map((task, i) => {
            const st = STATE[task.state] || { label: task.state, cls: "bg-muted" };
            return (
              <div key={i} className="flex items-start gap-3 px-4 py-3 text-sm">
                <span className={`mt-0.5 shrink-0 rounded-full px-2 py-0.5 text-[11px] ${st.cls}`}>{st.label}</span>
                <div className="min-w-0 flex-1">
                  <div className="truncate" dir="auto">{task.title || "—"}</div>
                  <div className="mt-0.5 text-xs text-muted-foreground">
                    {when(task.at)}
                    {task.minutes != null ? ` · ${t("{n} دقیقه", { n: fa(task.minutes) })}` : ""}
                    {task.checkpoints ? ` · ${t("{n} گزارش وضعیت", { n: fa(task.checkpoints) })}` : ""}
                    {task.reason ? ` · ${task.reason}` : ""}
                  </div>
                </div>
              </div>
            );
          })}
          {!data.tasks.length ? <div className="px-4 py-8 text-center text-sm text-muted-foreground">{t("در هفت روز اخیر درخواستی نبوده.")}</div> : null}
        </div>
      </div>
    </div>
  );
}
