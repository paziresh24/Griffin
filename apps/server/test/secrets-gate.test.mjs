import test from "node:test";
import assert from "node:assert/strict";
import { forgetDecisions, secretsGate } from "../src/guard.mjs";
import { createAsks } from "../src/asks.mjs";

function storeWith(caller) {
  const rows = [];
  return {
    rows,
    recordApproval: (row) => rows.push(row),
    appendEvent: () => {},
    rootChatId: (id) => id,
    getChat: (id) => ({ id, caller, title: "t" }),
  };
}

test("reading another person's secrets asks the owner, even in the owner's own chat; own project and key names stay free", async () => {
  forgetDecisions();
  const asks = createAsks();
  const store = storeWith("owner");
  let ran = 0;
  const tool = { async execute() { ran += 1; return { content: [] }; } };
  const gated = secretsGate({ infisical_get: tool, infisical_list: tool }, { chatId: "o1", asks, store, caller: "owner", ownerProjects: ["sara-example"] });

  await gated.infisical_get.execute({ projectId: "sara-example", name: "X" });
  await gated.infisical_list.execute({ projectId: "bob-example" });
  assert.equal(ran, 2);
  assert.equal(asks.isWaiting("o1"), false);

  const pending = gated.infisical_get.execute({ projectId: "bob-example", path: "/servers", name: "A" });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(asks.isWaiting("o1"), true);
  asks.answer("o1", { answer: "بله", selected: ["بله"] });
  await pending;
  assert.equal(ran, 3);
  // one yes covers that project for the chain
  await gated.infisical_get.execute({ projectId: "bob-example", path: "/other", name: "B" });
  assert.equal(ran, 4);
  assert.equal(asks.isWaiting("o1"), false);
});

test("a colleague's own project is free; someone else's is refused on an unattended chain", async () => {
  forgetDecisions();
  const asks = createAsks();
  let ran = 0;
  const tool = { async execute() { ran += 1; return { content: [] }; } };
  const peer = secretsGate({ infisical_get: tool }, { chatId: "p1", asks, store: storeWith("peer:nora-karimi"), caller: "peer:nora-karimi" });
  await peer.infisical_get.execute({ projectId: "nora-karimi", name: "X" });
  assert.equal(ran, 1);
  const job = secretsGate({ infisical_upsert: tool }, { chatId: "j1", asks, store: storeWith("scheduler"), caller: "scheduler", mode: "refuse" });
  const out = await job.infisical_upsert.execute({ projectId: "nora-karimi", name: "X", value: "v" });
  assert.equal(out.isError, true);
  assert.equal(ran, 1);
});
