import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openStore } from "../src/db.mjs";
import { buildRules } from "../src/prompt.mjs";
import { HANDOFF_MAX_OPEN, handoffDismissed, handoffOf, handoffStarted, handoffTool, shellWrites, teamWriteVerdict, watchHandoffs } from "../src/handoff.mjs";

const fresh = () => openStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "griffin-handoff-")), "db.sqlite"));
const body = (out) => JSON.parse(out.content[0].text);
const fakeRunner = () => {
  const sent = [];
  return { sent, isActive: () => false, send: async (chatId, input) => sent.push({ chatId, ...input }) };
};

test("handoff_to_owner leaves a suggested chat from the chain's root and rings the owner once", async () => {
  const store = fresh();
  const mother = store.createChat({ title: "👤 ابوالفضل حسینی", caller: "team" });
  const sub = store.createChat({ title: "رشته", caller: "agent:platform", parentChatId: mother.id });
  const rung = [];
  const tool = handoffTool({ store, chatId: sub.id, rootChatId: mother.id, who: "ابوالفضل حسینی", notify: async (text, chatId) => rung.push({ text, chatId }) });
  const out = await tool.execute({ title: "بکاپ دستی سفارش‌ها", why: "بکاپ پیش از مهاجرت لازم است", prompt: "Backup orders-db-manual در ns hojat-khajavi روی east" });
  assert.equal(out.isError, undefined);
  const { id } = body(out);
  const row = store.getSuggestion(id);
  assert.equal(row.from_chat_id, mother.id, "the card belongs to the conversation, not the subtask");
  assert.equal(row.status, "open");
  assert.match(row.prompt, /سپرده‌شده از گفتگوی/);
  assert.match(row.prompt, /نه دستور/, "the colleague side's text is framed as evidence");
  assert.match(row.prompt, /orders-db-manual/);
  assert.match(row.tldr, /ابوالفضل حسینی/);
  assert.equal(rung.length, 1);
  assert.equal(rung[0].chatId, mother.id);
  // Owner 2026-10-25: «قابل فهم نیستن که یعنی چی» — the line says what waits on him and what «شروع» does.
  assert.match(rung[0].text, /منتظر تأیید شماست: بکاپ دستی سفارش‌ها/);
  assert.match(rung[0].text, /درخواست از ابوالفضل حسینی: بکاپ پیش از مهاجرت لازم است/);
  assert.match(rung[0].text, /«شروع»/);

  // The same title again is the same handoff, not a new card.
  const again = body(await tool.execute({ title: "بکاپ دستی سفارش‌ها", why: "x", prompt: "y" }));
  assert.equal(again.id, id);
  assert.equal(store.listSuggestions({ status: "open" }).length, 1);
});

test("handoff_to_owner caps open handoffs per conversation and refuses a prompt too long", async () => {
  const store = fresh();
  const mother = store.createChat({ title: "👤 x", caller: "team" });
  const tool = handoffTool({ store, chatId: mother.id, rootChatId: mother.id });
  for (let i = 0; i < HANDOFF_MAX_OPEN; i++) assert.equal((await tool.execute({ title: `کار ${i}`, why: "w", prompt: "p" })).isError, undefined);
  const over = await tool.execute({ title: "یکی دیگر", why: "w", prompt: "p" });
  assert.equal(over.isError, true);
  assert.match(body(over).error, /already has 3 handoffs/);
  const long = await handoffTool({ store, chatId: "z", rootChatId: store.createChat({ title: "y", caller: "team" }).id }).execute({ title: "t", why: "w", prompt: "x".repeat(4000) });
  assert.equal(long.isError, true);
});

test("a started handoff reports each finished run back to the conversation; a dismissed one says so", async () => {
  const store = fresh();
  const runner = fakeRunner();
  const mother = store.createChat({ title: "👤 x", caller: "team" });
  const tool = handoffTool({ store, chatId: mother.id, rootChatId: mother.id, who: "x" });
  const { id } = body(await tool.execute({ title: "ساخت بکاپ", why: "w", prompt: "p" }));
  const started = store.createChat({ title: "ساخت بکاپ" });
  assert.equal(handoffStarted(store, id, started.id), true);
  assert.equal(handoffOf(store, started.id).from, mother.id);
  assert.equal(handoffStarted(store, id, started.id), false, "once");

  const stop = watchHandoffs({ store, runner, finalTextOf: async () => "بکاپ ساخته شد و completed است", frame: (_from, text) => `«صاحب‌کار از داخل اپ»: ${text}` });
  store.appendEvent(started.id, null, "run.finished", { status: "finished" });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(runner.sent.length, 1);
  assert.equal(runner.sent[0].chatId, mother.id);
  assert.match(runner.sent[0].text, /^«صاحب‌کار از داخل اپ»: \[نتیجهٔ گفتگوی اصلی/);
  assert.match(runner.sent[0].text, /completed/);
  // An unrelated chat's run says nothing.
  store.appendEvent(store.createChat({ title: "other" }).id, null, "run.finished", { status: "finished" });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(runner.sent.length, 1);
  stop();

  const second = body(await tool.execute({ title: "کار دوم", why: "w", prompt: "p" }));
  assert.equal(handoffDismissed(store, runner, second.id), true);
  assert.equal(runner.sent.length, 2);
  assert.match(runner.sent[1].text, /رد کرد/);
  // A plain suggestion (not a handoff) is neither.
  const plain = store.createSuggestion({ fromChatId: mother.id, title: "t", prompt: "p" });
  assert.equal(handoffStarted(store, plain.id, started.id), false);
  assert.equal(handoffDismissed(store, runner, plain.id), false);
});

test("team write verdict: writes need the handoff, reads pass", () => {
  assert.ok(teamWriteVerdict("gitlab_propose", {}));
  assert.ok(teamWriteVerdict("gitlab_mr", { action: "merge" }));
  assert.equal(teamWriteVerdict("gitlab_mr", { action: "view" }), null);
  assert.ok(teamWriteVerdict("debug_exec", { command: "kubectl -n x rollout restart deploy/y" }));
  assert.ok(teamWriteVerdict("debug_exec", { command: "curl -X POST https://example.com/api" }));
  assert.ok(teamWriteVerdict("debug_exec", { command: "psql -c 'delete from users where id=1'" }));
  assert.equal(teamWriteVerdict("debug_exec", { command: "kubectl -n x get pods -o wide | grep orders" }), null);
  assert.equal(teamWriteVerdict("debug_exec", { command: "curl -s https://www.example.com/healthz" }), null);
  assert.equal(teamWriteVerdict("kube_get", { kind: "pods" }), null);
  assert.equal(shellWrites("kubectl logs deploy/x --tail 50"), false);
});

test("the read-only handoff rules come with the tool, and win over owner_task", () => {
  const rules = buildRules({ caller: "team", tools: ["handoff_to_owner", "kube_get"] });
  assert.match(rules, /Read-only chain/);
  assert.ok(rules.indexOf("Read-only chain") > rules.indexOf("Work as tasks"), "said after the task rule it overrides");
  assert.doesNotMatch(buildRules({ caller: "owner", tools: ["owner_task"] }), /Read-only chain/);
});
