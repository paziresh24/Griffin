import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AGENTS, DEFAULT_AGENT, allowedTools, callerQuota, filterTools, listAgents } from "../src/agents/registry.mjs";
import { GRIFFIN_RULES, NEVER_DEAD_END, RULES, installRules } from "../src/prompt.mjs";

const ALL = [
  "kube_get",
  "kube_status",
  "kube_logs",
  "kube_secret",
  "debug_exec",
  "ask_owner",
  "visualize",
  "show_media",
  "pg_query",
  "arvan_cache_purge",
];

test("default agent is griffin", () => {
  assert.equal(DEFAULT_AGENT, "griffin");
  assert.equal(listAgents()[0].id, "griffin");
  assert.ok(AGENTS.griffin);
  assert.ok(AGENTS["platform"]);
  assert.ok(AGENTS["arvan-ban"]);
  assert.ok(AGENTS["nsin-ban"]);
});

test("griffin owner orchestrates via ask_agent; owns Telegram; no direct kube/arvan/nsin tools", () => {
  const names = [
    ...ALL,
    "ask_agent",
    "jobs_list",
    "jobs_create",
    "knowledge_list",
    "telegram_dialogs",
    "telegram_read",
    "telegram_send",
    "arvan_domains",
    "nsin_edge_ranges",
  ];
  const allowed = allowedTools("griffin", "owner", names);
  assert.ok(allowed.includes("ask_agent"));
  assert.ok(allowed.includes("ask_owner"));
  assert.ok(allowed.includes("jobs_list"));
  assert.ok(allowed.includes("telegram_dialogs"));
  assert.ok(allowed.includes("telegram_read"));
  assert.ok(allowed.includes("telegram_send"));
  assert.ok(!allowed.includes("kube_get"));
  assert.ok(!allowed.includes("arvan_domains"));
  assert.ok(!allowed.includes("nsin_edge_ranges"));
  assert.ok(!allowed.includes("debug_exec"));
});

test("griffin can call platform, arvan-ban and nsin-ban with peer quotas", () => {
  assert.ok(callerQuota("platform", "griffin").tools.includes("kube_get"));
  assert.ok(callerQuota("platform", "griffin").tools.includes("debug_exec"));
  assert.ok(callerQuota("platform", "griffin").tools.includes("ask_owner"));
  assert.ok(allowedTools("platform", "griffin", ALL).includes("ask_owner"));
  assert.ok(callerQuota("arvan-ban", "griffin").tools.includes("arvan_cache_purge"));
  assert.ok(callerQuota("nsin-ban", "griffin").tools.includes("nsin_edge_ranges"));
  assert.ok(!callerQuota("arvan-ban", "griffin").tools.includes("nsin_edge_ranges"));
});

test("griffin→platform peer quota excludes telegram — Griffin owns the owner's account", () => {
  const q = callerQuota("platform", "griffin").tools;
  assert.ok(!q.includes("telegram_dialogs"));
  assert.ok(!q.includes("telegram_read"));
  assert.ok(!q.includes("telegram_send"));
  const names = [...ALL, "telegram_dialogs", "telegram_read", "telegram_send", "kube_get"];
  const allowed = allowedTools("platform", "griffin", names);
  assert.ok(!allowed.includes("telegram_read"));
  assert.ok(allowed.includes("kube_get"));
});

test("owner gets everything available except arvan_* and nsin_* specialist tools", () => {
  const names = [...ALL, "nsin_edge_ranges"];
  const allowed = allowedTools("platform", "owner", names);
  assert.deepEqual(
    allowed,
    names.filter((n) => !n.startsWith("arvan_") && !n.startsWith("nsin_")),
  );
  assert.ok(!allowed.includes("arvan_cache_purge"));
  assert.ok(!allowed.includes("nsin_edge_ranges"));
});

test("platform owner reaches CDN/NSIN only via ask_agent, not arvan_*/nsin_*", () => {
  const names = [...ALL, "ask_agent", "arvan_domains", "http_check", "nsin_edge_ranges"];
  const allowed = allowedTools("platform", "owner", names);
  assert.ok(allowed.includes("ask_agent"));
  assert.ok(allowed.includes("http_check"));
  assert.ok(!allowed.includes("arvan_domains"));
  assert.ok(!allowed.includes("arvan_cache_purge"));
  assert.ok(!allowed.includes("nsin_edge_ranges"));
});

test("arvan-ban caller of platform gets get/status only — not kube_logs", () => {
  assert.deepEqual(allowedTools("platform", "arvan-ban", ALL), ["kube_get", "kube_status"]);
  assert.ok(!allowedTools("platform", "arvan-ban", ALL).includes("kube_logs"));
});

test("nsin-ban caller of platform gets mikrotik read only", () => {
  const names = [...ALL, "mikrotik_print", "mikrotik_ping", "mikrotik_address_list_add"];
  assert.deepEqual(allowedTools("platform", "nsin-ban", names), ["mikrotik_print", "mikrotik_ping"]);
});

test("scheduler does not get debug_exec, kube_secret or ask_owner", () => {
  const allowed = allowedTools("platform", "scheduler", ALL);
  assert.ok(!allowed.includes("debug_exec"));
  assert.ok(!allowed.includes("kube_secret"));
  assert.ok(!allowed.includes("ask_owner"));
  assert.ok(allowed.includes("kube_status"));
  assert.ok(allowed.includes("visualize"));
});

test("griffin and specialists have scheduler and team quotas for jobs / Telegram", () => {
  const names = [...ALL, "ask_agent", "end_agent", "knowledge_list", "telegram_send", "arvan_domains", "nsin_domains"];
  const gSched = allowedTools("griffin", "scheduler", names);
  assert.ok(gSched.includes("ask_agent"));
  assert.ok(!gSched.includes("ask_owner"));
  assert.ok(allowedTools("griffin", "team", names).includes("end_agent"));
  assert.ok(allowedTools("arvan-ban", "scheduler", names).includes("arvan_domains"));
  assert.ok(allowedTools("nsin-ban", "team", names).includes("end_agent"));
});

test("team coverage keeps ask_owner and debug_exec; excludes secrets", () => {
  const allowed = allowedTools("platform", "team", [
    ...ALL,
    "telegram_send",
    "arvan_cache_purge",
    "mikrotik_print",
    "end_agent",
    "gitlab_mr",
    "infisical_list",
    "infisical_get",
    "infisical_upsert",
    "kube_secret",
  ]);
  assert.ok(allowed.includes("ask_owner"));
  assert.ok(allowed.includes("pg_query"));
  assert.ok(allowed.includes("gitlab_mr"));
  assert.ok(allowed.includes("telegram_send"));
  assert.ok(allowed.includes("debug_exec"));
  assert.ok(allowed.includes("end_agent"));
  assert.ok(allowed.includes("infisical_list"));
  assert.ok(allowed.includes("infisical_get"));
  assert.ok(allowed.includes("infisical_upsert"));
  assert.ok(!allowed.includes("kube_secret"));
  assert.ok(!allowed.includes("arvan_cache_purge"));
});

test("unknown agent or caller throws — never falls open", () => {
  assert.throws(() => callerQuota("nope", "owner"), /unknown agent/);
  assert.throws(() => callerQuota("platform", "stranger"), /unknown caller/);
});

test("filterTools returns a new object and does not mutate input", () => {
  const input = { a: 1, b: 2, c: 3 };
  const out = filterTools(input, ["a", "c"]);
  assert.deepEqual(out, { a: 1, c: 3 });
  assert.deepEqual(input, { a: 1, b: 2, c: 3 });
  assert.notEqual(out, input);
});

test("installRules with no options is GRIFFIN_RULES plus the never-dead-end rule", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "griffin-rules-"));
  const file = installRules(dir);
  assert.equal(fs.readFileSync(file, "utf8"), GRIFFIN_RULES + NEVER_DEAD_END);
  assert.equal(fs.readFileSync(path.join(dir, "CLAUDE.md"), "utf8"), GRIFFIN_RULES + NEVER_DEAD_END);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("installRules for platform owner is RULES plus the never-dead-end rule", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "griffin-rules-"));
  const file = installRules(dir, { agent: "platform", caller: "owner" });
  assert.equal(fs.readFileSync(file, "utf8"), RULES + NEVER_DEAD_END);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("installRules for scheduler appends the quota note", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "griffin-rules-"));
  const file = installRules(dir, { agent: "platform", caller: "scheduler" });
  const text = fs.readFileSync(file, "utf8");
  assert.ok(text.startsWith(RULES));
  assert.match(text, /Who is calling you now: زمان‌بند/);
  assert.match(text, /kube_status/);
  const quotaLine = text.slice(text.indexOf("Who is calling you now:")).split("\n")[0];
  assert.doesNotMatch(quotaLine, /debug_exec/, "the scheduler quota itself has no terminal");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("prepareAgentWorkspaces creates per-agent cwd and symlinks shared clones", async () => {
  const { prepareAgentWorkspaces, agentCwd } = await import("../src/agents/workspaces.mjs");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "griffin-ws-"));
  fs.mkdirSync(path.join(root, "handbook"));
  fs.writeFileSync(path.join(root, "handbook", "AGENTS.md"), "hi");
  const prepared = prepareAgentWorkspaces(root, { linkShared: ["handbook"] });
  assert.ok(prepared.includes(agentCwd(root, "griffin")));
  assert.ok(prepared.includes(agentCwd(root, "platform")));
  assert.ok(prepared.includes(agentCwd(root, "arvan-ban")));
  assert.ok(prepared.includes(agentCwd(root, "nsin-ban")));
  assert.ok(fs.existsSync(path.join(agentCwd(root, "griffin"), ".cursor", "rules", "griffin.mdc")));
  assert.ok(fs.existsSync(path.join(agentCwd(root, "platform"), ".cursor", "rules", "platform.mdc")));
  assert.ok(fs.existsSync(path.join(agentCwd(root, "arvan-ban"), ".cursor", "rules", "arvan-ban.mdc")));
  assert.ok(fs.existsSync(path.join(agentCwd(root, "nsin-ban"), ".cursor", "rules", "nsin-ban.mdc")));
  assert.equal(fs.realpathSync(path.join(agentCwd(root, "platform"), "handbook")), path.join(root, "handbook"));
  assert.ok(!fs.existsSync(path.join(agentCwd(root, "arvan-ban"), "handbook")));
  assert.ok(!fs.existsSync(path.join(agentCwd(root, "nsin-ban"), "handbook")));
  assert.ok(!fs.existsSync(path.join(agentCwd(root, "griffin"), "handbook")));
  fs.rmSync(root, { recursive: true, force: true });
});

test("arvan-ban owner only gets CDN tools, not kube_secret, debug_exec or nsin_*", () => {
  const available = [...ALL, "arvan_domains", "http_check", "dns_lookup", "nsin_edge_ranges", "arvan_cache_purge"];
  const allowed = allowedTools("arvan-ban", "owner", available);
  assert.ok(allowed.includes("arvan_domains"));
  assert.ok(allowed.includes("http_check"));
  assert.ok(allowed.includes("ask_owner"));
  assert.ok(!allowed.includes("nsin_edge_ranges"));
  assert.ok(!allowed.includes("kube_secret"));
  assert.ok(!allowed.includes("debug_exec"));
  assert.ok(!allowed.includes("kube_get"));
});

test("nsin-ban owner gets NSIN tools, not arvan_* or kube", () => {
  const available = [
    ...ALL,
    "arvan_domains",
    "http_check",
    "dns_lookup",
    "nsin_edge_ranges",
    "nsin_domains",
    "nsin_cache_purge",
    "arvan_cache_purge",
  ];
  const allowed = allowedTools("nsin-ban", "owner", available);
  assert.ok(allowed.includes("nsin_edge_ranges"));
  assert.ok(allowed.includes("nsin_domains"));
  assert.ok(allowed.includes("nsin_cache_purge"));
  assert.ok(allowed.includes("http_check"));
  assert.ok(allowed.includes("ask_owner"));
  assert.ok(!allowed.includes("arvan_domains"));
  assert.ok(!allowed.includes("arvan_cache_purge"));
  assert.ok(!allowed.includes("kube_secret"));
  assert.ok(!allowed.includes("debug_exec"));
});

test("arvan-ban registry exposes CDN tools to platform caller", () => {
  const quota = callerQuota("arvan-ban", "platform");
  assert.ok(quota.tools.includes("arvan_cache_purge"));
  assert.ok(quota.tools.includes("http_check"));
  assert.ok(!quota.tools.includes("nsin_edge_ranges"));
  assert.equal(AGENTS["arvan-ban"].label, "آروان‌بان");
});

test("nsin-ban registry exposes NSIN tools to griffin and platform callers", () => {
  assert.ok(callerQuota("nsin-ban", "griffin").tools.includes("nsin_edge_ranges"));
  assert.ok(callerQuota("nsin-ban", "griffin").tools.includes("nsin_domains"));
  assert.ok(callerQuota("nsin-ban", "griffin").tools.includes("nsin_cache_purge"));
  assert.ok(callerQuota("nsin-ban", "platform").tools.includes("nsin_analytics_summary"));
  assert.ok(!callerQuota("nsin-ban", "griffin").tools.includes("nsin_dns_create"));
  assert.ok(callerQuota("nsin-ban", "arvan-ban").tools.includes("nsin_edge_ranges"));
  assert.equal(AGENTS["nsin-ban"].label, "انسین‌بان");
});
