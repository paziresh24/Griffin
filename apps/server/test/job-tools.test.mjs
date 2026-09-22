import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openStore } from "../src/db.mjs";
import { createJobs } from "../src/jobs/index.mjs";
import { createJobTools } from "../src/jobs/tools.mjs";
import { createRunner } from "../src/runner.mjs";

function payload(result) {
  return JSON.parse(result.content[0].text);
}

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "griffin-job-tools-"));
  const store = openStore(path.join(dir, "db.sqlite"));
  const sdk = {
    async create() {
      return {
        agentId: "a1",
        async send(_message, options) {
          return {
            id: "r",
            supports: () => true,
            async cancel() {},
            async wait() {
              await options.onDelta({ update: { type: "text-delta", text: "ok" } });
              return { status: "finished" };
            },
          };
        },
      };
    },
    resume: (_id, options) => sdk.create(options),
  };
  const runner = createRunner({ store, sdk, agentOptions: async () => ({}), log: { error() {} } });
  const jobs = createJobs({ store, runner, deliver: async () => [], log: { error() {} }, tickMs: 60_000 });
  const available = [
    { integrationId: "bot1", integrationName: "پلتفرم‌بان", kind: "telegram_bot", chat: "42", name: "Saved Messages" },
  ];
  const tools = createJobTools({ jobs, targets: () => available });
  return {
    jobs,
    tools,
    cleanup: () => {
      jobs.stop();
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("jobs_create schedules a job and jobs_list shows it", async () => {
  const s = setup();
  try {
    const created = payload(await s.tools.jobs_create.execute({
      name: "منابع گیت‌لب",
      prompt: "مصرف را نمودار بکش",
      every: "30m",
    }));
    assert.equal(created.name, "منابع گیت‌لب");
    assert.equal(created.trigger, "schedule");
    assert.equal(created.when, "هر 30 دقیقه");
    assert.ok(created.nextAt);
    assert.equal(created.delivery.targets.length, 0);

    const listed = payload(await s.tools.jobs_list.execute({}));
    assert.equal(listed.jobs.length, 1);
    assert.equal(listed.jobs[0].id, created.id);
    assert.equal(listed.destinations[0].name, "Saved Messages");
  } finally {
    s.cleanup();
  }
});

test("jobs_create matches deliverTo against paired chats", async () => {
  const s = setup();
  try {
    const created = payload(await s.tools.jobs_create.execute({
      name: "گزارش",
      prompt: "خلاصه بده",
      cron: "0 8 * * *",
      deliverTo: ["Saved Messages"],
    }));
    assert.deepEqual(created.delivery.targets, [{ integrationId: "bot1", chat: "42" }]);
  } finally {
    s.cleanup();
  }
});

test("jobs_create rejects an unknown destination and a bad interval", async () => {
  const s = setup();
  try {
    const dest = await s.tools.jobs_create.execute({ name: "ج", prompt: "پ", every: "30m", deliverTo: ["گروه ناموجود"] });
    assert.equal(dest.isError, true);
    assert.match(payload(dest).error, /گروه ناموجود/);

    const bad = await s.tools.jobs_create.execute({ name: "ج", prompt: "پ", every: "10s" });
    assert.equal(bad.isError, true);
  } finally {
    s.cleanup();
  }
});

test("jobs_update and jobs_delete change the store", async () => {
  const s = setup();
  try {
    const created = payload(await s.tools.jobs_create.execute({ name: "قدیمی", prompt: "کار", every: "1h" }));
    const updated = payload(await s.tools.jobs_update.execute({ id: created.id, enabled: false, name: "جدید" }));
    assert.equal(updated.name, "جدید");
    assert.equal(updated.enabled, false);

    const gone = payload(await s.tools.jobs_delete.execute({ id: created.id }));
    assert.equal(gone.ok, true);
    assert.equal(payload(await s.tools.jobs_list.execute({})).jobs.length, 0);
  } finally {
    s.cleanup();
  }
});
