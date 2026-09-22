import { useState } from "react";
import { usePolling } from "../api.js";
import { Activity, Cable, Server } from "lucide-react";

const CLUSTER_NAMES = {};  // optional display names per cluster id

export function HealthPanel({ variant = "card" }) {
  const health = usePolling("/api/health", 30_000);
  const clusters = Object.entries(health?.clusters || {});
  const problems = [
    health && !health.cursor?.ok,
    health && health.claude && !health.claude.ok,
    health && !health.broker?.ok,
    ...clusters.map(([, c]) => !c.api?.ok),
  ].filter(Boolean).length;

  if (!health) {
    return (
      <div className="flex items-center gap-2 rounded-2xl border bg-card p-6 text-sm text-muted-foreground">
        <span className="agent-dots text-primary" aria-hidden><i /><i /><i /></span>
        در حال بررسی مسیرها…
      </div>
    );
  }

  if (variant === "page") {
    return (
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-3">
          <Dot state={problems ? "warn" : "ok"} large />
          <div>
            <h2 className="text-lg font-semibold">سلامت مسیرها</h2>
            <p className="text-sm text-muted-foreground">
              {problems ? `${problems} مسیر مشکل دارد` : "همهٔ مسیرها سالم‌اند"}
              {health.stale ? " · اتصال به سرور قطع است" : ""}
            </p>
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <StatusCard
            icon={Activity}
            title="Cursor"
            check={health.cursor}
          />
          <StatusCard
            icon={Activity}
            title="Claude"
            check={health.claude || { ok: false, error: "نامشخص" }}
          />
          <StatusCard
            icon={Cable}
            title="کارگزار ابزارها"
            check={health.broker}
          />
        </div>

        <section className="overflow-hidden rounded-2xl border bg-card shadow-sm">
          <div className="flex items-center gap-2 border-b px-4 py-3">
            <Server className="size-4 text-muted-foreground" />
            <h3 className="font-medium">کلاسترها</h3>
          </div>
          <div className="grid grid-cols-[1.2fr_1fr_1fr] gap-2 border-b bg-muted/40 px-4 py-2 text-xs text-muted-foreground">
            <span>کلاستر</span>
            <span className="text-center">API</span>
            <span className="text-center">اضطراری</span>
          </div>
          <ul>
            {clusters.map(([name, c]) => (
              <li key={name} className="grid grid-cols-[1.2fr_1fr_1fr] items-center gap-2 border-b px-4 py-3 last:border-b-0">
                <span className="font-medium">{CLUSTER_NAMES[name] || name}</span>
                <CheckCell check={c.api} />
                <CheckCell check={c.emergency} emptyLabel="تعریف نشده" />
              </li>
            ))}
          </ul>
        </section>
        {health.stale ? <p className="text-sm text-warn">اتصال به سرور گریفین قطع است.</p> : null}
      </div>
    );
  }

  // Compact card (legacy)
  return (
    <section className="rounded-2xl border bg-card p-4 text-sm shadow-sm">
      <div className="mb-3 flex items-center gap-2">
        <Dot state={problems ? "warn" : "ok"} />
        <h2 className="font-medium">سلامت مسیرها</h2>
        <span className="ms-auto text-xs text-muted-foreground">
          {problems ? `${problems} مسیر مشکل دارد` : "همه سالم"}
        </span>
      </div>
      <div className="space-y-1.5">
        <Row label="Cursor" check={health.cursor} />
        <Row label="Claude" check={health.claude || { ok: false, error: "نامشخص" }} />
        <Row label="کارگزار ابزارها" check={health.broker} />
      </div>
    </section>
  );
}

function StatusCard({ icon: Icon, title, check }) {
  const ok = !!check?.ok;
  return (
    <div className={`rounded-2xl border p-4 shadow-sm ${ok ? "bg-card" : "border-bad/40 bg-bad/5"}`}>
      <div className="flex items-start gap-3">
        <span className={`flex size-10 items-center justify-center rounded-xl ${ok ? "bg-ok/15 text-ok" : "bg-bad/15 text-bad"}`}>
          <Icon className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="font-medium">{title}</p>
          <p className={`mt-0.5 text-sm ${ok ? "text-ok" : "text-bad"}`}>
            {ok ? "سالم" : check?.error || "قطع"}
          </p>
        </div>
        {check?.ms != null ? <span className="ltr text-xs text-muted-foreground">{check.ms}ms</span> : null}
      </div>
    </div>
  );
}

function CheckCell({ check, emptyLabel }) {
  if (!check) {
    return <span className="text-center text-xs text-muted-foreground">{emptyLabel || "—"}</span>;
  }
  return (
    <span title={title(check)} className="flex items-center justify-center gap-1.5 text-sm">
      <Dot state={check.ok ? "ok" : "bad"} />
      <span className={check.ok ? "text-ok" : "text-bad"}>{check.ok ? "سالم" : "قطع"}</span>
      {check.ms != null ? <span className="ltr text-[11px] text-muted-foreground">{check.ms}ms</span> : null}
    </span>
  );
}

function Row({ label, check }) {
  return (
    <div className="flex items-center gap-2" title={title(check)}>
      <Dot state={check?.ok ? "ok" : "bad"} />
      <span>{label}</span>
      {check?.ms ? <span className="ltr ms-auto text-muted-foreground">{check.ms}ms</span> : null}
    </div>
  );
}

function Dot({ state, large = false }) {
  const color = state === "ok" ? "bg-ok" : state === "warn" ? "bg-warn" : state === "bad" ? "bg-bad" : "bg-muted-foreground/40";
  return <span className={`inline-block rounded-full ${color} ${large ? "size-3" : "size-2"}`} />;
}

function title(check) {
  if (!check) return "";
  return check.ok ? `OK ${check.status ?? ""} ${check.ms ?? ""}ms` : `${check.error || "down"}`;
}
