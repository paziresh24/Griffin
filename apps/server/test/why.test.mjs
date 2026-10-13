import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp } from "../src/app.mjs";
import { openStore } from "../src/db.mjs";
import { buildManifest, diffManifests, recordManifest } from "../src/manifest.mjs";
import { explainRun } from "../src/why.mjs";

function setup() {
  const store = openStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "griffin-why-")), "db.sqlite"));
  const runner = { isActive: () => false, activeCount: () => 0, send: async () => ({ delivered: "run" }) };
  return { store, app: createApp({ store, runner }) };
}

const manifestOf = (store, over = {}) =>
  buildManifest({
    route: { provider: "openai", model: "glm-5.3-flash", effort: "medium" },
    agent: "griffin",
    caller: "owner",
    tools: ["kube_get", "ask_owner"],
    rules: "rules v1 token sk-ant-oat01-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    knowledge: [{ file: "s3.md", title: "S3" }],
    ...over,
  }, (text) => store.putBlob(text));

test("a manifest stores its rules once, masked, and chains with what changed", () => {
  const { store } = setup();
  const chat = store.createChat({ title: "t" });
  const first = recordManifest(store, chat.id, manifestOf(store));
  const again = manifestOf(store);
  assert.equal(again.rules.hash, first.data.rules.hash, "same rules = same blob");
  assert.doesNotMatch(store.getBlob(first.data.rules.hash), /sk-ant-oat01-A{20}/, "secret shapes are masked");
  assert.deepEqual(first.data.changes, [], "nothing to compare the first one with");
  const second = recordManifest(store, chat.id, manifestOf(store, { tools: ["kube_get", "debug_exec"], route: { provider: "claude", model: "sonnet" } }));
  assert.equal(second.data.prevId, first.id);
  const kinds = second.data.changes.map((c) => `${c.kind}:${c.key}`);
  for (const k of ["engine:provider", "engine:model", "engine:effort", "tools:added", "tools:removed"]) assert.ok(kinds.includes(k), k);
  assert.equal(store.latestManifestEvent(chat.id).id, second.id);
  assert.equal(store.latestManifestEvent(chat.id, second.id).id, first.id, "the one in force before an event");
  assert.deepEqual(diffManifests(null, second.data), []);
});

test("a run's events come from its own id window only", () => {
  const { store } = setup();
  const a = store.createChat({ title: "a" });
  const b = store.createChat({ title: "b" });
  store.appendEvent(a.id, null, "user", { text: "قبل" });
  const runId = store.startRun(a.id);
  store.appendEvent(a.id, runId, "run.started", { model: "m" });
  store.appendEvent(b.id, null, "text", { text: "چت دیگر" });
  store.appendEvent(a.id, runId, "text", { text: "جواب" });
  store.finishRun(a.id, runId, "finished", null);
  store.appendEvent(a.id, runId, "run.finished", { status: "finished" });
  store.appendEvent(a.id, null, "user", { text: "بعد" });
  assert.deepEqual(store.runEvents(runId).map((e) => e.type), ["run.started", "text", "run.finished"]);
  assert.deepEqual(store.runEvents("nope"), []);
});

test("explainRun: tools merge, failures, a mid-run message, review decisions and usage", () => {
  const at = (s) => `2026-10-12T10:00:${String(s).padStart(2, "0")}.000Z`;
  const events = [
    { type: "run.started", at: at(0), data: { model: "glm", provider: "openai", effort: "low", fallback: true } },
    { type: "tool.started", at: at(1), data: { callId: "1", name: "kube_get" } },
    { type: "tool.done", at: at(2), data: { callId: "1", name: "kube_get", result: { status: "success" } } },
    { type: "tool.done", at: at(3), data: { callId: "2", name: "kube_get", result: { status: "success" } } },
    { type: "user", at: at(4), data: { text: "فقط کلاستر اول", intent: "steer" } },
    { type: "tool.done", at: at(6), data: { callId: "3", name: "gitlab_mr", result: { status: "error", value: { content: [{ text: "denied" }] } } } },
    { type: "usage", at: at(7), data: { prompt_tokens: 1000, completion_tokens: 50 } },
    { type: "usage", at: at(8), data: { prompt_tokens: 1200, completion_tokens: 70 } },
    { type: "run.finished", at: at(9), data: { status: "finished" } },
  ];
  const approvals = [{ at: at(5), tool: "gitlab_mr", caller: "review", decision: "review-rejected", detail_json: JSON.stringify("push to main") }];
  const out = explainRun(events, { approvals, manifest: { tools: ["kube_get", "gitlab_mr", "s3_get"] } });
  assert.deepEqual(out.steps.map((s) => s.kind), ["tool", "message", "decision", "tool", "end"]);
  assert.equal(out.steps[0].count, 2);
  assert.equal(out.steps[3].error, "denied");
  assert.equal(out.steps[2].text, "push to main");
  for (const chip of ["fallback", "mid-run-message", "stopped", "reviewed"]) assert.ok(out.chips.includes(chip), chip);
  assert.deepEqual(out.run.usage, { requests: 2, input: 2200, output: 120, context: 1200 });
  assert.equal(out.run.effort, "low");
  assert.deepEqual(out.tools.unused, ["s3_get"]);
});

test("GET why answers for a run of that chat only; blobs need a real hash", async () => {
  const { store, app } = setup();
  const chat = store.createChat({ title: "t" });
  const other = store.createChat({ title: "o" });
  const manifest = recordManifest(store, chat.id, manifestOf(store));
  const runId = store.startRun(chat.id);
  store.appendEvent(chat.id, runId, "run.started", { model: "glm-5.3-flash", provider: "openai" });
  store.appendEvent(chat.id, runId, "run.finished", { status: "finished" });
  store.finishRun(chat.id, runId, "finished", null);
  const res = await app.request(`/api/chats/${chat.id}/runs/${runId}/why`);
  assert.equal(res.status, 200);
  const why = await res.json();
  assert.equal(why.manifest.agent, "griffin");
  assert.equal(why.run.model, "glm-5.3-flash");
  assert.equal((await app.request(`/api/chats/${other.id}/runs/${runId}/why`)).status, 404);
  const blob = await app.request(`/api/blobs/${manifest.data.rules.hash}`);
  assert.equal(blob.status, 200);
  assert.match(await blob.text(), /rules v1/);
  assert.equal((await app.request("/api/blobs/../etc")).status, 404);
  assert.equal((await app.request("/api/blobs/abc")).status, 400);
  // A deleted chat takes its manifest pointer with it.
  store.deleteChat(chat.id);
  assert.equal(store.getKv(`manifest:${chat.id}`), null);
});
