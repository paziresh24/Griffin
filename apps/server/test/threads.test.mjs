import test from "node:test";
import assert from "node:assert/strict";
import { handsToGriffin, threadInboundPrompt, threadOwnerPrompt, wantsGriffin } from "../src/integrations/threads.mjs";

test("wantsGriffin matches only a call at the start", () => {
  assert.equal(wantsGriffin("گریفین یه سؤال"), true);
  assert.equal(wantsGriffin("/griffin"), true);
  assert.equal(wantsGriffin("به گریفین گفتم"), false);
});

test("messages carry who said what; the behavior lives once in the run's rules", async () => {
  assert.equal(threadInboundPrompt({ name: "کریمی", text: " خرابه " }), "«کریمی»: خرابه");
  assert.equal(threadOwnerPrompt({ name: "کریمی", text: "الان" }), "«Owner در تلگرام به کریمی»: الان");
  const { buildRules } = await import("../src/prompt.mjs");
  const rules = buildRules({ agent: "griffin", caller: "team" });
  assert.match(rules, /end_agent/);
  assert.match(rules, /threads open by\s+themselves/);
  assert.match(rules, /\[NO_REPLY\]/);
  assert.match(rules, /Your final text \(after your last tool call\) is exactly what the colleague receives/);
  assert.doesNotMatch(buildRules({ agent: "griffin", caller: "owner" }), /Where you are: a Telegram chat/);
  // A mother chat speaks only through send_to_person: none of the thread delivery bullets.
  const mother = buildRules({ agent: "griffin", caller: "team", mother: true });
  assert.match(mother, /Where you are: a Telegram chat/);
  assert.doesNotMatch(mother, /exactly what the colleague receives|Close the thread \(end_agent\)|Everything you write is sent/);
});

test("handsToGriffin: only an explicit hand-off, not the owner answering himself", () => {
  assert.equal(handsToGriffin("الان"), false);
  assert.equal(handsToGriffin("البته ssh به سرورها دارید"), false);
  assert.equal(handsToGriffin("بله، بهتون کمک میکنه"), true);
  assert.equal(handsToGriffin("گریفین انجامش بده"), true);
  assert.equal(handsToGriffin("کمکت می‌کنه"), true);
});
