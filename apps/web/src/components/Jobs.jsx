import { useCallback, useEffect, useState } from "react";
import { Dialog, Switch } from "radix-ui";
import { AnimatePresence, motion } from "motion/react";
import { AlarmClock, ArrowRight, CalendarClock, Check, ChevronDown, Clock, Loader2, Lock, MessageSquare, Play, Plus, Send, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { api, navigate } from "../api.js";
import { BRAND, agentMeta } from "../brand.js";
import { AgentPicker, MODES } from "./Controls.jsx";
import { t } from "../i18n.js";

// A job's mode: the chat's mode list (Controls.jsx) plus «محدود» (owner 2026-10-19). What each means in
// a job, which nobody watches while it runs (jobs/owner-jobs.mjs); a job someone else wrote is always
// «محدود».
const JOB_HINTS = {
  agent: t("همهٔ ابزارهای گفتگوهای خودتان؛ هیچ چیزی نمی‌پرسد"),
  auto: t("همان ابزارها؛ کار حساس را از شما می‌پرسد و تا ۳۰ دقیقه منتظر جواب می‌ماند"),
  ask: t("همان ابزارها؛ کار حساس را از شما می‌پرسد و تا ۳۰ دقیقه منتظر جواب می‌ماند"),
  edits: t("همان ابزارها؛ کار حساس را از شما می‌پرسد و تا ۳۰ دقیقه منتظر جواب می‌ماند"),
  plan: t("فقط نقشهٔ کار را می‌نویسد و تغییری نمی‌دهد"),
  limited: t("سهمیهٔ محدود زمان‌بند؛ کار حساس را بدون پرسیدن رد می‌کند"),
};
const JOB_MODES = [...MODES.map((m) => ({ ...m, hint: JOB_HINTS[m.value] || m.hint })), { value: "limited", label: t("محدود"), icon: Lock, hint: JOB_HINTS.limited }];

function JobModePicker({ mode, onChange }) {
  const current = JOB_MODES.find((m) => m.value === mode) || JOB_MODES.find((m) => m.value === "agent");
  return (
    <div>
      <div className="flex flex-wrap gap-1.5">
        {JOB_MODES.map((m) => {
          const Icon = m.icon;
          const on = m.value === current.value;
          return (
            <button key={m.value} type="button" onClick={() => onChange(m.value)} title={m.hint} className={`press flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs ${on ? "border-primary bg-primary/10" : "hover:bg-muted"}`}>
              <Icon className="size-3.5" />
              {m.label}
            </button>
          );
        })}
      </div>
      <p className="mt-1 text-[11px] text-muted-foreground">{current.hint}</p>
    </div>
  );
}

// The server describes a schedule in Persian ("هر 30 دقیقه"); show it in the UI language.
const EVERY = /^هر (\d+) (دقیقه|ساعت|روز)$/; // i18n-ignore
function scheduleText(text) {
  const m = EVERY.exec(String(text || ""));
  if (!m) return t(text || "");
  const n = num(m[1]);
  return m[2] === "روز" ? t("هر {n} روز", { n }) : m[2] === "ساعت" ? t("هر {n} ساعت", { n }) : t("هر {n} دقیقه", { n }); // i18n-ignore
}

const EVERY_PRESETS = ["5m", "15m", "30m", "1h", "3h", "6h", "12h", "1d"];

const STATUS = {
  running: ["bg-signal animate-pulse", t("در حال اجرا")],
  held: ["bg-warn animate-pulse", t("منتظر برگشت موتور — بعدش یک بار اجرا می‌شود")],
  finished: ["bg-ok", t("موفق")],
  error: ["bg-bad", t("خطا")],
  cancelled: ["bg-warn", t("متوقف")],
  skipped: ["bg-muted-foreground", t("رد شد")],
};

const time = (iso) => (iso ? new Date(iso).toLocaleString(locale, { dateStyle: "short", timeStyle: "short" }) : "—");

export function JobsPage({ onBack }) {
  const [data, setData] = useState(null);
  const [editing, setEditing] = useState(null);

  const load = useCallback(() => api("/api/jobs").then(setData, (e) => toast.error(e.message)), []);
  useEffect(() => {
    load();
    const timer = setInterval(load, 5000);
    return () => clearInterval(timer);
  }, [load]);

  return (
    <div className="scrollbar-thin h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-2xl px-4 pb-16 pt-4 sm:px-6">
        <div className="mb-6 flex items-center gap-2">
          <button type="button" onClick={onBack} className="press flex size-8 items-center justify-center rounded-full hover:bg-muted" aria-label={t("بازگشت")}>
            <ArrowRight className="size-4 rtl-mirror" />
          </button>
          <h1 className="text-lg font-semibold">{t("جاب‌ها")}</h1>
          <button type="button" onClick={() => setEditing({})} className="press ms-auto flex items-center gap-1.5 rounded-full bg-primary px-3.5 py-2 text-sm font-medium text-primary-foreground shadow-sm hover:shadow">
            <Plus className="size-4" /> {t("جاب جدید")}
          </button>
        </div>
        <p className="mb-5 text-sm leading-6 text-muted-foreground">
          {t("کارهایی که {name} خودش زمان‌بندی می‌کند. هر جاب یک دستور + یک ایجنت است؛ در گفتگوی جدا اجرا می‌شود و جواب — با نمودار و فایل — به پیام‌رسان‌هایی که انتخاب کردی می‌رود.", { name: BRAND.name })}
        </p>

        {!data ? (
          <div className="flex justify-center py-16"><Loader2 className="size-5 animate-spin text-muted-foreground" /></div>
        ) : data.jobs.length === 0 ? (
          <button type="button" onClick={() => setEditing({})} className="press flex w-full flex-col items-center gap-2 rounded-2xl border border-dashed py-12 text-muted-foreground hover:border-primary/60 hover:text-foreground">
            <AlarmClock className="size-6" />
            {t("هنوز جابی نداری — مثلاً «هر دوشنبه صبح خلاصهٔ هفته را برایم بفرست»")}
          </button>
        ) : (
          <motion.ul layout className="space-y-3">
            <AnimatePresence initial={false}>
              {data.jobs.map((job) => (
                <motion.li key={job.id} layout initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, scale: 0.97 }}>
                  <JobCard job={job} targets={data.targets} onChange={load} onEdit={() => setEditing(job)} />
                </motion.li>
              ))}
            </AnimatePresence>
          </motion.ul>
        )}
      </div>
      <JobDialog job={editing} kinds={data?.kinds || []} targets={data?.targets || []} onClose={() => setEditing(null)} onSaved={load} />
    </div>
  );
}

function JobCard({ job, targets, onChange, onEdit }) {
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [runs, setRuns] = useState(null);

  const loadRuns = useCallback(() => api(`/api/jobs/${job.id}/runs`).then((r) => setRuns(r.runs), () => {}), [job.id]);
  useEffect(() => {
    if (!open) return undefined;
    loadRuns();
    const timer = setInterval(loadRuns, 5000);
    return () => clearInterval(timer);
  }, [open, loadRuns]);

  const call = async (path, method) => {
    setBusy(true);
    try {
      await api(path, { method });
      await onChange();
      if (open) loadRuns();
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  };

  const patch = async (body) => {
    setBusy(true);
    try {
      await api(`/api/jobs/${job.id}`, { method: "PATCH", body });
      await onChange();
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  };

  const remove = () => {
    if (!window.confirm(t("جاب «{name}» و گفتگوهای اجراهایش حذف شوند؟", { name: job.name }))) return;
    call(`/api/jobs/${job.id}`, "DELETE");
  };

  const [color, label] = STATUS[job.running ? "running" : job.held ? "held" : job.lastRun?.status] || ["bg-muted-foreground/50", t("هنوز اجرا نشده")];
  const names = (job.delivery?.targets || []).map((t) => targets.find((x) => x.integrationId === t.integrationId && x.chat === t.chat)?.name || t.chat);
  const who = agentMeta(job.agent || "platform");

  return (
    <div className="rounded-2xl border bg-card p-4 shadow-sm">
      <div className="flex items-center gap-3">
        <span className="flex size-10 items-center justify-center rounded-xl bg-primary/12 text-primary"><CalendarClock className="size-5" /></span>
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium" dir="auto">{job.name}</p>
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className={`size-2 rounded-full ${color}`} /> {label}
            <span>·</span>
            <span style={{ color: who.color }}>{who.short || who.label}</span>
            <span>·</span>
            {scheduleText(job.description)}
          </p>
        </div>
        <button type="button" onClick={() => call(`/api/jobs/${job.id}/run`, "POST")} disabled={busy || job.running} className="press flex items-center gap-1 rounded-full border px-3 py-1.5 text-xs hover:bg-muted disabled:opacity-50">
          {job.running ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5" />} {t("اجرا")}
        </button>
        <Switch.Root
          checked={job.enabled}
          disabled={busy}
          onCheckedChange={(enabled) => patch({ enabled })}
          dir="ltr"
          className="relative h-6 w-11 shrink-0 rounded-full bg-muted transition-colors data-[state=checked]:bg-primary"
          aria-label={t("فعال")}
        >
          <Switch.Thumb className="block size-5 translate-x-0.5 rounded-full bg-background shadow transition-transform duration-200 data-[state=checked]:translate-x-[1.375rem]" />
        </Switch.Root>
      </div>

      <p className="mt-3 line-clamp-2 rounded-lg bg-muted/50 px-3 py-2 text-xs leading-5 text-muted-foreground" dir="auto">{job.prompt}</p>

      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {job.enabled && job.nextAt ? <span className="flex items-center gap-1"><Clock className="size-3.5" /> {t("اجرای بعدی {when}", { when: time(job.nextAt) })}</span> : null}
        {names.length ? <span className="flex items-center gap-1"><Send className="size-3.5" /> {names.join(t("، "))}</span> : <span className="text-warn">{t("مقصدی انتخاب نشده")}</span>}
      </div>

      {job.lastRun?.error ? <p className="ltr mt-3 rounded-lg bg-bad/10 px-3 py-2 text-xs text-bad" dir="auto">{job.lastRun.error}</p> : null}

      <div className="mt-3 flex items-center gap-1 border-t pt-2 text-xs">
        <button type="button" onClick={() => setOpen(!open)} className="press flex items-center gap-1 rounded-lg px-2 py-1.5 text-muted-foreground hover:bg-muted hover:text-foreground">
          <ChevronDown className={`size-3.5 transition-transform ${open ? "rotate-180" : ""}`} /> {t("تاریخچه")}
        </button>
        <button type="button" onClick={onEdit} className="press rounded-lg px-2 py-1.5 text-muted-foreground hover:bg-muted hover:text-foreground">{t("ویرایش")}</button>
        <button type="button" onClick={remove} className="press ms-auto flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-muted-foreground hover:bg-bad/10 hover:text-bad">
          <Trash2 className="size-3.5" /> {t("حذف")}
        </button>
      </div>

      {open ? (
        <ul className="space-y-1 border-t pt-2 text-xs">
          {!runs ? <li className="py-2 text-center text-muted-foreground">…</li> : null}
          {runs?.length === 0 ? <li className="py-2 text-center text-muted-foreground">{t("هنوز اجرایی نبوده.")}</li> : null}
          {runs?.map((run) => {
            const [dot, text] = STATUS[run.status] || ["bg-muted-foreground", run.status];
            return (
              <li key={run.id} className="flex items-center gap-2 py-1">
                <span className={`size-2 shrink-0 rounded-full ${dot}`} />
                <span className="w-28 shrink-0 text-muted-foreground">{time(run.startedAt)}</span>
                <span className="shrink-0">{text}</span>
                <span className="truncate text-muted-foreground" dir="auto">{run.error || run.summary || ""}</span>
                {run.chatId ? (
                  <button type="button" onClick={() => navigate(run.chatId)} className="press ms-auto flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-muted-foreground hover:bg-muted hover:text-foreground">
                    <MessageSquare className="size-3.5" /> {t("گفتگو")}
                  </button>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}

const EMPTY = {
  name: "",
  prompt: "",
  agent: "griffin",
  mode: "agent",
  triggerType: "schedule",
  trigger: { every: "30m" },
  delivery: { targets: [], notify: "always" },
  options: { timeoutMinutes: 15, keepRuns: 20 },
  enabled: true,
};

function JobDialog({ job, kinds, targets, onClose, onSaved }) {
  const [form, setForm] = useState(EMPTY);
  const [mode, setMode] = useState("every");
  const [busy, setBusy] = useState(false);
  const editing = Boolean(job?.id);

  useEffect(() => {
    if (!job) return;
    const next = { ...EMPTY, ...job, trigger: { ...job.trigger }, delivery: { ...EMPTY.delivery, ...job.delivery }, options: { ...EMPTY.options, ...job.options } };
    setForm(next);
    setMode(next.trigger?.cron ? "cron" : "every");
  }, [job]);

  const set = (patch) => setForm((f) => ({ ...f, ...patch }));
  const toggleTarget = (target) => {
    const has = form.delivery.targets.some((t) => t.integrationId === target.integrationId && t.chat === target.chat);
    set({
      delivery: {
        ...form.delivery,
        targets: has
          ? form.delivery.targets.filter((t) => !(t.integrationId === target.integrationId && t.chat === target.chat))
          : [...form.delivery.targets, { integrationId: target.integrationId, chat: target.chat }],
      },
    });
  };

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    try {
      const trigger = form.triggerType !== "schedule" ? {} : mode === "cron" ? { cron: form.trigger.cron || "" } : { every: form.trigger.every || "30m" };
      const body = { ...form, trigger };
      await api(editing ? `/api/jobs/${job.id}` : "/api/jobs", { method: editing ? "PATCH" : "POST", body });
      toast.success(editing ? t("جاب ذخیره شد") : t("جاب ساخته شد"));
      onClose();
      onSaved();
    } catch (error) {
      toast.error(error.message);
    } finally {
      setBusy(false);
    }
  };

  const input = "w-full rounded-lg border bg-background px-3 py-2 text-sm outline-none focus:border-primary";
  return (
    <Dialog.Root open={Boolean(job)} onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/40 backdrop-blur-[2px] overlay" />
        <Dialog.Content className="pop fixed left-1/2 top-1/2 z-50 max-h-[90dvh] w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-2xl border bg-card p-5 shadow-2xl">
          <div className="mb-4 flex items-center">
            <Dialog.Title className="font-semibold">{editing ? t("ویرایش جاب") : t("جاب جدید")}</Dialog.Title>
            <Dialog.Close className="press ms-auto rounded-full p-1.5 hover:bg-muted" aria-label={t("بستن")}><X className="size-4" /></Dialog.Close>
          </div>
          <form onSubmit={submit} className="space-y-4">
            <label className="block">
              <span className="mb-1 block text-xs text-muted-foreground">{t("نام")}</span>
              <input value={form.name} onChange={(e) => set({ name: e.target.value })} required placeholder={t("خلاصهٔ هفتگی")} className={input} />
            </label>

            <label className="block">
              <span className="mb-1 block text-xs text-muted-foreground">{t("دستور به ایجنت")}</span>
              <textarea value={form.prompt} onChange={(e) => set({ prompt: e.target.value })} required rows={4} dir="auto" placeholder={t("کارهای هفتهٔ گذشته را در پنج خط خلاصه کن و آنچه هنوز باز مانده را جدا بگو.")} className={`${input} resize-y leading-6`} />
            </label>

            <div>
              <span className="mb-1 block text-xs text-muted-foreground">{t("کدام ایجنت اجرا کند")}</span>
              <AgentPicker agent={form.agent || "griffin"} onChange={(agent) => set({ agent })} className="w-full" />
            </div>

            <div>
              <span className="mb-1 block text-xs text-muted-foreground">{t("حالت اجرا")}</span>
              <JobModePicker mode={form.mode || "agent"} onChange={(mode) => set({ mode })} />
            </div>

            <div>
              <span className="mb-1 block text-xs text-muted-foreground">{t("تریگر")}</span>
              <div className="flex gap-2">
                {kinds.map((kind) => (
                  <button key={kind.type} type="button" onClick={() => set({ triggerType: kind.type })} className={`press flex-1 rounded-xl border px-3 py-2 text-xs ${form.triggerType === kind.type ? "border-primary bg-primary/8 ring-1 ring-primary" : "hover:bg-muted"}`}>
                    {t(kind.label)}
                  </button>
                ))}
              </div>
            </div>

            {form.triggerType === "schedule" ? (
              <div className="space-y-2 rounded-xl bg-muted/50 p-3">
                <div className="flex gap-2 text-xs">
                  {[["every", t("هر چند وقت")], ["cron", "cron"]].map(([key, label]) => (
                    <button key={key} type="button" onClick={() => setMode(key)} className={`press rounded-full px-3 py-1 ${mode === key ? "bg-primary text-primary-foreground" : "hover:bg-background"}`}>{label}</button>
                  ))}
                </div>
                {mode === "every" ? (
                  <div className="flex flex-wrap gap-1.5">
                    {EVERY_PRESETS.map((value) => (
                      <button key={value} type="button" onClick={() => set({ trigger: { every: value } })} className={`press ltr rounded-lg border px-2.5 py-1 font-mono text-xs ${form.trigger.every === value ? "border-primary bg-primary/10" : "hover:bg-background"}`}>{value}</button>
                    ))}
                    <input value={form.trigger.every || ""} onChange={(e) => set({ trigger: { every: e.target.value } })} placeholder="30m" className={`ltr w-24 font-mono ${input} py-1`} />
                  </div>
                ) : (
                  <input value={form.trigger.cron || ""} onChange={(e) => set({ trigger: { cron: e.target.value } })} placeholder="0,30 * * * *" className={`ltr font-mono ${input}`} />
                )}
                <p className="text-[11px] text-muted-foreground">{t("به وقت سرور (GRIFFIN_TZ). «هر ۳۰ دقیقه» روی :۰۰ و :۳۰ می‌افتد.")}</p>
              </div>
            ) : null}

            <div>
              <span className="mb-1 block text-xs text-muted-foreground">{t("جواب کجا برود")}</span>
              {targets.length ? (
                <div className="space-y-1">
                  {targets.map((target) => {
                    const checked = form.delivery.targets.some((t) => t.integrationId === target.integrationId && t.chat === target.chat);
                    return (
                      <button
                        key={`${target.integrationId}:${target.chat}`}
                        type="button"
                        onClick={() => toggleTarget(target)}
                        className={`press flex w-full items-center gap-2 rounded-lg border px-3 py-2 text-sm ${checked ? "border-primary bg-primary/8" : "hover:bg-muted"}`}
                      >
                        <span className={`flex size-4 items-center justify-center rounded border ${checked ? "border-primary bg-primary text-primary-foreground" : ""}`}>{checked ? <Check className="size-3" /> : null}</span>
                        <span dir="auto">{target.name}</span>
                        <span className="ms-auto text-xs text-muted-foreground">{target.integrationName}</span>
                      </button>
                    );
                  })}
                </div>
              ) : (
                <p className="rounded-lg bg-muted/50 px-3 py-2 text-xs text-muted-foreground">{t("هنوز گفتگوی وصل‌شده‌ای نداری. اول در «اتصال‌ها» ربات را با کد وصل کن.")}</p>
              )}
            </div>

            <div className="grid grid-cols-3 gap-2">
              <label className="block">
                <span className="mb-1 block text-[11px] text-muted-foreground">{t("ارسال")}</span>
                <select value={form.delivery.notify} onChange={(e) => set({ delivery: { ...form.delivery, notify: e.target.value } })} className={input}>
                  <option value="always">{t("همیشه")}</option>
                  <option value="error">{t("فقط خطا")}</option>
                  <option value="never">{t("هرگز")}</option>
                </select>
              </label>
              <label className="block">
                <span className="mb-1 block text-[11px] text-muted-foreground">{t("سقف زمان (دقیقه)")}</span>
                <input type="number" min={1} max={120} value={form.options.timeoutMinutes} onChange={(e) => set({ options: { ...form.options, timeoutMinutes: Number(e.target.value) } })} className={`ltr ${input}`} />
              </label>
              <label className="block">
                <span className="mb-1 block text-[11px] text-muted-foreground">{t("نگهداری اجرا")}</span>
                <input type="number" min={1} max={200} value={form.options.keepRuns} onChange={(e) => set({ options: { ...form.options, keepRuns: Number(e.target.value) } })} className={`ltr ${input}`} />
              </label>
            </div>

            <button type="submit" disabled={busy} className="press flex w-full items-center justify-center gap-2 rounded-xl bg-primary py-2.5 font-medium text-primary-foreground disabled:opacity-50">
              {busy ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />} {editing ? t("ذخیره") : t("ساختن جاب")}
            </button>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
