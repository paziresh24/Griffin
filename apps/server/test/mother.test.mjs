import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openStore } from "../src/db.mjs";
import { createIntegrations } from "../src/integrations/manager.mjs";
import { classifyThread } from "../src/integrations/threads.mjs";
import { COVERAGE_CALLER } from "../src/integrations/coverage.mjs";

// Each person has a mother chat; every message either opens a new thread or
// joins an open one; one issue can be grouped from several people.

const threads = [{ id: "A", title: "🧵 علی: پایپ‌لاین اپ" }, { id: "B", title: "🧵 علی: دسترسی گزارش" }];

test("with open threads, the classifier routes: a thread, a new one, or the latest", async () => {
  const jev = (answers) => ({ apiKey: "k", fetchImpl: async (_u, init) => {
    const body = JSON.parse(init.body);
    assert.deepEqual(Object.keys(body.questions.route.criteria), ["t0", "t1", "new"]);
    assert.match(body.state.open_threads, /t1: علی: دسترسی گزارش/);
    return { ok: true, json: async () => ({ answers }) };
  } });
  const r1 = await classifyThread({ message: "دیتابیس هنوز وصل نمیشه", from: "teammate", threads }, jev({ open: { noul: 0.8 }, kind: { choice: "problem" }, route: { choice: "t1" } }));
  assert.equal(r1.thread, "B");
  assert.equal(r1.start, false);
  const r2 = await classifyThread({ message: "یه سرور جدید می‌خوام", from: "teammate", threads }, jev({ open: { noul: 0.9 }, kind: { choice: "request" }, route: { choice: "new" } }));
  assert.equal(r2.start, true);
  const r3 = await classifyThread({ message: "ممنون", from: "teammate", threads }, jev({ open: { noul: 0.1 }, kind: { choice: "thanks" }, route: { choice: "new" } }));
  assert.equal(r3.thread, "A", "thanks never opens; it goes to the latest thread");
  const down = await classifyThread({ message: "x", from: "teammate", threads }, { apiKey: "k", fetchImpl: async () => ({ ok: false, status: 451 }) });
  assert.equal(down.thread, "A", "an outage never drops a message from a chat with open threads");
  const glm = await classifyThread({ message: "گزارش؟", from: "teammate", threads }, { fallbackAsk: async (p) => {
    assert.match(p, /t0: علی: پایپ‌لاین/);
    return '{"open": true, "kind": "question", "route": "t1"}';
  } });
  assert.equal(glm.thread, "B");
});

test("a person keeps several threads; replies reach every member; merge groups people", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "griffin-mother-"));
  const store = openStore(path.join(dir, "db.sqlite"));
  const sent = [];
  const runner = { isActive: () => false, cancel: async () => {}, send: async (chatId, input) => sent.push([chatId, input.text]) };
  const integrations = createIntegrations({ store, runner, asks: null, log: {} });
  try {
    const acc = store.createIntegration({ kind: "telegram_account", name: "acc", secret: "{}", settings: {} });
    const ali = store.upsertPerson({ externalId: "1001", name: "علی", data: { platform: "telegram" } });
    const reza = store.upsertPerson({ externalId: "1002", name: "رضا", data: { platform: "telegram" } });
    const { bridge } = integrations;
    const a = await bridge.startCoverage(acc.id, "1001", { name: "علی", personId: ali.id, fresh: true, title: "🧵 علی: A" });
    const b = await bridge.startCoverage(acc.id, "1001", { name: "علی", personId: ali.id, fresh: true, title: "🧵 علی: B" });
    assert.notEqual(a.chatId, b.chatId);
    assert.equal(store.openThreads(acc.id, "1001").length, 2, "two threads open at once");
    assert.equal(store.linkedChat(acc.id, "1001"), b.chatId, "the pointer is the newest");
    assert.deepEqual(store.linksForChat(a.chatId).map((l) => l.external_chat), ["1001"], "the older thread still delivers");
    assert.equal(store.getChat(a.chatId).caller, COVERAGE_CALLER);

    await bridge.closeThread(b.chatId);
    assert.equal(store.linkedChat(acc.id, "1001"), a.chatId, "closing repoints to the next open thread");
    assert.equal(bridge.isCovered(acc.id, "1001"), true);

    const c = await bridge.startCoverage(acc.id, "1002", { name: "رضا", personId: reza.id, fresh: true, title: "🧵 رضا: همان" });
    const merged = await bridge.mergeThreads(c.chatId, a.chatId);
    assert.deepEqual(merged.members.sort(), ["رضا", "علی"]);
    assert.deepEqual(store.linksForChat(a.chatId).map((l) => l.external_chat).sort(), ["1001", "1002"], "one answer reaches both");
    assert.equal(store.linkedChat(acc.id, "1002"), a.chatId);
    assert.equal(store.getChat(c.chatId).archived, 1);
    assert.match(sent.at(-1)[1], /یکی شد/);
    assert.equal(store.threadsForPerson(reza.id).find((t) => t.id === a.chatId).closed, false);

    await bridge.endCoverage(acc.id, "1002");
    assert.equal(bridge.isCovered(acc.id, "1002"), false, "/agent off stops it for that person");
    assert.equal(bridge.isCovered(acc.id, "1001"), true, "and not for the other member");
  } finally {
    store.close?.();
  }
});
