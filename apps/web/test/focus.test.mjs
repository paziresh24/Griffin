import test from "node:test";
import assert from "node:assert/strict";
import { choreCard } from "../src/focus.js";

// A stand-in for the page: the chore cards Tool.jsx draws (data-chore, data-chore-title).
const page = (cards) => {
  const els = cards.map(([chore, choreTitle]) => ({ dataset: { chore, choreTitle } }));
  return { els, querySelectorAll: () => els };
};

test("the board finds the chore's card by id, else the latest card with its title", () => {
  const doc = page([["", "دیسک node2"], ["a1", "توکن"], ["", "دیسک node2"]]);
  assert.equal(choreCard(doc, { choreId: "a1", title: "x" }), doc.els[1]);
  assert.equal(choreCard(doc, { choreId: "zz", title: "دیسک node2" }), doc.els[2], "an older card without id, by title, the latest");
  assert.equal(choreCard(page([]), { choreId: "a1", title: "x" }), null);
});
