import { DEFAULT_AGENT, resolveAgentId } from "../agents/registry.mjs";
import { formatLocal } from "./cron.mjs";
import { describeTrigger, nextTriggerAt, TRIGGERS, TriggerError, triggerKinds, validateTrigger } from "./triggers.mjs";

// A job is a saved prompt plus a trigger and a delivery list. When it fires, the job gets its own
// chat (hidden from the sidebar, listed under the job), the agent answers there exactly as it would
// for the owner, and the finished answer — text, files and charts — is delivered to the chosen
// messenger chats. Nobody is watching a job run, so the run is told not to ask questions and is
// cancelled when it takes too long.

const DEFAULT_TIMEOUT_MINUTES = 15;
const DEFAULT_KEEP_RUNS = 20;
const MAX_PROMPT = 8_000;

export function jobMessage(job) {
  return `[اجرای خودکار «${job.name}»] این پیام را زمان‌بند گریفین فرستاده، نه Owner. کسی پشت چت نیست: ask_owner نپرس و منتظر تأیید نمان؛ اگر جایی مبهم بود معقول‌ترین فرض را بگیر و در جواب بنویس که چه فرضی گرفتی. جواب نهایی باید کوتاه و آمادهٔ خواندن در پیام‌رسان باشد.\n\n${job.prompt}`;
}

export function createJobs({
  store,
  runner,
  deliver = async () => [],
  log = console,
  tickMs = 30_000,
  now = () => new Date(),
  timeoutFor = (job) => (job.options.timeoutMinutes || DEFAULT_TIMEOUT_MINUTES) * 60_000,
}) {
  const running = new Map(); // jobId -> { chatId, jobRunId }
  let timer = null;
  let stopped = false;

  function schedule(job, from = now()) {
    const next = job.enabled ? nextTriggerAt(job.triggerType, job.trigger, from) : null;
    const nextAt = next ? next.toISOString() : null;
    if (nextAt !== job.nextAt) return store.updateJob(job.id, { nextAt });
    return job;
  }

  function waitForRun(chatId, timeoutMs) {
    return new Promise((resolve) => {
      let timeout = null;
      const onEvent = (event) => {
        if (event.type !== "run.finished") return;
        cleanup();
        resolve({ status: event.data?.status || "error", error: event.data?.error || null });
      };
      const cleanup = () => {
        clearTimeout(timeout);
        store.bus.off(`chat:${chatId}`, onEvent);
      };
      store.bus.on(`chat:${chatId}`, onEvent);
      timeout = setTimeout(() => {
        cleanup();
        runner.cancel(chatId).catch(() => {});
        resolve({ status: "error", error: `از ${Math.round(timeoutMs / 60000)} دقیقه بیشتر طول کشید و متوقف شد` });
      }, timeoutMs);
    });
  }

  async function execute(job, trigger) {
    if (running.has(job.id)) {
      const run = store.startJobRun({ jobId: job.id, chatId: null, trigger });
      store.finishJobRun(run, { status: "skipped", error: "اجرای قبلی هنوز تمام نشده بود" });
      return store.listJobRuns(job.id, 1)[0];
    }
    const startedAt = now();
    const chat = store.createChat({
      title: `${job.name} — ${formatLocal(startedAt)}`,
      model: job.model,
      mode: job.mode === "plan" ? "plan" : "agent",
      jobId: job.id,
      caller: "scheduler",
      agent: resolveAgentId(job.agent),
    });
    const jobRunId = store.startJobRun({ jobId: job.id, chatId: chat.id, trigger });
    running.set(job.id, { chatId: chat.id, jobRunId });
    try {
      await runner.send(chat.id, { text: jobMessage(job), images: [] });
      const outcome = await waitForRun(chat.id, timeoutFor(job));
      const notify = job.delivery.notify || "always";
      const targets = Array.isArray(job.delivery.targets) ? job.delivery.targets : [];
      const shouldDeliver = targets.length && (notify === "always" || (notify === "error" && outcome.status !== "finished"));
      let delivery = null;
      if (shouldDeliver) {
        delivery = await deliver(chat.id, targets, { job, status: outcome.status }).catch((error) => [{ ok: false, error: error.message }]);
      }
      const summary = summarize(store, chat.id);
      store.finishJobRun(jobRunId, {
        status: outcome.status === "finished" ? "finished" : outcome.status || "error",
        error: outcome.error,
        summary,
        delivery,
      });
    } catch (error) {
      log.error?.(`[jobs] ${job.name}: ${error.message}`);
      store.finishJobRun(jobRunId, { status: "error", error: error.message });
    } finally {
      running.delete(job.id);
      store.pruneJobRuns(job.id, job.options.keepRuns || DEFAULT_KEEP_RUNS);
    }
    return store.listJobRuns(job.id, 1)[0];
  }

  function tick() {
    const at = now();
    for (const job of store.listJobs()) {
      if (!job.enabled || running.has(job.id)) continue;
      if (!job.nextAt) {
        // A job that was just enabled, or whose trigger changed, has no due time yet.
        if (nextTriggerAt(job.triggerType, job.trigger, at)) schedule(job, at);
        continue;
      }
      if (new Date(job.nextAt) > at) continue;
      schedule(job, at);
      execute(store.getJob(job.id), "schedule").catch((error) => log.error?.(`[jobs] ${job.id}: ${error.message}`));
    }
  }

  return {
    // Called by the HTTP layer and, later, by other trigger sources.
    async run(jobId, trigger = "manual") {
      const job = store.getJob(jobId);
      if (!job) return null;
      return execute(job, trigger);
    },

    isRunning: (jobId) => running.has(jobId),
    get: (jobId) => store.getJob(jobId),

    create(input) {
      const job = store.createJob(prepare(input, null, store));
      return schedule(job);
    },

    update(id, patch) {
      const current = store.getJob(id);
      if (!current) return null;
      const next = store.updateJob(id, prepare({ ...current, ...patch }, current, store));
      return schedule(next);
    },

    remove(id) {
      return store.deleteJob(id) > 0;
    },

    view: (job) => view(store, job, running),
    list: () => store.listJobs().map((job) => view(store, job, running)),
    runs: (jobId, limit) => store.listJobRuns(jobId, limit),
    kinds: triggerKinds,

    start() {
      if (timer) return;
      // Anything still marked running belongs to a previous process.
      for (const job of store.listJobs()) {
        for (const run of store.listJobRuns(job.id, 5)) {
          if (run.status === "running") store.finishJobRun(run.id, { status: "cancelled", error: "به‌خاطر ری‌استارت سرور قطع شد" });
        }
        // Recomputing nextAt from "now" on every boot postpones a daily job by a full day per
        // restart, and this app restarts most days — the job never becomes due. Keep any due
        // time the job already has: a future one is honored, an overdue one is left for the
        // first tick to fire as a missed catch-up instead of silently skipping a whole interval.
        if (job.enabled && job.nextAt) continue;
        schedule(job);
      }
      timer = setInterval(() => {
        if (!stopped) tick();
      }, tickMs);
      timer.unref?.();
    },

    tick,

    stop() {
      stopped = true;
      clearInterval(timer);
      timer = null;
    },
  };
}

// Normalizes and validates what the UI sent. Throws TriggerError with a Persian message.
function prepare(input, current = null, store = null) {
  const name = String(input.name ?? current?.name ?? "").trim();
  if (!name) throw new TriggerError("نام جاب لازم است");
  const prompt = String(input.prompt ?? current?.prompt ?? "").trim();
  if (!prompt) throw new TriggerError("متن دستور جاب لازم است");
  if (prompt.length > MAX_PROMPT) throw new TriggerError("متن دستور خیلی بلند است");
  const triggerType = String(input.triggerType ?? current?.triggerType ?? "schedule");
  if (!TRIGGERS[triggerType]) throw new TriggerError(`تریگر «${triggerType}» را نمی‌شناسم`);
  const targets = (Array.isArray(input.delivery?.targets) ? input.delivery.targets : [])
    .map((t) => ({ integrationId: String(t.integrationId || ""), chat: String(t.chat || "") }))
    .filter((t) => t.integrationId && t.chat)
    .slice(0, 10);
  const notify = ["always", "error", "never"].includes(input.delivery?.notify) ? input.delivery.notify : "always";
  let agent;
  if (input.agent !== undefined && input.agent !== null && String(input.agent).trim()) {
    agent = String(input.agent).trim();
  } else {
    agent = resolveAgentId(current?.agent ?? DEFAULT_AGENT);
  }
  const profile = store?.getAgentProfile?.(agent);
  if (!profile) throw new TriggerError(`ایجنت «${agent}» را نمی‌شناسم`);
  if (!profile.meta?.callers?.scheduler) {
    throw new TriggerError(`ایجنت «${profile.label}» برای جاب زمان‌بند سهمیه ندارد`);
  }
  return {
    name: name.slice(0, 80),
    prompt,
    model: input.model === undefined ? current?.model ?? null : input.model || null,
    mode: input.mode === "plan" ? "plan" : "agent",
    agent,
    triggerType,
    trigger: validateTrigger(triggerType, input.trigger ?? current?.trigger),
    delivery: { targets, notify },
    options: {
      timeoutMinutes: clamp(input.options?.timeoutMinutes, 1, 120, DEFAULT_TIMEOUT_MINUTES),
      keepRuns: clamp(input.options?.keepRuns, 1, 200, DEFAULT_KEEP_RUNS),
    },
    enabled: input.enabled === undefined ? current?.enabled ?? true : Boolean(input.enabled),
  };
}

function clamp(value, min, max, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
}

function summarize(store, chatId) {
  const charts = store.listCharts(chatId).length;
  const media = (store.listMedia?.(chatId) || []).length;
  const parts = [];
  if (charts) parts.push(`${charts} نمودار`);
  if (media) parts.push(`${media} فایل`);
  return parts.join(" · ") || null;
}

function view(store, job, running) {
  const last = store.lastJobRun(job.id);
  return {
    ...job,
    running: running.has(job.id),
    description: describeTrigger(job.triggerType, job.trigger),
    lastRun: last,
  };
}
