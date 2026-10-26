import { useEffect, useMemo, useState } from "react";
import { Loader2, RotateCcw } from "lucide-react";
import { api } from "../api.js";
import { t } from "../i18n.js";

// Settings → «نقشهٔ کلیک‌ها» (ui-clicks.mjs, clicks.js): the most clicked controls, the clicks that did
// nothing, and where on the screen people click — this install's own, or on the maintainer's install
// every install's together (a colleague 2026-10-24: «هیت‌مپ… دد کلیک‌ها را نمی‌فهمیم»).

const fa = (n) => Number(n || 0).toLocaleString("fa-IR");
const AREAS = { sidebar: t("فهرست کنار"), composer: t("کادر پیام"), menu: t("منو"), dialog: t("پنجره"), header: t("سرتیتر"), thread: t("گفتگو"), page: t("صفحه") };
const ROUTES = { home: t("صفحهٔ اصلی"), chat: t("گفتگو"), settings: t("تنظیمات"), telegram: t("تلگرام"), jobs: t("جاب‌ها"), agents: t("ایجنت‌ها"), peers: t("همکاران"), incidents: t("حادثه‌ها"), inbox: t("صندوق"), workbench: t("میز کار"), setup: t("راه‌اندازی") };
const routeName = (r) => {
  const [head, tail] = String(r || "").split(":");
  if (head === "settings" && tail) return t("تنظیمات · {tail}", { tail });
  if (head === "m") return t("ماژول {tail}", { tail });
  return ROUTES[head] || r;
};
const KIND_TABS = [
  { id: "click", label: t("پراستفاده‌ها"), kinds: ["click"], hint: t("دکمه‌ها و لینک‌هایی که بیشتر از همه زده شده‌اند. چیزی که این‌جا نیست، در این بازه زده نشده.") },
  { id: "dead", label: t("کلیک بی‌اثر"), kinds: ["dead", "rage", "disabled"], hint: t("کلیک روی چیزی که کاری نمی‌کند (آیکن، عنوان، کارت)، روی دکمهٔ غیرفعال، یا سه کلیک پشت هم روی یک جا (کلافگی).") },
  { id: "map", label: t("نقشهٔ صفحه"), kinds: [], hint: t("هر خانه یک دهم عرض و ارتفاع پنجره است؛ پررنگ‌تر یعنی کلیک بیشتر.") },
];
const KIND_NAMES = { dead: t("بی‌اثر"), rage: t("کلافگی"), disabled: t("دکمهٔ غیرفعال") };

export function ClickMapSection() {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [install, setInstall] = useState("");
  const [tab, setTab] = useState("click");
  const [query, setQuery] = useState("");
  const load = () => {
    setError("");
    api(`/api/clicks${install ? `?install=${encodeURIComponent(install)}` : ""}`).then(setData, (e) => setError(e.message));
  };
  useEffect(load, [install]);
  if (error) return <p className="rounded-2xl border border-dashed p-6 text-center text-sm text-bad">{error}</p>;
  if (!data) return <div className="flex justify-center py-10 text-muted-foreground"><Loader2 className="size-5 animate-spin" /></div>;
  const current = KIND_TABS.find((t) => t.id === tab);
  return (
    <div className="space-y-4 text-sm">
      {!data.enabled ? <p className="rounded-xl bg-warn/10 px-3 py-2 text-xs text-warn">{t("شمارش روی این نصب خاموش است (پیکربندی ← CLICK_MAP).")}</p> : null}
      <div className="flex flex-wrap items-center gap-2">
        {data.hub ? (
          <select value={install} onChange={(e) => setInstall(e.target.value)} className="rounded-lg border bg-background px-2 py-1.5 text-sm" aria-label={t("نصب")}>
            <option value="">{t("همهٔ نصب‌ها ({fa})", { fa: fa(data.installs.length) })}</option>
            {data.installs.map((i) => (
              <option key={i.install} value={i.install}>
                {i.owner || i.install}
              </option>
            ))}
          </select>
        ) : null}
        <span className="text-xs text-muted-foreground">{t("{fa} بار باز شدن صفحه در ۱۴ روز اخیر", { fa: fa(data.loads) })}</span>
        <button type="button" onClick={load} className="press ms-auto rounded-lg p-1.5 text-muted-foreground hover:bg-muted" title={t("خواندن دوباره")} aria-label={t("خواندن دوباره")}>
          <RotateCcw className="size-4" />
        </button>
      </div>
      <div className="flex gap-1 rounded-xl bg-muted/50 p-1" role="tablist">
        {KIND_TABS.map((t) => (
          <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)} className={`press flex-1 rounded-lg px-2 py-1.5 text-xs ${tab === t.id ? "bg-card font-medium shadow-sm" : "text-muted-foreground hover:text-foreground"}`}>
            {t.label}
          </button>
        ))}
      </div>
      <p className="text-xs leading-5 text-muted-foreground">{current.hint}</p>
      {tab === "map" ? (
        <ScreenMap positions={data.positions} />
      ) : (
        <>
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("جستجوی دکمه یا بخش…")} className="w-full rounded-lg border bg-background px-3 py-2 text-sm outline-none focus:border-primary/60" />
          <RowList rows={data.rows.filter((r) => current.kinds.includes(r.kind))} query={query} hub={data.hub && !install} />
        </>
      )}
    </div>
  );
}

function RowList({ rows, query, hub }) {
  const q = query.trim();
  const shown = (q ? rows.filter((r) => `${r.key} ${AREAS[r.area] || r.area} ${routeName(r.route)}`.includes(q)) : rows).slice(0, 150);
  if (!shown.length) return <p className="rounded-2xl border border-dashed p-6 text-center text-xs text-muted-foreground">{q ? t("پیدا نشد؛ یعنی در این بازه کسی آن را نزده.") : t("هنوز چیزی شمرده نشده.")}</p>;
  const max = shown[0].n || 1;
  return (
    <ul className="space-y-1">
      {shown.map((r) => (
        <li key={`${r.route}|${r.area}|${r.kind}|${r.key}`} className="relative overflow-hidden rounded-lg border px-3 py-2">
          <span className="absolute inset-y-0 start-0 bg-primary/8" style={{ width: `${Math.max(2, (r.n / max) * 100)}%` }} aria-hidden />
          <span className="relative flex items-center gap-2">
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium" dir="auto">{r.key}</span>
              <span className="block truncate text-[11px] text-muted-foreground">
                {routeName(r.route)} · {AREAS[r.area] || r.area}
                {KIND_NAMES[r.kind] ? ` · ${KIND_NAMES[r.kind]}` : ""}
                {hub ? t(" · {fa} نصب", { fa: fa(r.installs) }) : ""}
              </span>
            </span>
            <span className="shrink-0 tabular-nums">{fa(r.n)}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

function ScreenMap({ positions }) {
  const routes = useMemo(() => {
    const totals = new Map();
    for (const p of positions) totals.set(p.route, (totals.get(p.route) || 0) + p.n);
    return [...totals].sort((a, b) => b[1] - a[1]).map(([r]) => r);
  }, [positions]);
  const [route, setRoute] = useState("");
  const [mobile, setMobile] = useState(false);
  const chosen = route || routes[0] || "";
  const cells = new Map();
  for (const p of positions) {
    if (p.route !== chosen) continue;
    const [x, y, m] = p.key.split(",");
    if (Boolean(m) !== mobile) continue;
    cells.set(`${x},${y}`, (cells.get(`${x},${y}`) || 0) + p.n);
  }
  const max = Math.max(1, ...cells.values());
  if (!routes.length) return <p className="rounded-2xl border border-dashed p-6 text-center text-xs text-muted-foreground">{t("هنوز چیزی شمرده نشده.")}</p>;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <select value={chosen} onChange={(e) => setRoute(e.target.value)} className="rounded-lg border bg-background px-2 py-1.5 text-sm" aria-label={t("صفحه")}>
          {routes.map((r) => (
            <option key={r} value={r}>{routeName(r)}</option>
          ))}
        </select>
        <div className="flex gap-1 rounded-lg bg-muted/50 p-0.5">
          {[[false, t("رایانه")], [true, t("گوشی")]].map(([m, label]) => (
            <button key={label} type="button" onClick={() => setMobile(m)} className={`press rounded-md px-2.5 py-1 text-xs ${mobile === m ? "bg-card font-medium shadow-sm" : "text-muted-foreground"}`}>
              {label}
            </button>
          ))}
        </div>
      </div>
      {/* The window as it is on screen: left is left, whatever the page's direction. */}
      <div dir="ltr" className={`grid grid-cols-10 overflow-hidden rounded-xl border bg-muted/30 ${mobile ? "mx-auto aspect-[9/16] max-w-56" : "aspect-[16/10]"}`}>
        {Array.from({ length: 100 }, (_, i) => {
          const n = cells.get(`${i % 10},${Math.floor(i / 10)}`) || 0;
          const heat = n / max;
          return (
            <div
              key={i}
              title={n ? t("{fa} کلیک", { fa: fa(n) }) : ""}
              className="border-[0.5px] border-border/30"
              style={{ background: n ? `color-mix(in srgb, var(--bad) ${Math.round(15 + heat * 75)}%, transparent)` : undefined }}
            />
          );
        })}
      </div>
    </div>
  );
}
