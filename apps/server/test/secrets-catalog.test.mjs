import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

// Settings → Secrets offers these names; each must be one the broker really reads, or a colleague
// fills it in and kube_* still says «not set» (2026-10-28: kube__token vs platform__kube-token).
test("every Settings → Secrets tool name is read by the broker", () => {
  const index = readFileSync(new URL("../src/index.mjs", import.meta.url), "utf8");
  const block = index.match(/const TOOL_SECRETS = \[([\s\S]*?)\];/);
  assert.ok(block, "TOOL_SECRETS not found");
  const names = [...block[1].matchAll(/name: "([^"]+)"/g)].map((m) => m[1]);
  assert.ok(names.length >= 4);
  const dir = new URL("../../broker/src/", import.meta.url);
  const broker = readdirSync(dir).filter((f) => f.endsWith(".mjs")).map((f) => readFileSync(new URL(f, dir), "utf8")).join("\n");
  for (const name of names) assert.ok(broker.includes(`"${name}"`), `broker never reads ${name}`);
});
