import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openStore } from "../src/db.mjs";
import { nextCron, nextInterval, parseCron, parseDuration, tzOffsetMs } from "../src/jobs/cron.mjs";
import { createJobs, jobMessage } from "../src/jobs/index.mjs";
import { createRunner } from "../src/runner.mjs";
import { describeTrigger, nextTriggerAt, validateTrigger } from "../src/jobs/triggers.mjs";
import { seedExampleAgents } from "./fixture-agents.mjs";

const TZ = "Asia/Tehran";

function setup({ answer = "مصرف مموری گیت‌لب ۳٫۲ گیگ است.", hang = false, timeoutMs = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "griffin-jobs-"));
  const store = openStore(path.join(dir, "db.sqlite"));
  seedExampleAgents(store);
  const prompts = [];
  const sdk = {
    async create() {
      return {
        agentId: "a1",
        async send(message, options) {
          prompts.push(typeof message === "string" ? message : message.text);
          let cancelled = false;
          return {
            id: "r",
            supports: () => true,
            async cancel() { cancelled = true; },
            async wait() {
              if (hang) {
                for (let i = 0; i < 200 && !cancelled; i += 1) await new Promise((r) => setTimeout(r, 10));
                return { status: "cancelled" };
              }
              await options.onDelta({ update: { type: "text-delta", text: answer } });
              return { status: "finished" };
            },
          };
        },
      };
    },
    resume: (_id, options) => sdk.create(options),
  };
  const runner = createRunner({ store, sdk, agentOptions: async () => ({}), log: { error() {} } });
  const delivered = [];
  const jobs = createJobs({
    store,
    runner,
    deliver: async (chatId, targets, meta) => {
      delivered.push({ chatId, targets, meta });
      return targets.map((t) => ({ ...t, ok: true }));
    },
    log: { error() {} },
    tickMs: 10_000,
    ...(timeoutMs ? { timeoutFor: () => timeoutMs } : {}),
  });
  return { store, jobs, runner, prompts, delivered };
}

test("cron and interval are computed in Tehran wall-clock time", () => {
  assert.equal(tzOffsetMs(new Date("2026-09-16T00:00:00Z"), TZ), 3.5 * 3_600_000);
  // 09:14 local -> next half hour is 09:30 local = 06:00Z
  assert.equal(nextInterval(parseDuration("30m"), new Date("2026-09-16T05:44:00Z"), TZ).toISOString(), "2026-09-16T06:00:00.000Z");
  assert.equal(nextInterval(parseDuration("30m"), new Date("2026-09-16T06:00:00Z"), TZ).toISOString(), "2026-09-16T06:30:00.000Z");
  assert.equal(nextCron("0,30 * * * *", new Date("2026-09-16T05:44:00Z"), TZ).toISOString(), "2026-09-16T06:00:00.000Z");
  // 08:00 local on the 1st of the month = 04:30Z
  assert.equal(nextCron("0 8 1 * *", new Date("2026-09-16T05:44:00Z"), TZ).toISOString(), "2026-10-01T04:30:00.000Z");
  assert.deepEqual([...parseCron("*/15 * * * *")[0].values], [0, 15, 30, 45]);
  assert.throws(() => parseCron("* * *"), /۵ بخش/);
  assert.throws(() => parseDuration("30x"), /30m/);
  assert.throws(() => parseDuration("10s"), /یک دقیقه/);
});

test("trigger registry validates and describes without knowing the job", () => {
  assert.deepEqual(validateTrigger("schedule", { every: "30m" }), { every: "30m", tz: TZ });
  assert.deepEqual(validateTrigger("schedule", { cron: "0,30  *  * * *" }), { cron: "0,30 * * * *", tz: TZ });
  assert.equal(describeTrigger("schedule", { every: "30m" }), "هر 30 دقیقه");
  assert.equal(nextTriggerAt("manual", {}), null);
  assert.throws(() => validateTrigger("carrier-pigeon", {}), /نمی‌شناسم/);
});

test("a due job runs the agent in its own chat and delivers the answer", async () => {
  const { store, jobs, prompts, delivered } = setup();
  const job = jobs.create({
    name: "منابع گیت‌لب",
    prompt: "مصرف منابع گیت‌لب را نمودار بکش.",
    triggerType: "schedule",
    trigger: { every: "30m" },
    delivery: { targets: [{ integrationId: "i1", chat: "42" }] },
  });
  assert.ok(job.nextAt, "scheduling fills the next due time");

  // Make it due and tick the scheduler.
  store.updateJob(job.id, { nextAt: new Date(Date.now() - 1000).toISOString() });
  jobs.tick();
  await waitFor(() => store.lastJobRun(job.id)?.status === "finished");

  const run = store.lastJobRun(job.id);
  assert.equal(run.trigger, "schedule");
  assert.equal(delivered.length, 1);
  assert.deepEqual(delivered[0].targets, [{ integrationId: "i1", chat: "42" }]);
  assert.equal(delivered[0].chatId, run.chatId);
  assert.match(prompts[0], /اجرای خودکار «منابع گیت‌لب»/);
  assert.match(prompts[0], /ask_owner نپرس/);
  assert.match(prompts[0], /مصرف منابع گیت‌لب را نمودار بکش\./);
  // The job's chat stays out of the sidebar but is reachable from the run.
  assert.equal(store.listChats({ archived: false }).length, 0);
  assert.equal(store.getChat(run.chatId).job_id, job.id);
  assert.equal(store.getChat(run.chatId).agent, "griffin");
  assert.equal(store.getChat(run.chatId).caller, "scheduler");
  // …and the next run is scheduled again.
  assert.ok(new Date(store.getJob(job.id).nextAt) > new Date());
});

test("a job can run as griffin (or another agent with a scheduler quota)", async () => {
  const { store, jobs } = setup();
  const job = jobs.create({
    name: "با گریفین",
    prompt: "خلاصه بده",
    agent: "griffin",
    triggerType: "manual",
  });
  assert.equal(job.agent, "griffin");
  await jobs.run(job.id, "manual");
  const run = store.lastJobRun(job.id);
  assert.equal(run.status, "finished");
  assert.equal(store.getChat(run.chatId).agent, "griffin");
});

test("job rejects an agent without a scheduler quota", () => {
  const { jobs } = setup();
  assert.throws(() => jobs.create({ name: "x", prompt: "y", agent: "not-an-agent", triggerType: "manual" }), /نمی‌شناسم|سهمیه/);
});

test("manual runs work, overlapping runs are skipped, and only the newest runs are kept", async () => {
  const { store, jobs } = setup();
  const job = jobs.create({ name: "دستی", prompt: "سلام", triggerType: "manual", options: { keepRuns: 2 } });
  assert.equal(job.nextAt, null, "a manual job never becomes due on its own");

  for (let i = 0; i < 3; i += 1) await jobs.run(job.id, "manual");
  const runs = store.listJobRuns(job.id, 10);
  assert.equal(runs.length, 2, "older runs are pruned");
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM chats").get().n, 2, "pruned runs take their chats with them");

  jobs.tick();
  assert.equal(store.listJobRuns(job.id, 10).length, 2, "a manual job is not started by the scheduler");
});

test("a run that overruns its timeout is cancelled and still reported", async () => {
  const { store, jobs, delivered } = setup({ hang: true, timeoutMs: 80 });
  const job = jobs.create({
    name: "کند",
    prompt: "طولانی",
    triggerType: "manual",
    delivery: { targets: [{ integrationId: "i1", chat: "42" }], notify: "error" },
  });
  await jobs.run(job.id, "manual");
  const run = store.lastJobRun(job.id);
  assert.equal(run.status, "error");
  assert.match(run.error, /بیشتر طول کشید/);
  assert.equal(delivered.length, 1, "notify=error delivers exactly when the run did not finish");
  assert.equal(jobs.isRunning(job.id), false);
});

test("notify=always delivers a finished run, notify=error stays quiet", async () => {
  const { jobs, delivered } = setup();
  const quiet = jobs.create({ name: "ساکت", prompt: "کار", triggerType: "manual", delivery: { targets: [{ integrationId: "i1", chat: "42" }], notify: "error" } });
  await jobs.run(quiet.id, "manual");
  assert.equal(delivered.length, 0);
  const loud = jobs.create({ name: "پرحرف", prompt: "کار", triggerType: "manual", delivery: { targets: [{ integrationId: "i1", chat: "42" }] } });
  await jobs.run(loud.id, "manual");
  assert.equal(delivered.length, 1);
});

test("a job cannot run twice at once", async () => {
  const { store, jobs, runner } = setup({ hang: true, timeoutMs: 5_000 });
  const job = jobs.create({ name: "هم‌زمان", prompt: "کار", triggerType: "manual" });
  const first = jobs.run(job.id, "manual");
  await waitFor(() => jobs.isRunning(job.id));
  await jobs.run(job.id, "manual");
  assert.equal(store.listJobRuns(job.id, 10).find((r) => r.status === "skipped")?.error, "اجرای قبلی هنوز تمام نشده بود");
  await runner.cancel(store.listJobRuns(job.id, 10).find((r) => r.chatId).chatId);
  await first;
});

test("jobMessage keeps the owner's prompt verbatim", () => {
  assert.match(jobMessage({ name: "n", prompt: "متن اصلی" }), /متن اصلی$/);
});

function waitFor(check, ms = 4000) {
  const end = Date.now() + ms;
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (check()) return resolve();
      if (Date.now() > end) return reject(new Error("timeout"));
      setTimeout(tick, 10);
    };
    tick();
  });
}
