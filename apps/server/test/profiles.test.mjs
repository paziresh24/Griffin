import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openStore } from "../src/db.mjs";
import {
  APP_TOOL_NAMES,
  SELF_MGMT_TOOLS,
  filterToolsByProfile,
  publicProfile,
  resolveEnabledTools,
  seedProfilesFromRegistry,
} from "../src/agents/profiles.mjs";
import { createAgentSettingsTools, bindChatTools } from "../src/agents/settings-tools.mjs";
import { ASK_AGENT_TOOL, createPeers } from "../src/peers.mjs";
import { CORE_RULES, installRules } from "../src/prompt.mjs";
import { agentPayload, importAgent } from "../src/agents/import.mjs";
import { rulesFor } from "../src/prompt.mjs";
import { seedExampleAgents } from "./fixture-agents.mjs";

function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "griffin-profiles-"));
  const store = openStore(path.join(dir, "t.sqlite"));
  seedExampleAgents(store);
  return { store, dir };
}

test("a fresh install has exactly one agent; more are imported like any user would", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "griffin-seed-"));
  const store = openStore(path.join(dir, "t.sqlite"));
  const fresh = store.listAgentProfiles();
  assert.deepEqual(fresh.map((p) => p.id), ["griffin"], "no environment-specific agents ship");
  const griffin = fresh[0];
  assert.equal(griffin.provider, "cursor");
  assert.ok(!griffin.meta.allTools, "the default agent gets a named tool list, not everything");
  assert.ok(griffin.tools.includes("ask_agent"));
  for (const name of SELF_MGMT_TOOLS) assert.ok(griffin.tools.includes(name), name);
  assert.equal(store.seedAgentProfiles(), 0, "second seed is a no-op");

  seedExampleAgents(store);
  assert.deepEqual(store.listAgentProfiles().map((p) => p.id).sort(), ["arvan-ban", "griffin", "nsin-ban", "platform", "researcher"]);
  assert.equal(store.getAgentProfile("platform").meta.allTools, true);
  assert.ok(store.getAgentProfile("platform").meta.callers.scheduler);
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("seedProfilesFromRegistry matches openStore seed shape", () => {
  const rows = seedProfilesFromRegistry();
  assert.equal(rows.length, 1);
  assert.ok(rows.every((r) => r.builtIn && r.provider === "cursor"));
});

test("an agent can be created, edited and deleted at runtime", () => {
  const { store, dir } = tempStore();
  const created = importAgent(store, {
    id: "librarian",
    label: "کتابدار",
    domain: "reading and summarising",
    instructions: "You read and summarise. You never change anything.",
    tools: ["ask_owner", "show_media"],
    callers: { owner: { tools: "*" }, griffin: { tools: ["show_media"] } },
  });
  assert.equal(created.id, "librarian");
  assert.match(created.instructions, /never change anything/);
  assert.ok(created.tools.includes("list_agents"), "self-management is always added");

  const rules = rulesFor({ agent: "librarian", profile: store.getAgentProfile("librarian") });
  assert.ok(rules.startsWith(CORE_RULES), "every agent gets the shared core");
  assert.match(rules, /You read and summarise/);
  assert.match(rules, /`librarian`/);

  store.updateAgentProfile("librarian", { instructions: "New brief." });
  assert.equal(store.getAgentProfile("librarian").instructions, "New brief.");

  assert.equal(store.deleteAgentProfile("librarian"), true);
  assert.equal(store.getAgentProfile("librarian"), null);
  assert.equal(store.deleteAgentProfile("librarian"), false);
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a bad agent id is refused before it reaches the store", () => {
  assert.throws(() => agentPayload({ id: "Not Valid" }), /lowercase/);
  assert.throws(() => agentPayload({ id: "" }), /lowercase/);
  const payload = agentPayload({ id: "ok-1" });
  assert.equal(payload.meta.callers.owner.tools, "*", "owner may always call");
});

test("filterToolsByProfile uses tools_json for owner", () => {
  const { store, dir } = tempStore();
  store.updateAgentProfile("arvan-ban", { tools: ["arvan_domains", "ask_owner", ...SELF_MGMT_TOOLS] });
  const profile = store.getAgentProfile("arvan-ban");
  const map = {
    arvan_domains: 1,
    arvan_cache_purge: 1,
    ask_owner: 1,
    kube_get: 1,
    list_agents: 1,
  };
  const filtered = filterToolsByProfile(map, profile, { caller: "owner" });
  assert.deepEqual(Object.keys(filtered).sort(), ["arvan_domains", "ask_owner", "list_agents"]);
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("scheduler caller still uses meta.callers quota", () => {
  const { store, dir } = tempStore();
  const profile = store.getAgentProfile("platform");
  const catalog = ["kube_status", "kube_get", "debug_exec", "ask_owner"];
  const enabled = resolveEnabledTools(profile, { caller: "scheduler", catalogNames: catalog });
  assert.ok(enabled.includes("kube_status"));
  assert.ok(!enabled.includes("debug_exec"));
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("peer caller is bounded by its quota, never the full profile or self-mgmt", () => {
  const { store, dir } = tempStore();
  const profile = store.getAgentProfile("platform"); // allTools, every catalog tool
  const catalog = [
    "kube_get", "kube_status", "kube_secret", "pg_query", "debug_exec", "s3_get",
    "telegram_send", "ask_owner", ...SELF_MGMT_TOOLS,
  ];
  // A peer with a read-only quota gets exactly that, not the whole profile.
  store.updateAgentProfile("platform", {
    meta: { callers: { ...profile.meta.callers, "arvan-ban": { tools: ["kube_get", "kube_status"] } } },
  });
  const bounded = store.getAgentProfile("platform");
  const asPeer = resolveEnabledTools(bounded, { caller: "arvan-ban", catalogNames: catalog });
  assert.deepEqual(asPeer.sort(), ["kube_get", "kube_status"]);
  for (const dangerous of ["kube_secret", "pg_query", "debug_exec", "s3_get", "telegram_send"]) {
    assert.ok(!asPeer.includes(dangerous), dangerous);
  }
  // The self-management tools (which mutate RBAC) never reach a peer-invoked run.
  for (const name of SELF_MGMT_TOOLS) assert.ok(!asPeer.includes(name), name);
  // A caller with no quota row on this profile fails closed.
  assert.deepEqual(resolveEnabledTools(bounded, { caller: "no-such-agent", catalogNames: catalog }), []);
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("enable/disable tools via store and settings tools", async () => {
  const { store, dir } = tempStore();
  const chat = store.createChat({ title: "t", agent: "arvan-ban" });
  const catalog = ["arvan_domains", "http_check", "ask_owner", ...SELF_MGMT_TOOLS, ...APP_TOOL_NAMES];
  store.updateAgentProfile("arvan-ban", { tools: ["arvan_domains", ...SELF_MGMT_TOOLS] });

  const tools = bindChatTools(
    createAgentSettingsTools({ store, catalogNames: () => catalog }),
    chat.id,
  );
  const listed = JSON.parse((await tools.agent_tools_list.execute({})).content[0].text);
  assert.equal(listed.agent, "arvan-ban");
  assert.ok(listed.tools.find((t) => t.name === "arvan_domains")?.enabled);
  assert.ok(!listed.tools.find((t) => t.name === "http_check")?.enabled);

  await tools.agent_tools_enable.execute({ tools: ["http_check"] });
  assert.ok(store.getAgentProfile("arvan-ban").tools.includes("http_check"));

  await tools.agent_tools_disable.execute({ tools: ["http_check"] });
  assert.ok(!store.getAgentProfile("arvan-ban").tools.includes("http_check"));

  const blocked = await tools.agent_tools_disable.execute({ tools: ["list_agents"] });
  assert.equal(blocked.isError, true);

  await tools.agent_settings_set.execute({ provider: "claude", model: "sonnet" });
  const next = store.getAgentProfile("arvan-ban");
  assert.equal(next.provider, "claude");
  assert.equal(next.model, "sonnet");
  assert.equal(publicProfile(next).provider, "claude");

  const agents = JSON.parse((await tools.list_agents.execute({})).content[0].text);
  assert.ok(agents.agents.some((a) => a.id === "griffin"));

  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("an allTools agent switches single tools off via meta.disabled", () => {
  const { store, dir } = tempStore();
  store.disableAgentTools("platform", ["visualize"]);
  let profile = store.getAgentProfile("platform");
  assert.ok(profile.meta.disabled.includes("visualize"));
  const catalog = ["visualize", "ask_owner", "kube_get", "arvan_domains", ...SELF_MGMT_TOOLS];
  let enabled = resolveEnabledTools(profile, { caller: "owner", catalogNames: catalog });
  assert.ok(!enabled.includes("visualize"));
  assert.ok(enabled.includes("ask_owner"));
  assert.ok(enabled.includes("kube_get"));
  assert.ok(enabled.includes("arvan_domains"), "allTools means every tool the install has");

  store.enableAgentTools("platform", ["visualize"]);
  profile = store.getAgentProfile("platform");
  assert.ok(!profile.meta.disabled.includes("visualize"));
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("ask_agent uses target profile provider/model; unknown id refused", async () => {
  const { store, dir } = tempStore();
  store.updateAgentProfile("arvan-ban", { provider: "claude", model: "sonnet" });
  const parent = store.createChat({ title: "root", agent: "griffin", caller: "owner" });
  let childId = null;
  const runner = {
    async send(chatId) {
      childId = chatId;
      const runId = store.startRun(chatId);
      store.appendEvent(chatId, runId, "text", { text: "ok" });
      store.appendEvent(chatId, runId, "run.finished", { status: "finished" });
      store.finishRun(chatId, runId, "finished", null);
      return { runId };
    },
    cancel: async () => ({ status: "ok" }),
  };
  const peers = createPeers({ store, runner, timeoutMs: 5000 });
  const tool = peers.tool(parent.id);

  const bad = await tool.execute({ agent: "no-such-agent", request: "hi" });
  assert.equal(bad.isError, true);
  assert.match(bad.content[0].text, /list_agents/);

  const ok = await tool.execute({ agent: "arvan-ban", request: "دامنه‌ها" });
  assert.ok(!ok.isError);
  const child = store.getChat(childId);
  assert.equal(child.agent, "arvan-ban");
  assert.equal(child.provider, "claude");
  assert.equal(child.model, "sonnet");
  assert.equal(child.caller, "griffin");
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("installRules lists live peers from profiles", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "griffin-rules-peers-"));
  const peers = [
    { id: "arvan-ban", label: "آروان‌بان", domain: "CDN" },
    { id: "nsin-ban", label: "انسین‌بان", domain: "NSIN" },
  ];
  const file = installRules(dir, { agent: "griffin", caller: "owner", peers });
  const text = fs.readFileSync(file, "utf8");
  assert.ok(text.startsWith(CORE_RULES));
  assert.match(text, /Live peers/);
  assert.match(text, /`arvan-ban`/);
  assert.match(text, /list_agents/);
  assert.doesNotMatch(CORE_RULES, /kube|gitlab|cluster/i, "the core rules know no infrastructure");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("owner tools include ask_agent for every agent", () => {
  const { store, dir } = tempStore();
  for (const id of ["platform", "arvan-ban", "nsin-ban", "griffin"]) {
    const profile = store.getAgentProfile(id);
    const enabled = resolveEnabledTools(profile, {
      caller: "owner",
      catalogNames: [ASK_AGENT_TOOL, "ask_owner", "kube_get", ...SELF_MGMT_TOOLS],
    });
    assert.ok(enabled.includes(ASK_AGENT_TOOL), id);
  }
  assert.ok(store.getAgentProfile("arvan-ban").tools.includes(ASK_AGENT_TOOL));
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
