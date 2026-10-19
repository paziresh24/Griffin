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
