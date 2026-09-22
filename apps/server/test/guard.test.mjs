import test from "node:test";
import assert from "node:assert/strict";
import { classify, guardTools } from "../src/guard.mjs";
import { createAsks } from "../src/asks.mjs";

function recorder() {
  const rows = [];
  return { rows, recordApproval: (row) => rows.push(row), appendEvent() {} };
}

test("classify depends on args, not only the tool name", () => {
  assert.equal(classify("gitlab_mr", { action: "view" }), null);
  assert.ok(classify("gitlab_mr", { action: "merge" }).approve);
  assert.equal(classify("pg_query", { sql: "select 1" }), null);
  assert.ok(classify("pg_query", { sql: "update t set a=1 where id=2", write: true }).approve);
  assert.ok(classify("pg_query", { sql: "drop table t", write: true }).block);
  assert.ok(classify("nsin_dns_delete", {}).approve);
  assert.equal(classify("kube_get", {}), null);
  assert.equal(classify("debug_exec", { command: "df -h" }), null);
  assert.ok(classify("debug_exec", { command: "rm -rf /" }).block);
});

test("gated call runs only after owner yes and is audited", async () => {
  const asks = createAsks();
  const store = recorder();
  let merged = 0;
  const tools = { gitlab_mr: { async execute() { merged += 1; return { content: [] }; } } };
  const guarded = guardTools(tools, { chatId: "g1", asks, store, caller: "peer:ali-ahmadi" });

  await guarded.gitlab_mr.execute({ action: "view", project: "x", iid: 1 });
  assert.equal(merged, 1);
  assert.equal(asks.isWaiting("g1"), false);

  const pending = guarded.gitlab_mr.execute({ action: "merge", project: "x", iid: 1 });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(asks.isWaiting("g1"), true);
  asks.answer("g1", { answer: "بله", selected: ["بله"] });
  await pending;
  assert.equal(merged, 2);
  assert.equal(store.rows.at(-1).decision, "approved");
  assert.equal(store.rows.at(-1).caller, "peer:ali-ahmadi");
});

test("denied or blocked calls never execute", async () => {
  const asks = createAsks();
  const store = recorder();
  let ran = 0;
  const tools = {
    mikrotik_remove: { async execute() { ran += 1; return { content: [] }; } },
    pg_query: { async execute() { ran += 1; return { content: [] }; } },
  };
  const guarded = guardTools(tools, { chatId: "g2", asks, store, caller: "team" });
  const blocked = await guarded.pg_query.execute({ sql: "TRUNCATE users", write: true });
  assert.equal(blocked.isError, true);
  const pending = guarded.mikrotik_remove.execute({ id: "*1" });
  await new Promise((r) => setTimeout(r, 20));
  asks.answer("g2", { answer: "نه", selected: ["نه"] });
  const denied = await pending;
  assert.equal(denied.isError, true);
  assert.equal(ran, 0);
  assert.deepEqual(store.rows.map((r) => r.decision), ["blocked", "denied"]);
});

test("unwatched roots (scheduler/ops) refuse gated calls without hanging", async () => {
  const chats = { s1: { id: "s1", caller: "ops" } };
  const asks = createAsks({ store: { getChat: (id) => chats[id], rootChatId: (id) => id } });
  let ran = 0;
  const tools = { infisical_upsert: { async execute() { ran += 1; return { content: [] }; } } };
  const guarded = guardTools(tools, { chatId: "s1", asks, caller: "ops" });
  const result = await guarded.infisical_upsert.execute({});
  assert.equal(result.isError, true);
  assert.equal(ran, 0);
});
