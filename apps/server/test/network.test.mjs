import test from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { agentId, allowedOrigin, createNetwork } from "../src/network.mjs";

const DOMAINS = ["example.com", "example.org"];

test("only https addresses on the company's domains may join", () => {
  assert.equal(allowedOrigin("https://team-a.example.com/", DOMAINS), "https://team-a.example.com");
  assert.equal(allowedOrigin("http://team-a.example.com", DOMAINS), null);
  assert.equal(allowedOrigin("https://evil.example.net", DOMAINS), null);
  assert.equal(allowedOrigin("https://example.com.evil.net", DOMAINS), null);
  assert.equal(allowedOrigin("https://user:pw@a.example.com", DOMAINS), null);
  assert.equal(agentId("team-a.example.com"), "team-a-example-com");
});

// Three installs on one fake internet: A knows B, B knows C; A meets B and so meets C at once.
function install(host, net) {
  const kv = new Map();
  const users = new Map();
  const clients = [];
  const store = {
    getKv: (k) => kv.get(k) ?? null,
    setKv: (k, v) => kv.set(k, v),
    deleteKv: (k) => kv.delete(k),
    getPeerUser: (id) => users.get(id) || null,
    listPeerClients: (u) => clients.filter((c) => c.user === u).map((c) => ({ id: c.id, revoked_at: c.revoked ? 1 : null })),
    revokePeerClient: (u, id) => { const c = clients.find((x) => x.id === id); if (c) c.revoked = true; },
  };
  const peerAuth = {
    createUser: ({ id, label }) => users.set(id, { id, label }),
    issueClient: (user) => { const token = `grf_${host.replace(/\W/g, "")}_${clients.length}_xxxxxxxxxxxxxxxxxxxxxxxxx`; const id = String(clients.length); clients.push({ id, user, token }); return { id, token }; },
  };
  const box = new Map();
  const secrets = { get: (n) => box.get(n) || null, set: (n, v) => box.set(n, v) };
  const app = new Hono();
  const n = createNetwork({ store, peerAuth, secrets, env: { GRIFFIN_NETWORK_DOMAINS: DOMAINS.join(","), GRIFFIN_NETWORK_SEEDS: "" }, publicUrl: () => `https://${host}`, fetchFn: (url, init) => net(url, init), log: { log() {}, error() {} } });
  n.routes(app);
  // The peer MCP: a valid, unrevoked token opens tools/list; griffin_send answers at once.
  app.post("/mcp", async (c) => {
    const t = (c.req.header("authorization") || "").replace(/^Bearer /, "");
    const cl = clients.find((x) => x.token === t && !x.revoked);
    if (!cl) return c.json({ error: "no" }, 401);
    const body = await c.req.json();
    if (body.method === "tools/list") return c.json({ jsonrpc: "2.0", id: body.id, result: { tools: [] } });
    const answer = { taskId: "t1", contextId: "c1", state: "completed", answer: `${host} got: ${body.params.arguments.message} from ${cl.user}` };
    return c.json({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: JSON.stringify(answer) }] } });
  });
  return { host, app, n, users, secrets: box };
}

test("a new agent that meets one member meets the whole network, and they all meet it", async () => {
  const hosts = {};
  const net = (url, init = {}) => { const u = new URL(url); return hosts[u.host].app.request(u.pathname, init); };
  const a = (hosts["a.example.com"] = install("a.example.com", net));
  const b = (hosts["b.example.com"] = install("b.example.com", net));
  const c = (hosts["c.example.com"] = install("c.example.com", net));
  const settle = () => new Promise((r) => setTimeout(r, 50));
  await b.n.hello("https://c.example.com");
  for (let i = 0; i < 10; i++) await settle();
  assert.deepEqual(b.n.connected().map((x) => x.url), ["https://c.example.com"]);
  await a.n.hello("https://b.example.com");
  for (let i = 0; i < 20; i++) await settle();
  assert.deepEqual(a.n.connected().map((x) => x.url).sort(), ["https://b.example.com", "https://c.example.com"]);
  assert.ok(c.n.connected().some((x) => x.url === "https://a.example.com"), "C knows the newcomer");
  assert.ok(c.users.has("net-a-example-com"), "C made a peer user for A");
  const r = await a.n.ask("c-example-com", "سلام");
  assert.equal(r.state, "completed");
  assert.match(r.answer, /c\.example\.com got: سلام from net-a-example-com/);
});

test("a token is taken only from an address we said hello to", async () => {
  const net = () => { throw new Error("offline"); };
  const x = install("x.example.com", net);
  const res = await x.app.request("/api/public/network/token", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ from: "https://y.example.com", token: "grf_aaaaaaaaaaaaaaaaaaaaaaaaaaaa" }) });
  assert.equal(res.status, 400);
  assert.equal(x.n.connected().length, 0);
});

test("a hello sent in someone else's name does not cut their working link", async () => {
  const hosts = {};
  const net = (url, init = {}) => { const u = new URL(url); return hosts[u.host].app.request(u.pathname, init); };
  const a = (hosts["a.example.com"] = install("a.example.com", net));
  const b = (hosts["b.example.com"] = install("b.example.com", net));
  const settle = () => new Promise((r) => setTimeout(r, 50));
  await a.n.hello("https://b.example.com");
  for (let i = 0; i < 10; i++) await settle();
  // A third party asks B to say hello to "A": B mints a token, A refuses it (no hello pending).
  await b.app.request("/api/public/network/hello", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: "https://a.example.com" }) });
  for (let i = 0; i < 10; i++) await settle();
  const r = await a.n.ask("b-example-com", "هنوز وصلیم؟");
  assert.equal(r.state, "completed");
});

test("an install with the network off has no card, refuses hello and token, and asks nothing", async () => {
  let on = false;
  const calls = [];
  const kv = new Map();
  const store = { getKv: (k) => kv.get(k) ?? null, setKv: (k, v) => kv.set(k, v), deleteKv: (k) => kv.delete(k), getPeerUser: () => null, listPeerClients: () => [], revokePeerClient() {} };
  const peerAuth = { createUser() { calls.push("user"); }, issueClient() { calls.push("client"); return { id: "1", token: "grf_x" }; } };
  const box = new Map([["network/b-example-com", "grf_tokenforbxxxxxxxxxxxxxxxx"]]);
  const secrets = { get: (n) => box.get(n) || null, set: (n, v) => box.set(n, v) };
  kv.set("network:agents", { "b-example-com": { id: "b-example-com", url: "https://b.example.com" } });
  const app = new Hono();
  const n = createNetwork({ store, peerAuth, secrets, env: { GRIFFIN_NETWORK_DOMAINS: DOMAINS.join(","), GRIFFIN_NETWORK_SEEDS: "https://b.example.com" }, publicUrl: () => "https://a.example.com", enabled: () => on, fetchFn: async (url) => { calls.push(String(url)); throw new Error("no net"); }, log: { log() {}, error() {} } });
  n.routes(app);
  n.ownerRoutes(app);
  assert.equal((await app.request("/api/public/network/card")).status, 404);
  await app.request("/api/public/network/hello", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: "https://b.example.com" }) });
  const tok = await app.request("/api/public/network/token", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ from: "https://b.example.com", token: "grf_abcdefghijklmnopqrstuvwxyz" }) });
  assert.equal(tok.status, 400);
  await n.refresh();
  await assert.rejects(n.ask("b-example-com", "hi"), /off/);
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(calls, []);
  assert.equal((await (await app.request("/api/network")).json()).off, true);
  on = true;
  assert.equal((await app.request("/api/public/network/card")).status, 200);
});

// A peer agent asked, got «auth-required», ended its turn: the late answer must still reach it.
test("an answer that outlives network_ask wakes the chat that asked", async () => {
  const kv = new Map([["network:agents", { "b-example-com": { id: "b-example-com", url: "https://b.example.com", name: "گریفین", owner: "Owner" } }]]);
  const store = { getKv: (k) => kv.get(k) ?? null, setKv: (k, v) => kv.set(k, v), deleteKv: (k) => kv.delete(k), getChat: (id) => (id === "chat-1" ? { id } : null) };
  const secrets = { get: () => "grf_tokenforbxxxxxxxxxxxxxxxx", set() {} };
  let polls = 0;
  const reply = (r) => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: JSON.stringify(r) }] } }), { headers: { "content-type": "application/json" } });
  const fetchFn = async (url, init) => {
    const { params } = JSON.parse(init.body);
    if (params.name === "griffin_send") return reply({ taskId: "t9", contextId: "c9", state: "auth-required", seq: 3 });
    polls += 1;
    return reply(polls < 3 ? { taskId: "t9", state: "auth-required", seq: 3 + polls } : { taskId: "t9", state: "completed", seq: 9, answer: "دسترسی خواندنی داده شد" });
  };
  const sent = [];
  const runner = { isActive: () => false, send: async (chatId, msg) => sent.push({ chatId, text: msg.text }) };
  const n = createNetwork({ store, peerAuth: {}, secrets, runner, env: { GRIFFIN_NETWORK_DOMAINS: DOMAINS.join(","), GRIFFIN_NETWORK_SEEDS: "" }, publicUrl: () => "https://a.example.com", fetchFn, log: { log() {}, error() {} }, pollGapMs: 1, retryMs: 1 });
  const r = await n.tools("chat-1").network_ask.execute({ agent: "b-example-com", message: "دسترسی می‌خواهم" });
  assert.equal(r.state, "auth-required");
  assert.match(r.note, /comes back to THIS chat by itself/);
  assert.equal(n.pending("chat-1"), 1);
  for (let i = 0; i < 50 && !sent.length; i++) await new Promise((res) => setTimeout(res, 5));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].chatId, "chat-1");
  assert.ok(sent[0].text.startsWith("[گزارش خودکار زیرکارها"), "treated like a delegate report");
  assert.match(sent[0].text, /دسترسی خواندنی داده شد/);
  assert.equal(n.pending("chat-1"), 0);
  // The owner's API path (no chat) keeps the old behaviour: nothing is followed.
  const plain = await n.ask("b-example-com", "x", { fresh: true });
  assert.equal(plain.state, "auth-required");
  assert.equal(n.pending("chat-1"), 0);
});
