import test from "node:test";
import assert from "node:assert/strict";
import { peerBridgeRefusal } from "../src/providers/peer-bridge-guard.mjs";

// 2026-11-09: a colleague's agent asked another install through a repo's stdio bridge; its late answer never reached his chat.
test("a hand-made bridge to another install may not start or continue work; network_ask is named instead", () => {
  for (const name of ["mcp__griffin__griffin_send", "mcp__griffin__griffin_reply", "mcp__karsara__karsara_send", "mcp__bridge__griffin_send"]) {
    const why = peerBridgeRefusal(name, "other");
    assert.ok(why, name);
    assert.match(why, /mcp__other__network_ask/);
  }
  assert.match(peerBridgeRefusal("mcp__griffin__griffin_reply", "other"), /network_reply/);
});

test("reads of a started task, this install's own tools and everything else pass", () => {
  for (const name of ["mcp__griffin__griffin_wait", "mcp__griffin__griffin_tasks", "mcp__griffin__griffin_limits", "mcp__griffin__griffin_cancel", "mcp__other__network_ask", "mcp__board__send", "Bash", "", undefined]) {
    assert.equal(peerBridgeRefusal(name, "other"), null, String(name));
  }
  // An install whose own server is literally named griffin keeps its own tools.
  assert.equal(peerBridgeRefusal("mcp__griffin__griffin_send", "griffin"), null);
});
