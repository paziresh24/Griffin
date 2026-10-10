import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const bridge = fileURLToPath(new URL("../../../bin/griffin-mcp.mjs", import.meta.url));

test("stdio bridge introspects without a server and explains a missing one", async () => {
  const child = spawn(process.execPath, [bridge], { env: { PATH: process.env.PATH }, stdio: ["pipe", "pipe", "inherit"] });
  const lines = [];
  child.stdout.setEncoding("utf8").on("data", (d) => lines.push(...d.split("\n").filter(Boolean)));
  for (const msg of [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "griffin_tasks", arguments: {} } },
  ])
    child.stdin.write(JSON.stringify(msg) + "\n");
  child.stdin.end();
  await new Promise((r) => child.on("close", r));
  const byId = Object.fromEntries(lines.map((l) => JSON.parse(l)).map((m) => [m.id, m]));
  assert.equal(byId[1].result.serverInfo.name, "griffin");
  assert.deepEqual(byId[2].result.tools.map((t) => t.name), ["griffin_send", "griffin_wait", "griffin_reply", "griffin_cancel", "griffin_tasks"]);
  assert.match(byId[3].error.message, /GRIFFIN_URL/);
});
