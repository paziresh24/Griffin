import test from "node:test";
import assert from "node:assert/strict";

// Work.jsx imports JSX; test the pure split by loading only its function source.
import fs from "node:fs";
import { unwrapResult } from "../src/result.js";
const src = fs.readFileSync(new URL("../src/components/Work.jsx", import.meta.url), "utf8");
const body = src.slice(src.indexOf("const RESULT_TOOLS"), src.indexOf("export function toolProps")).replace("export function", "function");
const splitRun = new Function("unwrapResult", `${body}; return splitRun;`)(unwrapResult);

test("finished run: work log holds thinking, tools and narration; answer holds final text and result tools", () => {
  const parts = [
    { type: "reasoning", text: "a" },
    { type: "text", text: "الان چک می‌کنم" },
    { type: "tool", name: "kube_status" },
    { type: "tool", name: "visualize" },
    { type: "text", text: "بعدی" },
    { type: "tool", name: "metrics_query" },
    { type: "reasoning", text: "b" },
    { type: "text", text: "**جواب**" },
  ];
  const { work, answer } = splitRun(parts);
  assert.deepEqual(work.map((p) => p.name || p.text), ["a", "الان چک می‌کنم", "kube_status", "بعدی", "metrics_query", "b"]);
  assert.deepEqual(answer.map((p) => p.name || p.text), ["visualize", "**جواب**"]);
});

test("no tools: only thinking goes to the log", () => {
  const { work, answer } = splitRun([{ type: "reasoning", text: "x" }, { type: "text", text: "سلام" }]);
  assert.equal(work.length, 1);
  assert.deepEqual(answer.map((p) => p.text), ["سلام"]);
});

// An ask_owner result as the timeline stores it (MCP content, first text part is the JSON).
const askResult = (value) => ({ value: { content: [{ type: "text", text: JSON.stringify(value) }] } });

test("an answered ask_owner stays in place in the work log; a pending one is pulled out", () => {
  const tool = (name, status = "complete") => ({ type: "tool", name, status });
  const ask = { ...tool("ask_owner", "success"), result: askResult({ answered: true, answer: "بله" }) };
  const answered = splitRun([tool("mikrotik_exec"), ask, tool("mikrotik_exec"), { type: "text", text: "done" }]);
  assert.deepEqual(answered.work.map((p) => p.name), ["mikrotik_exec", "ask_owner", "mikrotik_exec"]);
  const pending = splitRun([tool("mikrotik_exec"), tool("ask_owner", "running")]);
  assert.deepEqual(pending.answer.map((p) => p.name), ["ask_owner"]);
});

// diff.md §8.1: the run stopped with the question unanswered; Griffin folded the card into the
// collapsed work group, so the owner never saw it. Whatever ended the run, an open question is shown.
test("an ask_owner left unanswered when the run stopped is never folded into the work log", () => {
  const work = { type: "tool", name: "Bash", status: "success" };
  const endings = [
    { status: "success", result: askResult({ answered: false, reason: "no answer" }) },
    { status: "error" },
    { status: "cancelled" },
    { status: "success" },
  ];
  for (const ending of endings) {
    const ask = { type: "tool", name: "ask_owner", callId: "c1", args: { question: "کجا؟" }, ...ending };
    const { work: log, answer } = splitRun([work, ask, work, { type: "text", text: "متوقف شد" }]);
    assert.ok(!log.includes(ask), `folded into the log when ${JSON.stringify(ending)}`);
    assert.ok(answer.includes(ask), `missing from the answer when ${JSON.stringify(ending)}`);
  }
});

test("a closed question without an answer stays history: the nag guard's duplicate, an over plan-limit card", () => {
  const work = { type: "tool", name: "Bash", status: "success" };
  const duplicate = { type: "tool", name: "ask_owner", status: "success", result: askResult({ answered: false, duplicate: true }) };
  const plan = { type: "tool", name: "ask_owner", status: "success", args: { kind: "plan-fallback" }, result: askResult({ answered: false }) };
  for (const ask of [duplicate, plan]) assert.ok(splitRun([work, ask, work]).work.includes(ask));
});

test("the native AskUserQuestion twin of an ask_owner card is dropped; a lone one is kept", () => {
  const native = { type: "tool", name: "AskUserQuestion", callId: "toolu_1", status: "success", args: { questions: [{ question: "کجا؟" }] } };
  const card = { type: "tool", name: "ask_owner", callId: "toolu_1:ask:0", status: "running", args: { question: "کجا؟" } };
  const both = splitRun([native, card]);
  assert.deepEqual([...both.work, ...both.answer].map((p) => p.name), ["ask_owner"]);
  const lone = splitRun([native, { type: "text", text: "x" }]);
  assert.deepEqual(lone.work.map((p) => p.name), ["AskUserQuestion"]);
});

test("the native ExitPlanMode twin of its plan card (PLAN_APPROVAL) is dropped; a lone one is kept", () => {
  const native = { type: "tool", name: "ExitPlanMode", callId: "toolu_9", status: "success", args: {} };
  const card = { type: "tool", name: "ask_owner", callId: "toolu_9:ask:plan", status: "running", args: { question: "Approve this plan?" } };
  const both = splitRun([native, card]);
  assert.deepEqual([...both.work, ...both.answer].map((p) => p.name), ["ask_owner"]);
  const lone = splitRun([native, { type: "text", text: "x" }]);
  assert.deepEqual(lone.work.map((p) => p.name), ["ExitPlanMode"]);
});

// A review finding: questions the system refused or nobody watches are not the owner's to answer.
test("refused, unwatched and withdrawn questions stay in the log; a timeout or a stopped run's question comes out", () => {
  const work = { type: "tool", name: "Bash", status: "success" };
  const ask = (result, status = "success") => ({ type: "tool", name: "ask_owner", status, result });
  const refusal = { value: { isError: true, content: [{ type: "text", text: "انتخاب ابزار با خودت است" }] } };
  const closed = [
    ask(refusal, "error"),
    ask(askResult({ answered: false, reason: "nobody is watching this chain (scheduler/job/ops root) — decide yourself or refuse" })),
    ask(askResult({ answered: false, reason: "withdrawn" })),
    ask({ status: "error", error: { message: "question is required" } }, "error"),
  ];
  for (const part of closed) assert.ok(splitRun([work, part, work]).work.includes(part), JSON.stringify(part.result));
  const open = [
    ask(askResult({ answered: false, reason: "no answer from the owner in 30 minutes — record it in triage as waiting for him and go on" })),
    ask(askResult({ answered: false, reason: "the owner stopped the run before answering" })),
    ask(null, "error"),
  ];
  for (const part of open) assert.ok(splitRun([work, part, work]).answer.includes(part), JSON.stringify(part.result));
});

test("a native AskUserQuestion with more questions than cards is kept: its later questions live only there", () => {
  const native = { type: "tool", name: "AskUserQuestion", callId: "toolu_2", status: "error", args: { questions: [{ question: "a" }, { question: "b" }] } };
  const card = { type: "tool", name: "ask_owner", callId: "toolu_2:ask:0", status: "cancelled", args: { question: "a" } };
  const { work, answer } = splitRun([native, card]);
  assert.deepEqual([...work, ...answer].map((p) => p.name).sort(), ["AskUserQuestion", "ask_owner"]);
});

// A part type this renderer does not know (`suggestion` / `chapter`, or anything later) has no
// text and no tool fields: drawn as text it would throw. It is set aside instead.
test("unknown part types are set aside, never handed to the text or tool renderers", () => {
  const parts = [
    { type: "chapter", title: "کاوش", summary: null },
    { type: "text", text: "الان" },
    { type: "tool", name: "kube_status" },
    { type: "suggestion", id: "s1", title: "رفع README", tldr: "x", status: "open" },
    { type: "mystery" },
    { type: "text", text: "جواب" },
  ];
  const { work, answer, other } = splitRun(parts);
  for (const part of [...work, ...answer]) assert.ok(["text", "reasoning", "tool"].includes(part.type), part.type);
  assert.deepEqual(work.map((p) => p.name || p.text), ["الان", "kube_status"]);
  assert.deepEqual(answer.map((p) => p.text), ["جواب"]);
  assert.deepEqual(other.map((p) => p.type), ["chapter", "suggestion", "mystery"]);
});
