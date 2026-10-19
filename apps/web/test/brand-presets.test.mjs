// Every preset must survive the server's checks unchanged in meaning: colours the server accepts,
// logos its SVG sanitizer keeps.
import test from "node:test";
import assert from "node:assert/strict";
import { LOGOS, PALETTES, hexToOklch, paletteFromColor, renderLogo } from "../src/brand-presets.js";
import { COLOR_KEYS, isColor, sanitizeSvg } from "../../server/src/brand.mjs";

const KEYS = Object.keys(COLOR_KEYS);

test("at least eight palettes, each with light and dark tokens the server accepts", () => {
  assert.ok(PALETTES.length >= 8);
  assert.equal(PALETTES[0].id, "griffin");
  assert.equal(new Set(PALETTES.map((p) => p.id)).size, PALETTES.length);
  for (const p of [...PALETTES, paletteFromColor("#1e90ff")]) {
    for (const mode of ["light", "dark"]) {
      for (const key of KEYS) assert.ok(isColor(p[mode][key]), `${p.id}.${mode}.${key} = ${p[mode][key]}`);
    }
    for (const key of ["bg", "main", "light", "alt"]) assert.ok(isColor(p.ink[key]), `${p.id}.ink.${key}`);
  }
});

test("at least eight logos; every logo in every palette passes the SVG sanitizer whole", () => {
  assert.ok(LOGOS.length >= 8);
  for (const logo of LOGOS) {
    for (const palette of PALETTES) {
      const svg = renderLogo(logo.id, palette, "<آتنا>");
      const clean = sanitizeSvg(svg);
      assert.equal(clean.replace(/\s+/g, ""), svg.replace(/\s+/g, ""), `${logo.id}/${palette.id}`);
    }
  }
  assert.match(renderLogo("monogram", PALETTES[0], "آتنا"), />آ<\/text>/);
});

test("Griffin's stock icon is the hub in the orange palette", () => {
  const svg = renderLogo("hub", PALETTES[0]);
  assert.match(svg, /#1a120c/);
  assert.match(svg, /#e8873a/);
});

test("hex to oklch", () => {
  const white = hexToOklch("#ffffff");
  assert.ok(Math.abs(white.l - 1) < 0.001 && white.c < 0.001);
  const red = hexToOklch("#ff0000");
  assert.ok(Math.abs(red.l - 0.628) < 0.01 && Math.abs(red.h - 29) < 1);
  assert.equal(paletteFromColor("nope"), null);
});
