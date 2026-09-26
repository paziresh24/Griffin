import test from "node:test";
import assert from "node:assert/strict";
import { simulateTools } from "../src/sim.mjs";

test("simulation runs reads, records side effects, and answers questions with a no", async () => {
  const ran = [];
  const tool = (name) => ({ description: name, execute: async (args) => { ran.push(name); return { ok: true, args }; } });
  const tools = simulateTools({
    kube_get: tool("kube_get"),
    telegram_send: tool("telegram_send"),
    mikrotik_exec: tool("mikrotik_exec"),
    ask_owner: tool("ask_owner"),
  });
  assert.deepEqual(await tools.kube_get.execute({ kind: "pods" }), { ok: true, args: { kind: "pods" } });
  assert.match((await tools.telegram_send.execute({ chat: "x", text: "hi" })).content[0].text, /"simulated":true/);
  assert.equal((await tools.mikrotik_exec.execute({ router: "office", command: "/ip/route/print" })).ok, true, "a console read runs");
  assert.match((await tools.mikrotik_exec.execute({ router: "office", command: "/ip/route/add dst-address=1.2.3.0/24" })).content[0].text, /needsApproval/);
  assert.match((await tools.ask_owner.execute({ question: "?" })).content[0].text, /"answer":"نه"/);
  assert.deepEqual(ran, ["kube_get", "mikrotik_exec"]);
});
