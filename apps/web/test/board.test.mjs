// The home-page task board: the inbox store and which chats the home-page board lists as working or just done.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { cardHead, createInboxStore, hasBoard, recentDone, sourceTag, stepLine, workingTasks } from "../src/board.js";

const tick = () => new Promise((r) => setImmediate(r));
const NOW = Date.parse("2026-10-12T12:00:00.000Z");
const iso = (minutesAgo) => new Date(NOW - minutesAgo * 60_000).toISOString();
const chat = (id, extra = {}) => ({ id, title: id, source: "manual", runStatus: "finished", updatedAt: iso(10), ...extra });
const src = (file) => fs.readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8");
const between = (text, from, to) => text.slice(text.indexOf(from), text.indexOf(to, text.indexOf(from)));

test("inbox store: a refresh asked for mid-fetch runs once more after it; subscribers get the latest", async () => {
  const pending = [];
  const store = createInboxStore(() => new Promise((resolve) => pending.push(resolve)));
  let notified = 0;
  store.subscribe(() => (notified += 1));
  const first = store.refresh();
  await tick();
  assert.equal(pending.length, 1);
  assert.equal(store.refresh(), first, "same promise while one is in flight");
  store.refresh();
  pending[0]({ items: [{ id: "a" }], count: 1, todos: {} });
  await tick();
  assert.equal(pending.length, 2, "the coalesced re-run");
  pending[1]({ items: [{ id: "a" }, { id: "b" }], count: 2, todos: { c1: { done: 1, total: 2, current: "x" } } });
  await first;
  assert.equal(pending.length, 2, "exactly two fetches");
  assert.equal(notified, 2);
  assert.deepEqual(store.get().items.map((i) => i.id), ["a", "b"]);
  assert.equal(store.get().count, 2);
  assert.equal(store.get().loaded, true);
  assert.equal(store.get().todos.c1.current, "x");
});

test("inbox store: a failed fetch keeps the last list and marks it loaded", async () => {
  let fail = false;
  const store = createInboxStore(async () => {
    if (fail) throw new Error("502");
    return { items: [{ id: "a" }], count: 1, todos: {} };
  });
  await store.refresh();
  fail = true;
  await store.refresh();
  assert.deepEqual(store.get().items.map((i) => i.id), ["a"]);
  const fresh = createInboxStore(() => {
    throw new Error("down");
  });
  await fresh.refresh();
  assert.equal(fresh.get().loaded, true);
  assert.deepEqual(fresh.get().items, []);
  await fresh.refresh(); // not stuck on the failed run
});

test("workingTasks: running chats, parents of running subtasks and plan-limit waits; newest first, capped", () => {
  const list = [
    chat("done"),
    chat("run", { runStatus: "running", runStartedAt: iso(5), waitingForOwner: true }),
    chat("parent", { runStartedAt: iso(30), children: [{ id: "k1", runStatus: "running" }, { id: "k2", runStatus: "finished" }] }),
    chat("limit", { runStartedAt: iso(60), limitResumeAt: NOW + 3600_000 }),
  ];
  const rows = workingTasks(list, { run: { done: 1, total: 3, current: "بررسی دیسک" } });
  assert.deepEqual(rows.map((r) => r.chat.id), ["run", "parent", "limit"]);
  assert.equal(rows[0].todo.current, "بررسی دیسک");
  assert.equal(rows[0].waiting, true);
  assert.equal(rows[0].resumeAt, null);
  assert.equal(rows[1].runningChildren, 1);
  assert.equal(rows[1].todo, null);
  assert.equal(rows[2].resumeAt, NOW + 3600_000);
  // A task that runs only through its subtasks can still be stopped (cancelling the root cancels its
  // delegates); a plan-limit wait has its own «لغو».
  assert.deepEqual(rows.map((r) => r.stoppable), [true, true, false]);
  const many = Array.from({ length: 20 }, (_, i) => chat(`r${i}`, { runStatus: "running", runStartedAt: iso(i) }));
  assert.equal(workingTasks(many).length, 12);
  assert.equal(workingTasks(many)[0].chat.id, "r0");
});

test("recentDone: the owner's and colleagues' tasks of the last day, unread first, capped", () => {
  const list = [
    chat("read-new", { updatedAt: iso(1) }),
    chat("unread-old", { updatedAt: iso(120), runStatus: "error" }),
    chat("peer", { source: "peer", runStatus: "cancelled", updatedAt: iso(2) }),
    chat("tg", { source: "telegram" }),
    chat("job", { source: "job" }),
    chat("mother", { mother: true }),
    chat("global", { global: true }),
    chat("stale", { updatedAt: iso(25 * 60) }),
    chat("running", { runStatus: "running" }),
    chat("child-runs", { children: [{ id: "k", runStatus: "running" }] }),
    chat("never-ran", { runStatus: null }),
  ];
  const ids = recentDone(list, { isUnread: (c) => c.id === "unread-old", now: NOW }).map((c) => c.id);
  assert.deepEqual(ids, ["unread-old", "read-new", "peer"]);
  const many = Array.from({ length: 10 }, (_, i) => chat(`d${i}`, { updatedAt: iso(i) }));
  assert.equal(recentDone(many, { now: NOW }).length, 6);
});

test("a resolved error stays under «تازه تمام شد»; the kept card resolves or closes the chat", () => {
  assert.deepEqual(recentDone([chat("fixed", { runStatus: "resolved", updatedAt: iso(30) })], { now: NOW }).map((c) => c.id), ["fixed"]);
  const kept = between(src("components/Board.jsx"), 'item.kind === "kept" ? (', 'item.kind === "note" ? (');
  assert.match(kept, /\/retry`/);
  assert.match(kept, /\/resolve`/);
  assert.match(kept, /حل شد/);
  assert.match(kept, /archived: true[^]*بستن/);
  assert.doesNotMatch(kept, /\/kept\//, "«حذف» gave way to «حل شد»");
});

test("stepLine, sourceTag and hasBoard", () => {
  assert.equal(stepLine({ todo: { done: 2, total: 5, current: "بررسی دیسک" } }), "۲/۵ — بررسی دیسک");
  assert.equal(stepLine({ todo: { done: 5, total: 5, current: null } }), "۵/۵");
  assert.match(stepLine({ resumeAt: NOW }), /^ساعت [۰-۹]{2}:[۰-۹]{2} خودش ادامه می‌دهد$/);
  assert.equal(stepLine({}), "در حال کار");
  assert.equal(sourceTag({ source: "peer" }), "همکار");
  assert.equal(sourceTag({ source: "manual", mother: true }), "تلگرام");
  assert.equal(sourceTag({ source: "manual" }), null);
  assert.equal(hasBoard({ count: 0 }, []), false);
  assert.equal(hasBoard(null, null), false);
  assert.equal(hasBoard({ count: 1 }, []), true);
  assert.equal(hasBoard({ count: 0 }, [chat("r", { runStatus: "running" })]), true);
  assert.equal(hasBoard({ count: 0 }, [], 2), true, "open suggestions wait for him too");
});

test("cardHead: the title, and the chain it came from on its own line — chores included", () => {
  assert.deepEqual(cardHead({ kind: "question", title: "دسترسی لاگ", who: "خانم سارا احمدی" }), { title: "دسترسی لاگ", who: "از گفتگو با «خانم سارا احمدی»" });
  assert.deepEqual(cardHead({ kind: "chore", title: "علی را به گروه X اضافه کن", who: "آقای علی رضایی" }), { title: "", who: "از گفتگو با «آقای علی رضایی»" });
  assert.deepEqual(cardHead({ kind: "kept", chatTitle: "گزارش" }), { title: "گزارش", who: null });
});

test("Board.jsx: who off the header row, suggestions without inbox items, stop on subtasks", () => {
  const board = src("components/Board.jsx");
  const card = between(board, "function InboxCard(", "function TaskLists(");
  const header = between(card, '<div className="flex min-w-0 flex-wrap', "</div>");
  // At 375px a nowrap «از گفتگو با «…»» beside the title squeezed it to a few characters.
  assert.doesNotMatch(header, /\bwho\b/, "who is on its own line, not in the header row");
  assert.match(card, /\{who \? <p /);
  const needs = between(board, "export function NeedsYou(", "function InboxCard(");
  assert.match(needs, /if \(!inbox\.items\.length && !suggestions\) return null;/);
  assert.match(needs, /<SidebarSuggestions \/>/, "the sidebar's copy refreshes the store; no second fetch per chat-list change");
  const row = between(board, "function WorkingRow(", "\n}\n");
  assert.match(row, /\{row\.stoppable \? \(/);
});

test("new chat page: the box is docked at the bottom and the board fills the page above it", () => {
  const thread = src("components/Thread.jsx");
  const body = between(thread, "function ThreadBody(", "function WelcomeHero(");
  // Docked in the footer like a chat's box: it never moves or remounts (a dictation in progress
  // would be thrown away) when the first board item arrives.
  assert.match(body, /const docked = showHero && !compact/);
  assert.match(body, /readOnly \|\| \(showHero && !docked\) \? null/);
  assert.match(body, /variant=\{showHero \? "hero" : "dock"\}/);
  const hero = between(thread, "function WelcomeHero(", "const fadeUp =");
  assert.match(hero, /const composer = docked \? null/, "the hero leaves its composer slot empty when docked");
  assert.doesNotMatch(hero, /if \(board\)/);
  const tree = hero.slice(hero.lastIndexOf("return ("));
  const slots = ["welcome-glow", "<SetupCard />", "{board.top}", "{bottom}", "suggestions.map"];
  const at = slots.map((slot) => tree.indexOf(slot));
  assert.ok(at.every((i) => i > 0), "every slot is in the one tree");
  assert.deepEqual([...at].sort((a, b) => a - b), at, "tasks on top: «منتظر شما», then the task lists");
});
