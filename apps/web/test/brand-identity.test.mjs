// The web app names no install's assistant or owner itself: the server says who (brand.js), the tab
// ends in the product on a Karsara install, and a fresh browser takes the install's skin.
import test from "node:test";
import assert from "node:assert/strict";
import { AGENT_META, BRAND, loadBrand } from "../src/brand.js";
import { tabTitle } from "../src/tab-title.js";

test("a Karsara install shows «کارسرا» in the tab, its own assistant name, Karsara's blurb, and its skin", async () => {
  const skins = [];
  const answers = {
    "/api/public/brand/info": { name: "نوا", latin: "Nova", product: "کارسرا", productLatin: "Karsara", productId: "karsara", skin: "karsara" },
    "/api/brand": { owner: "رضایی", blurb: "دستیارِ رضایی" },
  };
  const fetchImpl = async (url) => ({ ok: true, json: async () => answers[url] });
  await loadBrand({ fetchImpl, onSkin: (s) => skins.push(s) });
  assert.equal(BRAND.name, "نوا");
  assert.equal(AGENT_META.griffin.label, "نوا");
  // The new-chat line reads as the Karsara product's does, whatever the server sends.
  assert.equal(AGENT_META.griffin.blurb, "یک دستیار مختص شما.");
  assert.deepEqual(skins, ["karsara"]);
  assert.match(tabTitle({ page: "settings" }), /· کارسرا$/);
});

test("a Griffin install keeps the assistant's name last in the tab", async () => {
  const fetchImpl = async (url) => ({ ok: url.includes("public"), json: async () => ({ name: "آتنا", latin: "Atena", product: "گریفین", productId: "griffin", skin: "griffin" }) });
  await loadBrand({ fetchImpl, onSkin: () => {} });
  assert.match(tabTitle({ page: "settings" }), /· آتنا$/);
});
