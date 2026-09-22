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
import { installRules, GRIFFIN_RULES } from "../src/prompt.mjs";

function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "griffin-profiles-"));
  const store = openStore(path.join(dir, "t.sqlite"));
  return { store, dir };
}

test("seed creates four built-in agent profiles from registry", () => {
  const { store, dir } = tempStore();
  const list = store.listAgentProfiles();
  assert.equal(list.length, 4);
  const ids = list.map((p) => p.id).sort();
  assert.deepEqual(ids, ["arvan-ban", "griffin", "nsin-ban", "platform"]);
  const griffin = store.getAgentProfile("griffin");
  assert.equal(griffin.provider, "cursor");
  assert.equal(griffin.meta.allPlatform, undefined);
  assert.ok(griffin.tools.includes("ask_agent"));
  assert.ok(griffin.tools.includes("telegram_dialogs"));
  for (const name of SELF_MGMT_TOOLS) {
    assert.ok(griffin.tools.includes(name), name);
  }
  assert.equal(store.getAgentProfile("platform").meta.allPlatform, true);
  assert.ok(store.getAgentProfile("platform").meta.callers.scheduler);
  assert.equal(store.seedAgentProfiles(), 0, "second seed is a no-op");
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("seedProfilesFromRegistry matches openStore seed shape", () => {
  const rows = seedProfilesFromRegistry();
  assert.equal(rows.length, 4);
  assert.ok(rows.every((r) => r.builtIn && r.provider === "cursor"));
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
  const profile = store.getAgentProfile("platform"); // allPlatform, huge domain
  const catalog = [
    "kube_get", "kube_status", "kube_secret", "pg_query", "debug_exec", "s3_get",
    "telegram_send", "ask_owner", ...SELF_MGMT_TOOLS,
  ];
  // arvan-ban calling platform gets exactly its quota (read-only), not the whole platform.
  const asPeer = resolveEnabledTools(profile, { caller: "arvan-ban", catalogNames: catalog });
  assert.deepEqual(asPeer.sort(), ["kube_get", "kube_status"]);
  for (const dangerous of ["kube_secret", "pg_query", "debug_exec", "s3_get", "telegram_send"]) {
    assert.ok(!asPeer.includes(dangerous), dangerous);
  }
  // The self-management tools (which mutate RBAC) never reach a peer-invoked run.
  for (const name of SELF_MGMT_TOOLS) assert.ok(!asPeer.includes(name), name);
  // A caller with no quota row on this profile fails closed.
  assert.deepEqual(resolveEnabledTools(profile, { caller: "no-such-agent", catalogNames: catalog }), []);
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

test("platform allPlatform disable/enable via meta.disabled", () => {
  const { store, dir } = tempStore();
  store.disableAgentTools("platform", ["visualize"]);
  let profile = store.getAgentProfile("platform");
  assert.ok(profile.meta.disabled.includes("visualize"));
  const catalog = ["visualize", "ask_owner", "kube_get", "arvan_domains", ...SELF_MGMT_TOOLS];
  let enabled = resolveEnabledTools(profile, { caller: "owner", catalogNames: catalog });
  assert.ok(!enabled.includes("visualize"));
  assert.ok(enabled.includes("ask_owner"));
  assert.ok(enabled.includes("kube_get"));
  assert.ok(!enabled.includes("arvan_domains"), "specialist CDN stays out of platform allPlatform");

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
  assert.ok(text.startsWith(GRIFFIN_RULES));
  assert.match(text, /Live peers/);
  assert.match(text, /`arvan-ban`/);
  assert.match(text, /list_agents/);
  assert.match(GRIFFIN_RULES, /list_agents/);
  assert.doesNotMatch(GRIFFIN_RULES, /برو arvan-ban/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("seed owner tools include ask_agent for specialists and griffin", () => {
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
