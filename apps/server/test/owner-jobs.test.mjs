import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openStore } from "../src/db.mjs";
import { createAsks } from "../src/asks.mjs";
import { forgetDecisions, guardTools } from "../src/guard.mjs";
import { createJobs } from "../src/jobs/index.mjs";
import { createJobTools } from "../src/jobs/tools.mjs";
import { jobRoutes } from "../src/jobs/routes.mjs";
import { claudeCodeOptions, createOwnerJobs, jobChatMode, jobWriterOf, migrateJobModes, ownerWroteJob, runAccess } from "../src/jobs/owner-jobs.mjs";
import { createClaudeProvider } from "../src/providers/claude.mjs";
import { griffinStatePaths } from "../src/providers/state-guard.mjs";
import { noteOwnerAnswer } from "../src/guard.mjs";
import { thirdPartyKey } from "../src/related.mjs";
import { createChatTrust } from "../src/knowledge-trust.mjs";

// Gap 3 (Karsara → Griffin): a job the owner wrote runs with his attended tools unless its mode is
// «محدود»; in an asking mode its gated calls ask him and are never approved for him, in «بدون پرسیدن»
// nothing asks; a job whose prompt another chain wrote stays unattended.

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "griffin-owner-jobs-"));
  const store = openStore(path.join(dir, "db.sqlite"));
  const runner = { send: async () => {}, cancel: async () => {} };
  const jobs = createJobs({ store, runner, log: { error() {}, warn() {}, info() {} }, tickMs: 60_000, timeoutFor: () => 150, pollMs: 10 });
  const trust = createChatTrust({ store });
  const toolsIn = (chatId) => createJobTools({ jobs, targets: () => [], chatId });
  return { store, jobs, trust, toolsIn, cleanup: () => { jobs.stop(); store.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}
const payload = (out) => JSON.parse(out.content[0].text);
const ownerJobsOf = (env, extra = {}) => createOwnerJobs({ store: env.store, ownerRooted: (id) => env.trust.ownerRooted(id), ...extra });
const jobChat = (env, job) => env.store.createChat({ title: "run", jobId: job.id, caller: "scheduler" });

test("writer: jobs_create from a chat records that chat; the jobs page records the owner; a same-prompt edit keeps it", async () => {
  const env = setup();
  try {
    const own = env.store.createChat({ title: "mine" });
    const created = payload(await env.toolsIn(own.id).jobs_create.execute({ name: "گزارش", prompt: "دیسک را چک کن", every: "1h" }));
    assert.equal(env.jobs.get(created.id).options.promptChatId, own.id);

    const colleague = env.store.createChat({ title: "theirs", caller: "team" });
    await env.toolsIn(colleague.id).jobs_update.execute({ id: created.id, every: "2h" });
    assert.equal(env.jobs.get(created.id).options.promptChatId, colleague.id, "a schedule/agent/destination change steers the job too: that chat becomes the writer");
    await env.toolsIn(own.id).jobs_update.execute({ id: created.id, enabled: true });
    assert.equal(env.jobs.get(created.id).options.promptChatId, own.id);
    await env.toolsIn(colleague.id).jobs_update.execute({ id: created.id, prompt: "دیسک را چک کن" });
    assert.equal(env.jobs.get(created.id).options.promptChatId, colleague.id, "writing the prompt, even the same text, makes that chat the writer");

    env.jobs.update(created.id, { prompt: "حافظه را چک کن" });
    assert.equal(env.jobs.get(created.id).options.promptChatId, "owner", "the jobs page is the owner");
    env.jobs.update(created.id, { enabled: false });
    assert.equal(env.jobs.get(created.id).options.promptChatId, "owner");

    const page = env.jobs.create({ name: "صفحه", prompt: "سلام", triggerType: "manual" });
    assert.equal(page.options.promptChatId, "owner");
    const nochat = payload(await env.toolsIn(null).jobs_create.execute({ name: "x", prompt: "y", triggerType: "manual" }));
    assert.notEqual(env.jobs.get(nochat.id).options.promptChatId, "owner", "a tool with no chat is never the owner");
  } finally {
    env.cleanup();
  }
});

test("the jobs page body cannot name a prompt writer", async () => {
  const env = setup();
  try {
    const handlers = {};
    const app = new Proxy({}, { get: (_t, verb) => (route, handler) => (handlers[`${verb} ${route}`] = handler) });
    jobRoutes(app, env.jobs);
    const ctx = (body, id) => ({ get: (k) => (k === "ownerVia" ? "cookie" : undefined), req: { json: async () => body, param: () => id }, json: (value) => value });
    const made = await handlers["post /api/jobs"](ctx({ name: "a", prompt: "b", triggerType: "manual", promptChatId: "someone" }));
    assert.equal(env.jobs.get(made.job.id).options.promptChatId, "owner");
    const colleague = env.store.createChat({ title: "theirs", caller: "team" });
    await env.toolsIn(colleague.id).jobs_update.execute({ id: made.job.id, prompt: "c" });
    await handlers["patch /api/jobs/:id"](ctx({ promptChatId: null }, made.job.id));
    assert.equal(env.jobs.get(made.job.id).options.promptChatId, colleague.id, "an empty writer in the body does not mark it the owner's");
  } finally {
    env.cleanup();
  }
});

test("fullTools: for jobs the owner's own chain wrote, unless the job is «محدود»", async () => {
  const env = setup();
  try {
    const own = env.store.createChat({ title: "mine" });
    const ownChild = env.store.createChat({ title: "sub", parentChatId: own.id, caller: "griffin" });
    const colleague = env.store.createChat({ title: "theirs", caller: "team" });
    const peer = env.store.createChat({ title: "peer", caller: "peer:someone" });
    const mk = async (chatId, name) => env.jobs.get(payload(await env.toolsIn(chatId).jobs_create.execute({ name, prompt: name, triggerType: "manual" })).id);
    const byOwner = await mk(own.id, "own");
    const byOwnChild = await mk(ownChild.id, "own-child");
    const byColleague = await mk(colleague.id, "colleague");
    const byPeer = await mk(peer.id, "peer");
    const byPage = env.jobs.create({ name: "page", prompt: "page", triggerType: "manual" });
    const legacy = env.store.createJob({ name: "old", prompt: "old", triggerType: "manual", trigger: {}, options: {} });
    const selfJobRun = jobChat(env, byPage);
    const bySelf = await mk(selfJobRun.id, "self"); // a job chat writing a job prompt

    const on = ownerJobsOf(env);
    for (const job of [byOwner, byOwnChild, byPage]) {
      const run = jobChat(env, job);
      assert.equal(on.fullTools(run.id), true, job.name);
      env.store.updateJob(job.id, { mode: "limited" });
      assert.equal(on.fullTools(run.id), false, `${job.name}: «محدود» runs on the scheduler's quota`);
      env.store.updateJob(job.id, { mode: "agent" });
      const sub = env.store.createChat({ title: "sub", parentChatId: run.id, caller: "griffin" });
      assert.equal(on.fullTools(sub.id), true, `${job.name}: a delegated child of the run too`);
    }
    for (const job of [byColleague, byPeer, legacy, bySelf]) assert.equal(on.fullTools(jobChat(env, job).id), false, job.name);
    assert.equal(on.fullTools(own.id), false, "not a job chat");
    const ops = env.store.createChat({ title: "ops", caller: "ops" });
    assert.equal(on.fullTools(ops.id), false, "the ops room is not a job");
  } finally {
    env.cleanup();
  }
});

test("writerVerdict is the hook for a Telegram-origin check: it may only veto, and gets the root id", () => {
  const job = (promptChatId) => ({ options: { promptChatId } });
  const store = { rootChatId: (id) => (id === "child" ? "root" : id), getKv: () => null };
  assert.equal(ownerWroteJob(job("c1"), { ownerRooted: () => true, writerVerdict: () => false }), false);
  assert.equal(ownerWroteJob(job("c1"), { ownerRooted: () => false, writerVerdict: () => true }), false, "a yes cannot make a chat the owner's");
  assert.equal(ownerWroteJob(job("c1"), { ownerRooted: () => true, writerVerdict: () => true }), true);
  assert.equal(ownerWroteJob(job("c1"), { ownerRooted: () => true, writerVerdict: () => null }), true);
  const seen = [];
  ownerWroteJob(job("child"), { store, ownerRooted: () => true, writerVerdict: (...args) => (seen.push(args), null) });
  assert.deepEqual(seen, [["root", "child"]]);
  assert.equal(ownerWroteJob(job("owner"), { writerVerdict: () => false }), true, "the jobs page needs no chat check");
  assert.equal(ownerWroteJob(job(undefined), { ownerRooted: () => true }), false);
});

test("runAccess: unchanged for every run except an owner job, which gets the owner's tools and an asking guard", () => {
  assert.deepEqual(runAccess({ rootCaller: "owner", unattended: false }), { asOwner: true, guardMode: null });
  assert.deepEqual(runAccess({ rootCaller: "scheduler", unattended: true }), { asOwner: false, guardMode: "refuse" });
  assert.deepEqual(runAccess({ rootCaller: "ops", unattended: true }), { asOwner: false, guardMode: "refuse" });
  assert.deepEqual(runAccess({ rootCaller: "peer:x", unattended: false }), { asOwner: false, guardMode: "ask" });
  assert.deepEqual(runAccess({ rootCaller: "team", unattended: false, coverage: true }), { asOwner: false, guardMode: null });
  assert.deepEqual(runAccess({ rootCaller: "scheduler", unattended: true, ownerJob: true }), { asOwner: true, guardMode: "ask" });
});

function jobAsks(env, ownerJobs, ownerJobAskMs) {
  return createAsks({ store: env.store, log: {}, ownerJobApprovals: (id) => ownerJobs.fullTools(id), ...(ownerJobAskMs ? { ownerJobAskMs } : {}) });
}

test("owner job: a gated call asks the owner and runs only on his yes", async () => {
  forgetDecisions();
  const env = setup();
  try {
    const job = env.jobs.create({ name: "page", prompt: "page", triggerType: "manual" });
    const run = jobChat(env, job);
    const asks = jobAsks(env, ownerJobsOf(env));
    let ran = 0;
    const tools = { mikrotik_remove: { async execute() { ran += 1; return { content: [] }; } } };
    const mode = runAccess({ rootCaller: "scheduler", unattended: true, ownerJob: true }).guardMode;
    const guarded = guardTools(tools, { chatId: run.id, asks, store: env.store, caller: "scheduler", mode });

    const yes = guarded.mikrotik_remove.execute({ id: "*7" });
    await new Promise((r) => setTimeout(r, 20));
    const open = asks.list().find((q) => q.rootChatId === run.id);
    assert.ok(open, "the approval reached the owner's open questions");
    assert.equal(ran, 0, "nothing ran before his answer");
    asks.answer(run.id, { answer: "بله", selected: ["بله"], askId: open.id });
    assert.equal((await yes).isError, undefined);
    assert.equal(ran, 1);

    const no = guarded.mikrotik_remove.execute({ id: "*8" });
    await new Promise((r) => setTimeout(r, 20));
    asks.answer(run.id, { answer: "نه", selected: ["نه"] });
    assert.equal((await no).isError, true);
    assert.equal(ran, 1);
  } finally {
    env.cleanup();
  }
});

test("owner job: an unanswered approval closes after the timeout and is not approved", async () => {
  forgetDecisions();
  const env = setup();
  try {
    const job = env.jobs.create({ name: "page", prompt: "page", triggerType: "manual" });
    const run = jobChat(env, job);
    const settled = [];
    const ownerJobs = ownerJobsOf(env);
    const asks = createAsks({ store: env.store, log: {}, ownerJobApprovals: (id) => ownerJobs.fullTools(id), ownerJobAskMs: 30, onSettled: (id, info) => settled.push({ id, info }) });
    let ran = 0;
    const tools = { mikrotik_remove: { async execute() { ran += 1; return { content: [] }; } } };
    const guarded = guardTools(tools, { chatId: run.id, asks, store: env.store, caller: "scheduler", mode: "ask" });
    const out = await guarded.mikrotik_remove.execute({ id: "*9" });
    assert.equal(out.isError, true);
    assert.equal(ran, 0);
    assert.equal(asks.isWaiting(run.id), false);
    assert.ok(settled.some((s) => s.id === run.id && s.info.cancelled), "the mirrored question is closed");
  } finally {
    env.cleanup();
  }
});

test("job chains stay as today: a non-owner job's approval and any job's plain ask_owner are refused at once", async () => {
  const env = setup();
  try {
    const colleague = env.store.createChat({ title: "theirs", caller: "team" });
    const theirs = env.jobs.get(payload(await env.toolsIn(colleague.id).jobs_create.execute({ name: "t", prompt: "t", triggerType: "manual" })).id);
    const mine = env.jobs.create({ name: "m", prompt: "m", triggerType: "manual" });
    const asks = jobAsks(env, ownerJobsOf(env));
    const conf = await asks.confirm(jobChat(env, theirs).id, { question: "حذف کنم؟" });
    assert.equal(conf.answered, false);
    const plain = payload(await asks.tool(jobChat(env, mine).id).execute({ question: "کدام کلاستر؟" }));
    assert.equal(plain.answered, false, "only guard approvals come out of an owner job");
    const offAsks = createAsks({ store: env.store, log: {} });
    assert.equal((await offAsks.confirm(jobChat(env, mine).id, { question: "حذف کنم؟" })).answered, false, "flag off: refused as today");
  } finally {
    env.cleanup();
  }
});

test("owner job: the approval reaches the owner's Telegram and his tap answers it", async () => {
  forgetDecisions();
  const { createIntegrations } = await import("../src/integrations/manager.mjs");
  const env = setup();
  const calls = [];
  const queue = [];
  let waiter = null;
  const fetchImpl = async (url, init) => {
    const method = String(url).split("/").pop();
    const body = JSON.parse(init.body || "{}");
    if (method === "getUpdates") {
      if (!queue.length) await new Promise((resolve) => { waiter = resolve; init.signal?.addEventListener("abort", resolve); });
      return Response.json({ ok: true, result: queue.splice(0) });
    }
    calls.push({ method, body });
    if (method === "getMe") return Response.json({ ok: true, result: { username: "griffin_bot", first_name: "G" } });
    return Response.json({ ok: true, result: { message_id: calls.length } });
  };
  let updateId = 0;
  const push = (update) => { queue.push({ update_id: ++updateId, ...update }); waiter?.(); waiter = null; };
  const until = async (check, ms = 3000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await check()) return;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error("timeout");
  };
  const ownerJobs = ownerJobsOf(env);
  const holder = { current: null };
  const asks = createAsks({ store: env.store, log: {}, ownerJobApprovals: (id) => ownerJobs.fullTools(id), onSettled: (id, info) => holder.current?.clearQuestion(id, info) });
  const runner = { isActive: () => false, send: async () => {}, cancel: async () => {} };
  const integrations = createIntegrations({ store: env.store, runner, asks, fetchImpl, ownerJobApprovals: (id) => ownerJobs.fullTools(id), log: {} });
  holder.current = integrations;
  try {
    const added = await integrations.addBot({ kind: "telegram_bot", token: "555:ABCDEFGHIJKLMNOPQRSTUVWXYZ" });
    env.store.updateIntegration(added.id, { settings: { pairedChats: ["777"], pairedNames: { 777: "Owner" }, username: "griffin_bot" } });
    const job = env.jobs.create({ name: "پاکسازی شبانه", prompt: "page", triggerType: "manual" });
    const run = jobChat(env, job);
    let ran = 0;
    const guarded = guardTools({ mikrotik_remove: { async execute() { ran += 1; return { content: [] }; } } }, { chatId: run.id, asks, store: env.store, caller: "scheduler", mode: "ask" });
    const pending = guarded.mikrotik_remove.execute({ id: "*3" });
    const questions = () => calls.filter((c) => c.method === "sendMessage" && c.body.reply_markup);
    await until(() => questions().length === 1);
    assert.match(questions()[0].body.text, /از جاب «پاکسازی شبانه»/);
    const askId = asks.list()[0].id;
    push({ callback_query: { id: "cq1", data: `a:${askId}:0`, from: { id: 777 }, message: { chat: { id: 777 }, message_id: calls.indexOf(questions()[0]) + 1 } } });
    assert.equal((await pending).isError, undefined);
    assert.equal(ran, 1);
  } finally {
    integrations.stopAll();
    await new Promise((r) => setTimeout(r, 50));
    env.cleanup();
  }
});

test("an owner chat holding a colleague's words writes jobs as unknown, so they stay unattended", async () => {
  const env = setup();
  try {
    const own = env.store.createChat({ title: "mine" });
    const child = env.store.createChat({ title: "sub", parentChatId: own.id, caller: "griffin" });
    env.store.setKv(thirdPartyKey(own.id), { at: new Date().toISOString(), from: "peer:x" });
    const tools = (id) => createJobTools({ jobs: env.jobs, targets: () => [], chatId: id, writerOf: jobWriterOf(env.store, { ownerRooted: (id) => env.trust.ownerRooted(id) }) });
    for (const id of [own.id, child.id]) {
      const made = payload(await tools(id).jobs_create.execute({ name: "x", prompt: "y", triggerType: "manual" }));
      assert.equal(env.jobs.get(made.id).options.promptChatId, "unknown");
      assert.equal(ownerJobsOf(env).fullTools(jobChat(env, env.jobs.get(made.id)).id), false);
    }
    const clean = env.store.createChat({ title: "clean" });
    assert.equal(jobWriterOf(env.store, { ownerRooted: (id) => env.trust.ownerRooted(id) })(clean.id), clean.id);
  } finally {
    env.cleanup();
  }
});

test("owner job: a yes to one approval does not let the next, different gated call through (index.mjs wiring)", async () => {
  forgetDecisions();
  const env = setup();
  try {
    const job = env.jobs.create({ name: "page", prompt: "page", triggerType: "manual" });
    const run = jobChat(env, job);
    const ownerJobs = ownerJobsOf(env);
    // Same onSettled as index.mjs.
    const asks = createAsks({
      store: env.store, log: {}, ownerJobApprovals: (id) => ownerJobs.fullTools(id),
      onSettled: (chatId, info) => { if (info?.by !== "requester" && info?.answer != null && !info?.ownerJobApproval && !ownerJobs.fullTools(chatId)) noteOwnerAnswer(env.store, chatId, info); },
    });
    let ran = 0;
    const guarded = guardTools({ mikrotik_remove: { async execute() { ran += 1; return { content: [] }; } } }, { chatId: run.id, asks, store: env.store, caller: "scheduler", mode: "ask" });
    const a = guarded.mikrotik_remove.execute({ id: "*1" });
    await new Promise((r) => setTimeout(r, 20));
    asks.answer(run.id, { answer: "بله", selected: ["بله"] });
    await a;
    assert.equal(ran, 1);
    const b = guarded.mikrotik_remove.execute({ id: "*2" });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(asks.isWaiting(run.id), true, "the second call asks again");
    assert.equal(ran, 1);
    asks.answer(run.id, { answer: "نه", selected: ["نه"] });
    assert.equal((await b).isError, true);
  } finally {
    env.cleanup();
  }
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function runChatOf(env, job, fire) {
  const before = env.store.listJobRuns(job.id, 50).length;
  fire();
  for (let i = 0; i < 100 && env.store.listJobRuns(job.id, 50).length === before; i += 1) await sleep(5);
  return env.store.listJobRuns(job.id, 1)[0].chatId;
}

test("jobs_run from a non-owner chain gives that run today's restricted tools, even on an owner job", async () => {
  const env = setup();
  try {
    const own = env.store.createChat({ title: "mine" });
    const ownChild = env.store.createChat({ title: "sub", parentChatId: own.id, caller: "griffin" });
    const colleague = env.store.createChat({ title: "theirs", caller: "team" });
    const colleagueChild = env.store.createChat({ title: "sub", parentChatId: colleague.id, caller: "griffin" });
    const job = env.jobs.create({ name: "owner's", prompt: "p", triggerType: "manual" });
    const on = ownerJobsOf(env);
    const fire = (chatId) => () => env.toolsIn(chatId).jobs_run.execute({ id: job.id });
    for (const id of [colleague.id, colleagueChild.id]) {
      const run = await runChatOf(env, job, fire(id));
      assert.equal(on.fullTools(run), false, "fired by a colleague's chain");
      await sleep(200);
    }
    for (const id of [own.id, ownChild.id]) {
      const run = await runChatOf(env, job, fire(id));
      assert.equal(on.fullTools(run), true, "fired from the owner's chain");
      await sleep(200);
    }
    const viaTool = await runChatOf(env, job, fire(null));
    assert.equal(on.fullTools(viaTool), false, "a tool with no chat is not the owner");
    await sleep(200);
    const handlers = {};
    const app = new Proxy({}, { get: (_t, verb) => (route, handler) => (handlers[`${verb} ${route}`] = handler) });
    jobRoutes(app, env.jobs);
    const page = await runChatOf(env, job, () => handlers["post /api/jobs/:id/run"]({ get: (k) => (k === "ownerVia" ? "cookie" : undefined), req: { param: () => job.id }, json: (v) => v }));
    assert.equal(on.fullTools(page), true, "the jobs page's run button is the owner");
    await sleep(200);
    const scheduled = await runChatOf(env, job, () => env.jobs.run(job.id, "schedule"));
    assert.equal(on.fullTools(scheduled), true, "a scheduled run has no starter to judge");
    const verdict = createOwnerJobs({ store: env.store, ownerRooted: () => true, writerVerdict: (id) => (id === colleague.id ? false : null) });
    await sleep(200);
    const hooked = await runChatOf(env, job, fire(own.id));
    assert.equal(verdict.fullTools(hooked), true);
    await sleep(200);
    const hookedColleague = await runChatOf(env, job, fire(colleague.id));
    assert.equal(verdict.fullTools(hookedColleague), false, "writerVerdict judges the starter too");
    await sleep(200);
  } finally {
    env.cleanup();
  }
});

test("the job timeout pauses while an approval waits on the owner, and resumes after", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "griffin-owner-jobs-wait-"));
  const store = openStore(path.join(dir, "db.sqlite"));
  let waiting = true;
  const runner = { send: async () => {}, cancel: async () => {} };
  const jobs = createJobs({ store, runner, log: { error() {}, warn() {}, info() {} }, tickMs: 60_000, timeoutFor: () => 100, pollMs: 10, isWaiting: () => waiting });
  try {
    const job = jobs.create({ name: "w", prompt: "w", triggerType: "manual" });
    const started = Date.now();
    const done = jobs.run(job.id, "schedule");
    await sleep(300);
    assert.equal(store.listJobRuns(job.id, 1)[0].status, "running", "300 ms of waiting did not use up a 100 ms timeout");
    waiting = false;
    const run = await done;
    assert.equal(run.status, "error");
    assert.ok(Date.now() - started >= 380, "the timeout counted only the time after the answer");
  } finally {
    jobs.stop();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("without a waiting approval the job timeout is unchanged", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "griffin-owner-jobs-nowait-"));
  const store = openStore(path.join(dir, "db.sqlite"));
  const runner = { send: async () => {}, cancel: async () => {} };
  const jobs = createJobs({ store, runner, log: { error() {}, warn() {}, info() {} }, tickMs: 60_000, timeoutFor: () => 100, pollMs: 10 });
  try {
    const job = jobs.create({ name: "w", prompt: "w", triggerType: "manual" });
    const started = Date.now();
    const run = await jobs.run(job.id, "schedule");
    assert.equal(run.status, "error");
    assert.ok(Date.now() - started < 1000);
  } finally {
    jobs.stop();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the writer verdict is taken at write time: a chat that is not the owner's then records unknown, and stays so", async () => {
  const env = setup();
  try {
    const integ = env.store.createIntegration({ kind: "telegram_account", name: "acct", secret: "x", settings: {} });
    const saved = env.store.createChat({ title: "me", caller: "owner" });
    env.store.linkChat(integ.id, "me", saved.id);
    const tools = createJobTools({ jobs: env.jobs, targets: () => [], chatId: saved.id, writerOf: jobWriterOf(env.store, { ownerRooted: (id) => env.trust.ownerRooted(id) }) });
    const made = payload(await tools.jobs_create.execute({ name: "fwd", prompt: "forwarded words", every: "1h" }));
    assert.equal(env.jobs.get(made.id).options.promptChatId, "unknown");
    env.store.deleteIntegration?.(integ.id);
    assert.equal(ownerJobsOf(env).fullTools(jobChat(env, env.jobs.get(made.id)).id), false, "unlinking later does not make it the owner's");
    const hook = jobWriterOf(env.store, { ownerRooted: () => true, writerVerdict: () => false });
    assert.equal(hook(env.store.createChat({ title: "own" }).id), "unknown", "the hook's veto applies at write time too");
  } finally {
    env.cleanup();
  }
});

test("paused time is capped at the job timeout plus one question window", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "griffin-owner-jobs-cap-"));
  const store = openStore(path.join(dir, "db.sqlite"));
  const runner = { send: async () => {}, cancel: async () => {} };
  const jobs = createJobs({ store, runner, log: { error() {}, warn() {}, info() {} }, tickMs: 60_000, timeoutFor: () => 100, questionWindowMs: 100, pollMs: 5, isWaiting: () => true });
  try {
    const job = jobs.create({ name: "w", prompt: "w", triggerType: "manual" });
    const started = Date.now();
    const run = await jobs.run(job.id, "schedule");
    const took = Date.now() - started;
    assert.equal(run.status, "error");
    assert.ok(took >= 280 && took < 1500, `pause 200 ms at most, then 100 ms of timeout: took ${took} ms`);
  } finally {
    jobs.stop();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("jobs over HTTP: the page's login cookie writes as the owner, the owner token as unknown — job running or not", async () => {
  const { createApp } = await import("../src/app.mjs");
  const { createAuth } = await import("../src/auth.mjs");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "griffin-owner-jobs-api-"));
  const store = openStore(path.join(dir, "db.sqlite"));
  let finish = null;
  const runner = { send: async (chatId) => { finish = () => store.bus.emit(`chat:${chatId}`, { type: "run.finished", data: { status: "finished" } }); }, cancel: async () => {}, isActive: () => false };
  const jobs = createJobs({ store, runner, log: { error() {}, warn() {}, info() {} }, tickMs: 60_000, timeoutFor: () => 5_000, pollMs: 10 });
  const app = createApp({ store, runner, auth: createAuth({ dataDir: dir, store }), extraRoutes: (api) => jobRoutes(api, jobs) });
  const token = fs.readFileSync(path.join(dir, "owner.token"), "utf8").trim();
  const origin = "http://localhost";
  const login = await app.request(`${origin}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json", origin }, body: JSON.stringify({ token }) });
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const send = (method, url, body, auth) => app.request(`${origin}${url}`, { method, headers: { "content-type": "application/json", origin, ...auth }, body: body ? JSON.stringify(body) : undefined });
  const asPage = { cookie };
  const asToken = { authorization: `Bearer ${token}` };
  try {
    const job = jobs.create({ name: "mine", prompt: "p", triggerType: "manual" });
    const other = jobs.create({ name: "other", prompt: "q", triggerType: "manual" });
    const done = jobs.run(other.id, "schedule"); // an unrelated job is running
    await sleep(30);
    assert.equal((await send("PATCH", `/api/jobs/${job.id}`, { prompt: "from the page" }, asPage)).status, 200);
    assert.equal(jobs.get(job.id).options.promptChatId, "owner", "the owner's own page edit while another job runs stays his");
    assert.equal((await send("PATCH", `/api/jobs/${job.id}`, { enabled: true }, asToken)).status, 200);
    assert.equal(jobs.get(job.id).options.promptChatId, "unknown", "the token (a script or a job's Bash) is not the owner");
    const made = await (await send("POST", "/api/jobs", { name: "n", prompt: "n", triggerType: "manual" }, asToken)).json();
    assert.equal(jobs.get(made.job.id).options.promptChatId, "unknown");
    finish();
    await done;
    assert.equal((await send("PATCH", `/api/jobs/${job.id}`, { prompt: "later, by token" }, asToken)).status, 200);
    assert.equal(jobs.get(job.id).options.promptChatId, "unknown", "after the run ends too");
    assert.equal((await send("PATCH", `/api/jobs/${job.id}`, { prompt: "page again" }, asPage)).status, 200);
    assert.equal(jobs.get(job.id).options.promptChatId, "owner");
    assert.equal((await send("POST", `/api/jobs/${job.id}/run`, null, asToken)).status, 202);
    await sleep(30);
    assert.equal(store.getKv(`jobrunby:${store.listJobRuns(job.id, 1)[0].chatId}`), "unknown", "a run the token starts is not the owner's");
  } finally {
    finish?.();
    jobs.stop();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("owner job with CLAUDE_CODE on: full Claude Code under the state guard, told it is his unattended scheduled job", async () => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "griffin-owner-jobs-cc-")));
  const knowledgeRoot = path.join(base, "workspace", "knowledge");
  const data = path.join(base, "data");
  const work = path.join(base, "work");
  for (const d of [knowledgeRoot, data, work]) fs.mkdirSync(d, { recursive: true });
  const statePaths = () => griffinStatePaths({ knowledgeRoot, data, home: path.join(data, "home") });
  const fileAccess = { read: [path.join(base, "workspace")], write: [work], deny: [knowledgeRoot] };
  try {
    const opts = claudeCodeOptions({ fileAccess, claudeCodeOn: true, stateGuardOn: true, statePaths, ownerJob: true });
    assert.equal(opts.claudeCode, true);
    assert.ok(opts.stateGuard?.protect?.length, "the state guard covers owner jobs");
    assert.equal(opts.ownerJob, true);
    assert.equal(claudeCodeOptions({ fileAccess: null, claudeCodeOn: true, stateGuardOn: true, statePaths, ownerJob: false }).claudeCode, false, "no file access: no Claude Code, as today");
    let seen = null;
    const queryImpl = ({ prompt, options }) => {
      seen = options;
      return (async function* () {
        for await (const _ of prompt) break;
        yield { type: "system", subtype: "init", session_id: options.sessionId, mcp_servers: [] };
        yield { type: "result", subtype: "success", is_error: false, result: "ok", session_id: options.sessionId };
      })();
    };
    const agent = createClaudeProvider({ apiKey: "sk-ant-api-test", queryImpl }).create({ cwd: work, rules: "RULES", fileAccess, ...opts });
    await (await agent.send("go")).wait();
    assert.equal(seen.tools, undefined, "full built-ins, Bash included");
    assert.doesNotMatch(seen.systemPrompt.append, /owner's own chat/);
    assert.match(seen.systemPrompt.append, /scheduled job, running unattended/);
    let denied = false;
    for (const m of seen.hooks.PreToolUse) {
      if (m.matcher && !new RegExp(`^(?:${m.matcher})$`).test("Bash")) continue;
      for (const hook of m.hooks) {
        const out = await hook({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: `echo x > ${knowledgeRoot}/evil.md` }, cwd: work }, "u1", { signal: new AbortController().signal });
        if (out?.hookSpecificOutput?.permissionDecision === "deny") denied = true;
      }
    }
    assert.equal(denied, true, "Bash cannot write the knowledge store from an owner job");
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("a job's mode replaces the install switch: «بدون پرسیدن» asks nothing, the asking modes ask, «محدود» is the scheduler's quota", async () => {
  const { CONFIG_SCHEMA } = await import("../src/config.mjs");
  assert.equal(CONFIG_SCHEMA.find((c) => c.key === "OWNER_JOBS_FULL_TOOLS"), undefined, "no install switch any more");
  const env = setup();
  try {
    const ownerJobs = ownerJobsOf(env);
    const job = env.jobs.create({ name: "p", prompt: "p", triggerType: "manual" });
    assert.equal(job.mode, "agent", "a new job: «بدون پرسیدن», as a new chat");
    const run = jobChat(env, job);
    assert.equal(ownerJobs.fullTools(run.id), true);
    assert.equal(ownerJobs.bypass(run.id), true);
    assert.deepEqual(runAccess({ rootCaller: "scheduler", unattended: true, ownerJob: true, bypass: true }), { asOwner: true, guardMode: null }, "nothing asks: as in his own chat");
    for (const mode of ["auto", "ask", "edits", "plan"]) {
      env.jobs.update(job.id, { mode });
      assert.equal(ownerJobs.fullTools(run.id), true, mode);
      assert.equal(ownerJobs.bypass(run.id), false, `${mode}: a gated call asks him`);
      assert.equal(jobChatMode(mode), mode, `${mode}: the run chat gets the same mode`);
    }
    env.jobs.update(job.id, { mode: "limited" });
    assert.equal(ownerJobs.fullTools(run.id), false);
    assert.equal(ownerJobs.bypass(run.id), false);
    assert.equal(jobChatMode("limited"), "agent");
    env.jobs.update(job.id, { mode: "nonsense" });
    assert.equal(env.jobs.get(job.id).mode, "limited", "an unknown mode keeps the stored one");
    env.jobs.update(job.id, { name: "renamed" });
    assert.equal(env.jobs.get(job.id).mode, "limited", "an edit without a mode keeps it");
    // A job someone else wrote: «بدون پرسیدن» changes nothing.
    const colleague = env.store.createChat({ title: "theirs", caller: "team" });
    const theirs = env.jobs.get(payload(await env.toolsIn(colleague.id).jobs_create.execute({ name: "c", prompt: "c", triggerType: "manual", mode: "agent" })).id);
    assert.equal(ownerJobs.fullTools(jobChat(env, theirs).id), false);
    assert.equal(ownerJobs.bypass(jobChat(env, theirs).id), false);
  } finally {
    env.cleanup();
  }
});

test("jobs_update with only a mode changes the mode; without one it keeps it", async () => {
  const env = setup();
  try {
    const own = env.store.createChat({ title: "mine" });
    const tools = env.toolsIn(own.id);
    const created = payload(await tools.jobs_create.execute({ name: "n", prompt: "n", triggerType: "manual", mode: "ask" }));
    assert.equal(created.mode, "ask");
    assert.equal(payload(await tools.jobs_update.execute({ id: created.id, enabled: false })).mode, "ask");
    assert.equal(payload(await tools.jobs_update.execute({ id: created.id, mode: "plan" })).mode, "plan");
  } finally {
    env.cleanup();
  }
});

test("migration: jobs stored before modes keep how they ran — «محدود», or asking where OWNER_JOBS_FULL_TOOLS=1; once", () => {
  for (const [flag, want] of [[false, "limited"], [true, "ask"]]) {
    const env = setup();
    try {
      const a = env.store.createJob({ name: "a", prompt: "a", triggerType: "manual", trigger: {}, options: {} });
      const b = env.store.createJob({ name: "b", prompt: "b", mode: "plan", triggerType: "manual", trigger: {}, options: {} });
      assert.equal(migrateJobModes(env.store, { fullToolsFlag: flag }), 1);
      assert.equal(env.store.getJob(a.id).mode, want);
      assert.equal(env.store.getJob(b.id).mode, "plan");
      env.store.updateJob(a.id, { mode: "agent" });
      assert.equal(migrateJobModes(env.store, { fullToolsFlag: flag }), 0, "runs once");
      assert.equal(env.store.getJob(a.id).mode, "agent");
    } finally {
      env.cleanup();
    }
  }
});

test("owner job: the speed-bump fence refuses LITERAL paths into the data folder and the broker socket, reads included; his home stays open (not a boundary: built paths pass)", async () => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "griffin-owner-jobs-read-")));
  const knowledgeRoot = path.join(base, "workspace", "knowledge");
  const data = path.join(base, "data");
  const home = path.join(data, "home");
  const run = path.join(base, "run", "griffin");
  const work = path.join(base, "work");
  for (const d of [knowledgeRoot, home, run, work]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(data, "owner.token"), "t");
  const socket = path.join(run, "broker.sock");
  const statePaths = () => griffinStatePaths({ knowledgeRoot, data, home });
  const fileAccess = { read: [path.join(base, "workspace")], write: [work], deny: [knowledgeRoot] };
  const { brokerPaths } = await import("../src/jobs/owner-jobs.mjs");
  const optionsFor = async (ownerJob, stateGuardOn = true) => {
    let seen = null;
    const queryImpl = ({ prompt, options }) => {
      seen = options;
      return (async function* () {
        for await (const _ of prompt) break;
        yield { type: "system", subtype: "init", session_id: options.sessionId, mcp_servers: [] };
        yield { type: "result", subtype: "success", is_error: false, result: "ok", session_id: options.sessionId };
      })();
    };
    const opts = claudeCodeOptions({ fileAccess, claudeCodeOn: true, stateGuardOn, statePaths, ownerJob, dataDir: data, jobClosed: brokerPaths(socket) });
    const agent = createClaudeProvider({ apiKey: "sk-ant-api-test", queryImpl }).create({ cwd: work, rules: "RULES", fileAccess, ...opts });
    await (await agent.send("go")).wait();
    return seen;
  };
  const decide = async (options, tool, input) => {
    for (const m of options.hooks?.PreToolUse || []) {
      if (m.matcher && !new RegExp(`^(?:${m.matcher})$`).test(tool)) continue;
      for (const hook of m.hooks) {
        const out = await hook({ hook_event_name: "PreToolUse", tool_name: tool, tool_input: input, cwd: work }, "u1", { signal: new AbortController().signal });
        if (out?.hookSpecificOutput?.permissionDecision === "deny") return "deny";
      }
    }
    return "allow";
  };
  try {
    for (const stateGuardOn of [true, false]) {
      const job = await optionsFor(true, stateGuardOn);
      assert.equal(await decide(job, "Bash", { command: `cat ${data}/owner.token` }), "deny", "token read");
      assert.equal(await decide(job, "Bash", { command: `cd ${data} && cat owner.token` }), "deny");
      assert.equal(await decide(job, "Bash", { command: `sqlite3 -readonly ${data}/griffin.db 'select value from kv'` }), "deny", "session secret in the DB");
      assert.equal(await decide(job, "Bash", { command: `curl --unix-socket ${socket} -X POST http://x/tools/mikrotik_remove` }), "deny", "broker socket");
      assert.equal(await decide(job, "Read", { file_path: `${data}/owner.token` }), "deny", "Read tool");
      assert.equal(await decide(job, "Grep", { pattern: "x", path: data }), "deny");
      assert.equal(await decide(job, "Bash", { command: `echo x > ${knowledgeRoot}/n.md` }), "deny", `knowledge write (STATE_GUARD ${stateGuardOn ? "on" : "off"})`);
      assert.equal(await decide(job, "Bash", { command: `cat ${home}/.gitconfig` }), "allow", "his home stays readable");
      assert.equal(await decide(job, "Bash", { command: `ls ${work} && git status` }), "allow");
      assert.equal(await decide(job, "Bash", { command: `cat ${knowledgeRoot}/n.md` }), "allow", "notes stay readable");
    }
    const chat = await optionsFor(false);
    assert.equal(await decide(chat, "Bash", { command: `cat ${data}/owner.token` }), "allow", "the owner's own chats keep reading, as today");
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("a job approval's yes does not bless the chain even if the job is made «محدود» before he answers", async () => {
  forgetDecisions();
  const env = setup();
  try {
    const job = env.jobs.create({ name: "page", prompt: "page", triggerType: "manual" });
    const run = jobChat(env, job);
    env.jobs.update(job.id, { mode: "ask" });
    const ownerJobs = ownerJobsOf(env);
    const settledInfo = [];
    // Same onSettled as index.mjs.
    const asks = createAsks({
      store: env.store, log: {}, ownerJobApprovals: (id) => ownerJobs.fullTools(id),
      onSettled: (chatId, info) => { settledInfo.push(info); if (info?.by !== "requester" && info?.answer != null && !info?.ownerJobApproval && !ownerJobs.fullTools(chatId)) noteOwnerAnswer(env.store, chatId, info); },
    });
    const ran = [];
    const guarded = guardTools({ mikrotik_remove: { async execute(args) { ran.push(args.id); return { content: [] }; } } }, { chatId: run.id, asks, store: env.store, caller: "scheduler", mode: "ask" });
    const a = guarded.mikrotik_remove.execute({ id: "*1" });
    await sleep(20);
    env.jobs.update(job.id, { mode: "limited" });
    asks.answer(run.id, { answer: "بله", selected: ["بله"] });
    await a;
    assert.ok(settledInfo.some((i) => i.ownerJobApproval === true), "asks.mjs reports it was a job approval");
    const b = await guarded.mikrotik_remove.execute({ id: "*2" });
    assert.equal(b.isError, true);
    assert.deepEqual(ran, ["*1"], "the second, different call did not run on the first yes");
  } finally {
    env.cleanup();
  }
});
