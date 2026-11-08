import test from "node:test";
import assert from "node:assert/strict";
import { ASKS_INSIDE, chatAsk } from "../src/ask.js";

const item = (id, over = {}) => ({ id, kind: "question", askId: id, chatId: "root", sourceChatId: "root", question: id, at: "2026-11-05T10:00:00Z", ...over });

test("the chat's own open question is found, the newest one", () => {
  const items = [item("old"), item("new", { at: "2026-11-05T11:00:00Z" }), item("other", { chatId: "x", sourceChatId: "x", at: "2026-11-05T12:00:00Z" })];
  assert.equal(chatAsk(items, "root").id, "new");
});

test("a subtask's question belongs to the subtask's chat, not the root's", () => {
  const items = [item("sub", { sourceChatId: "sub" })];
  assert.equal(chatAsk(items, "sub").id, "sub");
  assert.equal(chatAsk(items, "root"), null);
});

test("approvals count; telegram drafts and chores do not; no chat finds nothing", () => {
  assert.equal(chatAsk([item("a", { kind: "approval" })], "root").id, "a");
  assert.equal(chatAsk([item("t", { kind: "telegram" }), item("c", { kind: "chore" })], "root"), null);
  assert.equal(chatAsk([item("a")], null), null);
  assert.equal(chatAsk(undefined, "root"), null);
});

test("both server-side asking tools are drawn with the card", () => {
  assert.ok(ASKS_INSIDE.has("request_full_access"));
  assert.ok(ASKS_INSIDE.has("request_owner_chat"));
});
