import test from "node:test";
import assert from "node:assert/strict";
import { freeShell } from "../src/jobs/owner-jobs.mjs";

const base = { provider: "claude", unattended: false, rootCaller: "owner", rootMode: "agent" };

test("«بدون پرسیدن» on Claude is a shell in his chats, also one holding someone else's words", () => {
  assert.equal(freeShell(base), true);
  assert.equal(freeShell({ ...base, rootMode: undefined }), true, "agent is the default mode");
});

test("a colleague's conversation gets it with his grant only", () => {
  assert.equal(freeShell({ ...base, rootCaller: "team", rootMode: "agent", fullGrant: { until: "x" } }), true);
  assert.equal(freeShell({ ...base, rootCaller: "team", rootMode: "ask", fullGrant: null }), false);
  assert.equal(freeShell({ ...base, rootCaller: "peer:team-b", fullGrant: { until: "x" } }), true);
  assert.equal(freeShell({ ...base, rootCaller: "peer:team-b", fullGrant: null }), false);
});

test("not on another engine, another mode, unattended, the desk or the inbox dispatcher", () => {
  for (const over of [{ provider: "cursor" }, { provider: "openai" }, { rootMode: "ask" }, { rootMode: "auto" }, { unattended: true }, { desk: true }, { inboxChat: true }]) {
    assert.equal(freeShell({ ...base, ...over }), false, JSON.stringify(over));
  }
});
