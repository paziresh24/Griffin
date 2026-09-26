import { Bot, Cable, Radar, Server, Sparkles } from "lucide-react";
import { usePolling } from "../api.js";
import { Group, Item } from "./SettingsParts.jsx";

const CLUSTER_NAMES = {}; // optional display names per cluster id
const OPS_MODES = { record: "فقط ثبت", shadow: "سایه (بدون ارسال)", live: "فعال", off: "خاموش" };

// A provider with no key/URL is a choice, not an outage: shown muted and not counted as a problem.
const notConfigured = (check) => /^no .*(api key|base url)/i.test(String(check?.error || ""));

function stateOf(check) {
  if (!check) return "none";
  if (check.ok) return "ok";
  return notConfigured(check) ? "none" : "bad";
}

export function StatusSection() {
  const health = usePolling("/api/health", 15_000);

  if (!health) {
    return (
      <div className="flex items-center gap-2 rounded-2xl border bg-card p-5 text-sm text-muted-foreground">
        <span className="agent-dots text-primary" aria-hidden><i /><i /><i /></span>
        در حال بررسی…
      </div>
    );
  }

  const providers = [
    ["Cursor", health.cursor],
    ["Claude", health.claude],
    ["OpenAI", health.openai],
  ].filter(([, check]) => check);
  const clusters = Object.entries(health.clusters || {});
  const ops = health.ops;
  const opsBad = Boolean(ops && ops.mode !== "off" && (ops.error || (ops.lastPollAt && !ops.lastOkAt)));
  const problems = [
    ...providers.map(([, c]) => stateOf(c) === "bad"),
    !health.broker?.ok,
    ...clusters.map(([, c]) => !c.api?.ok),
    opsBad,
  ].filter(Boolean).length;
  const warn = problems || health.stale;

  return (
    <div className="space-y-6">
      <div className={`flex items-center gap-3 rounded-2xl border px-4 py-3.5 ${warn ? "border-warn/40 bg-warn/8" : "border-ok/30 bg-ok/8"}`}>
        <Dot state={warn ? "warn" : "ok"} large />
        <div className="min-w-0 flex-1">
          <p className="font-medium">{health.stale ? "اتصال به سرور قطع است" : problems ? `${problems.toLocaleString("fa")} مورد نیاز به توجه دارد` : "همه‌چیز سالم است"}</p>
          <p className="text-xs text-muted-foreground">
            {health.activeRuns ? `${health.activeRuns.toLocaleString("fa")} کار در حال اجرا` : "کاری در حال اجرا نیست"} · هر ۱۵ ثانیه به‌روز می‌شود
          </p>
        </div>
      </div>

      <Group title="مدل‌ها">
        {providers.map(([name, check]) => (
          <Item key={name} icon={name === "Cursor" ? Sparkles : Bot} title={name} trailing={<Check check={check} />} />
        ))}
      </Group>

      <Group title="زیرساخت">
        <Item icon={Cable} title="کارگزار ابزارها" trailing={<Check check={health.broker} />} />
        {ops ? (
          <Item
            icon={Radar}
            title="دریافت هشدارها"
            subtitle={[
              OPS_MODES[ops.mode] || ops.mode,
              ops.openIncidents ? `${ops.openIncidents} حادثهٔ باز` : null,
              ops.lastOkAt ? `آخرین خواندن ${ago(ops.lastOkAt)}` : "هنوز خوانده نشده",
            ].filter(Boolean).join(" · ")}
            trailing={<Pill state={ops.mode === "off" ? "none" : opsBad ? "bad" : "ok"} title={ops.error || ""}>{ops.mode === "off" ? "خاموش" : opsBad ? "خطا" : "فعال"}</Pill>}
          />
        ) : null}
      </Group>

      {clusters.length ? (
        <Group title="کلاسترها">
          {clusters.map(([name, c]) => (
            <Item
              key={name}
              icon={Server}
              title={CLUSTER_NAMES[name] || name}
              trailing={
                <>
                  <Pill state={stateOf(c.api)} title={tip(c.api)}>API</Pill>
                  <Pill state={c.emergency ? stateOf(c.emergency) : "none"} title={c.emergency ? tip(c.emergency) : "تعریف نشده"}>اضطراری</Pill>
                </>
              }
            />
          ))}
        </Group>
      ) : null}
    </div>
  );
}

function Check({ check }) {
  const state = stateOf(check);
  const label = state === "ok" ? "سالم" : state === "none" ? "پیکربندی نشده" : "قطع";
  return (
    <>
      {state === "ok" && check?.ms != null ? <span className="ltr text-[11px] text-muted-foreground">{check.ms}ms</span> : null}
      <Pill state={state} title={tip(check)}>{label}</Pill>
    </>
  );
}

export function Pill({ state, title, children }) {
  const tone = state === "ok" ? "bg-ok/12 text-ok" : state === "bad" ? "bg-bad/12 text-bad" : state === "warn" ? "bg-warn/15 text-warn" : "bg-muted text-muted-foreground";
  return (
    <span title={title} className={`inline-flex max-w-48 items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium ${tone}`}>
      <Dot state={state} />
      <span className="truncate">{children}</span>
    </span>
  );
}

export function Dot({ state, large = false }) {
  const color = state === "ok" ? "bg-ok" : state === "warn" ? "bg-warn" : state === "bad" ? "bg-bad" : "bg-muted-foreground/40";
  return <span className={`inline-block shrink-0 rounded-full ${color} ${large ? "size-2.5" : "size-1.5"}`} />;
}

function tip(check) {
  if (!check) return "";
  return check.ok ? `OK ${check.status ?? ""} ${check.ms ?? ""}ms` : String(check.error || "down");
}

function ago(at) {
  const s = Math.max(0, Math.round((Date.now() - new Date(at).getTime()) / 1000));
  if (s < 60) return "همین حالا";
  if (s < 3600) return `${Math.round(s / 60)} دقیقه پیش`;
  return `${Math.round(s / 3600)} ساعت پیش`;
}
