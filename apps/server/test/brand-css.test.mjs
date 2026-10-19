import test from "node:test";
import assert from "node:assert/strict";
import { DARK_SELECTOR, LIGHT_SELECTOR, brandCss, upgradeBrandCss } from "../src/brand.mjs";

const set = { brand: "#123456", primary: "#123456", primaryForeground: "#ffffff", accent: "#eeeeee" };

test("the palette is written to win over the Karsara look too", () => {
  const css = brandCss({ light: set, dark: set });
  assert.ok(css.includes(`${LIGHT_SELECTOR}{--brand:#123456`));
  assert.ok(css.includes(`${DARK_SELECTOR}{--brand:#123456`));
});

test("an older brand.css is served with the same selectors", () => {
  const old = "/* x */\n:root{--primary:red}\n.dark{--primary:blue}\n";
  const up = upgradeBrandCss(old);
  assert.ok(up.includes(`${LIGHT_SELECTOR}{--primary:red}`));
  assert.ok(up.includes(`${DARK_SELECTOR}{--primary:blue}`));
  assert.equal(upgradeBrandCss(up), up, "already upgraded: unchanged");
  assert.equal(upgradeBrandCss(""), "");
});
