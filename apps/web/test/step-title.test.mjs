// A command step reads like Claude Desktop: the row shows the model's plain sentence (Claude Bash's
// `description`, or the `intent` a guarded call carries), else where the command ran; the raw
// command stays on the row while running or failed, and in the opened body always.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const src = fs.readFileSync(new URL("../src/components/Tool.jsx", import.meta.url), "utf8");
const work = fs.readFileSync(new URL("../src/components/Work.jsx", import.meta.url), "utf8");
const start = src.indexOf("const SHELL_PLACES");
assert.ok(start >= 0, "Tool.jsx defines the shell steps");
const body = src.slice(start, src.indexOf("}\n", src.indexOf("export function stepTitle")) + 2).replace("export function", "function");
// t() as in tests: the Persian key with its {placeholders} filled.
const t = (text, vars) => (vars ? text.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m)) : text);
const stepTitle = new Function("t", `${body}; return stepTitle;`)(t);

test("the model's own sentence is the title", () => {
  assert.equal(stepTitle("Bash", { command: "ls", description: "  look for\nkubeconfigs " }), "look for kubeconfigs");
  assert.equal(stepTitle("debug_exec", { command: "df -h", intent: "می‌خوام ببینم دیسک چقدر پره" }), "می‌خوام ببینم دیسک چقدر پره");
});

test("no sentence: where the command ran, never the raw command", () => {
  assert.equal(stepTitle("debug_exec", { command: "ls" }), "دستور در سندباکس");
  assert.equal(stepTitle("debug_exec", { command: "ls", host: "build-box" }), "دستور روی build-box");
  assert.equal(stepTitle("ssh_exec", { host: "192.0.2.5", command: "uptime", intent: "   " }), "دستور روی 192.0.2.5");
  assert.equal(stepTitle("kube_exec", { pod: "web-1", command: "env" }), "دستور داخل پاد web-1");
  assert.equal(stepTitle("mikrotik_exec", { router: "office", command: "/ip/route/print" }), "کنسول میکروتیک office");
  assert.equal(stepTitle("Bash", undefined), "دستور");
});

test("other tools keep their label", () => {
  assert.equal(stepTitle("kube_get", { description: "x" }), null);
  assert.equal(stepTitle("Artifact", { description: "gallery subtitle" }), null);
});

test("row and running work log use the sentence; the command stays visible running, failed and opened", () => {
  const card = src.slice(src.indexOf("function GenericToolCard"), src.indexOf("export function SourceBadge"));
  assert.match(card, /stepTitle\(toolName, args\)/);
  assert.match(card, /plain \? \(running \|\| isError \? args\.command : ""\)/);
  assert.match(work, /stepTitle\(current\.name, current\.args\)/);
  const toolBody = src.slice(src.indexOf("function ToolBody"), src.indexOf("switch (toolName)"));
  const withCommand = toolBody.indexOf("<ShellCommand command={args.command} />");
  assert.ok(withCommand >= 0 && withCommand < toolBody.indexOf("if (isError) return <ErrorBody"), "a failed step shows its command above the error");
  const shell = src.slice(src.indexOf('case "debug_exec":'), src.indexOf('case "mikrotik_print":'));
  assert.match(shell, /<ShellBody toolName=\{toolName\} args=\{args\} result=\{result\} \/>/);
  const views = fs.readFileSync(new URL("../src/components/ToolViews.jsx", import.meta.url), "utf8");
  assert.match(views, /<ShellCommand command=\{args\.command\} \/>/, "the opened body shows the command above the output");
});
