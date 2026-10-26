import test from "node:test";
import assert from "node:assert/strict";
import { classify, forgetDecisions, guardTools, secretAdminBackdoor } from "../src/guard.mjs";
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
  assert.ok(classify("debug_exec", { host: "ops-box", command: "uptime" }).approve, "a real host (not the sandbox) asks the owner");
  assert.equal(classify("debug_exec", { host: "sandbox", command: "uptime" }), null);
  // ssh_exec as the read-only user griffin needs no approval; another user asks; destructive blocked.
  assert.equal(classify("ssh_exec", { host: "203.0.113.57", command: "hostname" }), null);
  assert.ok(classify("ssh_exec", { host: "203.0.113.57", user: "root", command: "hostname" }).approve);
  assert.ok(classify("ssh_exec", { host: "x", command: "rm -rf /" }).block);
});

test("git push / forge API writes from the shell need the owner; forge tokens are fenced", () => {
  // The shape of a push that once wiped a shared GitOps repository.
  const push = classify("debug_exec", { command: "cd /tmp/pg\ngit commit -q -m fix\ngit push --quiet -o merge_request.create=false origin bomfix:main 2>&1 | tail -3" });
  assert.match(push.approve, /push/);
  assert.match(push.approve, /bomfix:main/);
  assert.ok(classify("debug_exec", { command: `curl -X PUT -H "PRIVATE-TOKEN: $T" https://gitlab.example.com/api/v4/projects/9/merge_requests/1/merge` }).approve);
  assert.equal(classify("debug_exec", { command: `curl -s -H "PRIVATE-TOKEN: $T" https://gitlab.example.com/api/v4/user` }), null);
  assert.equal(classify("debug_exec", { command: "git -C /workspace/repos/x log -3 && git status" }), null);
  assert.ok(classify("infisical_get", { projectId: "owner", path: "/secrets/gitlab-superuser", name: "TOKEN" }).block);
  assert.ok(classify("infisical_list", { projectId: "owner", search: "gitlab-superuser" }).block);
  assert.ok(classify("debug_exec", { command: "cat ~/.secrets/gitlab-superuser.token" }).block);
  assert.equal(classify("infisical_get", { projectId: "alice", path: "/", name: "N8N_API_KEY" }), null);
  // After one name was blocked, a peer chain read OTHER working forge tokens.
  assert.ok(classify("infisical_get", { projectId: "owner", path: "/ci", name: "GITLAB_TOKEN" }).block);
  assert.ok(classify("infisical_get", { projectId: "owner", path: "/bots/shared", name: "gitlab-api-token" }).block);
  assert.ok(classify("infisical_get", { projectId: "owner", path: "/", name: "GITHUB_TOKEN" }).block);
  assert.ok(classify("debug_exec", { command: "infisical secrets get GITLAB_TOKEN --path /ci --plain" }).block);
  assert.equal(classify("infisical_get", { projectId: "alice", path: "/", name: "SMS_TOKEN" }), null);
  // The server hook's escape hatch is never an agent's — fenced for every caller, owner chats too.
  assert.ok(secretAdminBackdoor("debug_exec", { command: "git push -o allow-mass-delete origin x:main" }));
  assert.equal(secretAdminBackdoor("debug_exec", { command: "git status" }), null);
});

test("full Arvan cache purge needs the owner with the site-death warning; a narrow url purge is free", () => {
  const full = classify("arvan_cache_purge", { domain: "example.com", scope: "all" });
  assert.ok(full.approve);
  assert.match(full.approve, /کل کش/);
  assert.match(full.approve, /ساعت/); // the consequence travels with the question
  assert.equal(classify("arvan_cache_purge", { domain: "example.com", scope: "urls", urls: ["https://example.com/a.css"] }), null);
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

// 2026-10-20: a shell step carries a `description` (its title in the chat). It is for the row only:
// the tool never receives it, and the same command with another title is the same command to the
// owner's remembered answer.
test("a shell step's title is dropped before the tool runs and does not change the approval key", async () => {
  forgetDecisions();
  const asks = createAsks();
  const store = recorder();
  const seen = [];
  const tools = { ssh_exec: { async execute(args) { seen.push(args); return { content: [] }; } }};
  const guarded = guardTools(tools, { chatId: "m2", asks, store, caller: "peer:x" });

  const first = guarded.ssh_exec.execute({ host: "10.0.0.5", user: "root", command: "hostname", description: "پیدا کردن نام سرور" });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(asks.answer("m2", { answer: "بله", selected: ["بله"] }), true);
  await first;
  await guarded.ssh_exec.execute({ host: "10.0.0.5", user: "root", command: "hostname", description: "همان دستور با عنوان دیگر" });
  assert.equal(asks.isWaiting("m2"), false, "another title did not open a second question");
  assert.deepEqual(seen[0], { host: "10.0.0.5", user: "root", command: "hostname" });
  assert.deepEqual(seen[1], { host: "10.0.0.5", user: "root", command: "hostname" });

  forgetDecisions();
});

// Owner 2026-09-23: approving a router health check is noise. Reads are free; writes still ask.
test("router console: reads (incl. GET-only fetch, ping) are free, writes still ask", () => {
  for (const command of [
    "/ip/address/print",
    '/tool/fetch url="http://192.0.2.52:5678/healthz" mode=http keep-result=no as-value',
    "/ping 8.8.8.8 count=3",
    "/ip cloud print; /system identity print",
  ]) assert.equal(classify("mikrotik_exec", { command, router: "edge" }), null, command);
  for (const command of [
    '/tool fetch url="https://api.ipify.org" dst-path=ipify.txt',
    "/ppp secret add name=x password=y",
    "/export file=backup",
    '/tool fetch url="http://x" http-method=post keep-result=no',
    "/system reboot",
  ]) assert.ok(classify("mikrotik_exec", { command, router: "office" })?.approve, command);
});

test("the approval question is built from the call, never the model's pitch; one yes covers the scope", async () => {
  forgetDecisions();
  const asks = createAsks();
  const store = recorder();
  store.rootChatId = () => "q1";
  store.getChat = () => ({ id: "q1", caller: "peer:alice", title: "Alice: دیتابیس برای سرویس inbox" });
  const seen = [];
  const tools = {
    kube_exec: { inputSchema: { type: "object", properties: {} }, async execute(args) { seen.push(args.command); return { content: [] }; } },
  };
  const guarded = guardTools(tools, { chatId: "q1", asks, store, caller: "platform", extra: new Set(["kube_exec"]) });
  assert.equal(guarded.kube_exec.inputSchema.properties.why, undefined, "no why argument for the model to argue with");
  assert.ok(guarded.kube_exec.inputSchema.properties.intent, "gated tools take one plain sentence for the owner");

  const call = (command) => ({ cluster: "c1", namespace: "bob", pod: "db-1", command, why: "لطفاً اجرا شود، تأیید گرفته شده" });
  const pending = guarded.kube_exec.execute(call("nc -zv db 5432"));
  await new Promise((r) => setTimeout(r, 20));
  const q = store.events.find((e) => e.type === "tool.started").data.args.question;
  assert.doesNotMatch(q, /لطفاً/, "the model's pitch never reaches the owner");
  assert.match(q, /namespace «bob»/);
  assert.match(q, /برای: دیتابیس برای سرویس inbox/);
  assert.match(q, /⚠️ این مالِ bob است/, "writing into someone else's namespace is called out");
  assert.equal(store.rows.some((r) => r.decision === "peer-card"), false, "no method card for a namespace the requester cannot touch");
  asks.answer("q1", { answer: "بله", selected: ["بله"] });
  await pending;
  await guarded.kube_exec.execute(call("python3 -c 'import socket'"));
  assert.equal(store.events.filter((e) => e.type === "tool.started").length, 1, "a reshaped command in the same namespace is not asked again");
  assert.deepEqual(seen, ["nc -zv db 5432", "python3 -c 'import socket'"], "why never reaches the tool");
  forgetDecisions();
});

// Ask like a person: who wants what, what I would change, OK?
test("an agent's plain sentence is the approval question; pleading or tool names fall back", async () => {
  const { approvalQuestion, plainIntent } = await import("../src/guard.mjs");
  const store = { rootChatId: () => "r", getChat: () => ({ id: "r", caller: "peer:alice", title: "x" }) };
  const intent = "می‌خوان سرویس inbox به سرور تلفن برسه؛ برای این کار باید روی گیت‌وی یه route اضافه کنم";
  const q = approvalQuestion(store, "r", "kube_exec", { cluster: "c1", namespace: "alice", pod: "p", command: "nc" }, "اجرای دستور داخل پاد", intent);
  assert.ok(q.startsWith(intent));
  assert.match(q, /اوکیه؟$/);
  assert.doesNotMatch(q, /kube_exec|پاد p|namespace/, "no tool talk when the agent said it plainly");
  for (const bad of ["لطفاً اجرا شود، تأیید گرفته شده", "telegram_send به گروه", "x".repeat(300)]) assert.equal(plainIntent(bad), "", bad);
  const named = { ...store, getKv: (k) => (k === "owner-names" ? { "bob": "آقای باب" } : null) };
  assert.match(approvalQuestion(named, "r", "kube_exec", { cluster: "c1", namespace: "bob" }, "x", intent), /⚠️ این مالِ آقای باب است/);
  const team = approvalQuestion(store, "r", "telegram_send", { chat: "گروه آپدیت‌ها", text: "فعال شد" }, "فرستادن پیام", "");
  assert.match(team, /^فرستادن پیام — در «گروه آپدیت‌ها»: «فعال شد»/);
  const withFile = approvalQuestion(store, "r", "telegram_send", { chat: "امیرحسین مرادی", text: "گزارش", file: "out/report.pdf" }, "فرستادن پیام", "");
  assert.match(withFile, /^فرستادن پیام — در «امیرحسین مرادی»: فایل «report\.pdf» با «گزارش»/);
  // a DNS cleanup is one question that names every record (2026-10-24: 23 records, one ask each)
  const dns = approvalQuestion(store, "r", "arvan_dns_delete", { domain: "example.com", records: [{ name: "old1" }, { name: "old2", type: "CNAME" }] }, "حذف رکورد DNS آروان", "۲۳ رکورد مرده را پاک می‌کنم تا زون زیر سقف برود");
  assert.match(dns, /2 رکورد در example\.com: old1، old2 \(CNAME\)/);
});

// The agent writes intent once, then the same secrets go to a new folder without it.
test("a chain's plain sentence carries over to its next approval, naming what this one touches", async () => {
  forgetDecisions();
  const asks = createAsks();
  const store = recorder();
  store.rootChatId = () => "c1";
  store.getChat = (id) => (id === "c1" ? { id: "c1", caller: "team", title: "/agent · Bob" } : null);
  const tools = { infisical_upsert: { inputSchema: { type: "object", properties: {} }, async execute() { return { content: [] }; } } };
  const guarded = guardTools(tools, { chatId: "c1", asks, store, caller: "team" });
  const intent = "برای استیجینگ inbox، رمز دیتابیس را در پروژهٔ آقای باب می‌گذارم";
  const first = guarded.infisical_upsert.execute({ projectId: "bob", path: "/", name: "MAIN_DB", value: "x", intent });
  await new Promise((r) => setTimeout(r, 20));
  asks.answer("c1", { answer: "بله", selected: ["بله"] });
  await first;
  const second = guarded.infisical_upsert.execute({ projectId: "bob", path: "/staging", name: "LOG_DB", value: "y" });
  await new Promise((r) => setTimeout(r, 20));
  const q = store.events.filter((e) => e.type === "tool.started").at(-1).data.args.question;
  assert.ok(q.startsWith(intent), q);
  assert.match(q, /\(این بار: LOG_DB\)/);
  assert.doesNotMatch(q, /\/agent|نوشتن secret/);
  asks.answer("c1", { answer: "نه", selected: ["نه"] });
  await second;
  forgetDecisions();
});

test("routerReadOnly: :put of a find and print … where are reads, file= and set are not", async () => {
  const { routerReadOnly } = await import("../src/guard.mjs");
  assert.equal(routerReadOnly(":put [:len [/ip/route/find]]"), true);
  assert.equal(routerReadOnly(':put "x"; /ip/route/print without-paging where dst-address~"172.16"'), true);
  assert.equal(routerReadOnly("/ip route print detail file=routes-export"), false);
  assert.equal(routerReadOnly(":put [/ip/route/set 0 disabled=yes]"), false);
});

test("ask tools refuse a tool-choice question; a normal question still goes out", async () => {
  const asks = createAsks();
  const tool = asks.requesterTool("tc1");
  const r = await tool.execute({ question: "چه مسیری می‌روی؟", options: ["با kube_secret بخوان", "با kube_get بخوان"] });
  assert.ok(r.isError, "which-tool is the agent's own decision");
  assert.equal(asks.isWaiting("tc1"), false, "nothing reached a person");
  const pending = asks.tool("tc1").execute({ question: "کدام namespace منظورت بود؟" });
  await new Promise((res) => setTimeout(res, 10));
  assert.equal(asks.isWaiting("tc1"), true);
  asks.answer("tc1", { answer: "x", selected: ["x"] });
  await pending;
});

test("a colleague trusted for in-pod reads runs kube_exec without waiting on the owner; others still ask", async () => {
  forgetDecisions();
  const asks = createAsks();
  const store = recorder();
  const kv = new Map([["peertrust:boss", { inPod: true }]]);
  let caller = "peer:boss";
  store.rootChatId = () => "t1";
  store.getChat = () => ({ id: "t1", caller, title: "boss: check" });
  store.getKv = (k) => kv.get(k) || null;
  let ran = 0;
  const tools = { kube_exec: { inputSchema: { type: "object", properties: {} }, async execute() { ran += 1; return { content: [] }; } } };
  const guarded = guardTools(tools, { chatId: "t1", asks, store, caller: "platform", extra: new Set(["kube_exec"]) });
  await guarded.kube_exec.execute({ cluster: "c1", namespace: "other", pod: "p", command: "env | sha256sum" });
  assert.equal(ran, 1);
  assert.equal(asks.isWaiting("t1"), false, "no owner question");
  assert.equal(store.rows.at(-1).decision, "trusted", "audited");
  caller = "peer:someone";
  forgetDecisions();
  await guarded.kube_exec.execute({ cluster: "c1", namespace: "someone", pod: "p", command: "ls" });
  assert.equal(ran, 2, "a colleague's own namespace never waits on the owner");
  const pending = guarded.kube_exec.execute({ cluster: "c1", namespace: "other2", pod: "p", command: "ls" });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(asks.isWaiting("t1"), true, "an untrusted colleague still needs the owner");
  asks.answer("t1", { answer: "نه", selected: ["نه"] });
  await pending;
  forgetDecisions();
});

test("a raw write to the Arvan/NSIN API from debug_exec asks the owner with the exact call", () => {
  // The shape of the command that once switched a whole domain's cache off.
  const cmd = `KEY=$(cat /root/.arvan-key)\ncurl -s -m 30 -X PATCH -H "Authorization: ApiKey $KEY" -H "Content-Type: application/json" \\\n  -d '{"cache_developer_mode":true}' \\\n  "https://napi.arvancloud.ir/cdn/4.0/domains/example.com/caching"`;
  const c = classify("debug_exec", { command: cmd });
  assert.ok(c.approve, "must ask");
  assert.match(c.approve, /PATCH \/cdn\/4\.0\/domains\/example\.com\/caching/);
  assert.match(c.approve, /cache_developer_mode":true/, "the owner sees the field and value");
  assert.ok(classify("debug_exec", { command: `curl -s --request DELETE https://api.nsin.ir/domains/x.ir/dns/records/1` }).approve);
  assert.ok(classify("debug_exec", { command: `curl -s https://api.nsin.ir/zones/x/purge --data '{"a":1}'` }).approve, "a body alone means a write");
  assert.ok(classify("debug_exec", { command: `python3 -c "import requests; requests.patch('https://napi.arvancloud.ir/cdn/4.0/domains/d/caching', json={})"` }).approve);
  // reads stay free
  assert.equal(classify("debug_exec", { command: `curl -s -H "Authorization: ApiKey $K" https://napi.arvancloud.ir/cdn/4.0/domains/example.com/caching` }), null);
  assert.equal(classify("debug_exec", { command: `curl -s -X POST https://example.com/api -d '{}'` }), null, "only the CDN control planes");
});

// A cutover needing 8 sibling page rules gets one approval, not eight; a rule on
// another path still asks.
test("page rules: one yes covers the same host/path, whatever sibling is copied, not another path", async () => {
  forgetDecisions();
  const asks = createAsks();
  const store = recorder();
  store.rootChatId = () => "pr1";
  store.getChat = () => ({ id: "pr1", caller: "team", title: "billing" });
  const made = [];
  const tools = { arvan_page_rule_create: { inputSchema: { type: "object", properties: {} }, async execute(args) { made.push(args.url); return { content: [] }; } } };
  const guarded = guardTools(tools, { chatId: "pr1", asks, store, caller: "arvan-ban" });
  const rule = (url, copy_from = "11111111-2222-3333-4444-555555555555") => ({ domain: "example.com", copy_from, url });
  const first = guarded.arvan_page_rule_create.execute(rule("https://api.example.com/billing/v1/factors/search*"));
  await new Promise((r) => setTimeout(r, 20));
  const asked = () => store.events.filter((e) => e.type === "tool.started").length;
  assert.equal(asked(), 1);
  assert.match(store.events.find((e) => e.type === "tool.started").data.args.question, /api\.example\.com\/billing/);
  asks.answer("pr1", { answer: "بله", selected: ["بله"] });
  await first;
  await guarded.arvan_page_rule_create.execute(rule("https://api.example.com/billing/v1/payment/card-numbers*", "66666666-7777-8888-9999-000000000000"));
  assert.equal(asked(), 1, "a sibling rule under the same path is not asked again");
  const other = guarded.arvan_page_rule_create.execute(rule("https://api.example.com/*"));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(asked(), 2, "a rule outside the approved path asks again");
  asks.answer("pr1", { answer: "نه", selected: ["نه"] });
  await other.catch(() => {});
  assert.equal(made.length, 2);
  forgetDecisions();
});

// An owner-rooted chat once read the secret manager's instance-admin secret and queried its DB.
test("Infisical admin plane is fenced for every caller, owner included", async () => {
  const { fenceBackdoors, secretAdminBackdoor } = await import("../src/guard.mjs");
  assert.ok(secretAdminBackdoor("kube_secret", { cluster: "c1", namespace: "infisical", name: "infisical-instance-admin" }));
  assert.ok(secretAdminBackdoor("pg_query", { cluster: "c2", namespace: "infisical", name: "infisical-db", database: "infisical", sql: "select 1" }));
  assert.ok(secretAdminBackdoor("debug_exec", { command: "kubectl -n infisical get secret infisical-instance-admin -o json" }));
  assert.equal(secretAdminBackdoor("pg_query", { name: "support-db", database: "postgres", sql: "select 1" }), null);
  assert.equal(secretAdminBackdoor("kube_secret", { namespace: "alice", name: "app" }), null);
  let ran = 0;
  const store = recorder();
  const tools = fenceBackdoors({ kube_secret: { async execute() { ran++; return {}; } } }, { chatId: "c", store, caller: "owner" });
  const r = await tools.kube_secret.execute({ namespace: "infisical", name: "infisical-secrets" });
  assert.equal(ran, 0);
  assert.match(JSON.stringify(r), /infisical_machine_identity/);
  await tools.kube_secret.execute({ namespace: "x", name: "y" });
  assert.equal(ran, 1);
});

test("a yes is learned for that person and scope; another person still asks", async () => {
  const { guardTools, forgetDecisions } = await import("../src/guard.mjs");
  forgetDecisions();
  const kv = new Map();
  const chats = { a: { id: "a", caller: "peer:ali" }, b: { id: "b", caller: "peer:ali" }, c: { id: "c", caller: "peer:reza" } };
  const store = { getChat: (id) => chats[id], rootChatId: (id) => id, getKv: (k) => kv.get(k), setKv: (k, v) => kv.set(k, v), recordApproval() {}, appendEvent() {} };
  let asked = 0;
  const asks = { confirm: async () => { asked++; return { answered: true, answer: "بله" }; } };
  const tool = { kube_exec: { execute: async () => "ran" } };
  const args = { cluster: "east", namespace: "other-ns", pod: "p", command: "ls" };
  assert.equal(await guardTools(tool, { chatId: "a", asks, store }).kube_exec.execute(args), "ran");
  forgetDecisions(); // a new day: in-memory decisions are gone, the grant is not
  assert.equal(await guardTools(tool, { chatId: "b", asks, store }).kube_exec.execute({ ...args, command: "df" }), "ran");
  assert.equal(asked, 1);
  await guardTools(tool, { chatId: "c", asks, store }).kube_exec.execute(args);
  assert.equal(asked, 2);
});

test("a network peer's own namespace (kv peer-owner) runs without asking; a typed question is not a no", async () => {
  const { guardTools, forgetDecisions } = await import("../src/guard.mjs");
  forgetDecisions();
  const kv = new Map([["peer-owner", { "net-karsara-sharifi-example-org": ["sara-sharifi"] }]]);
  const chats = { a: { id: "a", caller: "peer:net-karsara-sharifi-example-org" } };
  const store = { getChat: (id) => chats[id], rootChatId: (id) => id, getKv: (k) => kv.get(k), setKv: (k, v) => kv.set(k, v), recordApproval() {}, appendEvent() {} };
  const replies = ["کجا در جریانه که من نمیبینم؟", "بله"];
  let asked = 0;
  const asks = { confirm: async () => ({ answered: true, answer: replies[asked++] }) };
  const tool = { kube_exec: { execute: async () => "ran" } };
  const own = { cluster: "east", namespace: "sara-sharifi", pod: "p", command: "ls" };
  assert.equal(await guardTools(tool, { chatId: "a", asks, store }).kube_exec.execute(own), "ran");
  assert.equal(asked, 0);
  const other = { ...own, namespace: "akazemi" };
  const first = await guardTools(tool, { chatId: "a", asks, store }).kube_exec.execute(other);
  assert.match(first.content[0].text, /به‌جای جواب سؤال پرسید/);
  assert.equal(await guardTools(tool, { chatId: "a", asks, store }).kube_exec.execute(other), "ran");
  assert.equal(asked, 2);
});
