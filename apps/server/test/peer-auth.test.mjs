import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { openStore } from "../src/db.mjs";
import { createPeerAuth, hashToken } from "../src/peer-auth.mjs";
import { resolveEnabledTools } from "../src/agents/profiles.mjs";
import { guardTools } from "../src/guard.mjs";
import { seedExampleAgents } from "./fixture-agents.mjs";

function setup(clock = { t: Date.parse("2026-09-19T10:00:00Z") }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "griffin-peer-"));
  const store = openStore(path.join(dir, "t.sqlite"));
  seedExampleAgents(store);
  const auth = createPeerAuth({ store, now: () => clock.t });
  return { store, auth, clock };
}

test("user + client: token works once issued, only its hash is stored", () => {
  const { store, auth } = setup();
  auth.createUser({ id: "ali-ahmadi", label: "آقای احمدی" });
  const { token, id } = auth.issueClient("ali-ahmadi", { label: "laptop" });
  assert.match(token, /^grf_/);
  const row = store.peerClientByHash(hashToken(token));
  assert.equal(row.id, id);
  assert.ok(!JSON.stringify(store.listPeerClients("ali-ahmadi")).includes(token));
  const who = auth.authenticate(`Bearer ${token}`);
  assert.equal(who.caller, "peer:ali-ahmadi");
  assert.equal(who.clientId, id);
});

test("two clients per user; revoking one keeps the other", () => {
  const { auth, store } = setup();
  auth.createUser({ id: "ali-ahmadi" });
  const laptop = auth.issueClient("ali-ahmadi", { label: "laptop" });
  const capsule = auth.issueClient("ali-ahmadi", { label: "edge capsule" });
  assert.ok(store.revokePeerClient("ali-ahmadi", laptop.id));
  assert.equal(auth.authenticate(`Bearer ${laptop.token}`).status, 401);
  assert.equal(auth.authenticate(`Bearer ${capsule.token}`).userId, "ali-ahmadi");
});

test("bad, expired and disabled tokens are refused", () => {
  const { auth, store, clock } = setup();
  auth.createUser({ id: "x-user" });
  const short = auth.issueClient("x-user", { ttlDays: 1 });
  assert.equal(auth.authenticate("Bearer grf_nope").status, 401);
  assert.equal(auth.authenticate("").status, 401);
  clock.t += 2 * 86_400_000;
  assert.equal(auth.authenticate(`Bearer ${short.token}`).error, "token expired");
  const other = auth.issueClient("x-user");
  store.setPeerUserEnabled("x-user", false);
  assert.equal(auth.authenticate(`Bearer ${other.token}`).status, 403);
  assert.throws(() => auth.createUser({ id: "Bad Id!" }));
});

test("rate limit per client", () => {
  const { auth } = setup();
  auth.createUser({ id: "busy" });
  const { token } = auth.issueClient("busy");
  let last;
  for (let i = 0; i < 121; i += 1) last = auth.authenticate(`Bearer ${token}`);
  assert.equal(last.status, 429);
});

test("new peer gets a narrow default quota; no secrets, shell or mutation", () => {
  const { auth, store } = setup();
  auth.createUser({ id: "ali-ahmadi" });
  const platform = store.getAgentProfile("platform");
  const catalog = ["kube_get", "kube_secret", "debug_exec", "pg_query", "s3_get", "kube_logs", "telegram_send", "gitlab_mr"];
  const tools = resolveEnabledTools(platform, { caller: "peer:ali-ahmadi", catalogNames: catalog });
  assert.deepEqual(tools.sort(), ["gitlab_mr", "kube_get"]);
  // Unknown peer: fail closed.
  assert.deepEqual(resolveEnabledTools(platform, { caller: "peer:someone-else", catalogNames: catalog }), []);
});

test("irreversible calls are refused (not asked) on peer chains", async () => {
  const rows = [];
  let merged = 0;
  const tools = { gitlab_mr: { async execute() { merged += 1; return { content: [] }; } } };
  const guarded = guardTools(tools, {
    chatId: "p1",
    asks: { confirm: () => { throw new Error("must not ask"); } },
    store: { recordApproval: (r) => rows.push(r) },
    caller: "peer:ali-ahmadi",
    mode: "refuse",
  });
  const result = await guarded.gitlab_mr.execute({ action: "merge", project: "p", iid: 1 });
  assert.equal(result.isError, true);
  assert.equal(merged, 0);
  assert.equal(rows[0].decision, "refused");
  await guarded.gitlab_mr.execute({ action: "view", project: "p", iid: 1 });
  assert.equal(merged, 1);
});

test("Bearer middleware answers 401 with WWW-Authenticate and passes identity", async () => {
  const { auth } = setup();
  auth.createUser({ id: "ali-ahmadi" });
  const { token } = auth.issueClient("ali-ahmadi");
  const app = new Hono();
  app.get("/peer/v1/whoami", auth.middleware(), (c) => c.json(c.get("peer")));
  const denied = await app.request("/peer/v1/whoami");
  assert.equal(denied.status, 401);
  assert.match(denied.headers.get("www-authenticate"), /Bearer/);
  const ok = await app.request("/peer/v1/whoami", { headers: { authorization: `Bearer ${token}` } });
  assert.equal((await ok.json()).caller, "peer:ali-ahmadi");
});

test("quota API: replace, remove, and refuse self-management / wildcard", async () => {
  const { auth, store } = setup();
  auth.createUser({ id: "ali-ahmadi" });
  const app = new Hono();
  auth.routes(app, { selfMgmtTools: ["agent_tools_enable"] });
  const put = (body) => app.request("/api/peers/ali-ahmadi/quota", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  assert.equal((await put({ agent: "platform", tools: ["agent_tools_enable"] })).status, 400);
  assert.equal((await put({ agent: "platform", tools: ["*"] })).status, 400);
  const ok = await (await put({ agent: "platform", tools: ["kube_get", "kube_logs"] })).json();
  assert.deepEqual(ok.quotas.find((q) => q.agent === "platform").tools, ["kube_get", "kube_logs"]);
  await put({ agent: "platform", tools: [] });
  assert.equal(store.getAgentProfile("platform").meta.callers["peer:ali-ahmadi"], undefined);
  const listed = await (await app.request("/api/peers")).json();
  assert.equal(listed.users[0].caller, "peer:ali-ahmadi");
});

test("self-management tools never reach a non-owner even if a quota row lists them", () => {
  const { store } = setup();
  store.updateAgentProfile("griffin", { meta: { callers: { "peer:x": { tools: ["ask_agent", "agent_tools_enable"] } } } });
  const tools = resolveEnabledTools(store.getAgentProfile("griffin"), { caller: "peer:x", catalogNames: ["ask_agent", "agent_tools_enable"] });
  assert.deepEqual(tools, ["ask_agent"]);
});

test("invite pickup: GET shows a button only, POST mints a token once, then it is gone", async () => {
  const { auth, store } = setup();
  auth.createUser({ id: "sara-karimi", label: "خانم کریمی" });
  const app = new Hono();
  auth.routes(app);
  const created = await (await app.request("/api/peers/sara-karimi/pickups", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).json();
  const path = new URL(created.url, "http://x").pathname;
  const page = await (await app.request(path)).text();
  assert.match(page, /دریافت توکن/);
  assert.equal(store.listPeerClients("sara-karimi").length, 0); // a preview GET mints nothing
  const got = await app.request(path, { method: "POST" });
  assert.equal(got.status, 200);
  const token = (await got.text()).match(/grf_[A-Za-z0-9_-]+/)[0];
  assert.equal(auth.authenticate(`Bearer ${token}`).userId, "sara-karimi");
  assert.equal((await app.request(path, { method: "POST" })).status, 410);
  assert.ok(!JSON.stringify(store.db.prepare("SELECT * FROM kv").all()).includes(token));
});

test("peer_invite: registers, stores token in the peer's own Infisical project, never returns it", async () => {
  const { store, auth } = setup();
  const calls = [];
  const callBroker = async (name, args) => {
    calls.push({ name, args });
    if (name === "infisical_projects") {
      return { projects: [{ id: "pid-1", name: "dana-lee" }, { id: "pid-2", name: "someone-else" }] };
    }
    if (name === "infisical_upsert") return { name: args.name, action: "created" };
    throw new Error(`unexpected tool ${name}`);
  };
  const tool = auth.inviteTool({ callBroker });
  assert.equal(tool.name, "peer_invite");

  const result = await tool.execute({ id: "Dana-Lee", label: "خانم لی" });
  assert.ok(!result.isError, JSON.stringify(result));
  const payload = JSON.parse(result.content[0].text);

  // peer registered with the default quota
  assert.equal(payload.peer, "dana-lee");
  assert.equal(payload.created, true);
  assert.ok(store.getPeerUser("dana-lee"));

  // token went app→broker into their own project, key GRIFFIN_MCP_TOKEN, prod, /
  assert.equal(calls[0].name, "infisical_projects");
  assert.equal(calls[1].name, "infisical_upsert");
  assert.equal(calls[1].args.projectId, "pid-1");
  assert.equal(calls[1].args.name, "GRIFFIN_MCP_TOKEN");
  assert.match(calls[1].args.value, /^grf_/);
  assert.equal(calls[1].args.environment, "prod");
  assert.equal(calls[1].args.path, "/");

  // the tool result carries the location, never the token; a re-invite authenticates with it
  assert.ok(!result.content[0].text.includes(calls[1].args.value));
  assert.equal(payload.secret.key, "GRIFFIN_MCP_TOKEN");
  assert.equal(payload.secret.projectId, "pid-1");
  assert.equal(auth.authenticate(`Bearer ${calls[1].args.value}`).caller, "peer:dana-lee");

  // second invite: user exists, a fresh client is minted and upserted again
  const again = await tool.execute({ id: "dana-lee", label: "خانم لی" });
  const payload2 = JSON.parse(again.content[0].text);
  assert.equal(payload2.created, false);
  assert.equal(calls.filter((c) => c.name === "infisical_upsert").length, 2);

  // no matching project and no explicit projectId → error listing visible projects, nothing minted
  const missing = await tool.execute({ id: "nobody-here", label: "x" });
  assert.ok(missing.isError);
  assert.match(missing.content[0].text, /no Infisical project named "nobody-here"/);
  assert.ok(!store.getPeerUser("nobody-here"));
});
