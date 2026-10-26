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
function install(host, net, extra = {}) {
  const kv = new Map();
  const users = new Map();
  const clients = [];
  const store = {
    getKv: (k) => kv.get(k) ?? null,
    setKv: (k, v) => kv.set(k, v),
    deleteKv: (k) => kv.delete(k),
    ...(extra.chats ? { getChat: (id) => (extra.chats.includes(id) ? { id } : null) } : {}),
    getPeerUser: (id) => users.get(id) || null,
    listPeerClients: (u) => clients.filter((c) => c.user === u).map((c) => ({ id: c.id, revoked_at: c.revoked ? 1 : null })),
    revokePeerClient: (u, id) => { const c = clients.find((x) => x.id === id); if (c) c.revoked = true; },
  };
  const peerAuth = {
    createUser: ({ id, label }) => users.set(id, { id, label }),
    issueClient: (user) => { const token = `grf_${host.replace(/\W/g, "")}_${clients.length}_xxxxxxxxxxxxxxxxxxxxxxxxx`; const id = String(clients.length); clients.push({ id, user, token }); return { id, token }; },
    authenticate: (header) => {
      const token = String(header || "").replace(/^Bearer /, "");
      const c = clients.find((x) => x.token === token && !x.revoked);
      return c ? { userId: c.user, clientId: c.id } : { error: "invalid token", status: 401 };
    },
  };
  const box = new Map();
  const secrets = { get: (n) => box.get(n) || null, set: (n, v) => box.set(n, v), delete: (n) => box.delete(n) };
  const app = new Hono();
  const n = createNetwork({ store, peerAuth, secrets, env: { GRIFFIN_NETWORK_DOMAINS: DOMAINS.join(","), GRIFFIN_NETWORK_SEEDS: "" }, publicUrl: () => `https://${host}`, fetchFn: (url, init) => net(url, init), log: { log() {}, error() {} }, ...(extra.runner ? { runner: extra.runner } : {}), ...(extra.presence ? { presence: extra.presence } : {}), pollGapMs: 1, retryMs: 1 });
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
  return { host, app, n, users, clients, secrets: box };
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
  const secrets = { get: (n) => box.get(n) || null, set: (n, v) => box.set(n, v), delete: (n) => box.delete(n) };
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

test("a token the other install no longer knows (set up again) is replaced by a new handshake, and the ask goes through", async () => {
  const hosts = {};
  const net = (url, init = {}) => { const u = new URL(url); return hosts[u.host].app.request(u.pathname, init); };
  const a = (hosts["a.example.org"] = install("a.example.org", net));
  const b = (hosts["b.example.org"] = install("b.example.org", net));
  const settle = () => new Promise((r) => setTimeout(r, 50));
  await a.n.hello("https://b.example.org");
  for (let i = 0; i < 10; i++) await settle();
  const before = a.secrets.get("network__b-example-org") ?? [...a.secrets.values()][0];
  assert.ok(before, "A holds a token for B");
  // B's data reset: every token it ever gave is gone.
  for (const c of b.clients) c.revoked = true;
  const r = await a.n.ask("b-example-org", "هنوز وصلیم؟");
  assert.equal(r.state, "completed");
  assert.match(r.answer, /from net-a-example-org/);
  assert.ok(b.clients.some((c) => !c.revoked), "B issued a fresh token");
});

// 2026-10-20: Jafari renamed her agent; colleagues kept the old name, and saw no logo or colour.
test("a member's rename, colour and logo are read again from its card, not only when we connected", async () => {
  const kv = new Map([["network:agents", { "b-example-org": { id: "b-example-org", url: "https://b.example.org", name: "قدیمی", owner: "خانم جعفری" } }]]);
  // 2026-10-24: Ghorbani renamed «مانا»; his chats on other installs stayed under the old peer label.
  const users = new Map([["net-b-example-org", { id: "net-b-example-org", label: "قدیمی (خانم جعفری)" }]]);
  const store = { getKv: (k) => kv.get(k) ?? null, setKv: (k, v) => kv.set(k, v), deleteKv: (k) => kv.delete(k), getPeerUser: (id) => users.get(id) || null, setPeerUserLabel: (id, label) => (users.get(id).label = label) };
  const secrets = { get: () => "grf_tokenforbxxxxxxxxxxxxxxxx", set() {}, delete() {} };
  const svg = '<svg viewBox="0 0 64 64"><rect width="64" height="64" fill="#0f766e"/><script>alert(1)</script></svg>';
  const card = { url: "https://b.example.org", name: "نو", latin: "Nou", owner: "خانم جعفری", product: "Karsara", color: "#0f766e" };
  const fetchFn = async (url) => {
    const path = new URL(url).pathname;
    if (path === "/api/public/network/card") return new Response(JSON.stringify(card), { headers: { "content-type": "application/json" } });
    if (path === "/icon.svg") return new Response(svg, { headers: { "content-type": "image/svg+xml" } });
    return new Response(JSON.stringify({ agents: [] }), { headers: { "content-type": "application/json" } });
  };
  const app = new Hono();
  const n = createNetwork({ store, peerAuth: {}, secrets, env: { GRIFFIN_NETWORK_DOMAINS: "example.org", GRIFFIN_NETWORK_SEEDS: "" }, publicUrl: () => "https://a.example.org", fetchFn, log: { log() {}, error() {} } });
  n.ownerRoutes(app);
  await n.refresh();
  const [b] = n.list();
  assert.equal(b.name, "نو");
  assert.equal(users.get("net-b-example-org").label, "نو (خانم جعفری)", "its chats are headed with the new name");
  assert.equal(b.color, "#0f766e");
  assert.match(b.icon, /^\/api\/network\/b-example-org\/icon\.svg\?v=[0-9a-f]{8}$/);
  const res = await app.request(b.icon);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "image/svg+xml");
  const body = await res.text();
  assert.match(body, /<rect/);
  assert.doesNotMatch(body, /script/, "an uploaded logo is rebuilt from an allowlist");
  // Renamed again, colour dropped: the next refresh follows.
  card.name = "نام تازه";
  delete card.color;
  await n.refresh();
  assert.equal(n.list()[0].name, "نام تازه");
  assert.equal(n.list()[0].color, null);
  assert.equal((await app.request("/api/network/nobody/icon.svg")).status, 404);
});

// Owner 2026-10-20: agents did not know another agent was updating, and went to Telegram at once.
function pair(extraB = {}) {
  const hosts = {};
  const sent = [];
  const net = (url, init = {}) => {
    const u = new URL(url);
    if (hosts[u.host].down) throw new TypeError("fetch failed");
    return hosts[u.host].app.request(u.pathname, init);
  };
  const runner = { isActive: () => false, send: async (chatId, msg) => sent.push({ chatId, text: msg.text }) };
  const a = (hosts["a.example.org"] = install("a.example.org", net, { chats: ["chat-1"], runner }));
  const b = (hosts["b.example.org"] = install("b.example.org", net, extraB));
  return { a, b, sent };
}
const connectPair = async (a) => {
  await a.n.hello("https://b.example.org");
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 30));
};
const waitFor = async (check, ms = 2000) => {
  const end = Date.now() + ms;
  while (Date.now() < end && !check()) await new Promise((r) => setTimeout(r, 5));
};

test("a member that is stopping for an update says so; a message to it waits and goes when it is back", async () => {
  const { a, b, sent } = pair({ presence: () => ({ commit: "abc123456789", activeRuns: 2 }) });
  await connectPair(a);
  const card = await (await b.app.request("/api/public/network/card")).json();
  assert.equal(card.presence.state, "ready");
  assert.equal(card.presence.commit, "abc123456789");

  await b.n.leave(); // B's SIGTERM: it tells A first
  assert.equal(a.n.statusOf("b-example-org").state, "updating");
  assert.equal((await (await b.app.request("/api/public/network/card")).json()).presence.state, "updating");
  b.down = true;

  const r = await a.n.tools("chat-1").network_ask.execute({ agent: "b-example-org", message: "سلام" });
  assert.equal(r.state, "queued");
  assert.equal(r.agentStatus, "updating");
  assert.match(r.note, /Telegram/);
  assert.equal(a.n.pending("chat-1"), 1);
  assert.equal(a.n.list().find((x) => x.id === "b-example-org").status.state, "updating");
  assert.equal(a.n.list().find((x) => x.id === "b-example-org").queued, 1);
  assert.equal(sent.length, 0);

  b.down = false;
  await b.n.arrive(); // back up: «ready» reaches A, which sends what waited
  await waitFor(() => sent.length);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].chatId, "chat-1");
  assert.ok(sent[0].text.startsWith("[گزارش خودکار زیرکارها"));
  assert.match(sent[0].text, /در صف ماند/);
  assert.match(sent[0].text, /b\.example\.org got: سلام from net-a-example-org/);
  assert.equal(a.n.pending("chat-1"), 0);
  assert.equal(a.n.statusOf("b-example-org").state, "ready");
});

test("an outage nobody announced is seen by the probe (unreachable, then down); asking meanwhile queues instead of losing the message", async () => {
  const { a, b, sent } = pair();
  await connectPair(a);
  b.down = true;
  await a.n.probeAll();
  assert.equal(a.n.statusOf("b-example-org").state, "unreachable");
  const r = await a.n.tools("chat-1").network_ask.execute({ agent: "b-example-org", message: "وضعیت؟" });
  assert.equal(r.state, "queued");
  await a.n.probeAll();
  await a.n.probeAll();
  assert.equal(a.n.statusOf("b-example-org").state, "down");
  assert.equal(sent.length, 0);
  b.down = false;
  await a.n.probeAll(); // the card answers again: ready, and the queue is sent
  await waitFor(() => sent.length);
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /b\.example\.org got: وضعیت؟/);
});

// 2026-10-21: four installs with no engine at all held colleagues' requests for days.
test("a member with no engine set up says so, and asking it fails at once instead of waiting there", async () => {
  const { a, sent } = pair({ presence: () => ({ canThink: false, noEngine: true }) });
  await connectPair(a);
  await a.n.probeAll();
  assert.equal(a.n.statusOf("b-example-org").noEngine, true);
  await assert.rejects(a.n.tools("chat-1").network_ask.execute({ agent: "b-example-org", message: "سلام" }), /no AI engine/);
  assert.equal(sent.length, 0);
});

test("without a chat to wake, asking an updating member fails with the reason instead of queueing", async () => {
  const { a, b } = pair();
  await connectPair(a);
  await b.n.leave();
  b.down = true;
  await assert.rejects(a.n.ask("b-example-org", "x"), /updating/);
  assert.equal(a.n.pending("chat-1"), 0);
});

test("only the member itself may announce its state, and only by the token it was given", async () => {
  const { a, b } = pair();
  await connectPair(a);
  const post = (body, token) => a.app.request("/api/public/network/status", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
  const tokenOfB = b.secrets.get("network/a-example-org");
  assert.equal((await post({ from: "https://b.example.org", state: "updating" }, "grf_nope_nope_nope_nope_nope_nope")).status, 401);
  assert.equal((await post({ from: "https://c.example.org", state: "updating" }, tokenOfB)).status, 403, "B cannot speak for C");
  assert.equal((await post({ from: "https://b.example.org", state: "gone" }, tokenOfB)).status, 400);
  assert.equal((await post({ from: "https://b.example.org", state: "updating" }, tokenOfB)).status, 200);
  assert.equal(a.n.statusOf("b-example-org").state, "updating");
});

test("the follow of a task keeps waiting while its member restarts, instead of giving up", async () => {
  const kv = new Map([["network:agents", { "b-example-org": { id: "b-example-org", url: "https://b.example.org", name: "نوا" } }]]);
  const store = { getKv: (k) => kv.get(k) ?? null, setKv: (k, v) => kv.set(k, v), deleteKv: (k) => kv.delete(k), getChat: () => ({ id: "chat-1" }) };
  const secrets = { get: () => "grf_tokenforbxxxxxxxxxxxxxxxx", set() {} };
  let phase = 0;
  const reply = (r) => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: JSON.stringify(r) }] } }), { headers: { "content-type": "application/json" } });
  const fetchFn = async (url, init) => {
    if (String(url).endsWith("/card")) {
      if (phase < 40) throw new TypeError("fetch failed");
      return new Response(JSON.stringify({ presence: { state: "ready" } }), { headers: { "content-type": "application/json" } });
    }
    const { params } = JSON.parse(init.body);
    if (params.name === "griffin_send") return reply({ taskId: "t1", contextId: "c1", state: "working", seq: 1 });
    phase += 1;
    if (phase < 30) throw new TypeError("fetch failed"); // 30 failed polls: far past the 20-error limit
    return reply({ taskId: "t1", state: "completed", seq: 5, answer: "تمام شد" });
  };
  const sent = [];
  const runner = { isActive: () => false, send: async (chatId, msg) => sent.push({ chatId, text: msg.text }) };
  const n = createNetwork({ store, peerAuth: {}, secrets, runner, env: { GRIFFIN_NETWORK_SEEDS: "" }, publicUrl: () => "https://a.example.org", fetchFn, log: { log() {}, error() {} }, pollGapMs: 1, retryMs: 1 });
  const r = await n.tools("chat-1").network_ask.execute({ agent: "b-example-org", message: "کار طولانی" });
  assert.notEqual(r.state, "completed");
  assert.equal(r.state, "working", "the task was sent; the member went away while it worked");
  kv.set("network:status", { "b-example-org": { state: "unreachable", failures: 1 } }); // what the minute probe records
  await waitFor(() => sent.length, 4000);
  assert.equal(sent.length, 1, "the result came after the restart");
  assert.match(sent[0].text, /تمام شد/);
});

test("a member whose public name moved is followed to the new name, token and all", async () => {
  const hosts = {};
  const moved = new Set();
  const net = (url, init = {}) => {
    const u = new URL(url);
    // The old name redirects browser-style GETs to the new one, as app.mjs does for OLD_HOSTS.
    if (moved.has(u.host) && (init.method || "GET") === "GET") return new Response(null, { status: 301, headers: { location: `https://new-b.example.org${u.pathname}` } });
    const h = moved.has(u.host) ? "new-b.example.org" : u.host;
    return hosts[h].app.request(u.pathname, init);
  };
  const a = (hosts["a.example.org"] = install("a.example.org", net));
  let bName = "old-b.example.org";
  const b = install("old-b.example.org", net);
  hosts["old-b.example.org"] = b;
  const settle = () => new Promise((r) => setTimeout(r, 50));
  await a.n.hello("https://old-b.example.org");
  for (let i = 0; i < 20; i++) await settle();
  assert.deepEqual(a.n.connected().map((x) => x.url), ["https://old-b.example.org"]);
  const token = a.secrets.get(`network/${agentId("old-b.example.org")}`) || [...a.secrets.values()][0];
  assert.ok(token);

  // B is renamed: same install, new public name; the old name now redirects.
  const b2 = install("new-b.example.org", net);
  b2.clients.push(...b.clients);
  hosts["new-b.example.org"] = b2;
  moved.add("old-b.example.org");
  bName = "new-b.example.org";
  await a.n.refresh();
  for (let i = 0; i < 10; i++) await settle();
  const urls = a.n.connected().map((x) => x.url);
  assert.deepEqual(urls, ["https://new-b.example.org"], "one entry, at the new name");
  assert.equal([...a.secrets.values()].includes(token), true, "the token we held came along");
  const r = await a.n.ask(agentId(bName), "سلام");
  assert.equal(r.state, "completed");
});
