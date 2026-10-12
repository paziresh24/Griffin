import test from "node:test";
import assert from "node:assert/strict";
import { classifyThread, handsToGriffin, threadStartPrompt, wantsGriffin } from "../src/integrations/threads.mjs";

test("wantsGriffin matches only a call at the start", () => {
  assert.equal(wantsGriffin("گریفین یه سؤال"), true);
  assert.equal(wantsGriffin("/griffin"), true);
  assert.equal(wantsGriffin("به گریفین گفتم"), false);
});

test("classifyThread asks Jev and fails closed", async () => {
  const cfg = (answers, ok = true) => ({ apiKey: "k", fetchImpl: async (url, init) => {
    assert.equal(url, "https://api.typesafe.ai/v1/systemone");
    const body = JSON.parse(init.body);
    assert.equal(body.model, "jev-latest");
    assert.equal(body.state.sender, "teammate");
    assert.deepEqual(Object.keys(body.questions), ["open", "kind"]);
    assert.equal(init.headers.authorization, "Bearer k");
    return { ok, status: ok ? 200 : 500, json: async () => ({ answers }) };
  } });
  const yes = await classifyThread({ message: "پایپ‌لاین patient روی main فیل شده", from: "teammate" }, cfg({ open: { noul: 0.95 }, kind: { choice: "problem", confidence: 0.8 } }));
  assert.equal(yes.start, true);
  assert.match(yes.reason, /open=0\.95 kind=problem/);
  assert.equal(yes.topic, "پایپ‌لاین patient روی main فیل شده");
  assert.equal((await classifyThread({ message: "ممنون", from: "teammate" }, cfg({ open: { noul: 0.7 }, kind: { choice: "thanks", confidence: 1 } }))).start, false, "thanks never opens");
  assert.equal((await classifyThread({ message: "جلسه؟", from: "teammate" }, cfg({ open: { noul: 0.16 }, kind: { choice: "question", confidence: 0.9 } }))).start, false, "below 0.6 stays shut");
  assert.equal((await classifyThread({ message: "x", from: "teammate" }, cfg({}, false))).start, false);
  assert.equal((await classifyThread({ message: "x" }, {})).start, false, "no key, no threads");
});

test("thread messages carry who said what; the behavior lives once in the run's rules", async () => {
  const p = threadStartPrompt({ name: "کریمی", history: ["همکار: سلام"], message: "خرابه", from: "teammate", topic: "پایپ‌لاین" });
  assert.match(p, /همکار: سلام/);
  assert.match(p, /«کریمی»: خرابه$/);
  assert.doesNotMatch(p, /end_agent|NO_REPLY/);
  const { buildRules } = await import("../src/prompt.mjs");
  const rules = buildRules({ agent: "griffin", caller: "team" });
  assert.match(rules, /end_agent/);
  assert.match(rules, /threads open by\s+themselves/);
  assert.match(rules, /\[NO_REPLY\]/);
  assert.doesNotMatch(buildRules({ agent: "griffin", caller: "owner" }), /Where you are: a 1:1 Telegram chat/);
});

test("handsToGriffin: only an explicit hand-off, not the owner answering himself", () => {
  assert.equal(handsToGriffin("الان"), false);
  assert.equal(handsToGriffin("البته ssh به سرورها دارید"), false);
  assert.equal(handsToGriffin("بله، بهتون کمک میکنه"), true);
  assert.equal(handsToGriffin("گریفین انجامش بده"), true);
  assert.equal(handsToGriffin("کمکت می‌کنه"), true);
});

test("GLM fallback runs when Jev fails, so a classifier outage does not silence teammates", async () => {
  const jev451 = async () => ({ ok: false, status: 451 });
  // teammate asks for something -> GLM says open
  const askOpen = async () => '{"open": true, "kind": "request"}';
  const r = await classifyThread(
    { history: [], message: "لطفاً دسترسی دیتابیس را بده", from: "teammate" },
    { apiKey: "k", fetchImpl: jev451, fallbackAsk: askOpen },
  );
  assert.equal(r.start, true);
  assert.match(r.reason, /451/);
  assert.match(r.reason, /glm/);
  // thanks -> GLM says not open
  const askThanks = async () => '{"open": false, "kind": "thanks"}';
  const r2 = await classifyThread({ history: [], message: "ممنون حله", from: "teammate" }, { apiKey: "k", fetchImpl: jev451, fallbackAsk: askThanks });
  assert.equal(r2.start, false);
  // no fallback provided -> fails closed with the jev reason
  const r3 = await classifyThread({ history: [], message: "x", from: "teammate" }, { apiKey: "k", fetchImpl: jev451 });
  assert.equal(r3.start, false);
  assert.match(r3.reason, /451/);
});

test("Jev success path still used when it works (fallback not consulted)", async () => {
  let fbCalled = false;
  const jevOk = async () => ({ ok: true, json: async () => ({ answers: { open: { noul: 0.95 }, kind: { choice: "request", confidence: 0.9 } } }) });
  const r = await classifyThread({ history: [], message: "پایپ‌لاین فیل شد", from: "teammate" }, { apiKey: "k", fetchImpl: jevOk, fallbackAsk: async () => { fbCalled = true; return "{}"; } });
  assert.equal(r.start, true);
  assert.match(r.reason, /jev open=0.95/);
  assert.equal(fbCalled, false);
});
