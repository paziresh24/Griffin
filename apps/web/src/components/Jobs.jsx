import { useCallback, useEffect, useState } from "react";
import { Dialog, Switch } from "radix-ui";
import { AnimatePresence, motion } from "motion/react";
import { AlarmClock, ArrowRight, CalendarClock, Check, ChevronDown, Clock, Loader2, MessageSquare, Play, Plus, Send, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { api, navigate } from "../api.js";
import { agentMeta } from "../brand.js";
import { AgentPicker } from "./Controls.jsx";

const EVERY_PRESETS = ["5m", "15m", "30m", "1h", "3h", "6h", "12h", "1d"];

const STATUS = {
  running: ["bg-primary animate-pulse", "در حال اجرا"],
  finished: ["bg-ok", "موفق"],
  error: ["bg-bad", "خطا"],
  cancelled: ["bg-warn", "متوقف"],
  skipped: ["bg-muted-foreground", "رد شد"],
};

const time = (iso) => (iso ? new Date(iso).toLocaleString("fa-IR", { dateStyle: "short", timeStyle: "short" }) : "—");

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
          <button type="button" onClick={onBack} className="press flex size-8 items-center justify-center rounded-full hover:bg-muted" aria-label="بازگشت">
            <ArrowRight className="size-4" />
          </button>
          <h1 className="text-lg font-semibold">جاب‌ها</h1>
          <button type="button" onClick={() => setEditing({})} className="press ms-auto flex items-center gap-1.5 rounded-full bg-primary px-3.5 py-2 text-sm font-medium text-primary-foreground shadow-sm hover:shadow">
            <Plus className="size-4" /> جاب جدید
          </button>
        </div>
        <p className="mb-5 text-sm leading-6 text-muted-foreground">
          کارهایی که گریفین خودش زمان‌بندی می‌کند. هر جاب یک دستور + یک ایجنت است؛ در گفتگوی جدا اجرا می‌شود و جواب — با نمودار و فایل — به پیام‌رسان‌هایی که انتخاب کردی می‌رود.
        </p>

        {!data ? (
          <div className="flex justify-center py-16"><Loader2 className="size-5 animate-spin text-muted-foreground" /></div>
        ) : data.jobs.length === 0 ? (
          <button type="button" onClick={() => setEditing({})} className="press flex w-full flex-col items-center gap-2 rounded-2xl border border-dashed py-12 text-muted-foreground hover:border-primary/60 hover:text-foreground">
            <AlarmClock className="size-6" />
            هنوز جابی نداری — مثلاً «هر نیم ساعت نمودار مصرف منابع گیت‌لب»
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
    if (!window.confirm(`جاب «${job.name}» و گفتگوهای اجراهایش حذف شوند؟`)) return;
    call(`/api/jobs/${job.id}`, "DELETE");
  };

  const [color, label] = STATUS[job.running ? "running" : job.lastRun?.status] || ["bg-muted-foreground/50", "هنوز اجرا نشده"];
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
            {job.description}
          </p>
        </div>
        <button type="button" onClick={() => call(`/api/jobs/${job.id}/run`, "POST")} disabled={busy || job.running} className="press flex items-center gap-1 rounded-full border px-3 py-1.5 text-xs hover:bg-muted disabled:opacity-50">
          {job.running ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5" />} اجرا
        </button>
        <Switch.Root
          checked={job.enabled}
          disabled={busy}
          onCheckedChange={(enabled) => patch({ enabled })}
          dir="ltr"
          className="relative h-6 w-11 shrink-0 rounded-full bg-muted transition-colors data-[state=checked]:bg-primary"
          aria-label="فعال"
        >
          <Switch.Thumb className="block size-5 translate-x-0.5 rounded-full bg-background shadow transition-transform duration-200 data-[state=checked]:translate-x-[1.375rem]" />
        </Switch.Root>
      </div>

      <p className="mt-3 line-clamp-2 rounded-lg bg-muted/50 px-3 py-2 text-xs leading-5 text-muted-foreground" dir="auto">{job.prompt}</p>

      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {job.enabled && job.nextAt ? <span className="flex items-center gap-1"><Clock className="size-3.5" /> اجرای بعدی {time(job.nextAt)}</span> : null}
        {names.length ? <span className="flex items-center gap-1"><Send className="size-3.5" /> {names.join("، ")}</span> : <span className="text-warn">مقصدی انتخاب نشده</span>}
      </div>

      {job.lastRun?.error ? <p className="ltr mt-3 rounded-lg bg-bad/10 px-3 py-2 text-xs text-bad" dir="auto">{job.lastRun.error}</p> : null}

      <div className="mt-3 flex items-center gap-1 border-t pt-2 text-xs">
        <button type="button" onClick={() => setOpen(!open)} className="press flex items-center gap-1 rounded-lg px-2 py-1.5 text-muted-foreground hover:bg-muted hover:text-foreground">
          <ChevronDown className={`size-3.5 transition-transform ${open ? "rotate-180" : ""}`} /> تاریخچه
        </button>
        <button type="button" onClick={onEdit} className="press rounded-lg px-2 py-1.5 text-muted-foreground hover:bg-muted hover:text-foreground">ویرایش</button>
        <button type="button" onClick={remove} className="press ms-auto flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-muted-foreground hover:bg-bad/10 hover:text-bad">
          <Trash2 className="size-3.5" /> حذف
        </button>
      </div>

      {open ? (
        <ul className="space-y-1 border-t pt-2 text-xs">
          {!runs ? <li className="py-2 text-center text-muted-foreground">…</li> : null}
          {runs?.length === 0 ? <li className="py-2 text-center text-muted-foreground">هنوز اجرایی نبوده.</li> : null}
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
                    <MessageSquare className="size-3.5" /> گفتگو
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
      toast.success(editing ? "جاب ذخیره شد" : "جاب ساخته شد");
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
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/40 backdrop-blur-[2px] data-[state=open]:animate-[fade-in_150ms]" />
        <Dialog.Content className="pop fixed left-1/2 top-1/2 z-50 max-h-[90dvh] w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-2xl border bg-card p-5 shadow-2xl">
          <div className="mb-4 flex items-center">
            <Dialog.Title className="font-semibold">{editing ? "ویرایش جاب" : "جاب جدید"}</Dialog.Title>
            <Dialog.Close className="press ms-auto rounded-full p-1.5 hover:bg-muted" aria-label="بستن"><X className="size-4" /></Dialog.Close>
          </div>
          <form onSubmit={submit} className="space-y-4">
            <label className="block">
              <span className="mb-1 block text-xs text-muted-foreground">نام</span>
              <input value={form.name} onChange={(e) => set({ name: e.target.value })} required placeholder="وضعیت منابع گیت‌لب" className={input} />
            </label>

            <label className="block">
              <span className="mb-1 block text-xs text-muted-foreground">دستور به ایجنت</span>
              <textarea value={form.prompt} onChange={(e) => set({ prompt: e.target.value })} required rows={4} dir="auto" placeholder="مصرف CPU و مموری پادهای یک اپ را در ۶ ساعت گذشته نمودار بکش و خلاصهٔ کوتاه بده." className={`${input} resize-y leading-6`} />
            </label>

            <div>
              <span className="mb-1 block text-xs text-muted-foreground">کدام ایجنت اجرا کند</span>
              <AgentPicker agent={form.agent || "griffin"} onChange={(agent) => set({ agent })} className="w-full" />
            </div>

            <div>
              <span className="mb-1 block text-xs text-muted-foreground">تریگر</span>
              <div className="flex gap-2">
                {kinds.map((kind) => (
                  <button key={kind.type} type="button" onClick={() => set({ triggerType: kind.type })} className={`press flex-1 rounded-xl border px-3 py-2 text-xs ${form.triggerType === kind.type ? "border-primary bg-primary/8 ring-1 ring-primary" : "hover:bg-muted"}`}>
                    {kind.label}
                  </button>
                ))}
              </div>
            </div>

            {form.triggerType === "schedule" ? (
              <div className="space-y-2 rounded-xl bg-muted/50 p-3">
                <div className="flex gap-2 text-xs">
                  {[["every", "هر چند وقت"], ["cron", "cron"]].map(([key, label]) => (
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
                <p className="text-[11px] text-muted-foreground">ساعت تهران. «هر ۳۰ دقیقه» روی :۰۰ و :۳۰ می‌افتد.</p>
              </div>
            ) : null}

            <div>
              <span className="mb-1 block text-xs text-muted-foreground">جواب کجا برود</span>
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
                <p className="rounded-lg bg-muted/50 px-3 py-2 text-xs text-muted-foreground">هنوز گفتگوی وصل‌شده‌ای نداری. اول در «اتصال‌ها» ربات را با کد وصل کن.</p>
              )}
            </div>

            <div className="grid grid-cols-3 gap-2">
              <label className="block">
                <span className="mb-1 block text-[11px] text-muted-foreground">ارسال</span>
                <select value={form.delivery.notify} onChange={(e) => set({ delivery: { ...form.delivery, notify: e.target.value } })} className={input}>
                  <option value="always">همیشه</option>
                  <option value="error">فقط خطا</option>
                  <option value="never">هرگز</option>
                </select>
              </label>
              <label className="block">
                <span className="mb-1 block text-[11px] text-muted-foreground">سقف زمان (دقیقه)</span>
                <input type="number" min={1} max={120} value={form.options.timeoutMinutes} onChange={(e) => set({ options: { ...form.options, timeoutMinutes: Number(e.target.value) } })} className={`ltr ${input}`} />
              </label>
              <label className="block">
                <span className="mb-1 block text-[11px] text-muted-foreground">نگهداری اجرا</span>
                <input type="number" min={1} max={200} value={form.options.keepRuns} onChange={(e) => set({ options: { ...form.options, keepRuns: Number(e.target.value) } })} className={`ltr ${input}`} />
              </label>
            </div>

            <button type="submit" disabled={busy} className="press flex w-full items-center justify-center gap-2 rounded-xl bg-primary py-2.5 font-medium text-primary-foreground disabled:opacity-50">
              {busy ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />} {editing ? "ذخیره" : "ساختن جاب"}
            </button>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
