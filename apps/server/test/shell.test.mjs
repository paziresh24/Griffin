import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { fileVersion, shellHandler, versionShell } from "../src/shell.mjs";

const HTML = '<link rel="icon" href="/icon.svg" type="image/svg+xml" /><script src="/assets/index-abc.js"></script><link rel="stylesheet" href="/brand.css" />';

test("shell: brand.css and icon.svg links get the version, the bundles do not", () => {
  const out = versionShell(HTML, { css: "11", icon: "22" });
  assert.match(out, /href="\/brand\.css\?v=11"/);
  assert.match(out, /href="\/icon\.svg\?v=22"/);
  assert.match(out, /src="\/assets\/index-abc\.js"/);
});

test("shell: an already versioned link is replaced, not doubled", () => {
  assert.equal(versionShell('<link href="/brand.css?v=1" />', { css: "2" }), '<link href="/brand.css?v=2" />');
});

test("shell: a missing file is version 0 and a changed file is a new version", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shell-"));
  const file = path.join(dir, "brand.css");
  assert.equal(fileVersion(file), "0");
  fs.writeFileSync(file, "a");
  const first = fileVersion(file);
  assert.notEqual(first, "0");
  fs.utimesSync(file, new Date(Date.now() + 5000), new Date(Date.now() + 5000));
  assert.notEqual(fileVersion(file), first);
});

test("shell: served with the look versions and never cacheable", async () => {
  const dist = fs.mkdtempSync(path.join(os.tmpdir(), "dist-"));
  const brand = fs.mkdtempSync(path.join(os.tmpdir(), "brand-"));
  fs.writeFileSync(path.join(dist, "index.html"), HTML);
  fs.writeFileSync(path.join(brand, "brand.css"), ":root{}");
  const app = new Hono();
  app.get("*", shellHandler({ webDist: dist, brandDir: brand }));
  const res = await app.request("/some/route");
  const body = await res.text();
  assert.equal(res.status, 200);
  assert.match(body, /\/brand\.css\?v=\d{5,}/);
  assert.match(body, /\/icon\.svg\?v=0/);
  assert.match(res.headers.get("cache-control"), /no-store/);
  assert.equal(res.headers.get("cdn-cache-control"), "no-store");
});
