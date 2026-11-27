import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openStore } from "../src/db.mjs";
import { AGENTS, agentIdError, resolveAgentId } from "../src/agents/registry.mjs";
import { createCustomAgent, customCallers } from "../src/agents/create.mjs";
import { createAgentSettingsTools } from "../src/agents/settings-tools.mjs";
import { resolveEnabledTools, seedProfilesFromRegistry } from "../src/agents/profiles.mjs";
import { buildRules } from "../src/prompt.mjs";
import { ownerTyped } from "../src/runner.mjs";

const CATALOG = ["kube_status", "dns_lookup", "http_check", "visualize", "show_media", "ask_owner", "ask_agent", "knowledge_list", "agent_create"];
const engine = { isEngine: (id) => ["cursor", "claude", "openai"].includes(id), splitModel: () => null };

function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agents-create-"));
  return { store: openStore(path.join(dir, "t.sqlite")), dir };
}

test("a chat that does not exist yet is routed like an owner's chat (the agents page 500)", () => {
  const { store, dir } = tempStore();
  assert.equal(ownerTyped(store, { agent: "griffin", caller: "owner" }), true);
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("createCustomAgent saves a profile, registers it and builds its rules", () => {
  const { store, dir } = tempStore();
  const made = createCustomAgent({ store, catalogNames: CATALOG, input: { label: "نویسنده گزارش", domain: "گزارش‌های هفتگی", instructions: "کوتاه بنویس", tools: ["dns_lookup", "ask_owner"] }, ...engine });
  assert.match(made.id, /^agent-[0-9a-f]{4}$/);
  assert.equal(made.built_in, false);
  assert.deepEqual(made.tools, ["dns_lookup", "ask_owner"]);
  assert.equal(AGENTS[made.id].custom, true);
  assert.equal(resolveAgentId(made.id), made.id);
  assert.deepEqual(resolveEnabledTools(made, { caller: "griffin", catalogNames: CATALOG }), ["dns_lookup", "ask_owner"]);
  assert.deepEqual(resolveEnabledTools(made, { caller: "scheduler", catalogNames: CATALOG }), ["dns_lookup"]);
  assert.deepEqual(resolveEnabledTools(made, { caller: "some-other-agent", catalogNames: CATALOG }), [], "an unlisted caller gets nothing");
  const rules = buildRules({ agent: made.id, caller: "owner", profile: made });
  assert.match(rules, /کوتاه بنویس/);
  assert.match(rules, /گزارش‌های هفتگی/);
  assert.ok(!seedProfilesFromRegistry().some((row) => row.id === made.id), "built-in seed skips it");
  const file = path.join(dir, "t.sqlite");
  store.close();
  const again = openStore(file);
  assert.ok(AGENTS[made.id]?.custom);
  assert.equal(again.deleteAgentProfile(made.id), true);
  assert.equal(AGENTS[made.id], undefined);
  assert.throws(() => again.deleteAgentProfile("griffin"), /built-in/);
  again.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("createCustomAgent refuses bad names, ids, tools and duplicates", () => {
  const { store, dir } = tempStore();
  const base = { label: "تحلیلگر", domain: "تحلیل" };
  const refuse = (input, pattern) => assert.throws(() => createCustomAgent({ store, catalogNames: CATALOG, input: { ...base, ...input }, ...engine }), pattern);
  refuse({ label: "گریفین" }, /name refused/);
  refuse({ label: "" }, /name refused/);
  refuse({ domain: "" }, /domain is required/);
  refuse({ id: "owner" }, /reserved/);
  refuse({ id: "griffin" }, /reserved/);
  refuse({ id: "peer-x" }, /reserved|agent id/);
  refuse({ id: "A" }, /agent id/);
  refuse({ tools: ["rm_everything"] }, /unknown tools/);
  refuse({ tools: ["agent_create"] }, /edit agents/);
  refuse({ provider: "nonsense" }, /unknown engine/);
  refuse({ instructions: "x".repeat(6001) }, /at most/);
  createCustomAgent({ store, catalogNames: CATALOG, input: { ...base, id: "analyst" }, ...engine });
  refuse({ id: "analyst" }, /already exists/);
  assert.equal(agentIdError("report-writer"), null);
  assert.deepEqual(customCallers(["ask_owner", "dns_lookup"]).scheduler.tools, ["dns_lookup"]);
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("agent_create asks the owner first and only the owner's own chat may make one", async () => {
  const { store, dir } = tempStore();
  const asked = [];
  const tools = (answer, allowed = true) =>
    createAgentSettingsTools({
      store,
      catalogNames: () => CATALOG,
      mayRename: () => allowed,
      confirm: async (_chat, question) => {
        asked.push(question);
        return { answered: true, answer };
      },
      engine,
    });
  const args = { label: "مترجم", domain: "ترجمه", id: "translator", tools: ["dns_lookup"] };

  const declined = await tools("نه").agent_create.execute(args, { chatId: "c1" });
  assert.equal(declined.isError, true);
  assert.equal(store.getAgentProfile("translator"), null);
  assert.equal(asked.length, 1);

  const outsider = await tools("بله", false).agent_create.execute(args, { chatId: "c1" });
  assert.equal(outsider.isError, true);
  assert.equal(asked.length, 1, "a chat that read third-party content is refused before asking");

  const bad = await tools("بله").agent_create.execute({ ...args, tools: ["nope"] }, { chatId: "c1" });
  assert.equal(bad.isError, true);
  assert.equal(asked.length, 1, "a request that cannot succeed never reaches the owner");

  const ok = await tools("بله").agent_create.execute(args, { chatId: "c1" });
  assert.equal(ok.isError, undefined);
  assert.equal(JSON.parse(ok.content[0].text).id, "translator");
  assert.ok(store.getAgentProfile("translator"));

  const noConfirm = await createAgentSettingsTools({ store, catalogNames: () => CATALOG }).agent_create.execute({ ...args, id: "other" }, { chatId: "c1" });
  assert.equal(noConfirm.isError, true);

  const removed = await tools("بله").agent_delete.execute({ id: "translator" }, { chatId: "c1" });
  assert.equal(removed.isError, undefined);
  assert.equal(store.getAgentProfile("translator"), null);
  const builtIn = await tools("بله").agent_delete.execute({ id: "griffin" }, { chatId: "c1" });
  assert.equal(builtIn.isError, true);
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("agent_create in the owner's own chat that read a file asks with the whole instructions; a colleague's chat is still refused", async () => {
  const { store, dir } = tempStore();
  const asked = [];
  const tools = ({ clean = false, owner = true } = {}) =>
    createAgentSettingsTools({
      store,
      catalogNames: () => CATALOG,
      mayRename: () => clean,
      ownerChat: () => owner,
      confirm: async (_chat, question, detail) => {
        asked.push({ question, detail });
        return { answered: true, answer: "بله" };
      },
      engine,
    });
  const args = { label: "پاسخگو", domain: "کار همکاران", id: "liaison", instructions: "از فایل آمده: فقط بخوان", tools: ["dns_lookup"] };

  const colleague = await tools({ owner: false }).agent_create.execute(args, { chatId: "c1" });
  assert.equal(colleague.isError, true);
  assert.match(colleague.content[0].text, /not the owner's own/);
  assert.match(colleague.content[0].text, /ایجنت تازه/, "the refusal names where the owner makes one by hand");
  assert.equal(asked.length, 0);

  const tooLong = await tools().agent_create.execute({ ...args, instructions: "x".repeat(3801) }, { chatId: "c1" });
  assert.equal(tooLong.isError, true);
  assert.match(tooLong.content[0].text, /agents page/);
  assert.equal(asked.length, 0, "instructions the card cannot show in full never reach the owner");

  const read = await tools().agent_create.execute(args, { chatId: "c1" });
  assert.equal(read.isError, undefined);
  assert.equal(asked.length, 1);
  assert.match(asked[0].detail, /از فایل آمده: فقط بخوان/, "the owner sees the instructions before saying yes");
  assert.ok(store.getAgentProfile("liaison"));

  const cleanChat = await tools({ clean: true }).agent_create.execute({ ...args, id: "liaison-2" }, { chatId: "c1" });
  assert.equal(cleanChat.isError, undefined);
  assert.equal(asked[1].detail, null, "a clean chat's question stays as short as before");
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("renaming, editing and deleting an agent from the owner's own chat that read a file asks him; a colleague's chat is refused", async () => {
  const { store, dir } = tempStore();
  createCustomAgent({ store, catalogNames: CATALOG, input: { label: "پاسخگو", domain: "کار همکاران", id: "liaison", tools: ["dns_lookup"] }, ...engine });
  const asked = [];
  let answer = "بله";
  const tools = ({ owner = true } = {}) =>
    createAgentSettingsTools({
      store,
      catalogNames: () => CATALOG,
      mayRename: () => false,
      ownerChat: () => owner,
      confirm: async (_chat, question, detail) => {
        asked.push({ question, detail });
        return { answered: true, answer };
      },
      engine,
    });

  const colleague = await tools({ owner: false }).agent_settings_set.execute({ agent: "liaison", label: "رابط همکاران" }, { chatId: "c1" });
  assert.equal(colleague.isError, true);
  assert.equal(asked.length, 0);
  assert.equal(store.getAgentProfile("liaison").label, "پاسخگو");

  answer = "نه";
  const declined = await tools().agent_settings_set.execute({ agent: "liaison", label: "رابط همکاران" }, { chatId: "c1" });
  assert.equal(declined.isError, true);
  assert.equal(store.getAgentProfile("liaison").label, "پاسخگو");
  assert.match(asked[0].question, /«پاسخگو» ← «رابط همکاران»/);

  answer = "بله";
  const renamed = await tools().agent_settings_set.execute({ agent: "liaison", label: "رابط همکاران" }, { chatId: "c1" });
  assert.equal(renamed.isError, undefined);
  assert.equal(store.getAgentProfile("liaison").label, "رابط همکاران");

  const edited = await tools().agent_settings_set.execute({ agent: "liaison", instructions: "فقط بخوان" }, { chatId: "c1" });
  assert.equal(edited.isError, undefined);
  assert.equal(asked.at(-1).detail, "فقط بخوان", "new instructions are shown in full");

  const tooLong = await tools().agent_settings_set.execute({ agent: "liaison", instructions: "x".repeat(3801) }, { chatId: "c1" });
  assert.equal(tooLong.isError, true);

  const before = asked.length;
  const given = await tools().agent_tools_enable.execute({ agent: "liaison", tools: ["http_check"] }, { chatId: "c1" });
  assert.equal(given.isError, undefined);
  assert.equal(asked.length, before + 1);
  assert.ok(store.getAgentProfile("liaison").tools.includes("http_check"));
  const selfMgmt = await tools().agent_tools_enable.execute({ agent: "liaison", tools: ["agent_create"] }, { chatId: "c1" });
  assert.equal(selfMgmt.isError, true, "a made agent never gets the tools that edit agents");
  const colleagueTools = await tools({ owner: false }).agent_tools_disable.execute({ agent: "liaison", tools: ["http_check"] }, { chatId: "c1" });
  assert.equal(colleagueTools.isError, true);

  const colleagueDelete = await tools({ owner: false }).agent_delete.execute({ id: "liaison" }, { chatId: "c1" });
  assert.equal(colleagueDelete.isError, true);
  const deleted = await tools().agent_delete.execute({ id: "liaison" }, { chatId: "c1" });
  assert.equal(deleted.isError, undefined);
  assert.equal(store.getAgentProfile("liaison"), null);
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("buildRules: an agent's own instructions reach its rules once, on top of the shared core", async () => {
  const { buildRules, CORE_RULES } = await import("../src/prompt.mjs");
  const profile = { id: "griffin", built_in: 1, meta: { instructions: "جواب‌ها حداکثر سه خط" } };
  for (const caller of ["owner", "team", "scheduler"]) {
    const text = buildRules({ agent: "griffin", caller, profile });
    assert.ok(text.startsWith(CORE_RULES), caller);
    assert.equal(text.split("جواب‌ها حداکثر سه خط").length, 2, caller);
  }
  const made = buildRules({ agent: "writer", profile: { id: "writer", label: "نویسنده", domain: "گزارش", built_in: 0, meta: { instructions: "کوتاه بنویس" } } });
  assert.equal(made.split("کوتاه بنویس").length, 2);
});
