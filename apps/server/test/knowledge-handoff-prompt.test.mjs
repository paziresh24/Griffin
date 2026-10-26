import test from "node:test";
import assert from "node:assert/strict";
import { buildRules } from "../src/prompt.mjs";

test("a colleague chat without knowledge_write is told to hand the note to the owner's writing chat", () => {
  const rules = buildRules({ agent: "griffin", caller: "peer:someone", tools: ["knowledge_list", "chat_list", "chat_send"] });
  assert.match(rules, /hand it to the owner's main chat/);
  assert.match(rules, /not «ذخیره نشد»|NOT dropped/);
});

test("an owner chat receiving a note asks the owner, then writes", () => {
  const rules = buildRules({ agent: "griffin", caller: "owner", tools: ["knowledge_write", "chat_list", "chat_send", "ask_owner"] });
  assert.match(rules, /you are the chat that can write/);
  assert.match(rules, /on yes call knowledge_write/);
});
