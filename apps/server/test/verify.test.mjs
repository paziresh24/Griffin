import test from "node:test";
import assert from "node:assert/strict";
import { createVerifier } from "../src/verify.mjs";

// The maker/checker pass: the finished run's read-only probes are re-executed outside the model
// and compared by signature. These tests drive it with a scripted store/runner/tool — no broker,
// no endpoint (fresh-context checker means deterministic checker).

function sdkResult(raw) {
  return { status: "success", value: { content: [{ type: "text", text: JSON.stringify(raw) }] } };
}

function harness({ caller = "peer:x", events = [], fresh = {} } = {}) {
  const appended = [];
  const sent = [];
  const calls = [];
  const store = {
    getChat: (id) => (id === "c1" ? { id, caller } : null),
    lastEventId: () => events.length,
    eventsAfter: (_chatId, after, limit) => events.slice(Math.max(0, after), Math.max(0, after) + limit),
    appendEvent: (chatId, runId, type, data) => appended.push({ chatId, runId, type, data }),
  };
  const runner = { isActive: () => false, send: async (chatId, msg) => sent.push({ chatId, msg }) };
  const callTool = async (name, args) => {
    calls.push({ name, args });
    const key = `${name}:${args?.url || args?.name || ""}`;
    if (!(key in fresh)) throw new Error(`no fresh result for ${key}`);
    return fresh[key];
  };
  const verifier = createVerifier({ store, callTool, runner, log: { error() {} } });
  return { verifier, appended, sent, calls };
}

const RUN = { type: "run.started", runId: "r1", data: {} };
const probe = (name, args, raw) => ({ type: "tool.done", runId: "r1", data: { name, args, result: sdkResult(raw) } });

test("verify: matching probes are re-checked silently — event only, no chat message", async () => {
  const h = harness({
    events: [RUN, probe("http_check", { url: "https://x.example/api/healthz" }, { status: 200 })],
    fresh: { "http_check:https://x.example/api/healthz": { status: 200, ms: 12 } },
  });
  const out = await h.verifier.verifyFinishedRun("c1");
  assert.deepEqual(out, { checks: 1, mismatches: 0 });
  assert.equal(h.sent.length, 0, "agreement never messages anyone");
  assert.equal(h.appended.at(-1).data.phase, "verified");
});

test("verify: a drifted claim is corrected in-chat for the requester to see", async () => {
  const h = harness({
    events: [RUN, probe("http_check", { url: "https://x.example/" }, { status: 200 })],
    fresh: { "http_check:https://x.example/": { status: 523 } },
  });
  const out = await h.verifier.verifyFinishedRun("c1");
  assert.deepEqual(out, { checks: 1, mismatches: 1 });
  assert.equal(h.sent.length, 1, "the mismatch reaches the chat as a system line");
  assert.match(h.sent[0].msg.text, /راستی‌آزمایی خودکار/);
  assert.match(h.sent[0].msg.text, /200/);
  assert.match(h.sent[0].msg.text, /523/);
  assert.equal(h.sent[0].msg.intent, "queue");
  assert.equal(h.appended.at(-1).data.phase, "verify-mismatch");
});

test("verify: DNS answers compare as a set — reordering is not drift", async () => {
  const h = harness({
    events: [RUN, probe("dns_lookup", { name: "x.example" }, { records: ["1.1.1.1", "2.2.2.2"] })],
    fresh: { "dns_lookup:x.example": { records: ["2.2.2.2", "1.1.1.1"], ms: 3 } },
  });
  assert.deepEqual(await h.verifier.verifyFinishedRun("c1"), { checks: 1, mismatches: 0 });
});

test("verify: only the LAST run's probes count, last occurrence per call wins", async () => {
  const events = [
    { type: "run.started", runId: "r0", data: {} },
    probe("http_check", { url: "https://old.example/" }, { status: 500 }), // previous run — ignored
    RUN,
    probe("http_check", { url: "https://x.example/" }, { status: 200 }),
    probe("http_check", { url: "https://x.example/" }, { status: 200 }), // same call repeated — deduped
  ];
  const h = harness({ events, fresh: { "http_check:https://x.example/": { status: 200 } } });
  assert.deepEqual(await h.verifier.verifyFinishedRun("c1"), { checks: 1, mismatches: 0 });
  assert.deepEqual(h.calls.map((c) => c.args.url), ["https://x.example/"], "the previous run's probe is never re-checked");
});

test("verify: owner chats and chats without probes are skipped untouched", async () => {
  const owner = harness({ caller: "owner", events: [RUN, probe("http_check", { url: "https://x/" }, { status: 200 })] });
  assert.deepEqual(await owner.verifier.verifyFinishedRun("c1"), { skipped: "caller" });
  assert.equal(owner.calls.length, 0);

  const none = harness({ events: [RUN] });
  assert.deepEqual(await none.verifier.verifyFinishedRun("c1"), { skipped: "no-probes" });
});

test("verify: a busy chat is left alone (verifying a moving target is noise), and the kill switch works", async () => {
  const { createVerifier } = await import("../src/verify.mjs");
  const busyVerifier = createVerifier({
    store: { getChat: () => ({ caller: "team" }), lastEventId: () => 1, eventsAfter: () => [RUN], appendEvent: () => {} },
    callTool: async () => assert.fail("must not call"),
    runner: { isActive: () => true, send: async () => {} },
    log: { error() {} },
  });
  assert.deepEqual(await busyVerifier.verifyFinishedRun("c1"), { skipped: "active" });

  const off = createVerifier({
    store: { getChat: () => ({ caller: "team" }) },
    callTool: async () => assert.fail("must not call"),
    runner: { isActive: () => false, send: async () => {} },
    enabled: () => false,
  });
  assert.deepEqual(await off.verifyFinishedRun("c1"), { skipped: "off" });
});
