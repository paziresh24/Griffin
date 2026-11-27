import test from "node:test";
import assert from "node:assert/strict";
import { createSubscriptionAuth, parseGrant, pastedCode, codexIdentity } from "../src/subscription-auth.mjs";
import { codexBody, codexTransport, geminiRequest, geminiSchema, antigravityTransport, antigravityCatalog, antigravityQuotaSummary, pickLevel, codexWindows } from "../src/providers/plan-transports.mjs";
import { createOpenAIProvider } from "../src/providers/openai.mjs";

const jwt = (claims) => `h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.s`;
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const memSecrets = () => {
  const m = new Map();
  return { get: (k) => m.get(k) || "", set: (k, v) => m.set(k, v), delete: (k) => m.delete(k), has: (k) => m.has(k), m };
};
const sse = (events) => new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""), { status: 200, headers: { "content-type": "text/event-stream" } });

test("pastedCode reads the localhost address, a query or a bare code", () => {
  assert.deepEqual(pastedCode("http://localhost:51121/oauth-callback?state=abc&code=4/0Ab-xyz&scope=x"), { code: "4/0Ab-xyz", state: "abc" });
  assert.deepEqual(pastedCode("code=4/0Ab-xyz123"), { code: "4/0Ab-xyz123", state: null });
  assert.deepEqual(pastedCode("4/0AbCdEfGhIj"), { code: "4/0AbCdEfGhIj", state: null });
  assert.equal(pastedCode("http://localhost:51121/oauth-callback?error=access_denied"), null);
  assert.equal(pastedCode(""), null);
});

test("codexIdentity reads email, account and plan from the id_token", () => {
  const id = jwt({ email: "a@b.c", "https://api.openai.com/auth": { chatgpt_account_id: "acc-1", chatgpt_plan_type: "plus" } });
  assert.deepEqual(codexIdentity(id), { email: "a@b.c", accountId: "acc-1", planType: "plus" });
});

test("codex device sign-in: code shown, polled until OpenAI issues it, grant saved", async () => {
  const secrets = memSecrets();
  const calls = [];
  let polls = 0;
  const connected = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: init.body });
    if (url.endsWith("/deviceauth/usercode")) return json(200, { device_auth_id: "dev-1", user_code: "ABCD-1234", interval: "5" });
    if (url.endsWith("/deviceauth/token")) return ++polls < 2 ? json(403, { error: "pending" }) : json(200, { authorization_code: "ac", code_challenge: "cc", code_verifier: "cv" });
    if (url.endsWith("/oauth/token")) {
      const exp = Math.floor(Date.now() / 1000) + 3600;
      return json(200, { access_token: jwt({ exp }), refresh_token: "rt", id_token: jwt({ email: "me@x.io", "https://api.openai.com/auth": { chatgpt_account_id: "acc", chatgpt_plan_type: "pro" } }) });
    }
    throw new Error(`unexpected ${url}`);
  };
  const auth = createSubscriptionAuth({ secrets, fetchImpl, onConnected: (id) => connected.push(id), pollFloorMs: 5 });
  // interval comes from OpenAI (5 s); the floor lets the test run fast only when OpenAI asks for less.
  const flow = await auth.start("openai-codex", "codex");
  assert.equal(flow.userCode, "ABCD-1234");
  assert.equal(flow.verificationUrl, "https://auth.openai.com/codex/device");
  assert.equal(auth.pending("openai-codex"), true);
  auth.cancel("openai-codex");
  // Restart with a short interval to exercise the poll loop.
  const fast = createSubscriptionAuth({
    secrets,
    onConnected: (id) => connected.push(id),
    pollFloorMs: 5,
    fetchImpl: async (url, init) => (url.endsWith("/usercode") ? json(200, { device_auth_id: "dev-1", user_code: "ABCD-1234", interval: "0" }) : fetchImpl(url, init)),
  });
  await fast.start("openai-codex", "codex");
  for (let i = 0; i < 100 && fast.status("openai-codex").status === "pending"; i += 1) await new Promise((r) => setTimeout(r, 10));
  assert.equal(fast.status("openai-codex").status, "ready");
  assert.deepEqual(connected, ["openai-codex"]);
  const grant = parseGrant(secrets.get("engine/openai-codex"));
  assert.equal(grant.plan, "codex");
  assert.equal(grant.accountId, "acc");
  assert.equal(grant.refresh, "rt");
  assert.deepEqual(fast.identity("openai-codex"), { email: "me@x.io", plan: "pro", method: "codex" });
  const exchange = calls.find((c) => c.url.endsWith("/oauth/token"));
  assert.match(exchange.body, /grant_type=authorization_code/);
  assert.match(exchange.body, /redirect_uri=https%3A%2F%2Fauth.openai.com%2Fdeviceauth%2Fcallback/);
  assert.match(exchange.body, /code_verifier=cv/);
});

test("antigravity: paste the localhost address, project resolved, wrong state refused", async () => {
  const secrets = memSecrets();
  const fetchImpl = async (url) => {
    if (url === "https://oauth2.googleapis.com/token") return json(200, { access_token: "ya29.x", refresh_token: "1//r", expires_in: 3599 });
    if (url.includes("userinfo")) return json(200, { email: "g@gmail.com" });
    if (url.endsWith(":loadCodeAssist")) return json(200, { cloudaicompanionProject: "proj-1", currentTier: { id: "standard-tier" } });
    throw new Error(`unexpected ${url}`);
  };
  const auth = createSubscriptionAuth({ secrets, fetchImpl });
  const flow = await auth.start("openai-antigravity", "antigravity");
  const u = new URL(flow.url);
  assert.equal(u.searchParams.get("redirect_uri"), "http://localhost:51121/oauth-callback");
  assert.equal(u.searchParams.get("code_challenge_method"), "S256");
  await assert.rejects(auth.submit("openai-antigravity", "http://localhost:51121/oauth-callback?state=other&code=4/abcdefghijk"), /ورود دیگری/);
  const state = u.searchParams.get("state");
  const done = await auth.submit("openai-antigravity", `http://localhost:51121/oauth-callback?state=${state}&code=4/abcdefghijk&scope=x`);
  assert.equal(done.status, "ready");
  const grant = parseGrant(secrets.get("engine/openai-antigravity"));
  assert.equal(grant.projectId, "proj-1");
  assert.equal(grant.email, "g@gmail.com");
});

test("credentials refresh an expiring grant once and keep the new token", async () => {
  const secrets = memSecrets();
  secrets.set("engine/openai-antigravity", JSON.stringify({ plan: "antigravity", access: "old", refresh: "1//r", expires: Date.now() + 1000, projectId: "p" }));
  let refreshes = 0;
  const auth = createSubscriptionAuth({
    secrets,
    fetchImpl: async () => {
      refreshes += 1;
      return json(200, { access_token: "new", expires_in: 3600 });
    },
  });
  const [a, b] = await Promise.all([auth.credentials("openai-antigravity"), auth.credentials("openai-antigravity")]);
  assert.equal(a.access, "new");
  assert.equal(b.access, "new");
  assert.equal(refreshes, 1);
  assert.equal(parseGrant(secrets.get("engine/openai-antigravity")).access, "new");
  assert.equal((await auth.credentials("openai-antigravity")).access, "new");
  assert.equal(refreshes, 1);
});

test("codexBody maps chat history to Responses input", () => {
  const body = codexBody({
    model: "gpt-5.5",
    reasoning_effort: "high",
    messages: [
      { role: "system", content: "rules" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "", tool_calls: [{ id: "c1", function: { name: "kube_get", arguments: '{"a":1}' } }] },
      { role: "tool", tool_call_id: "c1", content: "ok" },
    ],
    tools: [{ type: "function", function: { name: "kube_get", description: "d", parameters: { type: "object", properties: {} } } }],
  });
  assert.equal(body.instructions, "rules");
  assert.equal(body.store, false);
  assert.deepEqual(body.reasoning, { effort: "high", summary: "auto" });
  assert.deepEqual(body.input.map((i) => i.type), ["message", "function_call", "function_call_output"]);
  assert.equal(body.input[1].call_id, "c1");
  assert.equal(body.tools[0].name, "kube_get");
});

test("codex stream: text, reasoning and a tool call", async () => {
  const res = sse([
    { type: "response.reasoning_summary_text.delta", delta: "thinking" },
    { type: "response.output_text.delta", delta: "سلام" },
    { type: "response.output_item.added", item: { type: "function_call", id: "fc1", call_id: "call_1", name: "dns_lookup", arguments: "" } },
    { type: "response.function_call_arguments.delta", item_id: "fc1", delta: '{"name":' },
    { type: "response.function_call_arguments.delta", item_id: "fc1", delta: '"x.ir"}' },
    { type: "response.output_item.done", item: { type: "function_call", id: "fc1", call_id: "call_1", name: "dns_lookup", arguments: '{"name":"x.ir"}' } },
    { type: "response.completed", response: { usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } } },
  ]);
  const events = [];
  const out = await codexTransport.consume(res.body, async (e) => events.push(e.type));
  assert.equal(out.text, "سلام");
  assert.equal(out.reasoning, "thinking");
  assert.deepEqual(out.toolCalls.map((c) => [c.id, c.name, c.args.name]), [["call_1", "dns_lookup", "x.ir"]]);
  assert.equal(out.usage.prompt_tokens, 10);
  assert.ok(events.includes("tool-call-started"));
});

test("gemini request keeps thoughtSignature, names tool results, cleans schemas", () => {
  const req = geminiRequest({
    messages: [
      { role: "system", content: "rules" },
      { role: "user", content: "hi" },
      { role: "assistant", content: null, tool_calls: [{ id: "c1", signature: "SIG", function: { name: "kube_get", arguments: '{"a":1}' } }, { id: "c2", function: { name: "http_check", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "c1", content: "ok" },
      { role: "tool", tool_call_id: "c2", content: "200" },
    ],
    tools: [{ type: "function", function: { name: "kube_get", parameters: { $schema: "x", type: "object", additionalProperties: false, properties: { a: { type: ["integer", "null"] }, b: { anyOf: [{ type: "string" }, { type: "null" }] } }, required: ["a", "zz"] } } }],
  });
  assert.equal(req.systemInstruction.parts[0].text, "rules");
  assert.deepEqual(req.contents.map((c) => c.role), ["user", "model", "user"]);
  assert.equal(req.contents[1].parts[0].thoughtSignature, "SIG");
  assert.equal(req.contents[1].parts[1].thoughtSignature, "skip_thought_signature_validator");
  assert.deepEqual(req.contents[2].parts.map((p) => p.functionResponse.name), ["kube_get", "http_check"]);
  const schema = req.tools[0].functionDeclarations[0].parameters;
  assert.deepEqual(schema, { type: "OBJECT", properties: { a: { type: "INTEGER", nullable: true }, b: { type: "STRING" } }, required: ["a"] });
  assert.deepEqual(geminiSchema({ type: "array", items: { type: "string", enum: ["x"] } }), { type: "ARRAY", items: { type: "STRING", enum: ["x"] } });
});

test("antigravity stream: thoughts, text and a signed call", async () => {
  const res = sse([
    { response: { candidates: [{ content: { parts: [{ text: "hmm", thought: true }] } }] } },
    { response: { candidates: [{ content: { parts: [{ text: "باشه" }] } }] } },
    { response: { candidates: [{ content: { parts: [{ functionCall: { name: "dns_lookup", args: { name: "a.ir" } }, thoughtSignature: "S1" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 3 } } },
  ]);
  const out = await antigravityTransport.consume(res.body, async () => {});
  assert.equal(out.text, "باشه");
  assert.equal(out.reasoning, "hmm");
  assert.equal(out.toolCalls[0].signature, "S1");
  assert.equal(out.toolCalls[0].args.name, "a.ir");
  assert.equal(out.finishReason, "tool_calls");
  assert.equal(out.usage.prompt_tokens, 7);
});

test("openai provider on a codex plan: one run end to end, 401 refreshes once", async () => {
  const sent = [];
  let forced = 0;
  const provider = createOpenAIProvider({
    apiKey: '{"plan":"codex"}',
    baseUrl: "https://chatgpt.com/backend-api/codex",
    defaultModel: "gpt-5.5",
    plan: "codex",
    credentials: async ({ force } = {}) => {
      if (force) forced += 1;
      return { plan: "codex", access: force ? "fresh" : "stale", accountId: "acc" };
    },
    fetchImpl: async (url, init) => {
      sent.push({ url, auth: init.headers.authorization, account: init.headers["chatgpt-account-id"], body: JSON.parse(init.body) });
      if (init.headers.authorization === "Bearer stale") return json(401, { detail: "token expired" });
      return sse([{ type: "response.output_text.delta", delta: "done" }, { type: "response.completed", response: { usage: { input_tokens: 3, output_tokens: 1 } } }]);
    },
    log: { error() {}, warn() {} },
  });
  const agent = provider.create({ customTools: {} });
  const run = await agent.send("hello", {});
  const result = await run.wait();
  assert.equal(result.status, "finished");
  assert.equal(forced, 1);
  assert.equal(sent.length, 2);
  assert.equal(sent[1].url, "https://chatgpt.com/backend-api/codex/responses");
  assert.equal(sent[1].account, "acc");
  assert.equal(sent[1].body.model, "gpt-5.5");
  assert.equal(sent[1].body.input[0].content[0].text, "hello");
});

test("index.mjs declares planAccount once (a route-scope namesake hid it: «unknown plan: undefined», 2026-11-21)", async () => {
  const fs = await import("node:fs");
  const src = fs.readFileSync(new URL("../src/index.mjs", import.meta.url), "utf8");
  assert.equal((src.match(/\b(?:const|let|function)\s+planAccount\b/g) || []).length, 1);
});

test("antigravity: Google's «Verify your account» carries its link in the error, so the person can act (2026-11-22)", async () => {
  const url = "https://accounts.google.com/v3/signin/continue?plt=abc&continue=https://developers.google.com/gemini-code-assist/auth/auth_success_gemini";
  const provider = createOpenAIProvider({
    apiKey: '{"plan":"antigravity"}',
    baseUrl: "https://daily-cloudcode-pa.googleapis.com",
    defaultModel: "gemini-3-flash",
    plan: "antigravity",
    credentials: async () => ({ plan: "antigravity", access: "a", projectId: "p" }),
    fetchImpl: async () => json(403, { error: { code: 403, message: "Verify your account to continue.", status: "PERMISSION_DENIED", details: [{ reason: "VALIDATION_REQUIRED", metadata: { validation_url: url } }] } }),
    log: { error() {}, warn() {} },
  });
  const run = await provider.create({ customTools: {} }).send("hello", {});
  const result = await run.wait();
  assert.equal(result.status, "error");
  assert.match(result.error.message, /Verify your account/);
  assert.ok(result.error.message.includes(url));
});

// fetchAvailableModels as two real accounts answered it on 2026-11-23 (trimmed).
const AG_BODY = {
  models: {
    "gemini-4-neon-high": { displayName: "Gemini 4 Neon (High)" },
    "gemini-4-neon-xhigh": { displayName: "Gemini 4 Neon (XHigh)" },
    "gemini-4-neon-low": { displayName: "Gemini 4 Neon (Low)" },
    "gemini-4-carbon-disabled": { displayName: "Gemini 4 Carbon", disabled: true, tagTitle: "Unavailable" },
    "gemini-3.8-flash-high": { displayName: "Gemini 3.8 Flash (High)" },
    "gemini-3.8-flash-medium": { displayName: "Gemini 3.8 Flash (Medium)" },
    "gemini-3-flash": { displayName: "Gemini 3 Flash" },
    "gemini-4-hydrogen-sonar": {},
    "gemini-2.5-flash": { displayName: "Gemini 3.5 Flash Lite" },
    "claude-sonnet-5-5-medium": { displayName: "Claude Sonnet 5.5 (Medium)" },
    "tab_flash_lite_preview": {},
  },
  agentModelSorts: [{ groups: [{ modelIds: ["gemini-4-neon-high", "gemini-4-neon-xhigh", "gemini-4-neon-low", "gemini-3.8-flash-high", "gemini-3.8-flash-medium", "claude-sonnet-5-5-medium", "gemini-4-carbon-disabled"] }] }],
  commandModelIds: ["gemini-3-flash"],
  defaultAgentModelId: "gemini-4-neon-high",
};

test("antigravity models: offered Gemini only, no disabled or internal ones, effort variants are one model (2026-11-23)", () => {
  const c = antigravityCatalog(AG_BODY);
  assert.deepEqual(c.models, [
    { id: "gemini-4-neon", name: "Gemini 4 Neon", efforts: ["low", "high", "xhigh"] },
    { id: "gemini-3.8-flash", name: "Gemini 3.8 Flash", efforts: ["medium", "high"] },
    { id: "gemini-3-flash", name: "Gemini 3 Flash" },
  ]);
});

test("antigravity: the chat's effort picks the variant; another account's model is named plainly", () => {
  const c = antigravityCatalog(AG_BODY);
  assert.equal(antigravityTransport.resolve("gemini-4-neon", "xhigh", c), "gemini-4-neon-xhigh");
  assert.equal(antigravityTransport.resolve("gemini-4-neon", "max", c), "gemini-4-neon-xhigh");
  assert.equal(antigravityTransport.resolve("gemini-4-neon", "medium", c), "gemini-4-neon-low");
  assert.equal(antigravityTransport.resolve("gemini-4-neon", null, c), "gemini-4-neon-high");
  assert.equal(antigravityTransport.resolve("gemini-3.8-flash", "low", c), "gemini-3.8-flash-medium");
  assert.equal(antigravityTransport.resolve("gemini-4-neon-xhigh", null, c), "gemini-4-neon-xhigh");
  assert.equal(antigravityTransport.resolve("gemini-3.8-flash-low", null, c), "gemini-3.8-flash-medium");
  assert.equal(antigravityTransport.resolve("gemini-3-flash", "high", c), "gemini-3-flash");
  assert.throws(() => antigravityTransport.resolve("gemini-9-argon", null, c), /روی این حساب آنتی‌گرویتی نیست/);
  assert.equal(pickLevel(["low", "high"], "medium"), "low");
});

test("antigravity provider: a run on a family sends the variant of its effort", async () => {
  const sent = [];
  const provider = createOpenAIProvider({
    apiKey: '{"plan":"antigravity"}',
    baseUrl: "https://daily-cloudcode-pa.googleapis.com",
    defaultModel: "gemini-4-neon",
    plan: "antigravity",
    credentials: async () => ({ plan: "antigravity", access: "a", projectId: "p" }),
    fetchImpl: async (url, init) => {
      if (String(url).includes("fetchAvailableModels")) return json(200, AG_BODY);
      sent.push(JSON.parse(init.body).model);
      return sse([{ response: { candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }] } }]);
    },
    log: { error() {}, warn() {} },
  });
  assert.deepEqual((await provider.listModels()).map((m) => m.id), ["gemini-4-neon", "gemini-3.8-flash", "gemini-3-flash"]);
  const run = await provider.create({ customTools: {} }).send("hello", { effort: "xhigh" });
  assert.equal((await run.wait()).status, "finished");
  assert.equal(sent[0], "gemini-4-neon-xhigh");
});

test("usage: Antigravity's shared Gemini pool is one window; Codex's 5-hour and weekly windows (2026-11-23)", () => {
  const q = { remainingFraction: 0.50466967, resetTime: "2026-11-23T17:27:24Z" };
  const body = { ...AG_BODY, models: Object.fromEntries(Object.entries(AG_BODY.models).map(([id, m]) => [id, { ...m, quotaInfo: q }])) };
  assert.deepEqual(antigravityCatalog(body).windows, [{ label: "Gemini 4 Neon و 2 مدل دیگر", percentage: 50, resetAt: "2026-11-23T17:27:24Z" }]);
  const w = codexWindows({ rate_limit: { primary_window: { used_percent: 12.4, limit_window_seconds: 18000, reset_at: 1795370000 }, secondary_window: { used_percent: 3, limit_window_seconds: 604800, reset_after_seconds: 3600 } } });
  assert.equal(w[0].label, "5 ساعته");
  assert.equal(w[0].percentage, 12);
  assert.equal(w[0].resetAt, new Date(1795370000 * 1000).toISOString());
  assert.equal(w[1].label, "هفتگی");
  assert.equal(w[1].percentage, 3);
});

test("gemini schema: an empty string among enum values is dropped (Gemini refuses it, 2026-11-23)", () => {
  assert.deepEqual(geminiSchema({ type: "string", enum: ["", "low", "high"] }), { type: "STRING", enum: ["low", "high"] });
  assert.deepEqual(geminiSchema({ type: "string", enum: [""] }), { type: "STRING" });
});

test("antigravity: an empty model list (a bad read) does not block the run", () => {
  assert.equal(antigravityTransport.resolve("gemini-4-neon", "high", antigravityCatalog({})), "gemini-4-neon");
});

test("antigravity quota summary: returns both 5h and weekly windows, Argon separately, handles proto3 0%, skips Claude/GPT (2026-11-23)", async () => {
  const summaryBody = {
    groups: [
      {
        displayName: "Gemini Models",
        buckets: [
          { displayName: "Weekly", window: "weekly", remainingFraction: 0.72, resetTime: "2026-11-30T10:00:00Z" },
          { displayName: "5-hour", window: "5h", resetTime: "2026-11-23T22:00:00Z" }, // proto3 omits 0 → 100% used
        ],
      },
      {
        displayName: "Gemini 4 Argon",
        buckets: [{ displayName: "Weekly", window: "weekly", remainingFraction: 1, resetTime: "2026-11-30T10:00:00Z" }],
      },
      {
        displayName: "Claude / GPT-OSS",
        buckets: [{ displayName: "5-hour", window: "5h", remainingFraction: 0.5, resetTime: "2026-11-23T22:00:00Z" }],
      },
    ],
  };
  const parsed = antigravityQuotaSummary(summaryBody);
  assert.equal(parsed.hasSharedGemini, true);
  assert.deepEqual(parsed.windows, [
    { label: "۵ ساعته", percentage: 100, resetAt: "2026-11-23T22:00:00Z" },
    { label: "هفتگی", percentage: 28, resetAt: "2026-11-30T10:00:00Z" },
    { label: "Argon هفتگی", percentage: 0, resetAt: "2026-11-30T10:00:00Z" },
  ]);

  // Transport usage() uses retrieveUserQuotaSummary when available, falls back to fetchAvailableModels on error.
  const grant = { plan: "antigravity", access: "tok", projectId: "proj" };
  const fromSummary = await antigravityTransport.usage(grant, {
    baseUrl: "https://daily-cloudcode-pa.googleapis.com",
    fetchImpl: async (url) => {
      assert.ok(String(url).includes("retrieveUserQuotaSummary"));
      return json(200, summaryBody);
    },
  });
  assert.equal(fromSummary.length, 3);

  const q = { remainingFraction: 0.4, resetTime: "2026-11-23T22:00:00Z" };
  const fallbackBody = { ...AG_BODY, models: Object.fromEntries(Object.entries(AG_BODY.models).map(([id, m]) => [id, { ...m, quotaInfo: q }])) };
  const fromFallback = await antigravityTransport.usage(grant, {
    baseUrl: "https://daily-cloudcode-pa.googleapis.com",
    fetchImpl: async (url) => (String(url).includes("retrieveUserQuotaSummary") ? json(404, {}) : json(200, fallbackBody)),
  });
  assert.deepEqual(fromFallback, [{ label: "Gemini 4 Neon و 2 مدل دیگر", percentage: 60, resetAt: "2026-11-23T22:00:00Z" }]);
});

test("antigravity provider: empty thinking-only or malformed tool-call turns retry instead of finishing blank (2026-11-23)", async () => {
  let calls = 0;
  const provider = createOpenAIProvider({
    apiKey: '{"plan":"antigravity"}',
    baseUrl: "https://daily-cloudcode-pa.googleapis.com",
    defaultModel: "gemini-4-neon",
    plan: "antigravity",
    credentials: async () => ({ plan: "antigravity", access: "a", projectId: "p" }),
    fetchImpl: async (url) => {
      if (String(url).includes("fetchAvailableModels")) return json(200, AG_BODY);
      calls += 1;
      if (calls === 1) {
        return sse([{ response: { candidates: [{ content: { parts: [{ text: "فقط فکر", thought: true }] }, finishReason: "MALFORMED_FUNCTION_CALL" }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } } }]);
      }
      return sse([{ response: { candidates: [{ content: { parts: [{ text: "انجام شد" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 4 } } }]);
    },
    log: { error() {}, warn() {} },
  });
  const texts = [];
  const run = await provider.create({ customTools: {} }).send("ادامه بده", {
    onDelta: ({ update }) => {
      if (update.type === "text-delta") texts.push(update.text);
    },
  });
  const res = await run.wait();
  assert.equal(res.status, "finished");
  assert.equal(calls, 2);
  assert.equal(texts.join(""), "انجام شد");

  // If the model stays empty across all retries, surface no_answer error instead of silent finished.
  let blankCalls = 0;
  const alwaysBlank = createOpenAIProvider({
    apiKey: '{"plan":"antigravity"}',
    baseUrl: "https://daily-cloudcode-pa.googleapis.com",
    defaultModel: "gemini-4-neon",
    plan: "antigravity",
    credentials: async () => ({ plan: "antigravity", access: "a", projectId: "p" }),
    fetchImpl: async (url) => {
      if (String(url).includes("fetchAvailableModels")) return json(200, AG_BODY);
      blankCalls += 1;
      return sse([{ response: { candidates: [{ content: { parts: [{ text: "فقط فکر", thought: true }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } } }]);
    },
    log: { error() {}, warn() {} },
  });
  const blankRun = await alwaysBlank.create({ customTools: {} }).send("ادامه بده");
  const blankRes = await blankRun.wait();
  assert.equal(blankRes.status, "error");
  assert.equal(blankRes.error?.code, "no_answer");
  assert.equal(blankCalls, 3);
});
