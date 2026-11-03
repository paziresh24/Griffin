import test from "node:test";
import assert from "node:assert/strict";
import { onlyTools } from "../src/server.mjs";

test("BROKER_TOOLS: only the named tools are served; empty serves all", () => {
  const tools = { debug_exec: {}, kube_status: {}, gitlab_mr: {}, metricsData: () => {} };
  assert.deepEqual(Object.keys(onlyTools(tools, "debug_exec")), ["debug_exec"]);
  assert.deepEqual(Object.keys(onlyTools(tools, " debug_exec , kube_status ")), ["debug_exec", "kube_status"]);
  assert.equal(onlyTools(tools, ""), tools);
  assert.equal(onlyTools(tools, undefined), tools);
});
