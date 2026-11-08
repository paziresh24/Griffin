import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openStore } from "../src/db.mjs";
import { classifyEngineError, createDoctor } from "../src/doctor.mjs";

test("engine errors are classified by cause", () => {
  assert.equal(classifyEngineError({ status: 401, text: "invalid x-api-key" }), "bad_key");
  assert.equal(classifyEngineError({ status: 403, text: "Cursor is not available in your region" }), "region");
  assert.equal(classifyEngineError({ status: 403, text: "Request not allowed" }), "forbidden");
  assert.equal(classifyEngineError({ status: 402, text: "insufficient credits" }), "quota");
  assert.equal(classifyEngineError({ status: 429, text: "Rate limit reached for requests" }), "busy");
  assert.equal(classifyEngineError({ network: true, text: "ENOTFOUND" }), "network");
  assert.equal(classifyEngineError({ status: 404, text: "model not found" }), "model");
});

test("an agent on a rejected engine moves to one that answers, and back once it heals", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-"));
  const store = openStore(path.join(dir, "t.sqlite"));
  const agent = store.listAgentProfiles()[0];
  store.updateAgentProfile(agent.id, { provider: "claude" });
  const keys = { claude: "sk-ant-api-bad", openai: "sk-good", cursor: "" };
  let claudeOk = false;
  const fetchImpl = async (url) => {
    if (String(url).includes("anthropic")) return claudeOk ? new Response("{}", { status: 200 }) : new Response("invalid x-api-key", { status: 401 });
    return new Response("{}", { status: 200 });
  };
  const doctor = createDoctor({
    store,
    runner: { cancel: async () => {} },
    providers: { cursor: { listModels: async () => [] }, openai: { defaultModel: "m" } },
    providerKey: (id) => keys[id],
    providerConfig: () => ({}),
    engineIds: ["cursor", "claude", "openai"],
    dataDir: dir,
    fetchImpl,
  });
  const first = await doctor.heal();
  assert.equal(first.engines.find((e) => e.id === "claude").cause, "bad_key");
  assert.equal(store.getAgentProfile(agent.id).provider, "openai");
  assert.ok(first.applied.some((line) => line.startsWith(`agent ${agent.id}:`)));

  claudeOk = true;
  await doctor.heal();
  assert.equal(store.getAgentProfile(agent.id).provider, "claude");
});

test("cancel_stuck leaves a run alone by age: only the sweep decides, and heal never does it", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-"));
  const store = openStore(path.join(dir, "t.sqlite"));
  const chat = store.createChat({ title: "t" });
  const runId = store.startRun(chat.id);
  store.db.prepare("UPDATE runs SET started_at = ? WHERE id = ?").run(new Date(Date.now() - 60 * 60_000).toISOString(), runId);
  const cancelled = [];
  const runner = { cancel: async (id) => cancelled.push(id), sweepStale: async () => [] };
  const doctor = createDoctor({ store, runner, providers: {}, providerKey: () => "", providerConfig: () => ({}), engineIds: [], dataDir: dir });
  const r = await doctor.report();
  const stuck = r.checks.find((c) => c.id === "stuck");
  assert.equal(stuck.fix.id, "cancel_stuck");
  assert.ok(!stuck.fix.auto);
  assert.match((await doctor.fix("cancel_stuck")).done, /^0 /);
  assert.deepEqual(cancelled, []);
});

function healSetup(integrationList, notify, onUpdate = () => {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-"));
  const store = openStore(path.join(dir, "t.sqlite"));
  const updates = [];
  const doctor = createDoctor({
    store,
    runner: { cancel: async () => {}, sweepStale: async () => [] },
    providers: { openai: { defaultModel: "m" } },
    providerKey: () => "sk-good",
    providerConfig: () => ({}),
    engineIds: ["openai"],
    dataDir: dir,
    fetchImpl: async () => new Response("{}", { status: 200 }),
    integrations: { list: integrationList, update: (id, patch) => {
      updates.push([id, patch]);
      onUpdate();
    } },
    notify,
  });
  return { store, doctor, updates };
}

test("heal tells the owner once after two passes, then when it comes back; a failed send is retried", async () => {
  const sent = [];
  let fail = false;
  let down = true;
  const list = () => (down ? [{ id: "a", kind: "telegram_account", name: "حساب", enabled: true, status: { state: "error", error: "AUTH_KEY_UNREGISTERED sk-ant-api03-abcdefghijklmnopqrstuvwxyz" } }] : []);
  const { doctor, updates } = healSetup(list, async (text) => {
    if (fail) throw new Error("fetch failed");
    sent.push(text);
  });
  await doctor.heal();
  assert.equal(sent.length, 0, "one pass may be a blip");
  fail = true;
  await doctor.heal();
  assert.equal(sent.length, 0);
  fail = false;
  await doctor.heal();
  assert.equal(sent.length, 1, "the unsent message goes out on the next pass");
  assert.match(sent[0], /اتصال حساب وصل نیست/);
  assert.match(sent[0], /راه: ورود دوباره/);
  assert.doesNotMatch(sent[0], /sk-ant-api03/);
  await doctor.heal();
  assert.equal(sent.length, 1, "not told twice");
  assert.deepEqual(updates, [], "a login that must be redone is not restarted");
  down = false;
  await doctor.heal();
  assert.equal(sent.length, 2);
  assert.match(sent[1], /✅ درست شد: اتصال حساب/);
  await doctor.heal();
  assert.equal(sent.length, 2);
});

test("a connection that stays down after the restart is told once as a problem, with no «fixed» line", async () => {
  const sent = [];
  let down = true;
  const list = () => (down ? [{ id: "b", kind: "telegram_bot", name: "ربات", enabled: true, status: { state: "error", error: "fetch failed" } }] : []);
  const { doctor, updates } = healSetup(list, async (text) => sent.push(text));
  await doctor.heal();
  await doctor.heal();
  await doctor.heal();
  assert.equal(updates.length, 6, "each pass tries again");
  assert.equal(sent.length, 1);
  assert.match(sent[0], /اتصال ربات وصل نیست/);
  assert.doesNotMatch(sent[0], /🔧/);
  down = false;
  await doctor.heal();
  assert.equal(sent.length, 2);
  assert.match(sent[1], /✅ درست شد: اتصال ربات/);
});

test("heal reconnects a dropped connection and says so; a long run alone is no message", async () => {
  const sent = [];
  let down = true;
  const list = () => (down ? [{ id: "b", kind: "telegram_bot", name: "ربات", enabled: true, status: { state: "error", error: "fetch failed" } }] : []);
  const { store, doctor, updates } = healSetup(list, async (text) => sent.push(text), () => {
    down = false;
  });
  const chat = store.createChat({ title: "t" });
  store.db.prepare("UPDATE runs SET started_at = ? WHERE id = ?").run(new Date(Date.now() - 60 * 60_000).toISOString(), store.startRun(chat.id));
  const r = await doctor.heal();
  assert.deepEqual(updates, [["b", { enabled: false }], ["b", { enabled: true }]]);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /🔧 خودکار انجام شد: integration b restarted/);
  assert.doesNotMatch(sent[0], /ران/);
  assert.ok(r.applied.length);
  await doctor.heal();
  assert.equal(sent.length, 1, "a problem he was never told about has no «back» line");
});

test("no engine at all is told at once", async () => {
  const sent = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-"));
  const doctor = createDoctor({
    store: openStore(path.join(dir, "t.sqlite")),
    runner: {},
    providers: {},
    providerKey: () => "",
    providerConfig: () => ({}),
    engineIds: [],
    dataDir: dir,
    notify: async (text) => sent.push(text),
  });
  await doctor.heal();
  assert.equal(sent.length, 1);
  assert.match(sent[0], /هیچ موتوری کار نمی‌کند/);
});
