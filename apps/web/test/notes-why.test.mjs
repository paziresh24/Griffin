import test from "node:test";
import assert from "node:assert/strict";
import { createNotesStore, noteBody, noteError, noteWhen, sidebarNotes, untilLabel } from "../src/notes.js";
import { changeLabel, whyRows } from "../src/why.js";

test("a note's body: into a chat, or a new chat keeping an explicit «no repo»", () => {
  assert.deepEqual(noteBody({ text: " سلام ", chatId: "c1", atMs: null }), { text: "سلام", runAt: null, chatId: "c1" });
  const body = noteBody({ text: "x", atMs: Date.UTC(2026, 9, 12, 10), options: { repo: "", model: "", agent: "griffin", mode: undefined } });
  assert.deepEqual(body.options, { repo: "", agent: "griffin" });
  assert.equal(body.runAt, "2026-10-12T10:00:00.000Z");
});

test("when-labels count down; server refusals read as plain Persian", () => {
  const now = Date.now();
  assert.equal(untilLabel(now + 15 * 60_000, now), "۱۵ دقیقه دیگر");
  assert.equal(untilLabel(now - 1, now), "موعدش رسیده");
  assert.equal(untilLabel(now + 2 * 3_600_000 - 20_000, now), "۲ ساعت دیگر");
  assert.equal(untilLabel(now + 90 * 60_000, now), "۱ ساعت و ۳۰ دقیقه دیگر");
  assert.match(noteWhen({ runAt: null }), /بدون زمان/);
  assert.equal(noteError(new Error("unknown repo")), "این ریپو روی سرور نیست");
  assert.equal(noteError(new Error("already started")), "این یادداشت قبلاً اجرا شده");
});

test("the notes store refreshes after an action and runs one note at a time", async () => {
  const calls = [];
  const store = createNotesStore(async (path, opts = {}) => {
    calls.push(`${opts.method || "GET"} ${path}`);
    if (path === "/api/notes") return { notes: [{ id: "n1", text: "x" }] };
    return { chat: { id: "c9" } };
  });
  assert.equal((await store.run("n1")).id, "c9");
  assert.deepEqual(calls, ["POST /api/notes/n1/run", "GET /api/notes"]);
  assert.equal(store.getState().items.length, 1);
});

test("why rows: a fine stretch of tools is one line; failures, decisions and odd ends stand alone", () => {
  const rows = whyRows([
    { kind: "tool", name: "kube_get", status: "success", durationMs: 1000, at: "2026-10-12T10:00:02Z" },
    { kind: "tool", name: "kube_logs", status: "success", count: 2, durationMs: 500, at: "2026-10-12T10:00:04Z" },
    { kind: "decision", tool: "gitlab_mr", decision: "review-rejected", bad: true, text: "push به main" },
    { kind: "tool", name: "gitlab_mr", status: "error", error: "denied" },
    { kind: "message", text: "فقط کلاستر اول" },
    { kind: "end", status: "finished" },
  ]);
  assert.deepEqual(rows.map((r) => r.kind), ["tools", "decision", "tool", "message"]);
  assert.equal(rows[0].label, "۳ ابزار اجرا شد");
  assert.equal(rows[0].durationMs, 3000);
  assert.equal(rows[1].tone, "bad");
  assert.match(rows[1].label, /بازبین‌ها رد کردند/);
  assert.equal(whyRows([{ kind: "end", status: "error", error: "x" }])[0].label, "با خطا تمام شد");
  assert.match(changeLabel({ kind: "tools", change: "added", names: ["debug_exec"] }), /debug_exec/);
  assert.equal(changeLabel({ kind: "engine", key: "model" }), "مدل عوض شد");
});

test("the sidebar lists the person's own notes; the agent's reminders stay in their chat", () => {
  const items = [{ id: "a", text: "بعداً بپرس" }, { id: "r", text: "CI را چک کن", reminder: true, chatId: "c1" }];
  assert.deepEqual(sidebarNotes(items).map((n) => n.id), ["a"]);
  assert.deepEqual(sidebarNotes(null), []);
});
