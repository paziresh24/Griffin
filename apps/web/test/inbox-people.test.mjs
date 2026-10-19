import test from "node:test";
import assert from "node:assert/strict";
import { initial, itemOutcome, peoplePath, peopleRoute } from "../src/inbox-people.js";

test("inbox by sender: its routes and what the inbox did with each message", () => {
  assert.equal(peoplePath(), "#/inbox");
  assert.equal(peoplePath("42"), "#/inbox/42");
  assert.deepEqual(peopleRoute("#/inbox"), { peerId: null });
  assert.deepEqual(peopleRoute("#/inbox/42"), { peerId: "42" });
  assert.equal(peopleRoute("#/inbox/x"), null);
  assert.equal(initial("  علی"), "ع");
  assert.equal(initial(""), "?");
  assert.deepEqual(itemOutcome({ routed: [{ chatId: "c", title: "t" }] }), [{ kind: "routed", label: "رفت به گفتگوی «t»", chatId: "c" }]);
  assert.equal(itemOutcome({ suggested: [{ title: "تلگرام: x", status: "open" }] })[0].label, "پیشنهاد گفتگوی «x» (منتظر شما)");
  assert.equal(itemOutcome({ status: "pending" })[0].label, "در صف");
  assert.equal(itemOutcome({ status: "done" })[0].kind, "none");
});
