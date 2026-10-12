import test from "node:test";
import assert from "node:assert/strict";
import {
  answerItems, badgeText, canStartSuggestion, chapterAnchor, chatSuggestions, collectChapters, createSuggestionStore, suggestionStartBody, suggestionView,
} from "../src/chat-tools.js";

test("chapters stay in the answer's order; suggestion cards close the turn; unknown parts are dropped", () => {
  const ch = { type: "chapter", title: "پیاده‌سازی" };
  const sg = { type: "suggestion", id: "s1", title: "t" };
  const a = { type: "text", text: "الف" };
  const b = { type: "text", text: "ب" };
  const odd = { type: "mystery" };
  const parts = [sg, a, ch, odd, b];
  assert.deepEqual(answerItems(parts, [a, b], [sg, ch, odd]), [a, ch, b, sg]);
});

test("a card can start once its prompt is loaded, without opening «متن کامل»", () => {
  const item = { id: "s1", prompt: "متن", promptSha: "abc", repo: "acme/app", model: "openai:glm-5.3" };
  const view = suggestionView({ id: "s1", title: "کار", status: "open" }, undefined, item);
  assert.equal(view.promptOpen, true);
  assert.equal(canStartSuggestion(view), true);
  assert.equal(canStartSuggestion(suggestionView({ id: "s1", title: "کار" }, undefined, null)), false, "no prompt in hand, nothing to start");
  assert.equal(suggestionView({ id: "s1" }, "started", item).label, "شروع شد");
  assert.equal(canStartSuggestion(suggestionView({ id: "s1" }, "dismissed", item)), false);
});

test("this chat's open suggestions; badge capped", () => {
  const list = [{ id: "a", fromChatId: "c1", status: "open" }, { id: "b", fromChatId: "c1", status: "open" }, { id: "c", fromChatId: "c2", status: "open" }];
  assert.deepEqual(chatSuggestions(list, { b: "dismissed" }, "c1").map((s) => s.id), ["a"]);
  assert.equal(badgeText(0), "");
  assert.equal(badgeText(12), "۹+");
});

test("start sends the shown prompt's hash plus the card's model and note", async () => {
  assert.deepEqual(suggestionStartBody("h"), { promptSha: "h" });
  assert.deepEqual(suggestionStartBody("h", { model: "", note: " x ", notePosition: "before" }), { promptSha: "h", model: "", note: "x", notePosition: "before" });
  const calls = [];
  const store = createSuggestionStore(async (path, options) => {
    calls.push([path, options?.body]);
    return path.includes("start") ? { chat: { id: "new" } } : { suggestions: [{ id: "s1", prompt: "p", promptSha: "h", status: "open" }] };
  });
  await assert.rejects(store.start("s1"), /not loaded/);
  await store.refresh();
  store.setEdits("s1", { model: "claude:haiku", note: "تند" });
  assert.deepEqual(await store.start("s1"), { id: "new" });
  assert.deepEqual(calls.at(-1), ["/api/suggestions/s1/start", { promptSha: "h", model: "claude:haiku", note: "تند", notePosition: "after" }]);
  assert.equal(store.getState().overrides.s1, "started");
});

test("table of contents lists every chapter with its anchor", () => {
  const messages = [
    { id: "u1", role: "user", text: "x" },
    { id: "r1", role: "assistant", parts: [{ type: "text", text: "a" }, { type: "chapter", title: "کاوش", summary: "خواندن" }, { type: "chapter", title: " " }] },
  ];
  assert.deepEqual(collectChapters(messages), [{ id: chapterAnchor("r1", 1), title: "کاوش", summary: "خواندن" }]);
});
