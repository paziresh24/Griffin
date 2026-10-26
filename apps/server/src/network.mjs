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
//
// Presence (owner 2026-10-20: «ایجنتا نمیفهمن که ایجنتی در حال آپدیته … و سریع می‌رن سراغ تلگرام»): the card
// says whether an install is ready or updating, a member that stops to restart tells the others
// first (POST /status on SIGTERM, and «ready» when it is back), and every minute each member's card
// is read, so «ready / updating / unreachable / down» is known before anyone asks. A message to a
// member that is not ready waits in an outbox and goes by itself when it is back; its answer wakes the
// chat like any other — Telegram is never the way around an update.
import { randomUUID } from "node:crypto";
import { OWNER, PERSONA } from "./persona.mjs";
import { currentProduct } from "./identity.mjs";
import { isColor, sanitizeSvg } from "./brand.mjs";
import { createHash } from "node:crypto";

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

export const NETWORK_TOOLS = ["network_agents", "network_ask", "network_reply", "network_connect"];

const STATUS = "network:status";
const OUTBOX = "network:outbox";
const PROBE_MS = 60_000;
// An announced restart is believed this long; the member's «ready» (or a good probe) ends it sooner.
export const UPDATE_ETA_MS = 6 * 60_000;
const DOWN_AFTER = 3; // failed probes in a row before «unreachable» becomes «down»
const OUTBOX_MAX_MS = 6 * 3600_000;
const OUTBOX_MAX = 40;
// A request that did not reach the member because it is restarting or off the net — not a refusal.
export const isDownError = (error) =>
  /fetch failed|ECONN|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|timed? ?out|aborted|socket|http (404|408|502|503|504|52\d)\b/i.test(`${error?.name || ""} ${error?.message || ""} ${error?.cause?.code || ""}`);

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

/** "<agent> (<owner>)": how a member's peer user is labelled on this install. */
const memberLabel = (theirs, id) => `${String(theirs.name || id).slice(0, 40)}${theirs.owner ? ` (${String(theirs.owner).slice(0, 36)})` : ""}`;

// A member's skills as we keep them: strings only, bounded (its card is another install's words).
function cleanSkills(sk) {
  if (!sk || typeof sk !== "object") return null;
  const str = (v) => String(v || "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, 120);
  const arr = (v, n) => (Array.isArray(v) ? v.map(str).filter(Boolean).slice(0, n) : []);
  return { ...(sk.role ? { role: str(sk.role) } : {}), ...(sk.summary ? { summary: str(sk.summary) } : {}), repos: arr(sk.repos, 40), knows: arr(sk.knows, 80) };
}

export function createNetwork({ store, peerAuth, secrets, runner = null, env = {}, publicUrl = () => "", brandColor = () => null, skills = () => null, enabled = () => true, presence = () => ({}), fetchFn = globalThis.fetch, log = console, now = () => Date.now(), pollGapMs = 5_000, retryMs = 30_000, relinkMs = 20_000, probeMs = PROBE_MS }) {
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

  const bootAt = new Date(now()).toISOString();
  let leaving = null; // { until } while this install is stopping to restart
  /** What this install says about itself: ready, or updating (stopping to restart). */
  function selfPresence() {
    const extra = presence() || {};
    return { state: leaving ? "updating" : "ready", ...(leaving ? { until: leaving.until } : {}), startedAt: bootAt, ...extra };
  }
  function card({ withSkills = false } = {}) {
    const p = currentProduct();
    const color = brandColor();
    // The logo is not in the card: it is read from the install's own /icon.svg (syncCard).
    let sk = null;
    if (withSkills) try { sk = skills(); } catch {}
    return { url: self(), name: PERSONA.name, latin: PERSONA.latin, owner: OWNER.fullNameFa || OWNER.nameFa || OWNER.fullName, product: p.latin, presence: selfPresence(), ...(isColor(color) ? { color } : {}), ...(sk ? { skills: sk } : {}) };
  }

  // What a member shows of itself (name, owner, colour, logo) is read again from its own card: a
  // rename or a new logo there reaches this list, not only at the moment we connected (2026-10-20:
  // A colleague renamed her agent; colleagues kept seeing the old name, and no logo or colour at all).
  const iconKey = (id) => `network:icon:${id}`;
  const safeColor = (value) => (isColor(value) ? String(value).trim() : null);
  async function readIcon(origin) {
    const res = await fetchFn(`${origin}/icon.svg`, { headers: { accept: "image/svg+xml" }, signal: AbortSignal.timeout(10_000), redirect: "error" });
    if (!res.ok) return null;
    const svg = sanitizeSvg(await res.text()); // served from our own origin below, so rebuilt from an allowlist
    return svg;
  }
  async function syncCard(id) {
    const a = agents()[id];
    const origin = allowedOrigin(a?.url, domains);
    if (!origin) return;
    const token = secrets.get(secretName(id));
    const theirs = await getJson(`${origin}/api/public/network/card`, token ? { headers: { authorization: `Bearer ${token}` } } : {});
    if (allowedOrigin(theirs?.url, domains) !== origin) throw new Error("card address mismatch");
    // The peer user's label is what its chats are listed and headed under: a rename reaches them too.
    const user = `net-${id}`.slice(0, 41);
    const label = memberLabel(theirs, id);
    if (theirs.name && store.getPeerUser?.(user) && store.getPeerUser(user).label !== label) store.setPeerUserLabel(user, label);
    saveAgent(id, { name: theirs.name || a.name, latin: theirs.latin || a.latin, owner: theirs.owner || a.owner, product: theirs.product || a.product, color: safeColor(theirs.color), skills: cleanSkills(theirs.skills), lastSeen: new Date(now()).toISOString(), lastError: null });
    try {
      const svg = await readIcon(origin);
      if (svg) store.setKv(iconKey(id), { svg, v: createHash("sha1").update(svg).digest("hex").slice(0, 8) });
    } catch {
      // no logo (or an unusable one): the list falls back to the name's first letter
    }
  }
  // A member whose public name moved (its old name answers GETs with a redirect, app.mjs OLD_HOSTS):
  // follow it once, check the new name's card says so itself, and carry the entry over — the token
  // we hold, the logo — so the list does not keep a dead twin (2026-10-24: karsara-* → griffin-*).
  async function movedTo(id) {
    const a = agents()[id];
    const origin = allowedOrigin(a?.url, domains);
    if (!origin) return null;
    const res = await fetchFn(`${origin}/api/public/network/card`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15_000), redirect: "manual" });
    if (![301, 302, 307, 308].includes(res.status)) return null;
    const to = allowedOrigin(new URL(res.headers.get("location") || "", origin).origin, domains);
    if (!to || to === origin || to === self()) return null;
    const theirs = await getJson(`${to}/api/public/network/card`);
    if (allowedOrigin(theirs?.url, domains) !== to) return null;
    const newId = agentId(new URL(to).host);
    const all = agents();
    if (!all[newId]) all[newId] = { ...all[id], id: newId, url: to, lastError: null };
    delete all[id];
    store.setKv(KV, all);
    const token = secrets.get(secretName(id));
    if (token && !secrets.get(secretName(newId))) secrets.set(secretName(newId), token, { note: `network: ${to}` });
    secrets.delete?.(secretName(id));
    const icon = store.getKv(iconKey(id));
    if (icon && !store.getKv(iconKey(newId))) store.setKv(iconKey(newId), icon);
    store.deleteKv?.(iconKey(id));
    log.log?.(`[network] ${origin} moved to ${to}`);
    return newId;
  }
  let syncedAt = 0;
  async function syncCards({ force = false } = {}) {
    if (!force && now() - syncedAt < 60_000) return;
    syncedAt = now();
    for (const a of connected()) {
      await syncCard(a.id).catch(async (e) => {
        const moved = await movedTo(a.id).catch(() => null);
        if (moved) return syncCard(moved).catch((e2) => saveAgent(moved, { lastError: String(e2.message).slice(0, 80) }));
        saveAgent(a.id, { lastError: String(e.message).slice(0, 80) });
      });
    }
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
    if (!store.getPeerUser(user)) peerAuth.createUser({ id: user, label: memberLabel(theirs, id) });
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
    syncCard(id).catch(() => {});
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
  // The token we hold was refused (their install was set up again, its data reset): drop it, say
  // hello again — they send a fresh one to our own address — and wait for it. Before this a dead
  // token stayed for good, since refresh() only greets members we hold no token for (2026-10-20:
  // every ask from a colleague's install to another's came back 401).
  async function relink(id, url) {
    secrets.delete?.(secretName(id));
    saveAgent(id, { lastError: "token refused (401): reconnecting" });
    const said = await hello(url);
    if (!said.ok) throw new Error(`${id} refused our token and a new hello failed: ${said.reason}`);
    const end = now() + relinkMs;
    while (!secrets.get(secretName(id))) {
      if (now() >= end) throw new Error(`${id} refused our token; a new one was asked for and has not come yet — try again in a minute`);
      await new Promise((r) => setTimeout(r, 200));
    }
    return secrets.get(secretName(id));
  }
  async function withToken(id, use) {
    if (!enabled()) throw new Error("the agents' network is off on this install (config NETWORK)");
    const a = agents()[id];
    const token = secrets.get(secretName(id));
    if (!a?.url || !token) throw new Error(`not connected to ${id}`);
    try {
      return await use(a.url, token);
    } catch (error) {
      if (!/^http 401\b/.test(String(error?.message))) throw error;
      return use(a.url, await relink(id, a.url));
    }
  }
  async function call(id, name, args) {
    const result = await withToken(id, (url, token) => mcp(url, token, "tools/call", { name, arguments: args }));
    const text = result?.content?.[0]?.text || "{}";
    if (result?.isError) throw new Error(text.slice(0, 300));
    saveAgent(id, { lastSeen: new Date(now()).toISOString() });
    // It just answered: whatever the last probe thought, it is up.
    if (statusOf(id).state !== "ready") setStatus(id, { state: "ready", failures: 0, until: null });
    return JSON.parse(text);
  }
  // A plain POST to a member's own route, with the token it gave us (feedback.mjs).
  async function post(id, pathname, body) {
    return withToken(id, (url, token) => getJson(`${url}${pathname}`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body, timeoutMs: 30_000 }));
  }
  // ---- presence: who is ready, updating or off the net ----
  const statuses = () => store.getKv(STATUS) || {};
  const stamp = () => new Date(now()).toISOString();
  /** { state: ready|updating|unreachable|down|unknown, since?, until?, commit?, activeRuns?, canThink? } */
  function statusOf(id) {
    const s = statuses()[id];
    if (!s) return { state: "unknown" };
    // An announced restart that outlived its window with nothing heard since is just unreachable.
    if (s.state === "updating" && s.until && now() > Date.parse(s.until)) return { ...s, state: (s.failures || 0) >= DOWN_AFTER ? "down" : "unreachable" };
    return s;
  }
  function setStatus(id, patch) {
    const all = statuses();
    const prev = all[id] || {};
    const next = { ...prev, ...patch };
    if (patch.state && patch.state !== prev.state) next.since = stamp();
    all[id] = next;
    store.setKv(STATUS, all);
    return { prev, next };
  }
  const usable = (st) => st.state === "ready" || st.state === "unknown";
  const nameOf = (id) => agents()[id]?.name || id;

  // The member's card is public and cheap: its presence tells ready from updating, and a card that
  // does not come is a restart in progress (or worse) — three in a row make it «down».
  async function probeOne(a) {
    try {
      const theirs = await getJson(`${a.url}/api/public/network/card`, { timeoutMs: 6_000 });
      const p = theirs?.presence || {};
      const state = p.state === "updating" ? "updating" : "ready";
      const { prev } = setStatus(a.id, { state, failures: 0, lastOkAt: stamp(), commit: p.commit ?? null, activeRuns: p.activeRuns ?? null, canThink: p.canThink ?? null, noEngine: p.noEngine === true, until: state === "updating" ? p.until || null : null });
      if (state === "ready" && prev.state && prev.state !== "ready") flush().catch((e) => log.error?.(`[network] flush: ${e.message}`));
    } catch (error) {
      const prev = statusOf(a.id);
      const failures = (statuses()[a.id]?.failures || 0) + 1;
      if (prev.state === "updating") return void setStatus(a.id, { failures }); // inside its announced restart
      setStatus(a.id, { state: failures >= DOWN_AFTER ? "down" : "unreachable", failures, lastError: String(error.message).slice(0, 80) });
    }
  }
  async function probeAll() {
    if (!self()) return;
    await Promise.all(connected().map((a) => probeOne(a)));
    await flush();
  }
  // Tell every member something about this install, at once and without relinking: it is used while
  // stopping, when there is no time to repair a token.
  async function tellMembers(body) {
    await Promise.allSettled(
      connected().map((a) =>
        getJson(`${a.url}/api/public/network/status`, { method: "POST", headers: { authorization: `Bearer ${secrets.get(secretName(a.id))}` }, body, timeoutMs: 2_500 }),
      ),
    );
  }
  /** About to stop for a restart or an update: the members hear it first. */
  async function leave({ etaMs = UPDATE_ETA_MS } = {}) {
    if (!self()) return;
    leaving = { until: new Date(now() + etaMs).toISOString() };
    await tellMembers({ from: self(), state: "updating", until: leaving.until, commit: presence()?.commit ?? null });
  }
  /** Back up: the members stop waiting. */
  async function arrive() {
    leaving = null;
    if (!self()) return;
    await tellMembers({ from: self(), state: "ready", commit: presence()?.commit ?? null });
  }
  const publicStatus = (id) => {
    const { state, since, until, commit, activeRuns, canThink } = statusOf(id);
    return { state, ...(since ? { since } : {}), ...(until ? { until } : {}), ...(commit ? { commit } : {}), ...(activeRuns != null ? { activeRuns } : {}), ...(canThink === false ? { canThink: false } : {}), ...(statusOf(id).noEngine ? { noEngine: true } : {}) };
  };

  // Follow a task until it ends, needs an answer, or maxMs passes (then the taskId comes back).
  async function follow(id, first, maxMs) {
    let r = first;
    const end = now() + maxMs;
    while (["submitted", "working"].includes(r.state) && now() < end) {
      try {
        r = await call(id, "griffin_wait", { taskId: r.taskId, afterSeq: r.seq || 0, waitSec: 12 });
      } catch (error) {
        // It went away mid-task (an update): the task is its own, kept in its database; the background
        // follow picks it up when it is back.
        if (isDownError(error)) break;
        throw error;
      }
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
  const outbox = () => store.getKv(OUTBOX) || [];
  const pending = (chatId) => Object.values(follows()).filter((f) => f.chatId === chatId).length + outbox().filter((e) => e.chatId === chatId).length;
  function untrack(taskId) {
    const all = follows();
    if (!all[taskId]) return;
    delete all[taskId];
    saveFollows(all);
  }
  function track(chatId, id, r, { queued = false } = {}) {
    if (!runner || !chatId || !r?.taskId || !OPEN.has(r.state)) return false;
    const all = follows();
    all[r.taskId] = { agent: id, taskId: r.taskId, chatId, seq: r.seq || 0, since: all[r.taskId]?.since || new Date(now()).toISOString(), ...(queued ? { queued: true } : {}) };
    saveFollows(all);
    loop(r.taskId);
    return true;
  }

  function reportText(f, r, failure) {
    const a = agents()[f.agent] || {};
    const who = `${a.name || f.agent}${a.owner ? ` (${a.owner})` : ""}`;
    const queued = f.queued ? "این پیام وقتی آن ایجنت در دسترس نبود (آپدیت/قطع) در صف ماند و بعد از برگشتنش رفت؛ " : "";
    const head = `${NETWORK_REPORT_PREFIX} — پاسخ «${who}»${f.taskId ? ` به درخواست taskId ${f.taskId}` : ""}؛ ${queued}این پیام را سیستم فرستاده، نه Owner]\n\n`;
    if (!f.taskId) return `${head}${failure}\n\nاگر کار هنوز لازم است، دوباره با network_ask بفرست یا (فقط اگر هیچ راه شبکه‌ای نماند، و با ذکر دلیل) از راه دیگر؛ و برای کسی که کار را خواسته بگو چه شد.`;
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
          // The member is restarting (an update): wait for it, the 8-hour limit above still ends the follow.
          if (isDownError(error) && !usable(statusOf(f.agent))) {
            await sleep(retryMs);
            continue;
          }
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

  // The send itself. An error with .unsent set means the message did not reach the member (so it
  // may be queued); anything later is about a task the member already has.
  async function askNow(id, message, { fresh = false, maxMs = 4 * 60_000, chatId = null } = {}) {
    const contextId = fresh ? null : store.getKv(ctxKey(id));
    const send = (withContext) => call(id, "griffin_send", { message: String(message), ...(withContext ? { contextId } : {}), waitSec: 12 });
    let r;
    try {
      r = await send(Boolean(contextId));
    } catch (error) {
      // An old conversation that is busy or gone: start a new one.
      if (!contextId || isDownError(error)) throw Object.assign(error, { unsent: true });
      try {
        r = await send(false);
      } catch (second) {
        throw Object.assign(second, { unsent: true });
      }
    }
    const out = await follow(id, r, maxMs);
    return chatId ? handed(chatId, id, out) : brief(out);
  }

  const queuedBrief = (id, st) => ({
    state: "queued",
    agent: id,
    agentStatus: st.state,
    ...(st.since ? { since: st.since } : {}),
    note:
      `${nameOf(id)} is ${st.state === "updating" ? "updating (restarting)" : st.state === "down" ? "offline" : "not answering right now"}${st.since ? ` since ${st.since}` : ""}. ` +
      "Your message is queued and goes by itself the moment it is back; its answer then wakes THIS chat as «[گزارش خودکار زیرکارها — شبکهٔ ایجنت‌ها …]». " +
      "Tell the asker it is queued (and why) and end your turn. Do NOT switch to Telegram for an agent — Telegram is for a human; an update is not a reason.",
  });
  function enqueue(chatId, agent, message, fresh) {
    const list = outbox();
    if (list.length >= OUTBOX_MAX) throw new Error("the network outbox is full");
    list.push({ id: randomUUID(), agent, message: String(message), fresh: Boolean(fresh), chatId, since: stamp() });
    store.setKv(OUTBOX, list);
  }
  const dropFromOutbox = (entryId) => store.setKv(OUTBOX, outbox().filter((e) => e.id !== entryId));

  /** Ask a member. A member that is updating or off the net is not asked: a message from a chat waits in the outbox. */
  async function ask(id, message, opts = {}) {
    const { chatId = null } = opts;
    let st = statusOf(id);
    if (!usable(st) && agents()[id]?.url) {
      await probeOne(agents()[id]); // it may have come back since the last probe
      st = statusOf(id);
    }
    if (!usable(st)) {
      if (!chatId) throw new Error(`${nameOf(id)} is ${st.state === "updating" ? "updating (restarting)" : st.state}; try again in a few minutes`);
      enqueue(chatId, id, message, opts.fresh);
      return queuedBrief(id, st);
    }
    // No engine set up at all (its owner never finished setup) is not a late answer: the message would
    // wait there forever (four installs held colleagues' requests for days, 2026-10-21).
    if (st.noEngine) throw new Error(`${nameOf(id)} has no AI engine set up yet, so it cannot answer; tell its owner, or ask another member`);
    try {
      const res = await askNow(id, message, opts);
      // It is up but has no engine to think with (every plan limit reached): the answer will be late.
      if (statusOf(id).canThink === false) res.agentNote = `${nameOf(id)} is up but has no engine available right now (plan limit), so its answer may come late.`;
      return res;
    } catch (error) {
      if (!chatId || !error?.unsent || !isDownError(error)) throw error;
      setStatus(id, { state: "unreachable", failures: (statuses()[id]?.failures || 0) + 1, lastError: String(error.message).slice(0, 80) });
      enqueue(chatId, id, message, opts.fresh);
      return queuedBrief(id, statusOf(id));
    }
  }
  /** Tell a member something (a statement or a question) in place of a Telegram message to its agent. */
  const say = (id, text, { chatId = null } = {}) => ask(id, text, { chatId, maxMs: 30_000 });

  // Queued messages go out when their member is ready; one too old, or whose chat is gone, is dropped
  // (the chat hears it when it is a failure to tell).
  let flushing = false;
  async function flush() {
    if (flushing || !outbox().length) return;
    flushing = true;
    try {
      for (const e of outbox()) {
        if (store.getChat && !store.getChat(e.chatId)) {
          dropFromOutbox(e.id);
          continue;
        }
        const f = { agent: e.agent, taskId: null, chatId: e.chatId, queued: true };
        if (now() - Date.parse(e.since) > OUTBOX_MAX_MS) {
          dropFromOutbox(e.id);
          if (runner) await deliver(f, reportText(f, null, `پیام برای «${nameOf(e.agent)}» ${Math.round(OUTBOX_MAX_MS / 3600_000)} ساعت در صف ماند و آن ایجنت در دسترس نیامد`));
          continue;
        }
        if (!usable(statusOf(e.agent))) continue;
        try {
          const r = await askNow(e.agent, e.message, { fresh: e.fresh, maxMs: 20_000 });
          dropFromOutbox(e.id);
          if (!runner) continue;
          if (OPEN.has(r.state) && r.taskId) track(e.chatId, e.agent, r, { queued: true });
          else await deliver({ ...f, taskId: r.taskId }, reportText({ ...f, taskId: r.taskId }, r));
        } catch (error) {
          if (error?.unsent && isDownError(error)) continue; // still away: stays queued
          dropFromOutbox(e.id);
          if (runner) await deliver(f, reportText(f, null, `پیام صف‌شده به «${nameOf(e.agent)}» نرسید: ${String(error?.message || error).slice(0, 160)}`));
        }
      }
    } finally {
      flushing = false;
    }
  }
  async function reply(id, taskId, answer, { maxMs = 4 * 60_000, chatId = null } = {}) {
    const r = answer ? await call(id, "griffin_reply", { taskId, answer: String(answer), waitSec: 12 }) : await call(id, "griffin_wait", { taskId, waitSec: 12 });
    const out = await follow(id, r, maxMs);
    return chatId ? handed(chatId, id, out) : brief(out);
  }

  const iconOf = (id) => {
    const icon = store.getKv(iconKey(id));
    return icon?.svg ? `/api/network/${id}/icon.svg?v=${icon.v}` : null;
  };

  function list() {
    return Object.values(agents())
      .filter((a) => a.url)
      .map((a) => ({ id: a.id, url: a.url, name: a.name || a.id, latin: a.latin || "", owner: a.owner || "", product: a.product || "", color: a.color || null, icon: iconOf(a.id), connected: Boolean(secrets.get(secretName(a.id))), status: publicStatus(a.id), queued: outbox().filter((e) => e.agent === a.id).length, ...(a.skills ? { skills: a.skills } : {}), lastSeen: a.lastSeen || null, ...(a.lastError ? { lastError: a.lastError } : {}) }));
  }

  async function refresh() {
    if (!self()) return;
    for (const s of seeds) {
      const o = allowedOrigin(s, domains);
      if (o && o !== self() && !secrets.get(secretName(agentId(new URL(o).host)))) await hello(o).catch(() => {});
    }
    await syncCards({ force: true });
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
    // Skills only to a member that shows its network token: repo names and note titles are not public.
    app.get("/api/public/network/card", (c) => {
      if (!self()) return c.json({ error: "no public address" }, 404);
      const member = c.req.header("authorization") ? peerAuth.authenticate(c.req.header("authorization")) : null;
      return c.json(card({ withSkills: Boolean(member) }));
    });
    app.get("/api/public/network/peers", (c) => c.json({ agents: connected().map(({ url, name, latin, owner, product }) => ({ url, name, latin, owner, product })) }));
    app.post("/api/public/network/hello", async (c) => {
      if (limited(c.req.header("x-forwarded-for") || "direct")) return c.json({ error: "rate limited" }, 429);
      const body = await c.req.json().catch(() => ({}));
      if (!allowedOrigin(body.url, domains)) return c.json({ error: "address not allowed" }, 400);
      // Answered at once; the token goes to the caller's own address (onHello).
      onHello(body.url).catch((e) => log.error?.(`[network] hello from ${body.url}: ${e.message}`));
      return c.json({ ok: true });
    });
    // A member says it is stopping to restart (updating) or that it is back (ready): only by the
    // token this install gave it, and only about itself.
    app.post("/api/public/network/status", async (c) => {
      const who = peerAuth.authenticate(c.req.header("authorization"));
      if (who.error) return c.json({ error: who.error }, who.status);
      const body = await c.req.json().catch(() => ({}));
      const origin = allowedOrigin(body.from, domains);
      const id = origin ? agentId(new URL(origin).host) : null;
      if (!id || `net-${id}`.slice(0, 41) !== who.userId) return c.json({ error: "not that member" }, 403);
      if (!["updating", "ready"].includes(body.state)) return c.json({ error: "bad state" }, 400);
      const updating = body.state === "updating";
      const until = updating ? (Date.parse(body.until) > now() && Date.parse(body.until) < now() + 3600_000 ? body.until : new Date(now() + UPDATE_ETA_MS).toISOString()) : null;
      const { prev } = setStatus(id, { state: body.state, failures: 0, until, ...(body.commit ? { commit: String(body.commit).slice(0, 40) } : {}), ...(updating ? {} : { lastOkAt: stamp() }) });
      if (!updating && prev.state && prev.state !== "ready") flush().catch((e) => log.error?.(`[network] flush: ${e.message}`));
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
    // Opening the page re-reads the members' cards (at most once a minute, in the background): the
    // page polls this, so a rename or a new logo shows up within a minute or two.
    api.get("/api/network", (c) => {
      if (enabled() && self()) syncCards().catch(() => {});
      return c.json({ self: self() ? card({ withSkills: true }) : null, off: !enabled(), agents: list() });
    });
    api.get("/api/network/:id/icon.svg", (c) => {
      const icon = store.getKv(iconKey(c.req.param("id")));
      if (!icon?.svg) return c.text("not found", 404);
      return c.body(icon.svg, 200, { "content-type": "image/svg+xml", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox", "cache-control": "private, max-age=3600" });
    });
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
        description:
          "The colleagues' agents this install is connected to (the agents' network): id, name, owner (the colleague it works for), product, address, " +
          "and status.state — ready, updating (restarting for an update; back in minutes), unreachable / down (not answering), or unknown. " +
          "queued = messages waiting for it. skills = what that agent knows: its owner's role, the repos it works on and the titles of its notes — " +
          "the map for choosing whom to ask. This is where agents are reached: talk to one with network_ask. A colleague's AGENT is never a reason for Telegram — " +
          "an updating or offline agent gets your message queued and delivered when it is back. Not connected to someone's install yet: network_connect.",
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
          "If the answer is not in when the wait ends (working or auth-required), it comes back to this chat by itself as «[گزارش خودکار زیرکارها — شبکهٔ ایجنت‌ها …]» — end your turn, do not ask again. " +
          "If that agent is updating or offline the result is state \"queued\": the message goes by itself when it is back and the answer wakes this chat — say so to the asker; do not use Telegram.",
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
      network_connect: {
        description:
          "Make a path to a colleague's agent when network_agents does not list it: network_connect {url} says hello to that install (its https address on the company's domains; " +
          "it connects within seconds, and every agent it knows joins too); without a url it refreshes the whole network now. Then network_agents shows the result. " +
          "Try this before concluding that an agent cannot be reached over the network.",
        inputSchema: { type: "object", properties: { url: { type: "string" } }, additionalProperties: false },
        async execute({ url }) {
          if (url) return hello(String(url));
          await refresh();
          await probeAll();
          return { agents: list() };
        },
      },
    };
  }

  function start() {
    const tick = () => refresh().catch((e) => log.error?.(`[network] refresh: ${e.message}`));
    setTimeout(tick, 30_000).unref?.();
    setInterval(tick, REFRESH_MS).unref?.();
    // Presence: say «ready» to the members once up, then read each member's card every minute.
    const watch = () => probeAll().catch((e) => log.error?.(`[network] presence: ${e.message}`));
    setTimeout(() => {
      arrive().catch(() => {});
      watch();
    }, 20_000).unref?.();
    setInterval(watch, probeMs).unref?.();
    recover();
  }

  return { card, hello, onHello, onToken, gossip, list, ask, say, reply, post, refresh, routes, ownerRoutes, tools, start, connected, pending, recover, probeAll, leave, arrive, flush, statusOf };
}
