// The consult tool (server peers.mjs) gets its own card body: the other model's answer as
// markdown, who answered, why it failed, and a way into the consult's sub-chat. The frame is
// GenericToolCard's, so both skins draw it and only the body is new (no skin branch of its own).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const src = fs.readFileSync(new URL("../src/components/Tool.jsx", import.meta.url), "utf8");
const section = (from, to) => {
  const start = src.indexOf(from);
  assert.ok(start >= 0, `Tool.jsx has ${from}`);
  return src.slice(start, src.indexOf(to, start + from.length));
};

test("consult has a labelled row that names the model and opens by default", () => {
  const tools = section("const TOOLS = {", "\n};");
  assert.match(tools, /\n  consult: \{[^\n]*label: (?:t\()?"مشورت با مدل دیگر"\)?[^\n]*a\.provider, a\.model[^\n]*open: true/);
});

test("the consult body shows the answer, who answered, the failure, and links to its chat", () => {
  const toolBody = section("function ToolBody", "\n}\n");
  assert.match(toolBody, /case "consult":\s*return <ConsultBody args=\{args\} result=\{result\} \/>/);
  const body = section("function ConsultBody", "\n}\n");
  assert.match(body, /<PeerMarkdown text=\{answer\} \/>/);
  assert.match(body, /result\?\.state === "failed"/);
  assert.match(body, /result\.error/);
  assert.match(body, /result\.from/);
  assert.match(body, /navigate\(result\.consultId\)/);
  // Shared by both skins: no skin branch inside the body.
  assert.doesNotMatch(body, /useSkin|karsara/);
});

test("a consult that ran but failed is an error on the row and keeps its own body", () => {
  const card = section("export function ToolCard", "\n}\n");
  assert.match(card, /toolName === "consult"\) return <GenericToolCard \{\.\.\.props\} isError=\{props\.isError \|\| props\.result\?\.state === "failed"\} \/>/);
  const toolBody = section("function ToolBody", "\n}\n");
  const own = toolBody.indexOf('toolName === "consult" && result?.consultId) return <ConsultBody');
  assert.ok(own >= 0 && own < toolBody.indexOf("if (isError) return <ErrorBody"), "the failed consult's body comes before the generic error");
});

test("a consult's card stays in sight when the agent keeps working after it", () => {
  const work = fs.readFileSync(new URL("../src/components/Work.jsx", import.meta.url), "utf8");
  const body = work.slice(work.indexOf("const RESULT_TOOLS"), work.indexOf("export function toolProps")).replace("export function", "function");
  const splitRun = new Function(`${body}; return splitRun;`)();
  const { work: log, answer } = splitRun([
    { type: "tool", name: "consult" },
    { type: "tool", name: "repo_read" },
    { type: "text", text: "جواب" },
  ]);
  assert.deepEqual(answer.map((p) => p.name || p.text), ["consult", "جواب"]);
  assert.deepEqual(log.map((p) => p.name), ["repo_read"]);
});
