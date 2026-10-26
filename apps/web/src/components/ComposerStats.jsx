import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Popover } from "radix-ui";
import { api } from "../api.js";
import { loadLevel } from "../host-health.js";
import { isRtl, num, t } from "../i18n.js";

// The server's live resources (GET /api/host) behind the sidebar's alert line (HostNotice), and the
// composer's ring for the chat's context window with the plan limits behind it
// (GET /api/chats/:id/context, GET /api/usage). There is no resources gauge in the composer: the
// alerts say what matters.
// Styles: .kc-usage-* in styles.css.

const fa = (n) => num(Number(n || 0));
const round1 = (n) => (Number.isFinite(n) ? Math.round(n * 10) / 10 : "—");
const gb = (bytes) => round1((bytes || 0) / 1024 ** 3);
// Status colours (green / orange / red), whatever the install's palette (host-health.js).
const level = loadLevel;

function Bar({ percent, warnings = true }) {
  return (
    <div className="kc-usage-bar" data-level={warnings ? level(percent) : undefined} aria-hidden>
      <span style={{ width: `${Math.max(0, Math.min(100, percent || 0))}%` }} />
    </div>
  );
}

function uptime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 60) return "—";
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const parts = [];
  if (d) parts.push(t("{n} روز", { n: fa(d) }));
  if (h) parts.push(t("{n} ساعت", { n: fa(h) }));
  if (!d && m) parts.push(t("{n} دقیقه", { n: fa(m) }));
  return parts.join(t(" و "));
}

// Polls while the tab is visible; faster while the details are open.
export function useHost(open, slow = 10_000) {
  const [host, setHost] = useState(null);
  const load = useCallback(() => api("/api/host").then(setHost, () => setHost({ available: false })), []);
  useEffect(() => {
    load();
    const timer = setInterval(() => document.visibilityState !== "hidden" && load(), open ? 5_000 : slow);
    return () => clearInterval(timer);
  }, [load, open]);
  return host;
}

// The details behind the sidebar's line when the server is busy (HostNotice).
export function HostDetails({ host }) {
  const down = host?.available === false;
  return (
    <section>
      <div className="kc-usage-head kc-usage-title">
        <span>{t("منابع سرور")}</span>
        {host?.uptimeS ? <span className="kc-usage-num font-normal">{t("کارکرد {time}", { time: uptime(host.uptimeS) })}</span> : null}
      </div>
      {!host ? (
        <div className="kc-note">{t("در حال خواندن…")}</div>
      ) : down ? (
        <div className="kc-note">{t("در دسترس نیست")}</div>
      ) : (
        <>
          <div className="kc-usage-limit">
            <div className="kc-usage-head">
              <span>{t("پردازنده")}</span>
              <span className="ltr kc-usage-num">{round1(host.cpu?.percent)}% · {t("{n} هسته", { n: fa(host.cpu?.cores) })}</span>
            </div>
            <Bar percent={host.cpu?.percent} />
          </div>
          <div className="kc-usage-limit">
            <div className="kc-usage-head">
              <span>{t("حافظه")}</span>
              <span className="ltr kc-usage-num">{gb(host.memory?.used)} / {gb(host.memory?.total)} GB ({host.memory?.percent}%)</span>
            </div>
            <Bar percent={host.memory?.percent} />
          </div>
          {host.disk ? (
            <div className="kc-usage-limit">
              <div className="kc-usage-head">
                <span>{t("دیسک")}</span>
                <span className="ltr kc-usage-num">{gb(host.disk.used)} / {gb(host.disk.total)} GB{host.disk.percent == null ? "" : ` (${host.disk.percent}%)`}</span>
              </div>
              <Bar percent={host.disk.percent} />
              <div className="kc-usage-head">
                <span className="kc-note">{t("آزاد")}</span>
                <span className="ltr kc-usage-num">{gb(host.disk.available)} GB</span>
              </div>
            </div>
          ) : null}
          {Array.isArray(host.load) ? (
            <div className="kc-usage-head">
              <span className="kc-note">{t("بار سیستم")}</span>
              <span className="ltr kc-usage-num">{host.load.map(round1).join(" · ")}</span>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}

function resetIn(at) {
  const ms = new Date(at).getTime() - Date.now();
  if (!at || !Number.isFinite(ms) || ms <= 0) return null;
  const h = Math.floor(ms / 3_600_000);
  const m = Math.round((ms % 3_600_000) / 60_000);
  return h >= 24 ? t("{n} روز", { n: fa(Math.floor(h / 24)) }) : h ? t("{h} ساعت و {m} دقیقه", { h: fa(h), m: fa(m) }) : t("{n} دقیقه", { n: fa(m) });
}
const windowPercent = (w) => (w.percentage != null ? Math.round(Number(w.percentage)) : w.limit ? Math.round((Number(w.used) / Number(w.limit)) * 100) : null);
const tokens = (n) => (n >= 1e6 ? `${round1(n / 1e6)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n || 0));

// The plan windows (GET /api/usage), one copy for every ring on the page: read when a ring first
// shows and again every two minutes while the tab is visible, so a tap opens on numbers already
// there (a colleague 2026-10-24: it only started reading once opened, and showed nothing quickly).
const PLAN_EVERY_MS = 2 * 60_000;
const plan = { data: null, at: 0, loading: null, listeners: new Set(), timer: null };
function loadPlan(force = false) {
  if (plan.loading || (!force && plan.data && Date.now() - plan.at < 60_000)) return plan.loading;
  plan.loading = api("/api/usage")
    .then((data) => data, () => plan.data || { providers: [] })
    .then((data) => {
      plan.data = data;
      plan.at = Date.now();
      plan.loading = null;
      for (const listener of plan.listeners) listener();
    });
  return plan.loading;
}
function subscribePlan(onChange) {
  plan.listeners.add(onChange);
  loadPlan();
  plan.timer ??= setInterval(() => document.visibilityState !== "hidden" && loadPlan(true), PLAN_EVERY_MS);
  return () => {
    plan.listeners.delete(onChange);
    if (!plan.listeners.size) {
      clearInterval(plan.timer);
      plan.timer = null;
    }
  };
}
const usePlan = () => useSyncExternalStore(subscribePlan, () => plan.data, () => null);

const planWindows = (usage) => (usage?.providers || []).flatMap((p) => (p.windows || []).map((w) => ({ ...w, pct: windowPercent(w), provider: p.id, engine: p.label || p.id })));
// The fullest plan window, for the ring's tooltip and its second colour.
const worstWindow = (windows) => windows.reduce((worst, w) => (w.pct != null && (!worst || w.pct > worst.pct) ? w : worst), null);

// The ring: how full this chat's context window is, with its number beside it; the popover adds the
// plan's windows, by engine.
export function UsageRing({ chatId, running }) {
  const [open, setOpen] = useState(false);
  const [context, setContext] = useState(null);
  const usage = usePlan();
  const sawRun = useRef(false);
  const loadContext = useCallback(() => {
    if (!chatId) return setContext(null);
    return api(`/api/chats/${chatId}/context`).then(setContext, () => setContext({ available: false }));
  }, [chatId]);
  useEffect(() => {
    setContext(null);
    loadContext();
  }, [loadContext]);
  // After each turn the window has grown and the plan has been used: read both again.
  useEffect(() => {
    if (running) sawRun.current = true;
    else if (sawRun.current) {
      sawRun.current = false;
      loadContext();
      loadPlan(true);
    }
  }, [running, loadContext]);
  const onOpenChange = (next) => {
    setOpen(next);
    if (next) {
      loadContext();
      loadPlan(); // what is there shows at once; a stale copy is read again behind it
    }
  };
  const hasContext = Boolean(context?.available);
  const percent = hasContext ? context.percent : 0;
  const circumference = 2 * Math.PI * 6;
  const windows = planWindows(usage);
  const worst = worstWindow(windows);
  const engines = [...new Set(windows.map((w) => w.engine))];
  const title = [hasContext ? t("پنجرهٔ زمینه {fa}٪", { fa: fa(percent) }) : t("پنجرهٔ زمینه"), worst ? t("{label} {fa}٪", { label: worst.label, fa: fa(worst.pct) }) : null].filter(Boolean).join(" · ");
  return (
    <Popover.Root open={open} onOpenChange={onOpenChange}>
      <Popover.Trigger asChild>
        <button type="button" className="kc-usage-trigger gap-1 text-muted-foreground hover:text-foreground" aria-label={t("مصرف: {n}٪ از پنجرهٔ زمینه", { n: fa(percent) })} title={t({title})}>
          <svg viewBox="0 0 16 16" className="kc-usage-ring" data-level={level(percent)} aria-hidden>
            <circle cx="8" cy="8" r="6" />
            <circle cx="8" cy="8" r="6" data-fill="" strokeDasharray={`${(percent / 100) * circumference} ${circumference}`} />
          </svg>
          {hasContext ? <span className="text-[11px] tabular-nums">{t("{fa}٪", { fa: fa(percent) })}</span> : null}
          {worst && level(worst.pct) !== "ok" ? <span className="kc-usage-dot" data-level={level(worst.pct)} aria-hidden /> : null}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="end"
          side="top"
          sideOffset={6}
          collisionPadding={16}
          className="g-menu pop kc-usage scrollbar-thin z-50 overflow-y-auto overscroll-contain rounded-xl border bg-card shadow-xl"
          style={{ maxHeight: "min(32rem, var(--radix-popover-content-available-height))" }}
          dir={isRtl ? "rtl" : "ltr"}
        >
          <section>
            <div className="kc-usage-head">
              <span className="kc-usage-title">{t("پنجرهٔ زمینه")}</span>
              {hasContext ? <span className="kc-usage-big ltr">{t("{fa}٪", { fa: fa(context.percent) })}</span> : null}
            </div>
            {!chatId ? (
              <div className="kc-note">{t("پس از اولین پیام نمایش داده می‌شود")}</div>
            ) : !context ? (
              <div className="kc-note">{t("در حال خواندن…")}</div>
            ) : !hasContext ? (
              <div className="kc-note">{t("پس از پیامِ بعدی نمایش داده می‌شود")}</div>
            ) : (
              <>
                <Bar percent={context.percent} />
                <div className="kc-note ltr text-end">
                  {tokens(context.used)} / {tokens(context.window)}
                </div>
              </>
            )}
          </section>
          <div className="my-2.5 h-px bg-border" />
          <section>
            <div className="kc-usage-title">{t("سهمیهٔ پلن")}</div>
            {!usage ? (
              <div className="kc-note">{t("در حال خواندن…")}</div>
            ) : windows.length ? (
              engines.map((engine) => (
                <div key={engine} className="kc-usage-engine">
                  {engines.length > 1 ? <div className="kc-note font-medium" dir="auto">{engine}</div> : null}
                  {windows
                    .filter((w) => w.engine === engine)
                    .map((w, i) => (
                      <div key={i} className="kc-usage-limit">
                        <div className="kc-usage-head">
                          <span>{w.label}</span>
                          <span className="ltr kc-usage-num">{w.pct == null ? "—" : t("{fa}٪", { fa: fa(w.pct) })}</span>
                        </div>
                        <Bar percent={w.pct} />
                        {resetIn(w.resetAt) ? <div className="kc-note">{t("تازه می‌شود تا {time}", { time: resetIn(w.resetAt) })}</div> : null}
                      </div>
                    ))}
                </div>
              ))
            ) : (
              <div className="kc-note">{(usage.providers || []).find((p) => p.error)?.error || t("موتور فعلی سهمیهٔ پلن گزارش نمی‌دهد.")}</div>
            )}
          </section>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
