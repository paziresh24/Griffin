import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openStore } from "../src/db.mjs";
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


test("after the owner's yes in a colleague's agent conversation, the handoff starts his chat at once — once per yes", async () => {
  const { createAsks, OWNER_YES_KEY, ownerSaidYes } = await import("../src/asks.mjs");
  const { startSuggestedChat } = await import("../src/suggest-start.mjs");
  const store = fresh();
  const runner = fakeRunner();
  const peer = store.createChat({ title: "نقش Developer", caller: "peer:mahdi-bagheri" });
  const asks = createAsks({ store, log: null });
  // The owner taps the first (recommended) option of the agent's question; the colleague cannot answer it.
  const asked = asks.tool(peer.id).execute({ question: "پوش مستقیم به master برای mohr؟", options: [{ label: "بله، فقط mohr" }, { label: "نه" }] });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(asks.answer(peer.id, { answer: "بله، فقط mohr", by: "requester" }), false);
  assert.equal(asks.answer(peer.id, { answer: "بله، فقط mohr" }), true);
  await asked;
  assert.equal(store.getKv(OWNER_YES_KEY(peer.id)).question, "پوش مستقیم به master برای mohr؟");

  const rung = [];
  const tool = handoffTool({ store, chatId: peer.id, rootChatId: peer.id, who: "نوید (مهدی حسینی)", notify: async (text) => rung.push(text), start: (row) => startSuggestedChat({ store, runner, row }) });
  const out = body(await tool.execute({ title: "پوش مستقیم mohr", why: "مهدی پوش مستقیم می‌خواهد", prompt: "git_push را برای mahdibagheri/mohr باز کن" }));
  assert.match(out.started, /شروع شد/);
  const row = store.getSuggestion(out.id);
  assert.equal(row.status, "started");
  assert.equal(runner.sent.length, 1, "the owner's chat got the prompt without a click");
  assert.equal(runner.sent[0].chatId, row.started_chat_id);
  assert.match(runner.sent[0].text, /جواب «بله، فقط mohr» داد/, "the started chat knows what he said yes to");
  assert.equal(handoffOf(store, row.started_chat_id).from, peer.id, "its results report back");
  assert.match(rung[0], /شروع شد/);
  assert.equal(store.getKv(OWNER_YES_KEY(peer.id)), null, "the yes is spent");

  // The next handoff in the same conversation waits for its own approval.
  const next = body(await tool.execute({ title: "کار دیگر", why: "w", prompt: "p" }));
  assert.equal(next.started, undefined);
  assert.equal(store.getSuggestion(next.id).status, "open");
  assert.match(rung[1], /«شروع»/);

  assert.equal(ownerSaidYes("نه، فعلاً نه", [{ label: "نه، فعلاً نه" }]), false);
  assert.equal(ownerSaidYes("اوکیه"), true);
  assert.equal(ownerSaidYes("فقط برای mohr", [{ label: "فقط برای mohr" }, { label: "رد" }]), true);
  assert.equal(ownerSaidYes("فقط برای mohr", [{ label: "اول بررسی کن" }]), false);
});

test("an old yes or a no never starts a handoff by itself", async () => {
  const { OWNER_YES_KEY } = await import("../src/asks.mjs");
  const store = fresh();
  const runner = fakeRunner();
  const peer = store.createChat({ title: "x", caller: "peer:a" });
  store.setKv(OWNER_YES_KEY(peer.id), { question: "q", answer: "بله", at: new Date(Date.now() - 4 * 3_600_000).toISOString() });
  const tool = handoffTool({ store, chatId: peer.id, rootChatId: peer.id, start: async () => { throw new Error("must not start"); } });
  const out = body(await tool.execute({ title: "t", why: "w", prompt: "p" }));
  assert.equal(out.started, undefined);
  assert.equal(runner.sent.length, 0);
});
