import test from "node:test";
import assert from "node:assert/strict";
import { applySkin, readSkin } from "../src/skin.js";

test("skin: unknown or missing values fall back to griffin; a chosen skin persists and lands on <html>", () => {
  const store = new Map();
  globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)) };
  globalThis.document = { documentElement: { dataset: {} } };
  assert.equal(readSkin(), "griffin");
  assert.equal(applySkin("karsara"), "karsara");
  assert.equal(document.documentElement.dataset.skin, "karsara");
  assert.equal(readSkin(), "karsara");
  assert.equal(applySkin("<script>"), "griffin");
  store.set("griffin.skin", "bogus");
  assert.equal(readSkin(), "griffin");
  globalThis.localStorage = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
  assert.equal(readSkin(), "griffin");
  assert.equal(applySkin("karsara"), "karsara");
});
