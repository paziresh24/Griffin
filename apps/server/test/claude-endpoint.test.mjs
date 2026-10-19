import test from "node:test";
import assert from "node:assert/strict";
import { createClaudeProvider } from "../src/providers/claude.mjs";
import { createProviders, setAccounts } from "../src/providers/index.mjs";
import { CLAUDE_ENDPOINTS, endpointOf, endpointModel, endpointSettings } from "../src/providers/claude-endpoint.mjs";
import { splitModel, kindOf } from "../src/providers/ids.mjs";

// GLM (Z.ai) inside Claude Code: a claude-* account whose settings name an
// endpoint runs the same Claude Code — Bash, skills, hooks, MCP — with only the env of its query()
// changed. A fake Claude Code records the options it was started with and answers with `answer`.
const ZAI = CLAUDE_ENDPOINTS.find((e) => e.id === "zai");
function fakeClaude(answer = { subtype: "success", is_error: false, result: "ok" }) {
  const calls = [];
  const queryImpl = ({ prompt, options }) => {
    calls.push(options);
    const id = options.resume || options.sessionId;
    return (async function* () {
      for await (const _ of prompt) break;
      yield { type: "system", subtype: "init", session_id: id, mcp_servers: [] };
      yield { type: "result", session_id: id, ...answer };
    })();
  };
  return { queryImpl, calls };
}

async function runOnce(provider, sendOptions = {}, createOptions = { cwd: "/tmp" }) {
  const agent = provider.create(createOptions);
  return (await agent.send("سلام", sendOptions)).wait();
}

test("an endpoint account runs Claude Code on Z.ai: base URL, its key, every model slot, no Anthropic login", async () => {
  const saved = { ...process.env };
  // A host env with an Anthropic login and a stale override must not leak into the GLM run.
  Object.assign(process.env, { ANTHROPIC_API_KEY: "sk-ant-host", CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-host", ANTHROPIC_DEFAULT_MYTHOS_MODEL: "claude-mythos-5-1", ANTHROPIC_CUSTOM_HEADERS: "x-api-key: sk-ant-host", CLAUDE_CODE_USE_BEDROCK: "1" });
  try {
    const fake = fakeClaude();
    const provider = createClaudeProvider({ apiKey: "zai-test-key", defaultModel: "", endpoint: ZAI, queryImpl: fake.queryImpl });
    assert.equal((await runOnce(provider, { model: { id: "GLM-5.3" }, effort: "high", fast: true, onSuggestion: () => {} }, { cwd: "/tmp", fileAccess: { read: ["/"], write: ["/"], deny: [] }, claudeCode: true })).status, "finished");
    const o = fake.calls[0];
    assert.equal(o.model, "GLM-5.3");
    assert.equal(o.env.ANTHROPIC_BASE_URL, "https://api.z.ai/api/anthropic");
    assert.equal(o.env.ANTHROPIC_AUTH_TOKEN, "zai-test-key");
    assert.equal(o.env.ANTHROPIC_API_KEY, undefined);
    assert.equal(o.env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
    assert.equal(o.env.ANTHROPIC_DEFAULT_MYTHOS_MODEL, undefined);
    assert.equal(o.env.ANTHROPIC_CUSTOM_HEADERS, undefined);
    assert.equal(o.env.CLAUDE_CODE_USE_BEDROCK, undefined);
    for (const slot of ["ANTHROPIC_MODEL", "ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL", "ANTHROPIC_DEFAULT_FABLE_MODEL", "CLAUDE_CODE_SUBAGENT_MODEL"]) assert.equal(o.env[slot], "GLM-5.3", slot);
    assert.equal(o.env.ANTHROPIC_DEFAULT_HAIKU_MODEL, "GLM-5.3-Flash");
    assert.equal(o.env.ANTHROPIC_SMALL_FAST_MODEL, "GLM-5.3-Flash");
    assert.equal(o.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, "200000");
    // Claude-only extras stay off; the full harness stays on (Bash not taken away).
    assert.equal(o.effort, undefined);
    assert.equal(o.promptSuggestions, undefined);
    assert.equal(o.settings, undefined);
    assert.equal(o.disallowedTools, undefined);
    assert.deepEqual(o.settingSources, ["user", "project", "local"]);
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});

test("a Claude alias or no model on an endpoint account means its default model, never a Claude id", async () => {
  assert.equal(endpointModel(ZAI, "opus"), "GLM-5.3-Flash");
  assert.equal(endpointModel(ZAI, "claude-sonnet-5-5[1m]"), "GLM-5.3-Flash");
  assert.equal(endpointModel(ZAI, ""), "GLM-5.3-Flash");
  assert.equal(endpointModel(ZAI, "auto"), "GLM-5.3-Flash");
  assert.equal(endpointModel(ZAI, "GLM-5.3"), "GLM-5.3");
  const fake = fakeClaude();
  await runOnce(createClaudeProvider({ apiKey: "k", defaultModel: "sonnet", endpoint: ZAI, queryImpl: fake.queryImpl }), { model: { id: "opus" } });
  assert.equal(fake.calls[0].model, "GLM-5.3-Flash");
  assert.equal(fake.calls[0].env.ANTHROPIC_MODEL, "GLM-5.3-Flash");
});

test("a plain Claude account is unchanged: its own login, no endpoint, Claude ids", async () => {
  const fake = fakeClaude();
  const provider = createClaudeProvider({ apiKey: "sk-ant-api-test", queryImpl: fake.queryImpl });
  await runOnce(provider, { model: { id: "opus" }, effort: "high" });
  const o = fake.calls[0];
  assert.equal(o.model, "claude-opus-5-5");
  assert.equal(o.effort, "high");
  assert.equal(o.env.ANTHROPIC_API_KEY, "sk-ant-api-test");
  assert.notEqual(o.env.ANTHROPIC_BASE_URL, "https://api.z.ai/api/anthropic");
  assert.equal(o.env.ANTHROPIC_MODEL, process.env.ANTHROPIC_MODEL);
  assert.deepEqual((await provider.listModels()).map((m) => m.id), ["opus", "sonnet", "haiku"]);
  assert.ok(!provider.endpoint);
});

test("Z.ai's spent plan (1308, 1310) is a plan limit with its reset time, so ask mode asks; a plain rate limit is not", async () => {
  const end = async (result) => {
    const fake = fakeClaude({ subtype: "success", is_error: true, result });
    return runOnce(createClaudeProvider({ apiKey: "k", endpoint: ZAI, queryImpl: fake.queryImpl }));
  };
  const spent = await end('API Error: 429 {"type":"error","error":{"type":"1308","message":"Usage limit reached for 5 hour. Your limit will reset at 2026-10-15 18:00:00"}}');
  assert.equal(spent.status, "error");
  assert.equal(spent.error.code, "plan_limit");
  assert.equal(spent.error.autoFallback, true);
  assert.equal(spent.error.resetsAt, Date.parse("2026-10-15T18:00:00+08:00"));
  const weekly = await end('API Error: 429 {"error":{"code":"1310","message":"Weekly/Monthly Limit Exhausted. Your limit will reset at 2026-10-20 09:00:00"}}');
  assert.equal(weekly.error.code, "plan_limit");
  const busy = await end('API Error: 429 {"error":{"code":"1302","message":"Rate limit reached for requests"}}');
  assert.notEqual(busy.error?.code, "plan_limit");
});

test("models, plan windows and health of an endpoint account come from Z.ai with its key", async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, auth: init.headers.authorization });
    return { ok: true, status: 200, json: async () => ({ data: { limits: [{ unit: 3, number: 5, currentValue: 10, usage: 100, remaining: 90, percentage: 10, nextResetTime: 1760536800000 }, { unit: 6, number: 1, percentage: 40 }] } }) };
  };
  const provider = createClaudeProvider({ apiKey: "zai-test-key", endpoint: ZAI, fetchImpl, queryImpl: fakeClaude().queryImpl });
  assert.deepEqual((await provider.listModels()).map((m) => m.id), ["GLM-5.3-Flash", "GLM-5.3"]);
  assert.equal(provider.defaultModel, "GLM-5.3-Flash");
  const usage = await provider.usage();
  assert.deepEqual(usage.windows.map((w) => [w.label, w.percentage]), [["5 ساعته", 10], ["هفتگی", 40]]);
  assert.equal((await provider.health()).ok, true);
  assert.equal(seen[0].url, "https://api.z.ai/api/monitor/usage/quota/limit");
  assert.equal(seen[0].auth, "Bearer zai-test-key");
  assert.equal((await createClaudeProvider({ apiKey: "", endpoint: ZAI }).health()).ok, false);
});

test("the engine account: kind claude, settings { endpoint: 'zai' }, pinnable as claude-zai:<model>", () => {
  assert.equal(endpointOf({ endpoint: "zai" }), ZAI);
  assert.equal(endpointOf({}), null);
  assert.equal(endpointOf({ endpoint: "nope" }), null);
  setAccounts([{ id: "claude-zai" }]);
  try {
    assert.equal(kindOf("claude-zai"), "claude");
    assert.deepEqual(splitModel("claude-zai:GLM-5.3"), { provider: "claude-zai", model: "GLM-5.3" });
    const providers = createProviders({ accounts: [{ id: "claude", apiKey: "sk-ant-api-test" }, { id: "claude-zai", apiKey: "k", endpoint: ZAI }] });
    assert.equal(providers.claude.endpoint, null);
    assert.equal(providers["claude-zai"].endpoint, ZAI);
    assert.equal(providers["claude-zai"].defaultModel, "GLM-5.3-Flash");
    assert.equal(providers["claude-zai"].kind, "claude");
  } finally {
    setAccounts([]);
  }
});

test("switching an account's endpoint never carries one vendor's stored key to the other", () => {
  // No key stored yet: the endpoint and the preset's key file are set, and cleared together.
  const on = endpointSettings({ model: "GLM-5.3" }, "zai", { hasSecret: false });
  assert.deepEqual(on.next, { model: "GLM-5.3", endpoint: "zai", keyFile: "zai.api-key" });
  assert.deepEqual(endpointSettings(on.next, "", { hasSecret: false }).next, { model: "GLM-5.3" });
  // A key stored for the current vendor (an Anthropic token, or the Z.ai key): the switch is refused.
  assert.match(endpointSettings({}, "zai", { hasSecret: true }).error, /holds a key/);
  assert.match(endpointSettings({ endpoint: "zai" }, "", { hasSecret: true }).error, /holds a key/);
  // The same endpoint again is no switch, whatever is stored.
  assert.deepEqual(endpointSettings({ endpoint: "zai", keyFile: "zai.api-key" }, "zai", { hasSecret: true }).next, { endpoint: "zai", keyFile: "zai.api-key" });
  // Another key file the account had stays when the endpoint goes.
  assert.deepEqual(endpointSettings({ endpoint: "zai", keyFile: "older.api-key" }, "", {}).next, { keyFile: "older.api-key" });
  assert.match(endpointSettings({}, "zai", { base: true }).error, /base Claude account/);
  assert.deepEqual(endpointSettings({}, "", { base: true }).next, {}, "a no-op on the base account is no error");
  assert.match(endpointSettings({}, "nope", {}).error, /unknown endpoint/);
});
