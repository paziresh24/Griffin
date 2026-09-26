import test from "node:test";
import assert from "node:assert/strict";
import { classify, forgetDecisions, guardTools } from "../src/guard.mjs";
import { createAsks } from "../src/asks.mjs";

function recorder() {
  const rows = [];
  const events = [];
  return { rows, events, recordApproval: (row) => rows.push(row), appendEvent: (_chat, _run, type, data) => events.push({ type, data }) };
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

// Seen 2026-09-23: the agent re-sent the same router command seconds after the owner said no, and
// parallel identical calls each opened a question. One answer holds for the chain.
test("one owner answer covers identical calls: parallel ones share it, a no is not asked again", async () => {
  forgetDecisions();
  const asks = createAsks();
  const store = recorder();
  let ran = 0;
  const tools = { mikrotik_remove: { async execute() { ran += 1; return { content: [] }; } } };
  const guarded = guardTools(tools, { chatId: "m1", asks, store, caller: "peer:x" });

  const a = guarded.mikrotik_remove.execute({ id: "*1" });
  const b = guarded.mikrotik_remove.execute({ id: "*1" });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(asks.answer("m1", { answer: "نه", selected: ["نه"] }), true);
  assert.equal(asks.isWaiting("m1"), false, "the parallel twin did not open a second question");
  assert.ok((await a).isError);
  assert.ok((await b).isError);

  const again = await guarded.mikrotik_remove.execute({ id: "*1" });
  assert.ok(again.isError);
  assert.equal(asks.isWaiting("m1"), false, "a denied call is refused without asking again");
  assert.match(again.content[0].text, /قبلاً رد کرده/);

  const other = guarded.mikrotik_remove.execute({ id: "*2" });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(asks.isWaiting("m1"), true, "a different call is still asked");
  asks.answer("m1", { answer: "بله", selected: ["بله"] });
  await other;
  await guarded.mikrotik_remove.execute({ id: "*2" });
  assert.equal(ran, 2, "an approved call runs again without a new question");
  forgetDecisions();
});

// Owner 2026-09-23: approving a router health check is noise. Reads are free; writes still ask.
test("router console: reads (incl. GET-only fetch, ping) are free, writes still ask", () => {
  for (const command of [
    "/ip/address/print",
    '/tool/fetch url="http://172.16.105.52:5678/healthz" mode=http keep-result=no as-value',
    "/ping 8.8.8.8 count=3",
    "/ip cloud print; /system identity print",
  ]) assert.equal(classify("mikrotik_exec", { command, router: "yazd" }), null, command);
  for (const command of [
    '/tool fetch url="https://api.ipify.org" dst-path=ipify.txt',
    "/ppp secret add name=x password=y",
    "/export file=backup",
    '/tool fetch url="http://x" http-method=post keep-result=no',
    "/system reboot",
  ]) assert.ok(classify("mikrotik_exec", { command, router: "office" })?.approve, command);
});

test("the approval question is one plain line with the agent's why, not a JSON dump", async () => {
  forgetDecisions();
  const asks = createAsks();
  const store = recorder();
  let seen = null;
  const tools = {
    mikrotik_exec: {
      inputSchema: { type: "object", properties: { command: { type: "string" } }, required: ["command"], additionalProperties: false },
      async execute(args) { seen = args; return { content: [] }; },
    },
  };
  const guarded = guardTools(tools, { chatId: "q1", asks, store, caller: "peer:x" });
  assert.ok(guarded.mikrotik_exec.inputSchema.properties.why, "gated tools accept a why for the owner");

  const pending = guarded.mikrotik_exec.execute({ command: "/ppp secret add name=rezaei", router: "office", why: "آقای رضایی VPN شرکت می‌خواد" });
  await new Promise((r) => setTimeout(r, 20));
  const started = store.events.find((e) => e.type === "tool.started");
  assert.match(started.data.args.question, /^آقای رضایی VPN شرکت می‌خواد\nکار: دستور روی روتر office — \/ppp secret add name=rezaei\nبزنم؟$/);
  asks.answer("q1", { answer: "بله", selected: ["بله"] });
  await pending;
  assert.deepEqual(seen, { command: "/ppp secret add name=rezaei", router: "office" }, "why never reaches the tool");
  forgetDecisions();
});

test("routerReadOnly: :put of a find and print … where are reads, file= and set are not", async () => {
  const { routerReadOnly } = await import("../src/guard.mjs");
  assert.equal(routerReadOnly(":put [:len [/ip/route/find]]"), true);
  assert.equal(routerReadOnly(':put "x"; /ip/route/print without-paging where dst-address~"172.16"'), true);
  assert.equal(routerReadOnly("/ip route print detail file=routes-export"), false);
  assert.equal(routerReadOnly(":put [/ip/route/set 0 disabled=yes]"), false);
});
