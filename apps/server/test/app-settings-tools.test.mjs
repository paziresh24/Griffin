import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createAppSettingsTools, APP_SETTINGS_TOOLS } from "../src/app-settings-tools.mjs";
import { createAgentSettingsTools } from "../src/agents/settings-tools.mjs";

function makeStore() {
  const kv = new Map();
  const profiles = new Map([
    ["griffin", { id: "griffin", label: "آیریس", domain: "مادر", blurb: "", provider: "claude", model: null, tools: ["list_agents"], meta: { allPlatform: true } }],
    ["custom-1", { id: "custom-1", label: "نویسنده", domain: "گزارش", blurb: "", provider: "claude", model: null, tools: ["list_agents"], meta: { custom: true, instructions: "قدیمی" } }],
  ]);
  const chats = new Map([["chat-1", { id: "chat-1", agent: "griffin" }]]);
  return {
    bus: new EventEmitter(),
    getKv: (k) => kv.get(k) ?? null,
    setKv: (k, v) => kv.set(k, v),
    deleteKv: (k) => kv.delete(k),
    getChat: (id) => chats.get(id) || null,
    getAgentProfile: (id) => profiles.get(id) || null,
    listAgentProfiles: () => [...profiles.values()],
    updateAgentProfile: (id, patch) => {
      const cur = profiles.get(id);
      const next = { ...cur, ...patch, meta: patch.meta ? { ...cur.meta, ...patch.meta } : cur.meta };
      profiles.set(id, next);
      return next;
    },
    enableAgentTools: (id, list) => {
      const cur = profiles.get(id);
      const next = { ...cur, tools: [...new Set([...cur.tools, ...list])] };
      profiles.set(id, next);
      return next;
    },
    disableAgentTools: (id, list) => {
      const cur = profiles.get(id);
      const next = { ...cur, tools: cur.tools.filter((t) => !list.includes(t)) };
      profiles.set(id, next);
      return next;
    },
    deleteAgentProfile: (id) => profiles.delete(id),
  };
}

test("app_settings_get and app_settings_set update look, flags, ownerName, assistantName, config and emit prefs", async () => {
  const store = makeStore();
  const emitted = [];
  store.bus.on("prefs", (p) => emitted.push(p));
  const cfgState = { ENTER_KEY: "send", AUTO_CONTINUE: "1" };
  const config = {
    view: () => [
      { key: "ENTER_KEY", value: cfgState.ENTER_KEY, default: "send", kind: "choice", options: ["send", "newline"], restart: false },
      { key: "AUTO_CONTINUE", value: cfgState.AUTO_CONTINUE, default: "1", kind: "bool", restart: false },
    ],
    set: (patch) => {
      for (const [k, v] of Object.entries(patch)) {
        if (!(k in cfgState)) throw new Error(`unknown key ${k}`);
        cfgState[k] = String(v);
      }
      return { restart: [] };
    },
  };
  const tools = createAppSettingsTools({ store, config, skin: "griffin" });
  assert.deepEqual(Object.keys(tools).sort(), [...APP_SETTINGS_TOOLS].sort());

  const before = JSON.parse((await tools.app_settings_get.execute({})).content[0].text);
  assert.equal(before.appearance.look, "griffin");
  assert.equal(before.profile.assistantName, "آیریس");

  const setRes = await tools.app_settings_set.execute({
    look: "karsara",
    navStyle: "rail",
    ownerName: "عرفان",
    config: { ENTER_KEY: "newline" },
  });
  assert.ok(!setRes.isError);
  const parsed = JSON.parse(setRes.content[0].text);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.current.look, "karsara");
  assert.equal(parsed.current.navStyle, "rail");
  assert.equal(parsed.current.ownerName, "عرفان");
  assert.equal(cfgState.ENTER_KEY, "newline");
  assert.ok(emitted.length >= 1);

  const badFlag = await tools.app_settings_set.execute({ flags: { bogusFlag: true } });
  assert.equal(badFlag.isError, true);
});

test("engine_list and engine_manage support add, update, set_default, test, signin, and confirmed remove", async () => {
  const store = makeStore();
  const emitted = [];
  store.bus.on("prefs", (p) => emitted.push(p));
  const engines = [{ id: "claude", kind: "claude", label: "کلاد ۱", enabled: true, isDefault: true, state: "ok" }];
  const confirmCalls = [];
  let allowConfirm = false;

  const tools = createAppSettingsTools({
    store,
    confirm: async (chatId, q) => {
      confirmCalls.push({ chatId, q });
      return { answered: true, answer: allowConfirm ? "بله، حذف کن" : "لغو" };
    },
    providersApi: {
      list: async () => ({ providers: engines, defaultEngine: engines.find((e) => e.isDefault)?.id || null }),
      add: async ({ kind, label }) => {
        const id = `${kind}-${engines.length + 1}`;
        engines.push({ id, kind, label: label || id, enabled: true, isDefault: false, state: "no_key" });
        return { id, kind, label: label || id };
      },
      update: async (id, patch) => {
        const e = engines.find((x) => x.id === id);
        if (!e) throw new Error("unknown");
        Object.assign(e, patch);
        return { ok: true };
      },
      setDefault: async (id) => {
        for (const e of engines) e.isDefault = e.id === id;
        return { defaultEngine: id };
      },
      clearLimit: async () => ({ cleared: true }),
      test: async (id) => ({ ok: true, id }),
      startSignin: async (id) => ({ url: `https://claude.ai/oauth?acct=${id}` }),
      setGlobal: async () => {},
      remove: async (id) => {
        const idx = engines.findIndex((x) => x.id === id);
        if (idx >= 0) engines.splice(idx, 1);
        return { ok: true };
      },
    },
  });

  const added = JSON.parse((await tools.engine_manage.execute({ action: "add", kind: "claude", label: "کلاد ۲" })).content[0].text);
  assert.equal(added.ok, true);
  assert.equal(added.id, "claude-2");

  await tools.engine_manage.execute({ action: "update", id: "claude-2", label: "اکانت دوم" });
  assert.equal(engines.find((e) => e.id === "claude-2").label, "اکانت دوم");

  await tools.engine_manage.execute({ action: "set_default", id: "claude-2" });
  assert.equal(engines.find((e) => e.id === "claude-2").isDefault, true);

  // Refused remove keeps engine
  const denied = JSON.parse((await tools.engine_manage.execute({ action: "remove", id: "claude-2" }, { chatId: "chat-1" })).content[0].text);
  assert.equal(denied.cancelled, true);
  assert.equal(engines.length, 2);

  // Approved remove deletes engine
  allowConfirm = true;
  const removed = JSON.parse((await tools.engine_manage.execute({ action: "remove", id: "claude-2" }, { chatId: "chat-1" })).content[0].text);
  assert.equal(removed.ok, true);
  assert.equal(engines.length, 1);
  assert.equal(confirmCalls.length, 2);
  assert.ok(emitted.some((e) => e.kind === "providers"));
});

test("connection_list and connection_manage resolve bot token from secret store and require confirmation on remove", async () => {
  const store = makeStore();
  const list = [{ id: "tg-1", kind: "telegram_bot", name: "بات تست", enabled: true, status: "running" }];
  let proxyUrl = "http://user:pass@10.0.0.1:8080";
  const secrets = new Map([["bale-token", "12345:SECRET"]]);
  let receivedToken = null;

  const tools = createAppSettingsTools({
    store,
    secrets: { get: (k) => secrets.get(k) || null },
    confirm: async () => ({ answered: true, answer: "بله، حذف کن" }),
    integrationsApi: {
      list: () => list,
      add: async ({ kind, name, token }) => {
        receivedToken = token;
        const item = { id: "bale-1", kind, name, enabled: true, status: "running" };
        list.push(item);
        return item;
      },
      update: async (id, patch) => {
        const item = list.find((x) => x.id === id);
        Object.assign(item, patch);
        return item;
      },
      restart: async () => {},
      remove: async (id) => {
        const i = list.findIndex((x) => x.id === id);
        if (i >= 0) list.splice(i, 1);
      },
    },
    proxyApi: {
      get: () => ({ url: proxyUrl, fromEnv: false }),
      set: async (u) => { proxyUrl = u; },
      test: async () => ({ direct: { ok: false }, viaProxy: { ok: true } }),
    },
  });

  const listed = JSON.parse((await tools.connection_list.execute({})).content[0].text);
  assert.equal(listed.integrations.length, 1);
  assert.ok(!listed.proxy.url.includes("pass"), "proxy password must be masked");

  const added = JSON.parse((await tools.connection_manage.execute({ action: "add_bot", kind: "bale_bot", name: "بله", secretName: "bale-token" })).content[0].text);
  assert.equal(added.ok, true);
  assert.equal(receivedToken, "12345:SECRET");
  assert.ok(!JSON.stringify(added).includes("SECRET"), "bot token must never appear in tool result");

  await tools.connection_manage.execute({ action: "update", id: "tg-1", name: "بات اصلی", enabled: false });
  assert.equal(list.find((x) => x.id === "tg-1").name, "بات اصلی");
  assert.equal(list.find((x) => x.id === "tg-1").enabled, false);

  await tools.connection_manage.execute({ action: "remove", id: "bale-1" }, { chatId: "chat-1" });
  assert.equal(list.length, 1);
});

test("agent_settings_* and agent_tools_* can inspect and edit OTHER agents in owner chats", async () => {
  const store = makeStore();
  let ownerClean = true;
  const tools = createAgentSettingsTools({
    store,
    catalogNames: () => ["list_agents", "web_search", "agent_create"],
    mayRename: () => ownerClean,
  });

  const got = JSON.parse((await tools.agent_settings_get.execute({ agent: "custom-1" }, { chatId: "chat-1" })).content[0].text);
  assert.equal(got.id, "custom-1");
  assert.equal(got.instructions, "قدیمی");

  const upd = JSON.parse((await tools.agent_settings_set.execute({
    agent: "custom-1",
    label: "گزارش‌نویس",
    instructions: "فقط فارسی بنویس",
  }, { chatId: "chat-1" })).content[0].text);
  assert.equal(upd.label, "گزارش‌نویس");
  assert.equal(upd.instructions, "فقط فارسی بنویس");

  const en = await tools.agent_tools_enable.execute({ agent: "custom-1", tools: ["web_search"] }, { chatId: "chat-1" });
  assert.ok(!en.isError);
  assert.ok(store.getAgentProfile("custom-1").tools.includes("web_search"));

  // Custom agent cannot receive self-management tools
  const blocked = await tools.agent_tools_enable.execute({ agent: "custom-1", tools: ["agent_create"] }, { chatId: "chat-1" });
  assert.equal(blocked.isError, true);

  // Third-party chat cannot edit another agent
  ownerClean = false;
  const refused = await tools.agent_settings_set.execute({ agent: "custom-1", label: "هک" }, { chatId: "chat-1" });
  assert.equal(refused.isError, true);
});
