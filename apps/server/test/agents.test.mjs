import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AGENTS, CORE_TOOLS, DEFAULT_AGENT, allowedTools, callerQuota, filterTools, listAgents, resolveAgentId } from "../src/agents/registry.mjs";
import { agentPayload } from "../src/agents/import.mjs";
import { resolveEnabledTools } from "../src/agents/profiles.mjs";
import { CORE_RULES, DEFAULT_INSTRUCTIONS, NEVER_DEAD_END, installRules, rulesFor } from "../src/prompt.mjs";
import { exampleAgent } from "./fixture-agents.mjs";

const ALL = [
  "ask_owner",
  "ask_agent",
  "delegate",
  "visualize",
  "show_media",
  "jobs_list",
  "telegram_send",
  "kube_get",
  "debug_exec",
];

test("one built-in agent, and it owns nobody's infrastructure", () => {
  assert.equal(DEFAULT_AGENT, "griffin");
  assert.deepEqual(Object.keys(AGENTS), ["griffin"]);
  assert.equal(listAgents()[0].id, "griffin");
  for (const name of CORE_TOOLS) {
    assert.ok(!/^(kube|gitlab|grafana|mikrotik|arvan|nsin|infisical|s3|pg)_/.test(name), name);
  }
  const allowed = allowedTools("griffin", "owner", ALL);
  assert.ok(allowed.includes("ask_agent"));
  assert.ok(allowed.includes("ask_owner"));
  assert.ok(!allowed.includes("kube_get"), "infrastructure tools are opt-in per install");
  assert.ok(!allowed.includes("debug_exec"));
});

test("an unattended caller works but never asks; unknown caller fails closed", () => {
  const scheduled = allowedTools("griffin", "scheduler", ALL);
  assert.ok(scheduled.includes("delegate"));
  assert.ok(scheduled.includes("visualize"));
  assert.ok(!scheduled.includes("ask_owner"), "nobody is watching a scheduled run");
  assert.ok(allowedTools("griffin", "team", ALL).includes("ask_owner"));
  assert.throws(() => callerQuota("nope", "owner"), /unknown agent/);
  assert.throws(() => callerQuota("griffin", "stranger"), /unknown caller/);
});

test("agent ids are shapes, not a fixed list — custom agents are first class", () => {
  assert.equal(resolveAgentId("my-agent"), "my-agent");
  assert.equal(resolveAgentId("Not Valid"), DEFAULT_AGENT);
  assert.equal(resolveAgentId(""), DEFAULT_AGENT);
});

test("filterTools returns a new object and does not mutate input", () => {
  const input = { a: 1, b: 2, c: 3 };
  const out = filterTools(input, ["a", "c"]);
  assert.deepEqual(out, { a: 1, c: 3 });
  assert.deepEqual(input, { a: 1, b: 2, c: 3 });
  assert.notEqual(out, input);
});

test("rules are the shared core plus this agent's own instructions", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "griffin-rules-"));
  const file = installRules(dir);
  const text = fs.readFileSync(file, "utf8");
  assert.ok(text.startsWith(CORE_RULES));
  assert.ok(text.includes(DEFAULT_INSTRUCTIONS), "the default agent ships with instructions");
  assert.ok(text.includes(NEVER_DEAD_END));
  assert.match(text, /never claim to be/, "the voice section fixes the identity");
  assert.equal(fs.readFileSync(path.join(dir, "CLAUDE.md"), "utf8"), text);

  const own = rulesFor({
    agent: "scribe",
    profile: { label: "Scribe", domain: "writing", instructions: "Write minutes, never opinions." },
  });
  assert.ok(own.startsWith(CORE_RULES));
  assert.match(own, /`scribe` \(Scribe\)/);
  assert.match(own, /Your domain: writing/);
  assert.match(own, /Write minutes, never opinions/);
  assert.doesNotMatch(own, /kube|cluster|gitlab/i);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a non-owner caller is told who is calling and what it may use", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "griffin-rules-"));
  const profile = {
    label: "Scribe",
    instructions: "Write minutes.",
    meta: { callers: { scheduler: { tools: ["visualize", "knowledge_list"] } } },
  };
  const file = installRules(dir, { agent: "scribe", caller: "scheduler", profile });
  const text = fs.readFileSync(file, "utf8");
  assert.match(text, /Who is calling you now: زمان‌بند/);
  assert.match(text, /visualize, knowledge_list/);
  assert.match(text, /unattended/);
  const quotaLine = text.slice(text.indexOf("Who is calling you now:")).split("\n")[0];
  assert.doesNotMatch(quotaLine, /ask_owner/, "an unattended run is not told to ask");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("every agent gets its own cwd, rules and the shared directories", async () => {
  const { prepareAgentWorkspaces, agentCwd } = await import("../src/agents/workspaces.mjs");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "griffin-ws-"));
  fs.mkdirSync(path.join(root, "handbook"));
  fs.writeFileSync(path.join(root, "handbook", "AGENTS.md"), "hi");
  const prepared = prepareAgentWorkspaces(root, { agents: ["griffin", "scribe"], linkShared: ["handbook"] });
  assert.ok(prepared.includes(agentCwd(root, "griffin")));
  assert.ok(prepared.includes(agentCwd(root, "scribe")));
  assert.ok(fs.existsSync(path.join(agentCwd(root, "griffin"), ".cursor", "rules", "griffin.mdc")));
  assert.ok(fs.existsSync(path.join(agentCwd(root, "scribe"), ".cursor", "rules", "scribe.mdc")));
  assert.equal(fs.realpathSync(path.join(agentCwd(root, "scribe"), "handbook")), path.join(root, "handbook"));
  fs.rmSync(root, { recursive: true, force: true });
});

test("the shipped example agents are valid and keep their callers bounded", () => {
  const catalog = [
    "kube_get", "kube_status", "kube_secret", "debug_exec", "pg_query", "s3_get",
    "arvan_domains", "arvan_cache_purge", "nsin_domains", "nsin_dns_create",
    "telegram_send", "ask_owner", "visualize", "show_media", "list_agents",
  ];
  const platform = agentPayload(exampleAgent("platform.json"));
  assert.equal(platform.meta.allTools, true, "an infrastructure agent may hold every tool");
  const forGriffin = resolveEnabledTools({ ...platform, meta: platform.meta }, { caller: "griffin", catalogNames: catalog });
  assert.ok(forGriffin.includes("kube_get"));
  assert.ok(!forGriffin.includes("telegram_send"), "the messenger account stays with the orchestrator");
  assert.ok(!forGriffin.includes("list_agents"), "self-management never reaches a peer");

  const arvan = agentPayload(exampleAgent("cdn-arvan.json"));
  const arvanOwner = resolveEnabledTools(arvan, { caller: "owner", catalogNames: catalog });
  assert.ok(arvanOwner.includes("arvan_domains"));
  assert.ok(!arvanOwner.includes("kube_secret"), "a CDN agent has no business in the cluster");
  assert.ok(!arvanOwner.includes("nsin_domains"));

  const researcher = agentPayload(exampleAgent("researcher.json"));
  const researcherOwner = resolveEnabledTools(researcher, { caller: "owner", catalogNames: catalog });
  assert.deepEqual(researcherOwner.sort(), ["ask_owner", "list_agents", "show_media", "visualize"]);
});

test("buildRules: griffin in a colleague thread is not sent to itself and sees only its real tools", async () => {
  const { buildRules } = await import("../src/prompt.mjs");
  const text = buildRules({ agent: "griffin", caller: "team", tools: ["ask_agent", "delegate", "end_agent"] });
  assert.doesNotMatch(text, /ask_agent \{agent:"griffin"\}/);
  assert.match(text, /THIS conversation \(authoritative\): ask_agent, delegate, end_agent\./);
  assert.match(text, /Close the thread \(end_agent\)/, "a colleague thread gets the thread rules");
  assert.doesNotMatch(buildRules({ agent: "griffin", caller: "owner" }), /authoritative\): /);
});
