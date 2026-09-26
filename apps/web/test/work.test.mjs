import test from "node:test";
import assert from "node:assert/strict";

// Work.jsx imports JSX; test the pure split by loading only its function source.
import fs from "node:fs";
const src = fs.readFileSync(new URL("../src/components/Work.jsx", import.meta.url), "utf8");
const body = src.slice(src.indexOf("const RESULT_TOOLS"), src.indexOf("export function toolProps")).replace("export function", "function");
const splitRun = new Function(`${body}; return splitRun;`)();

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

test("an answered ask_owner stays in place in the work log; a pending one is pulled out", () => {
  const tool = (name, status = "complete") => ({ type: "tool", name, status });
  const answered = splitRun([tool("mikrotik_exec"), tool("ask_owner"), tool("mikrotik_exec"), { type: "text", text: "done" }]);
  assert.deepEqual(answered.work.map((p) => p.name), ["mikrotik_exec", "ask_owner", "mikrotik_exec"]);
  const pending = splitRun([tool("mikrotik_exec"), tool("ask_owner", "running")]);
  assert.deepEqual(pending.answer.map((p) => p.name), ["ask_owner"]);
});
