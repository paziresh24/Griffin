import test from "node:test";
import assert from "node:assert/strict";
import { escCancels } from "../src/keys.js";
import { fullAgo } from "../src/elapsed.js";

const key = (extra = {}) => ({ key: "Escape", defaultPrevented: false, isComposing: false, target: { closest: () => null }, ...extra });

test("Esc stops a running turn only when nothing else on screen owns it", () => {
  assert.equal(escCancels(key(), { running: true }), true);
  assert.equal(escCancels(key(), { running: false }), false);
  assert.equal(escCancels(key(), { running: true, layerOpen: true }), false, "a dialog or menu keeps its Esc");
  assert.equal(escCancels(key(), { running: true, slashOpen: true }), false, "the «/» list keeps its Esc");
  assert.equal(escCancels(key({ target: { closest: () => ({}) } }), { running: true }), false, "a focused field keeps its Esc");
  assert.equal(escCancels(key({ isComposing: true }), { running: true }), false);
  assert.equal(escCancels(key({ key: "Enter" }), { running: true }), false);
});

test("elapsed time on hover: full words, two units at most", () => {
  const now = new Date("2026-10-12T12:00:00Z");
  assert.equal(fullAgo("2026-10-12T11:59:40Z", now), "چند لحظه پیش");
  assert.equal(fullAgo("2026-10-12T09:57:00Z", now), "۲ ساعت و ۳ دقیقه پیش");
  assert.equal(fullAgo(null, now), "");
});
