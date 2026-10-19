import { test } from "node:test";
import assert from "node:assert/strict";
import { mcpCheckLine } from "../src/mcp.js";

test("ok shows latency and tool count; failures say why; stdio shows nothing", () => {
  assert.equal(mcpCheckLine({ checked: true, ok: true, ms: 42, tools: 20 }).tone, "ok");
  assert.match(mcpCheckLine({ checked: true, ok: true, ms: 42, tools: 20 }).text, /۲۰ ابزار/);
  assert.match(mcpCheckLine({ checked: true, ok: false, reason: "auth" }).text, /Authorization/);
  assert.match(mcpCheckLine({ checked: true, ok: false, reason: "http_502" }).text, /http_502/);
  assert.equal(mcpCheckLine({ checked: false, type: "stdio" }), null);
});
