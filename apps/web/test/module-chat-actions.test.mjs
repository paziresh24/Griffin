import { test } from "node:test";
import assert from "node:assert/strict";
import { chatDigest, moduleChatActions, moduleSelectionActions, selectionForModule } from "../src/modules.js";

test("chat buttons come from the enabled modules, each with its module", () => {
  const modules = [{ id: "a", chatActions: [{ id: "x", label: "X", view: "v" }] }, { id: "b" }, { id: "c", chatActions: [] }];
  const out = moduleChatActions(modules);
  assert.equal(out.length, 1);
  assert.equal(out[0].module.id, "a");
  assert.equal(out[0].action.id, "x");
  assert.deepEqual(moduleChatActions(null), []);
});

test("a chat's digest: the owner's words and the answers' text, nothing else, bounded", () => {
  const messages = [
    { role: "user", text: " فیلتر اولویت بگذار " },
    { role: "assistant", parts: [{ type: "reasoning", text: "thinking" }, { type: "tool", text: "ls" }, { type: "text", text: "باشه" }, { type: "text", text: "انجام شد" }] },
    { role: "note", text: "یادداشت" },
    { role: "user", text: "" },
  ];
  assert.deepEqual(chatDigest(messages), [{ role: "user", text: "فیلتر اولویت بگذار" }, { role: "assistant", text: "باشه\nانجام شد" }]);
  const many = Array.from({ length: 50 }, (_, i) => ({ role: "user", text: `m${i}` }));
  assert.equal(chatDigest(many).length, 30);
  assert.equal(chatDigest(many).at(-1).text, "m49", "the latest are kept");
  const long = chatDigest([{ role: "user", text: "x".repeat(5000) }]);
  assert.equal(long[0].text.length, 1500);
  const heavy = chatDigest(Array.from({ length: 30 }, () => ({ role: "user", text: "y".repeat(1500) })));
  assert.ok(heavy.reduce((n, m) => n + m.text.length, 0) <= 20000);
  assert.deepEqual(chatDigest(undefined), []);
});

test("selection-menu items come from the enabled modules; the selected text is trimmed and bounded", () => {
  const modules = [{ id: "board-app", selectionActions: [{ id: "to", label: "به بک‌لاگ", view: "new-task" }], chatActions: [{ id: "c", label: "c", view: "v" }] }, { id: "other" }];
  const out = moduleSelectionActions(modules);
  assert.deepEqual(out.map((x) => [x.module.id, x.action.id]), [["board-app", "to"]]);
  assert.deepEqual(moduleSelectionActions(null), []);
  assert.equal(selectionForModule("  متن  "), "متن");
  assert.equal(selectionForModule("x".repeat(5000)).length, 4000);
  assert.equal(selectionForModule(undefined), "");
});
