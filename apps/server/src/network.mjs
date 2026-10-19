// The agents' network (owner 2026-10-17: «ایجنت دیسکاوری… بشه ایجنتای بقیه بچه ها رو دید و باهاشون چت کرد.
// توی شبکه هر کس ایجنتایی که دیسکاور کرده رو به بقیه هم معرفی کنه»).
//
// Every install has a public card (/api/public/network/card) and lists the agents it is connected
// to (/peers). Two installs connect with a handshake in which a token only ever travels to the
// address of the install it was made for:
//   A → B  POST /hello {url: A}       (A remembers it asked B)
//   B: reads A's card at A's own address, makes a peer user net-<A> with the default read-only
//      quota and a fresh MCP token, and POSTs it to A's /token — so only the real A receives it;
//      B also says hello back, which gets B its own token for A.
//   A: takes a token only from an address it said hello to (10 minutes), checks it on B's /mcp,
//      keeps it in its secret store, then reads B's /peers and says hello to every agent it did not
//      know: one new agent that meets one member meets the whole network at once, and every member
//      meets the new one (it says hello to all of them).
// Only https addresses on the company's domains are accepted (GRIFFIN_NETWORK_DOMAINS). Talking to
// a member is its MCP (griffin_send/griffin_wait/griffin_reply): the member's agent answers within
// the default peer quota, and anything gated still waits for its own owner.
//
// A request the member did not finish within network_ask's wait (still working, or waiting for its
// own owner's approval) is followed in the background, and its end wakes the chat that asked, the
// way a delegated subtask does (otherwise an agent that got «auth-required» ends its turn and never
// hears the result that comes later).
import { OWNER, PERSONA } from "./persona.mjs";
import { currentProduct } from "./identity.mjs";

const PENDING_MS = 10 * 60_000;
const REFRESH_MS = 30 * 60_000;
const KV = "network:agents";
const ctxKey = (id) => `network:ctx:${id}`;
const pendingKey = (host) => `network:pending:${host}`;
const FOLLOWS = "network:follows";
const OPEN = new Set(["submitted", "working", "auth-required"]);
// A member's owner may answer an approval hours later (its own TTL is 6 h); past that, give up.
const FOLLOW_MAX_MS = 8 * 3600_000;
const FOLLOW_MAX_ERRORS = 20;
// The wake text starts like a delegate report so the app treats it the same (push, relays, desk).
export const NETWORK_REPORT_PREFIX = "[گزارش خودکار زیرکارها — شبکهٔ ایجنت‌ها";
const secretName = (id) => `network/${id}`;

export const NETWORK_TOOLS = ["network_agents", "network_ask", "network_reply"];

/** host → id ("agent.example.com" → "agent-example-com"), the peer user is net-<id>. */
export const agentId = (host) => String(host).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 36);

/** The origin of an address that may join, or null. */
export function allowedOrigin(raw, domains) {
  let u;
  try {
    u = new URL(String(raw || "").trim());
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.username || u.password || (u.port && u.port !== "443")) return null;
  const host = u.hostname.toLowerCase();
  return domains.some((d) => host === d || host.endsWith(`.${d}`)) ? `https://${host}` : null;
}

export function createNetwork({ store, peerAuth, secrets, runner = null, env = {}, publicUrl = () => "", enabled = () => true, fetchFn = globalThis.fetch, log = console, now = () => Date.now(), pollGapMs = 5_000, retryMs = 30_000 }) {
  const domains = String(env.GRIFFIN_NETWORK_DOMAINS || "").split(",").map((d) => d.trim().toLowerCase()).filter(Boolean);
  const seeds = String(env.GRIFFIN_NETWORK_SEEDS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  // Off (config NETWORK=off, e.g. a trial install beside the live one of the same owner): no card,
  // every hello and token refused, nothing asked — as if this install had no public address.
  const self = () => (enabled() ? allowedOrigin(publicUrl(), domains) : null);
  const agents = () => store.getKv(KV) || {};
  const saveAgent = (id, patch) => {
    const all = agents();
    all[id] = { ...(all[id] || { id, firstSeen: new Date(now()).toISOString() }), ...patch };
    store.setKv(KV, all);
    return all[id];
  };

  function card() {
    const p = currentProduct();
    return { url: self(), name: PERSONA.name, latin: PERSONA.latin, owner: OWNER.fullNameFa || OWNER.nameFa || OWNER.fullName, product: p.latin };
  }

  async function getJson(url, { method = "GET", body, headers = {}, timeoutMs = 15_000 } = {}) {
    const res = await fetchFn(url, {
      method,
      headers: { ...(body ? { "content-type": "application/json" } : {}), accept: "application/json", ...headers },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "error",
    });
    if (!res.ok) throw new Error(`http ${res.status}`);
    return res.json();
  }

  /** Ask an install to join (seed, a member's list, or the owner typing an address). */
  async function hello(raw) {
    const origin = allowedOrigin(raw, domains);
    const me = self();
    if (!origin || !me || origin === me) return { ok: false, reason: !me ? "this install has no public https address" : "address not allowed" };
    store.setKv(pendingKey(new URL(origin).host), now());
    try {
      await getJson(`${origin}/api/public/network/hello`, { method: "POST", body: { url: me } });
      return { ok: true };
    } catch (error) {
      saveAgent(agentId(new URL(origin).host), { url: origin, lastError: String(error.message).slice(0, 80) });
      return { ok: false, reason: String(error.message) };
    }
  }

  // Someone says hello: their card from their own address, a token for them to their own address.
  async function onHello(raw) {
    const origin = allowedOrigin(raw, domains);
    const me = self();
    if (!origin || !me || origin === me) return;
    const host = new URL(origin).host;
    const id = agentId(host);
    const theirs = await getJson(`${origin}/api/public/network/card`);
    if (allowedOrigin(theirs?.url, domains) !== origin) throw new Error("card address mismatch");
    const user = `net-${id}`.slice(0, 41);
    const label = `${String(theirs.name || id).slice(0, 40)}${theirs.owner ? ` (${String(theirs.owner).slice(0, 36)})` : ""}`;
    if (!store.getPeerUser(user)) peerAuth.createUser({ id: user, label });
    // The old token stays until the new one is taken: a hello someone else sends in their name is
    // refused at their end (no hello pending there) and must not cut the link that works.
    const old = store.listPeerClients(user).filter((c) => !c.revoked_at);
    const { id: fresh, token } = peerAuth.issueClient(user, { label: "network" });
    try {
      await getJson(`${origin}/api/public/network/token`, { method: "POST", body: { from: me, token } });
    } catch (error) {
      store.revokePeerClient(user, fresh);
      throw error;
    }
    for (const c of old) store.revokePeerClient(user, c.id);
    saveAgent(id, { url: origin, name: theirs.name, latin: theirs.latin, owner: theirs.owner, product: theirs.product, lastSeen: new Date(now()).toISOString() });
    if (!secrets.get(secretName(id))) await hello(origin);
  }

  // A token for us: only from an address we said hello to, and only one that opens its /mcp.
  async function onToken({ from, token }) {
    const origin = allowedOrigin(from, domains);
    if (!enabled()) throw new Error("network is off on this install");
    if (!origin || typeof token !== "string" || !/^grf_[\w-]{20,}$/.test(token)) throw new Error("bad token");
    const host = new URL(origin).host;
    const asked = Number(store.getKv(pendingKey(host)) || 0);
    if (!asked || now() - asked > PENDING_MS) throw new Error("no hello pending");
    await mcp(origin, token, "tools/list", {});
    const theirs = await getJson(`${origin}/api/public/network/card`).catch(() => ({}));
    const id = agentId(host);
    secrets.set(secretName(id), token, { note: `network: ${origin}` });
    store.deleteKv(pendingKey(host));
    saveAgent(id, { url: origin, name: theirs.name, latin: theirs.latin, owner: theirs.owner, product: theirs.product, lastSeen: new Date(now()).toISOString(), lastError: null });
    log.log?.(`[network] connected to ${host}`);
    gossip(origin).catch(() => {});
  }

  // Everyone a member knows that we do not, at once.
  async function gossip(origin) {
    const list = await getJson(`${origin}/api/public/network/peers`);
    const known = agents();
    for (const a of Array.isArray(list?.agents) ? list.agents : []) {
      const o = allowedOrigin(a?.url, domains);
      if (!o || o === self()) continue;
      const id = agentId(new URL(o).host);
      if (known[id] && secrets.get(secretName(id))) continue;
      await hello(o);
    }
  }

  /** The agents we can talk to (a token for them) — what /peers tells others. */
  function connected() {
    return Object.values(agents()).filter((a) => a.url && secrets.get(secretName(a.id)));
  }

  async function mcp(origin, token, method, params) {
    const out = await getJson(`${origin}/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: { jsonrpc: "2.0", id: Date.now(), method, params },
      timeoutMs: 30_000,
    });
    if (out?.error) throw new Error(String(out.error.message || "mcp error"));
    return out?.result;
  }
  async function call(id, name, args) {
    if (!enabled()) throw new Error("the agents' network is off on this install (config NETWORK)");
    const a = agents()[id];
    const token = secrets.get(secretName(id));
    if (!a?.url || !token) throw new Error(`not connected to ${id}`);
    const result = await mcp(a.url, token, "tools/call", { name, arguments: args });
    const text = result?.content?.[0]?.text || "{}";
    if (result?.isError) throw new Error(text.slice(0, 300));
    saveAgent(id, { lastSeen: new Date(now()).toISOString() });
    return JSON.parse(text);
  }
  // A plain POST to a member's own route, with the token it gave us (feedback.mjs).
  async function post(id, pathname, body) {
    if (!enabled()) throw new Error("the agents' network is off on this install (config NETWORK)");
    const a = agents()[id];
    const token = secrets.get(secretName(id));
    if (!a?.url || !token) throw new Error(`not connected to ${id}`);
    return getJson(`${a.url}${pathname}`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body, timeoutMs: 30_000 });
  }
  // Follow a task until it ends, needs an answer, or maxMs passes (then the taskId comes back).
  async function follow(id, first, maxMs) {
    let r = first;
    const end = now() + maxMs;
    while (["submitted", "working"].includes(r.state) && now() < end) {
      r = await call(id, "griffin_wait", { taskId: r.taskId, afterSeq: r.seq || 0, waitSec: 12 });
    }
    if (r.contextId) store.setKv(ctxKey(id), r.contextId);
    return r;
  }
  const brief = (r) => ({
    state: r.state,
    taskId: r.taskId,
    ...(r.answer ? { answer: r.answer } : {}),
    ...(r.question ? { question: r.question } : {}),
    ...(r.state === "auth-required" ? { note: "waits for that agent's own owner to approve" } : {}),
    ...(["submitted", "working"].includes(r.state) ? { note: "still working; call network_reply with this taskId and an empty answer to keep waiting" } : {}),
  });

  // Background follow of a request that outlived the wait: taskId → { agent, taskId, chatId, seq, since }.
  const follows = () => store.getKv(FOLLOWS) || {};
  const saveFollows = (all) => store.setKv(FOLLOWS, all);
  const running = new Set();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms).unref?.());
  const pending = (chatId) => Object.values(follows()).filter((f) => f.chatId === chatId).length;
  function untrack(taskId) {
    const all = follows();
    if (!all[taskId]) return;
    delete all[taskId];
    saveFollows(all);
  }
  function track(chatId, id, r) {
    if (!runner || !chatId || !r?.taskId || !OPEN.has(r.state)) return false;
    const all = follows();
    all[r.taskId] = { agent: id, taskId: r.taskId, chatId, seq: r.seq || 0, since: all[r.taskId]?.since || new Date(now()).toISOString() };
    saveFollows(all);
    loop(r.taskId);
    return true;
  }

  function reportText(f, r, failure) {
    const a = agents()[f.agent] || {};
    const who = `${a.name || f.agent}${a.owner ? ` (${a.owner})` : ""}`;
    const head = `${NETWORK_REPORT_PREFIX} — پاسخ «${who}» به درخواست taskId ${f.taskId}؛ این پیام را سیستم فرستاده، نه Owner]\n\n`;
    if (failure) return `${head}دنبال کردن این درخواست متوقف شد: ${failure}. اگر هنوز لازم است، با network_reply {agent: "${f.agent}", taskId: "${f.taskId}"} وضعیتش را بپرس.`;
    const body =
      r.state === "input-required"
        ? `آن ایجنت سؤالی پرسیده: ${r.question?.text || "(بدون متن)"}${r.question?.options?.length ? `\nگزینه‌ها: ${r.question.options.join(" · ")}` : ""}\nجواب را با network_reply {agent: "${f.agent}", taskId: "${f.taskId}", answer} بده.`
        : `وضعیت: ${r.state}${r.reason ? ` (${r.reason})` : ""}\n\n${String(r.answer || r.partialAnswer || "(بدون متن)").slice(-3_000)}`;
    return `${head}${body}\n\nاین نتیجه را برای کسی که کار را خواسته جمع‌بندی کن (نتیجه اول).`;
  }

  async function deliver(f, text) {
    for (let i = 0; i < 10; i += 1) {
      if (store.getChat && !store.getChat(f.chatId)) return;
      try {
        await runner.send(f.chatId, { text, images: [], intent: runner.isActive(f.chatId) ? "queue" : "send" });
        return;
      } catch (error) {
        log.error?.(`[network] wake ${f.chatId}: ${error?.message || error}`);
        await sleep(retryMs);
      }
    }
  }

  async function loop(taskId) {
    if (running.has(taskId)) return;
    running.add(taskId);
    let errors = 0;
    try {
      for (;;) {
        const f = follows()[taskId];
        if (!f) return;
        if (store.getChat && !store.getChat(f.chatId)) return untrack(taskId);
        if (now() - Date.parse(f.since) > FOLLOW_MAX_MS) {
          untrack(taskId);
          return deliver(f, reportText(f, null, "بعد از ۸ ساعت هنوز تمام نشده بود"));
        }
        let r;
        try {
          r = await call(f.agent, "griffin_wait", { taskId, afterSeq: f.seq || 0, waitSec: 12 });
          errors = 0;
        } catch (error) {
          errors += 1;
          if (errors >= FOLLOW_MAX_ERRORS || /unknown taskId|not connected/.test(String(error?.message))) {
            untrack(taskId);
            return deliver(f, reportText(f, null, String(error?.message || error).slice(0, 200)));
          }
          await sleep(retryMs);
          continue;
        }
        if (!follows()[taskId]) return; // answered in the foreground meanwhile (network_reply)
        if (!OPEN.has(r.state)) {
          untrack(taskId);
          return deliver(f, reportText(f, r));
        }
        if (r.seq) saveFollows({ ...follows(), [taskId]: { ...f, seq: r.seq } });
        await sleep(r.state === "auth-required" ? retryMs : pollGapMs);
      }
    } finally {
      running.delete(taskId);
    }
  }
  // After a restart: pick up the requests that were still being followed.
  function recover() {
    for (const taskId of Object.keys(follows())) loop(taskId).catch((e) => log.error?.(`[network] follow ${taskId}: ${e.message}`));
  }
  // What the asking model is told when the answer is not in yet.
  function handed(chatId, id, r) {
    const out = brief(r);
    if (OPEN.has(r.state) && track(chatId, id, r)) {
      out.note = `${r.state === "auth-required" ? "waits for that agent's own owner to approve. " : "still working. "}` +
        "Its answer comes back to THIS chat by itself as «[گزارش خودکار زیرکارها — شبکهٔ ایجنت‌ها …]» — tell the asker it is in progress and end your turn; do not ask again or poll.";
    } else if (r.taskId) untrack(r.taskId);
    return out;
  }

  async function ask(id, message, { fresh = false, maxMs = 4 * 60_000, chatId = null } = {}) {
    const contextId = fresh ? null : store.getKv(ctxKey(id));
    let r;
    try {
      r = await call(id, "griffin_send", { message: String(message), ...(contextId ? { contextId } : {}), waitSec: 12 });
    } catch (error) {
      // An old conversation that is busy or gone: start a new one.
      if (!contextId) throw error;
      r = await call(id, "griffin_send", { message: String(message), waitSec: 12 });
    }
    const out = await follow(id, r, maxMs);
    return chatId ? handed(chatId, id, out) : brief(out);
  }
  async function reply(id, taskId, answer, { maxMs = 4 * 60_000, chatId = null } = {}) {
    const r = answer ? await call(id, "griffin_reply", { taskId, answer: String(answer), waitSec: 12 }) : await call(id, "griffin_wait", { taskId, waitSec: 12 });
    const out = await follow(id, r, maxMs);
    return chatId ? handed(chatId, id, out) : brief(out);
  }

  function list() {
    return Object.values(agents())
      .filter((a) => a.url)
      .map((a) => ({ id: a.id, url: a.url, name: a.name || a.id, latin: a.latin || "", owner: a.owner || "", product: a.product || "", connected: Boolean(secrets.get(secretName(a.id))), lastSeen: a.lastSeen || null, ...(a.lastError ? { lastError: a.lastError } : {}) }));
  }

  async function refresh() {
    if (!self()) return;
    for (const s of seeds) {
      const o = allowedOrigin(s, domains);
      if (o && o !== self() && !secrets.get(secretName(agentId(new URL(o).host)))) await hello(o).catch(() => {});
    }
    for (const a of connected()) await gossip(a.url).catch((e) => saveAgent(a.id, { lastError: String(e.message).slice(0, 80) }));
  }

  const hits = new Map();
  const limited = (ip) => {
    const t = now();
    const recent = (hits.get(ip) || []).filter((x) => t - x < 60_000);
    recent.push(t);
    hits.set(ip, recent);
    return recent.length > 30;
  };
  function routes(app) {
    app.get("/api/public/network/card", (c) => (self() ? c.json(card()) : c.json({ error: "no public address" }, 404)));
    app.get("/api/public/network/peers", (c) => c.json({ agents: connected().map(({ url, name, latin, owner, product }) => ({ url, name, latin, owner, product })) }));
    app.post("/api/public/network/hello", async (c) => {
      if (limited(c.req.header("x-forwarded-for") || "direct")) return c.json({ error: "rate limited" }, 429);
      const body = await c.req.json().catch(() => ({}));
      if (!allowedOrigin(body.url, domains)) return c.json({ error: "address not allowed" }, 400);
      // Answered at once; the token goes to the caller's own address (onHello).
      onHello(body.url).catch((e) => log.error?.(`[network] hello from ${body.url}: ${e.message}`));
      return c.json({ ok: true });
    });
    app.post("/api/public/network/token", async (c) => {
      if (limited(c.req.header("x-forwarded-for") || "direct")) return c.json({ error: "rate limited" }, 429);
      const body = await c.req.json().catch(() => ({}));
      try {
        await onToken(body);
        return c.json({ ok: true });
      } catch (error) {
        return c.json({ error: String(error.message) }, 400);
      }
    });
  }
  function ownerRoutes(api) {
    api.get("/api/network", (c) => c.json({ self: self() ? card() : null, off: !enabled(), agents: list() }));
    api.post("/api/network/connect", async (c) => {
      const body = await c.req.json().catch(() => ({}));
      return c.json(await hello(body.url));
    });
    api.post("/api/network/refresh", async (c) => {
      await refresh();
      return c.json({ agents: list() });
    });
    api.post("/api/network/:id/ask", async (c) => {
      const body = await c.req.json().catch(() => ({}));
      try {
        const r = body.taskId ? await reply(c.req.param("id"), body.taskId, body.answer || "") : await ask(c.req.param("id"), body.message || "", { fresh: Boolean(body.fresh) });
        return c.json(r);
      } catch (error) {
        return c.json({ error: String(error.message) }, 502);
      }
    });
  }

  // The owner's own chats: see the network and talk to it. chatId: the chat a late answer wakes.
  function tools(chatId = null) {
    return {
      network_agents: {
        description: "The colleagues' agents this install is connected to (the agents' network): id, name, owner, product, address. Talk to one with network_ask.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        async execute() {
          return { agents: list() };
        },
      },
      network_ask: {
        description:
          "Send a message to a colleague's agent on the network (id from network_agents) and wait up to ~4 minutes for its answer. " +
          "The conversation with that agent continues across calls; fresh=true starts a new one. It answers within what its own " +
          "owner allows; an action it needs approval for waits for that owner (state auth-required). A question back comes as state input-required: answer with network_reply. " +
          "If the answer is not in when the wait ends (working or auth-required), it comes back to this chat by itself as «[گزارش خودکار زیرکارها — شبکهٔ ایجنت‌ها …]» — end your turn, do not ask again.",
        inputSchema: {
          type: "object",
          properties: { agent: { type: "string" }, message: { type: "string" }, fresh: { type: "boolean" } },
          required: ["agent", "message"],
          additionalProperties: false,
        },
        async execute({ agent, message, fresh }) {
          return ask(String(agent), String(message), { fresh: Boolean(fresh), chatId });
        },
      },
      network_reply: {
        description: "Answer a network agent's question (taskId from network_ask), or with an empty answer keep waiting for a task still working.",
        inputSchema: {
          type: "object",
          properties: { agent: { type: "string" }, taskId: { type: "string" }, answer: { type: "string" } },
          required: ["agent", "taskId"],
          additionalProperties: false,
        },
        async execute({ agent, taskId, answer }) {
          return reply(String(agent), String(taskId), String(answer || ""), { chatId });
        },
      },
    };
  }

  function start() {
    const tick = () => refresh().catch((e) => log.error?.(`[network] refresh: ${e.message}`));
    setTimeout(tick, 30_000).unref?.();
    setInterval(tick, REFRESH_MS).unref?.();
    recover();
  }

  return { card, hello, onHello, onToken, gossip, list, ask, reply, post, refresh, routes, ownerRoutes, tools, start, connected, pending, recover };
}
