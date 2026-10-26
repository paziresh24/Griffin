import { test } from "node:test";
import assert from "node:assert/strict";
import { createAccountTools } from "../src/integrations/telegram-account.mjs";

// Owner 2026-10-19: correcting a sent message means editing/deleting it, never a second message.
test("telegram_edit edits and telegram_delete revokes messages the account sent", async () => {
  const calls = [];
  const client = {
    getInputEntity: async (c) => ({ id: 1, c }),
    getEntity: async (c) => ({ id: 1, c, title: "X" }),
    editMessage: async (entity, opts) => calls.push(["edit", opts]),
    deleteMessages: async (entity, ids, opts) => calls.push(["delete", ids, opts]),
  };
  const tools = createAccountTools({ getClient: () => client });
  assert.ok(tools.telegram_edit && tools.telegram_delete);
  const edited = await tools.telegram_edit.execute({ chat: "123", messageId: 7, text: "درست شد" });
  const deleted = await tools.telegram_delete.execute({ chat: "123", messageIds: [8, 9] });
  assert.match(edited.content[0].text, /"edited":\s*true/);
  assert.match(deleted.content[0].text, /"deleted":\s*true/);
  assert.deepEqual(calls[0][1].message, 7);
  assert.deepEqual(calls[1].slice(1), [[8, 9], { revoke: true }]);
});
