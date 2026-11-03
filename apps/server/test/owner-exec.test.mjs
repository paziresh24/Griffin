import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createBrokerServer } from "../../broker/src/server.mjs";
import { openStore } from "../src/db.mjs";
import { createChatTrust } from "../src/knowledge-trust.mjs";
import { createOwnerExecTrust, markOwnerExec, OWNER_EXEC } from "../src/owner-exec.mjs";
import { createToolSource } from "../src/tools.mjs";
import { thirdPartyKey } from "../src/related.mjs";
import { OPS_CALLER } from "../src/incidents/opsroom.mjs";

// kube_exec as griffin-owner (2026-10-29): the owner's own untainted chats and the ops room only.
function env() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "griffin-owner-exec-"));
  const store = openStore(path.join(dir, "db.sqlite"));
  const chatTrust = createChatTrust({ store });
  const trust = createOwnerExecTrust({ store, ownerRooted: (id) => chatTrust.ownerRooted(id) });
  return { store, trust, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test("owner's own chat (and a chat delegated under it) runs as owner until it reads outside text", () => {
  const { store, trust, done } = env();
  try {
    const own = store.createChat({ title: "own", agent: "griffin" });
    store.appendEvent(own.id, null, "user", { text: "دیسک رو چک کن" });
    store.appendEvent(own.id, null, "tool.started", { callId: "1", name: "kube_get", args: {} });
    // Its own `later` reminder is not someone else's text.
    store.appendEvent(own.id, null, "user", { text: "یادآوری", from: { kind: "reminder" } });
    assert.equal(trust(own.id), true);
    const child = store.createChat({ title: "child", agent: "platform", caller: "griffin", parentChatId: own.id });
    assert.equal(trust(child.id), true);
    store.appendEvent(own.id, null, "tool.started", { callId: "2", name: "telegram_read", args: {} });
    assert.equal(trust(own.id), false);
    assert.equal(trust(child.id), false, "the child carries its root's context");
  } finally {
    done();
  }
});

test("colleague, third-party-marked, job and desk-less chats stay restricted; the ops room is owner", () => {
  const { store, trust, done } = env();
  try {
    const colleague = store.createChat({ title: "colleague", agent: "griffin", personId: "p1" });
    assert.equal(trust(colleague.id), false);
    const peer = store.createChat({ title: "peer", agent: "griffin", caller: "tavakoli" });
    assert.equal(trust(peer.id), false);
    const marked = store.createChat({ title: "marked", agent: "griffin" });
    store.setKv(thirdPartyKey(marked.id), true);
    assert.equal(trust(marked.id), false);
    const fromOther = store.createChat({ title: "relayed", agent: "griffin" });
    store.appendEvent(fromOther.id, null, "user", { text: "x", from: { kind: "telegram" } });
    assert.equal(trust(fromOther.id), false);
    const ops = store.createChat({ title: "ops", agent: "griffin", caller: OPS_CALLER });
    assert.equal(trust(ops.id), true);
    assert.equal(trust(""), false);
  } finally {
    done();
  }
});

test("markOwnerExec adds the Symbol flag only on the trusted verdict and drops a model's asOwner", async () => {
  const seen = [];
  const tools = { kube_exec: { execute: async (args) => seen.push(args) }, kube_get: { execute: async () => {} } };
  const yes = markOwnerExec(tools, { chatId: "c", trust: () => true });
  const no = markOwnerExec(tools, { chatId: "c", trust: () => false });
  await yes.kube_exec.execute({ cluster: "east", asOwner: false });
  await no.kube_exec.execute({ cluster: "east", asOwner: true });
  assert.equal(seen[0][OWNER_EXEC], true);
  assert.equal("asOwner" in seen[0], false);
  assert.equal(seen[1][OWNER_EXEC], undefined);
  assert.equal("asOwner" in seen[1], false);
  assert.equal(yes.kube_get, tools.kube_get);
});

test("tools.mjs sends asOwner from the flag alone: a model or peer asOwner:true never reaches the broker", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "owner-exec-sock-"));
  const socketPath = path.join(dir, "broker.sock");
  const got = [];
  const server = createBrokerServer({ tools: { kube_exec: { description: "x", inputSchema: { type: "object" }, execute: async (args) => (got.push(args), { ok: 1 }) } }, log: {} });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  try {
    const custom = await createToolSource({ socketPath }).customTools("chat-1");
    await custom.kube_exec.execute({ cluster: "east", asOwner: true }, {});
    await custom.kube_exec.execute({ cluster: "east", [OWNER_EXEC]: true }, {});
    // A wrapper that clones through JSON loses the flag: restricted, never owner.
    await custom.kube_exec.execute(JSON.parse(JSON.stringify({ cluster: "east", [OWNER_EXEC]: true })), {});
    assert.deepEqual(got.map((a) => a.asOwner), [false, true, false]);
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
