import test from "node:test";
import assert from "node:assert/strict";
import { accountFromStatus, createClaudeProvider, withCliModels } from "../src/providers/claude.mjs";

// Earlier Claude models must be in the menu, and the signed-in account's email and plan shown.

test("the menu keeps the aliases first and adds every other model Claude Code lists", () => {
  const base = [{ id: "opus" }, { id: "sonnet" }, { id: "haiku" }];
  const list = [
    { value: "default", displayName: "Default" },
    { value: "opus", displayName: "Opus" },
    { value: "claude-opus-4-1", displayName: "Opus 4.1", description: "older" },
    { value: "sonnet[1m]", displayName: "Sonnet 1M" },
    { value: "claude-sonnet-5", displayName: "Sonnet 5" },
    { value: "claude-sonnet-5", displayName: "dup" },
  ];
  const menu = withCliModels(base, [...list, { value: "claude-fable-5-1[1m]", displayName: "Fable" }]);
  assert.deepEqual(menu.map((m) => m.id), ["opus", "fable", "sonnet", "haiku", "claude-opus-4-1", "claude-sonnet-5"], "Fable joins as its alias, in Karsara's order");
  assert.equal(menu[1].more, undefined);
  assert.equal(menu[4].more, true);
  assert.equal(menu[4].name, "Opus 4.1");
  assert.equal(menu[4].description, "older");
  assert.equal(withCliModels([...base, { id: "fable" }], [{ value: "claude-fable-5-1[1m]" }]).filter((m) => m.id === "fable").length, 1, "no second Fable");
});

test("listModels asks Claude Code once, and falls back to the aliases when it does not answer", async () => {
  let asked = 0;
  const queryImpl = () => {
    asked += 1;
    return { supportedModels: async () => [{ value: "claude-opus-4-1", displayName: "Opus 4.1" }] };
  };
  const p = createClaudeProvider({ apiKey: ["sk-ant-oat", "01-x"].join(""), queryImpl });
  const first = await p.listModels();
  assert.ok(first.some((m) => m.id === "claude-opus-4-1" && m.provider === "claude"));
  await p.listModels();
  assert.equal(asked, 1, "cached");
  const silent = createClaudeProvider({ apiKey: ["sk-ant-oat", "01-x"].join(""), queryImpl: () => ({ supportedModels: () => new Promise(() => {}) }) });
  const aliases = await silent.listModels({ waitMs: 20 });
  assert.deepEqual(aliases.map((m) => m.id).slice(0, 3), ["opus", "sonnet", "haiku"]);
  assert.ok(!aliases.some((m) => m.more));
});

test("account: email and plan from a full login, nothing to name for a setup-token, none for an API key", async () => {
  assert.deepEqual(accountFromStatus(JSON.stringify({ loggedIn: true, email: "a@b.c", subscriptionType: "max", authMethod: "claude.ai" })), { email: "a@b.c", name: null, plan: "max", method: "claude.ai" });
  assert.deepEqual(accountFromStatus({ loggedIn: true, authMethod: "oauth_token" }), { email: null, name: null, plan: null, method: "oauth_token" });
  assert.equal(accountFromStatus({ loggedIn: false }), null);
  assert.equal(accountFromStatus("not json"), null);
  let calls = 0;
  const statusImpl = async () => {
    calls += 1;
    return JSON.stringify({ loggedIn: true, email: "a@b.c" });
  };
  const p = createClaudeProvider({ apiKey: ["sk-ant-oat", "01-x"].join(""), statusImpl });
  assert.equal((await p.account()).email, "a@b.c");
  await p.account();
  assert.equal(calls, 1, "cached");
  const api = createClaudeProvider({ apiKey: ["sk-ant-api", "03-x"].join(""), statusImpl });
  assert.equal(await api.account(), null);
});
