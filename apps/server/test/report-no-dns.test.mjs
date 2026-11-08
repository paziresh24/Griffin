import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("process.report never resolves socket peers (no synchronous reverse DNS on the main thread)", async () => {
  await import("../src/report-no-dns.mjs");
  assert.equal(process.report.excludeNetwork, true);
});

test("index.mjs loads report-no-dns before any dependency", () => {
  const src = fs.readFileSync(new URL("../src/index.mjs", import.meta.url), "utf8");
  const imports = [...src.matchAll(/^import .*$/gm)].map((m) => m[0]);
  const at = imports.findIndex((l) => l.includes("./report-no-dns.mjs"));
  assert.ok(at >= 0 && at <= 1, `report-no-dns must be among the first imports, found at ${at}`);
});
