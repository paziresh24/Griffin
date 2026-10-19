import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CREDIT_RETRY_MS, engineState, isCreditError, probeVerdict, rankByState, sameModelNames } from "../src/engine-state.mjs";
import { autoMovesOn, claudeLimitCode } from "../src/plan-fallback.mjs";
import { probeOutcome } from "../src/providers/claude.mjs";
import { classifyEngineError } from "../src/doctor.mjs";
import { createFeedback, feedbackMessage, feedbackReport } from "../src/feedback.mjs";

const NOW = Date.parse("2026-10-18T12:00:00Z");

test("out of credit is told apart from a plan limit", () => {
  assert.ok(isCreditError("Credit balance is too low to access the Anthropic API"));
  assert.ok(isCreditError('{"error":{"code":"insufficient_quota"}}'));
  assert.ok(!isCreditError("You've hit your weekly limit · resets 3pm"));
  assert.ok(!isCreditError("Error in foo.js:402"));
  // A run that hits it moves on instead of failing in place.
  assert.equal(claudeLimitCode("Credit balance is too low"), "plan_limit");
  assert.ok(autoMovesOn("Credit balance is too low"));
});

test("an account's state: off, no key, credit (retried after a while), limited until its reset, ok", () => {
  assert.equal(engineState({ enabled: false, keyed: true }).state, "off");
  assert.equal(engineState({ enabled: true, keyed: false }).state, "no_key");
  assert.equal(engineState({ enabled: true, keyed: true, creditAt: NOW - 1000, now: NOW }).state, "credit");
  assert.equal(engineState({ enabled: true, keyed: true, creditAt: NOW - CREDIT_RETRY_MS - 1, now: NOW }).state, "ok");
  assert.deepEqual(engineState({ enabled: true, keyed: true, limitedUntil: NOW + 5000, now: NOW }), { state: "limited", until: NOW + 5000 });
  assert.equal(engineState({ enabled: true, keyed: true, limitedUntil: NOW - 1, now: NOW }).state, "ok");
});

test("candidates rank usable first in their own order, limited by soonest reset, credit last", () => {
  const states = {
    a: { state: "credit" },
    b: { state: "limited", until: NOW + 3 * 3600_000 },
    c: { state: "ok" },
    d: { state: "limited", until: NOW + 600_000 },
    e: { state: "ok" },
    f: { state: "off" },
  };
  const list = ["a", "b", "c", "d", "e", "f"].map((provider) => ({ provider }));
  assert.deepEqual(rankByState(list, (id) => states[id]).map((c) => c.provider), ["c", "e", "d", "b", "a", "f"]);
});

test("a probe turn: credit, a closed limit with its reset, a full window, or usable", () => {
  assert.equal(probeOutcome({ failure: "Credit balance is too low", now: NOW }).state, "credit");
  const closed = probeOutcome({ failure: "You've hit your limit", closed: { status: "rejected", resetsAt: NOW / 1000 + 3600 }, now: NOW });
  assert.deepEqual([closed.state, closed.until], ["limited", NOW + 3600_000]);
  const full = probeOutcome({ windows: { seven_day: { utilization: 1, resetsAt: NOW / 1000 + 7200 }, five_hour: { utilization: 0.2, resetsAt: NOW / 1000 + 60 } }, now: NOW });
  assert.deepEqual([full.ok, full.state, full.until], [false, "limited", NOW + 7200_000]);
  assert.deepEqual(probeOutcome({ windows: { five_hour: { utilization: 0.5 } }, now: NOW }), { ok: true });
  assert.equal(probeOutcome({ failure: "timeout", now: NOW }).ok, false);
  assert.equal(probeVerdict({ ok: true, busy: true }), null);
  assert.equal(probeVerdict({ ok: false, state: "credit" }), "credit");
  assert.equal(probeVerdict({ ok: true }), "ok");
  assert.equal(classifyEngineError({ status: 402, text: "" }), "quota");
});

test("the default engine keeps the agent's model only where the name means the same", () => {
  const kindOf = (id) => id.split("-")[0];
  const isEndpoint = (id) => id === "claude-zai";
  assert.ok(sameModelNames("claude-2", "claude", { kindOf, isEndpoint }));
  assert.ok(!sameModelNames("claude-zai", "claude", { kindOf, isEndpoint }));
  assert.ok(!sameModelNames("openai-2", "openai", { kindOf, isEndpoint }));
  assert.ok(sameModelNames("openai", "openai", { kindOf, isEndpoint }));
});

test("feedback is kept with its details, masked, and sent to the maintainer's agent when connected", async () => {
  assert.equal(feedbackReport({ text: "  " }), null);
  const r = feedbackReport(
    { text: `دکمه کار نمی‌کند ${["sk-ant-api03-", "A".repeat(36)].join("")}`, kind: "support", browser: "Firefox", page: "#/c/abc", chatId: "abc", errors: ["TypeError: x"] },
    { commit: "1234567890ab", owner: "سارا", install: "griffin-sara.example.com", serverErrors: [{ at: "t", line: "boom", count: 2 }] },
  );
  assert.equal(r.kind, "support");
  assert.ok(!r.text.includes("AAAAAAAAAAAAAAAA"), "a pasted key never leaves masked-less");
  const msg = feedbackMessage(r);
  for (const part of ["درخواست پشتیبانی", "سارا", "1234567890ab", "Firefox", "abc", "TypeError: x", "boom ×2"]) assert.ok(msg.includes(part), part);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "feedback-"));
  const posted = [];
  const network = { list: () => [{ id: "support", url: "https://support.example.com", connected: true }], post: async (id, route, body) => (posted.push({ id, route, body }), { ok: true, told: false }) };
  const pixel = `data:image/jpeg;base64,${Buffer.from("fake-jpeg").toString("base64")}`;
  const fb = createFeedback({ dataDir: dir, network, supportHost: () => "support.example.com", selfHost: () => "griffin-sara.example.com", context: () => ({ owner: "سارا" }) });
  assert.deepEqual(await fb.submit({ text: "سلام", screenshot: pixel }), { ok: true, sent: true, told: false });
  assert.deepEqual([posted[0].id, posted[0].route, posted[0].body.screenshot], ["support", "/api/public/network/feedback", pixel]);
  assert.equal(posted[0].body.report.owner, "سارا");
  // Not connected to the maintainer: kept here only.
  assert.equal((await createFeedback({ dataDir: dir, network: null, supportHost: () => "x" }).submit({ text: "دوم", screenshot: "javascript:alert(1)" })).sent, false);
  assert.equal(fs.readFileSync(path.join(dir, "feedback.jsonl"), "utf8").trim().split("\n").length, 2);
  fs.rmSync(dir, { recursive: true });
});

test("the maintainer's inbox: a network member's report with its picture; support also reaches the owner's Telegram, marked for the desk to ignore", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "inbox-"));
  const told = [];
  const fb = createFeedback({ dataDir: dir, notifyOwner: async (text, shot) => told.push({ text, shot }), log: { error() {} } });
  const pixel = `data:image/png;base64,${Buffer.from("png").toString("base64")}`;
  const report = feedbackReport({ text: "کمک", kind: "support", page: "#/c/x" }, { owner: "رضا", install: "griffin-reza.example.com" });
  const r = await fb.receive(report, pixel, "یارا (رضا کریمی)");
  assert.deepEqual([r.ok, r.told], [true, true]);
  assert.match(told[0].text, /^🤖 درخواست پشتیبانی از رضا \(griffin-reza\.example\.com\)/);
  assert.match(told[0].text, /فرستاده از: یارا \(رضا کریمی\)/);
  assert.equal(told[0].shot.toString(), "png");
  // A plain feedback is only kept; a forged picture is dropped.
  await fb.receive({ ...report, kind: "feedback", text: "خوب است" }, "data:text/html;base64,PHNjcmlwdD4=", "x");
  const items = fb.inbox();
  assert.deepEqual(items.map((i) => [i.kind, Boolean(i.shot)]), [["feedback", false], ["support", true]]);
  assert.equal(fb.shotFile(items[1].id).type, "image/png");
  assert.equal(fb.shotFile("../../etc/passwd"), null);
  assert.equal(told.length, 1);
  assert.equal((await fb.receive({ text: "" }, null, "x")).ok, false);

  // The public route takes only a member of the agents' network.
  const { Hono } = await import("hono");
  const app = new Hono();
  const peerAuth = { authenticate: (h) => (h === "Bearer net" ? { userId: "net-griffin-reza", label: "یارا" } : h === "Bearer colleague" ? { userId: "reza", label: "x" } : { error: "invalid token", status: 401 }) };
  fb.routes(app, peerAuth);
  const call = (auth) => app.request("/api/public/network/feedback", { method: "POST", headers: { authorization: auth, "content-type": "application/json" }, body: JSON.stringify({ report: { ...report, kind: "feedback" } }) });
  assert.equal((await call("Bearer nope")).status, 401);
  assert.equal((await call("Bearer colleague")).status, 403);
  assert.equal((await call("Bearer net")).status, 200);
  assert.equal(fb.inbox()[0].from, "یارا");
  fs.rmSync(dir, { recursive: true });
});
