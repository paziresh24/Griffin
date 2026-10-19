import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { brandRoutes, isColor, sanitizeSvg } from "../src/brand.mjs";

const set = (brand) => ({ brand, primary: "oklch(0.7 0.15 55)", primaryForeground: "#fff", accent: "oklch(0.95 0.04 55)" });
const good = { logo: { preset: "leaf", svg: '<svg viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#123"/></svg>' }, palette: { preset: "teal", light: set("#0f766e"), dark: set("#5eead4") } };

function setup() {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "griffin-brand-")), "brand");
  const app = new Hono();
  brandRoutes(app, { dir });
  const call = (method, body) => app.request("/api/setup/brand", { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return { dir, call };
}

test("a malicious SVG comes out as plain drawing", () => {
  const out = sanitizeSvg(`<?xml version="1.0"?><svg onload="alert(1)" viewBox="0 0 64 64">
    <script>alert(1)</script><style>@import url(http://x)</style>
    <a href="javascript:alert(1)"><circle r="3"/></a>
    <foreignObject><div>hi</div></foreignObject>
    <image href="http://evil/x.png"/><image xlink:href="data:image/png;base64,AAAA"/>
    <use href="#a"/><rect fill="url(http://evil/p)" style="x" onclick="y" width="4"/>
    <circle cx="1" cy="1" r="2" fill="#e8873a"/></svg>`);
  assert.doesNotMatch(out, /script|onload|onclick|alert|foreignObject|style|evil|javascript|<a /i);
  assert.match(out, /^<svg viewBox="0 0 64 64" xmlns="http:\/\/www\.w3\.org\/2000\/svg">/);
  assert.match(out, /xlink:href="data:image\/png;base64,AAAA"/);
  assert.match(out, /<use href="#a"\/>/);
  assert.match(out, /<circle cx="1" cy="1" r="2" fill="#e8873a"\/>/);
  assert.match(out, /<rect width="4"\/>/);
});

test("SVGs that are not one <svg> root are refused", () => {
  for (const bad of ["<html><svg/></html>", "<svg>", "<svg/><svg/>", '<!DOCTYPE svg [<!ENTITY x "y">]><svg/>', "<svg><g></svg>", "hello", "<svg a=b/>", "<svg/>" + " ".repeat(101 * 1024)]) {
    assert.throws(() => sanitizeSvg(bad), undefined, bad.slice(0, 40));
  }
});

test("colours: hex or oklch only", () => {
  for (const ok of ["#abc", "#e8873a", "#e8873aff", "oklch(0.7 0.15 55)", "oklch(70% 0.15 55deg / 0.5)"]) assert.ok(isColor(ok), ok);
  for (const bad of ["red", "#e8873}", "oklch(1 2 3);}body{x:y", "rgb(1,2,3)", "", null]) assert.ok(!isColor(bad), String(bad));
});

test("save writes icon, css and the choice; a bad colour is refused; reset goes back to stock", async () => {
  const { dir, call } = setup();
  assert.equal((await (await call("GET")).json()).custom, false);

  const bad = await call("PUT", { ...good, palette: { ...good.palette, dark: { ...set("#fff"), accent: "red;}*{display:none" } } });
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /dark\.accent/);
  assert.ok(!fs.existsSync(path.join(dir, "brand.css")));

  const res = await call("PUT", good);
  assert.equal(res.status, 200);
  const view = await res.json();
  assert.equal(view.custom, true);
  assert.equal(view.logo.preset, "leaf");
  assert.equal(view.palette.preset, "teal");
  assert.equal(view.color, "#0f766e");
  const css = fs.readFileSync(path.join(dir, "brand.css"), "utf8");
  assert.match(css, /:not\(\[data-agent\]\)\{--brand:#0f766e;--primary:oklch\(0\.7 0\.15 55\);--primary-foreground:#fff;--accent:oklch\(0\.95 0\.04 55\)\}/);
  assert.match(css, /\.dark\[data-look\]:not\(\[data-agent\]\)\{--brand:#5eead4;/);
  assert.match(fs.readFileSync(path.join(dir, "icon.svg"), "utf8"), /^<svg /);

  const evil = await call("PUT", { ...good, logo: { svg: "<div/>" } });
  assert.equal(evil.status, 400);

  const reset = await (await call("DELETE")).json();
  assert.equal(reset.custom, false);
  assert.ok(!fs.existsSync(path.join(dir, "icon.svg")));
});
