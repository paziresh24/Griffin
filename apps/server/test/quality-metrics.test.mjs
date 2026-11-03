import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { qualityMetrics, personOf } from "../src/quality-metrics.mjs";

function fixture() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE chats (id TEXT PRIMARY KEY, created_at TEXT, parent_chat_id TEXT, caller TEXT, person_id TEXT, job_id TEXT, mode TEXT);
    CREATE TABLE runs (id TEXT PRIMARY KEY, chat_id TEXT, status TEXT, error TEXT, started_at TEXT);
    CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id TEXT, run_id TEXT, type TEXT, data TEXT, at TEXT);
    CREATE TABLE approvals (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT, chat_id TEXT, caller TEXT, tool TEXT, args_json TEXT, decision TEXT);
    CREATE TABLE peer_users (id TEXT PRIMARY KEY, label TEXT);
  `);
  let clock = 0;
  const at = () => new Date(Date.UTC(2026, 9, 20) + ++clock * 1000).toISOString();
  const chat = (id, extra = {}) => db.prepare("INSERT INTO chats VALUES (?, ?, ?, ?, ?, ?, ?)").run(id, at(), extra.parent ?? null, extra.caller ?? "owner", null, extra.job ?? null, extra.mode ?? "agent");
  const run = (id, chatId, status = "finished", error = null) => db.prepare("INSERT INTO runs VALUES (?, ?, ?, ?, ?)").run(id, chatId, status, error, at());
  const event = (chatId, type, data = {}, runId = null) => db.prepare("INSERT INTO events (chat_id, run_id, type, data, at) VALUES (?, ?, ?, ?, ?)").run(chatId, runId, type, JSON.stringify(data), at());
  const tools = (chatId, n, name = "kube_get") => { for (let i = 0; i < n; i++) event(chatId, "tool.started", { name }); };
  return { db, at, chat, run, event, tools };
}

test("a one-message task with no question, handoff or stop is zero-touch; simple vs complex by steps", () => {
  const f = fixture();
  f.chat("a");
  f.event("a", "user", { text: "x" });
  f.run("a1", "a");
  f.tools("a", 2);
  f.chat("b");
  f.event("b", "user", { text: "y" });
  f.run("b1", "b");
  f.tools("b", 6);
  const m = qualityMetrics(f.db);
  assert.equal(m.total.tasks, 2);
  assert.equal(m.total.ztrr, 1);
  assert.equal(m.total.complexShare, 0.5);
  assert.equal(m.total.freeShare, 1);
});

test("asks, handoffs, stops and text questions are human touches; MTTH counts steps before the first", () => {
  const f = fixture();
  f.chat("c", { mode: "ask" });
  f.event("c", "user", { text: "do it" });
  f.run("c1", "c");
  f.tools("c", 3);
  f.event("c", "ask.pending", { audience: "owner", via: null, fromChatId: "c" });
  f.tools("c", 1);
  f.event("c", "text", { text: "کدام شاخه؟" }, "c1");
  f.event("c", "user", { text: "main" });
  f.run("c2", "c");
  f.tools("c", 1, "owner_task");
  const m = qualityMetrics(f.db);
  const owner = m.users[0];
  assert.equal(owner.ztrr, 0);
  assert.equal(owner.humanFallback, 1);
  assert.equal(owner.clarificationsPerTask, 2); // the card in his own chat + the question in the answer
  assert.equal(owner.askCardClarificationsPerTask, 1);
  assert.equal(owner.mtthSteps, 3);
  assert.equal(owner.freeShare, 0);
});

test("a stop by the person is an abort, a restart's cut is not; a sub-chat's steps count toward its root", () => {
  const f = fixture();
  f.chat("d");
  f.event("d", "user", { text: "go" });
  f.run("d0", "d", "cancelled", "به‌خاطر ری‌استارت سرور قطع شد");
  f.run("d1", "d");
  f.chat("d-child", { parent: "d", caller: "griffin" });
  f.tools("d-child", 2);
  const decide = f.db.prepare("INSERT INTO approvals (at, chat_id, caller, tool, args_json, decision) VALUES (?, ?, ?, ?, ?, ?)");
  let m = qualityMetrics(f.db);
  assert.equal(m.total.tasks, 1);
  assert.equal(m.total.ztrr, 1);
  assert.equal(m.total.complexShare, 1); // it delegated
  assert.equal(m.total.stepsPerTask, 2);
  f.run("d2", "d", "cancelled", null);
  decide.run(f.at(), "d-child", "owner", "kube_exec", "{}", "peer-card");
  m = qualityMetrics(f.db);
  assert.equal(m.total.aborts, 1);
  assert.equal(m.total.humanFallback, 1);
});

test("jobs, ops, internal agents and e2e probes are not people; a colleague's peer is labelled", () => {
  assert.equal(personOf({ caller: "scheduler" }), null);
  assert.equal(personOf({ caller: "owner", job_id: "j" }), null);
  assert.equal(personOf({ caller: "peer:e2e-selftest" }), null);
  assert.equal(personOf({ caller: "peer:net-griffin-x" }).kind, "network");
  const f = fixture();
  f.db.prepare("INSERT INTO peer_users VALUES ('aida', 'آیدا')").run();
  f.chat("p", { caller: "peer:aida", mode: "ask" });
  f.event("p", "user", { text: "q" });
  f.run("p1", "p");
  f.chat("s", { caller: "ops" });
  const m = qualityMetrics(f.db, { system: true });
  assert.deepEqual(m.users.map((u) => u.label).sort(), ["system:ops", "آیدا"].sort());
  assert.equal(m.total.tasks, 1);
  assert.equal(m.users.find((u) => u.label === "آیدا").freeShare, null); // only the install's owner sets a mode
  assert.equal(qualityMetrics(f.db, { exclude: ["peer:aida"] }).total.tasks, 0);
});
