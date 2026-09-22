import { installCursorEgress } from "./egress.mjs";
import fs from "node:fs";
import path from "node:path";
import { getRequestListener } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Agent } from "@cursor/sdk";
import { createApp } from "./app.mjs";
import { createDualServer, loadTls } from "./listen.mjs";
import { ASK_REQUESTER_TOOL, ASK_TOOL, createAsks } from "./asks.mjs";
import { ASK_AGENT_TOOL, DELEGATE_TOOL, SUBTASKS_TOOL, createPeers } from "./peers.mjs";
import { createKnowledge, listAgentNotes, setNoteReviewed } from "./knowledge.mjs";
import { createVisualizer, VISUALIZE_TOOL } from "./charts.mjs";
import { createShowMedia, SHOW_MEDIA_TOOL } from "./media.mjs";
import { createAuth } from "./auth.mjs";
import { openStore } from "./db.mjs";
import { genv, resolveDbPath } from "./env.mjs";
import { installRules } from "./prompt.mjs";
import { createRunner } from "./runner.mjs";
import { clip } from "./updates.mjs";
import { createTitler } from "./titles.mjs";
import { createIntegrations, integrationRoutes } from "./integrations/manager.mjs";
import { createJobs } from "./jobs/index.mjs";
import { jobRoutes } from "./jobs/routes.mjs";
import { createJobTools } from "./jobs/tools.mjs";
import { createAccountTools, parseProxy } from "./integrations/telegram-account.mjs";
import { COVERAGE_CALLER, END_AGENT_TOOL, TEAM_MUTATING, createEndAgentTool, guardTeamTools } from "./integrations/coverage.mjs";
import { guardTools } from "./guard.mjs";
import { createPeerAuth, isPeerCaller, PEER_INVITE_TOOL } from "./peer-auth.mjs";
import { createPeerTasks } from "./peer-tasks.mjs";
import { createMcpHandler } from "./mcp.mjs";
import { brokerRequest, createToolSource } from "./tools.mjs";
import { createToolBudget } from "./budget.mjs";
import { DEFAULT_AGENT } from "./agents/registry.mjs";
import { filterToolsByProfile, publicProfile, rootCallerOf, APP_TOOL_NAMES, CALLER_LABELS, SELF_MGMT_TOOLS, unique as uniqueTools } from "./agents/profiles.mjs";
import { createIncidentStore, createIntake, incidentView, isTeamReport } from "./incidents/index.mjs";
import { createIncidentTools, createOpsRoom } from "./incidents/opsroom.mjs";
import { createBusinessSource } from "./incidents/business.mjs";
import { bindChatTools, createAgentSettingsTools } from "./agents/settings-tools.mjs";
import { agentCwd, prepareAgentWorkspaces } from "./agents/workspaces.mjs";
import {
  createProviders,
  DEFAULT_PROVIDER,
  normalizeProvider,
  PROVIDER_CLAUDE,
  PROVIDER_CURSOR,
} from "./providers/index.mjs";

const env = process.env;
// Must run before the SDK opens any connection.
installCursorEgress(env.CURSOR_PROXY);
const DATA = genv("DATA", "/data");
const WORKSPACE = genv("WORKSPACE", "/workspace");
const WEB_DIST = genv("WEB_DIST", path.resolve(import.meta.dirname, "../../web/dist"));
const HOST = env.HOST || "127.0.0.1";
const PORT = Number(env.PORT || 3100);

// Built-in tools the Cursor model may use. No "shell": live operations go through typed broker tools.
const TOOLS = ["read", "grep", "glob", "ls", "edit", "delete", "readLints", "semSearch", "mcp",
  "updateTodos", "readTodos", "webSearch", "webFetch", "task"];

function readSecret(envName, fileEnv, fallbackFile) {
  const fromEnv = (env[envName] || "").trim();
  if (fromEnv) return fromEnv;
  const file = env[fileEnv] || path.join(DATA, fallbackFile);
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim() : "";
}

function cursorApiKey() {
  return readSecret("CURSOR_API_KEY", "CURSOR_API_KEY_FILE", "cursor.api-key");
}

function anthropicApiKey() {
  return readSecret("ANTHROPIC_API_KEY", "ANTHROPIC_API_KEY_FILE", "anthropic.api-key");
}

fs.mkdirSync(DATA, { recursive: true });
prepareAgentWorkspaces(WORKSPACE);
const store = openStore(resolveDbPath(DATA));
const compacted = store.compactLargeEvents((data) => clip(data));
if (compacted) console.log(`[store] compacted ${compacted} oversized events`);

const toolSource = createToolSource({
  socketPath: genv("BROKER_SOCKET", "/run/griffin/broker.sock"),
  store,
});

// integrationsHolder breaks the cycle: asks needs to tell integrations a question closed, but
// integrations itself is constructed later (it takes asks as an argument).
const integrationsHolder = { current: null };
const asks = createAsks({ store, onSettled: (chatId) => integrationsHolder.current?.clearQuestion(chatId) });
const peersHolder = { current: null };
const knowledge = createKnowledge({
  store,
  root: path.join(WORKSPACE, "knowledge"),
  git: genv("DEMO") !== "1",
});
const KNOWLEDGE_ROOT = path.join(WORKSPACE, "knowledge");
const showMedia = createShowMedia({
  store,
  workspace: WORKSPACE,
  resolveRoots: (chatId) => {
    const chat = store.getChat(chatId);
    return [agentCwd(WORKSPACE, chat?.agent || DEFAULT_AGENT), WORKSPACE];
  },
});
const visualizer = createVisualizer({
  store,
  fetchMetrics: genv("DEMO") === "1" ? (await import("./demo-sdk.mjs")).demoMetrics : async (args) => {
    const { status, body } = await brokerRequest(toolSource.socketPath, "POST", "/data/metrics", args, 120_000);
    if (status !== 200 || !body?.ok) throw Object.assign(new Error(body?.error || `broker http ${status}`), { attempts: body?.attempts });
    return body.result;
  },
});

// Tool-less one-shot agent for chat titles (no workspace, no custom tools, fastest model the account routes).
async function generateText(prompt) {
  if (genv("DEMO") === "1") return "گفتگوی نمایشی";
  const os = await import("node:os");
  const key = cursorApiKey();
  if (!key) return "گفتگو";
  const agent = await Agent.create({
    apiKey: key,
    model: { id: env.CURSOR_TITLE_MODEL || "auto" },
    tools: [],
    local: { cwd: os.tmpdir(), settingSources: [] },
  });
  let text = "";
  const run = await agent.send(prompt, {
    onDelta: ({ update }) => {
      if (update.type === "text-delta") text += update.text;
    },
  });
  await run.wait();
  return text;
}
const maybeTitle = createTitler({ store, generate: generateText });
// Older chats still carry the first line of the question as title; rename them once, one at a time.
setTimeout(async () => {
  for (const chat of [...store.listChats({ archived: false }), ...store.listChats({ archived: true })]) {
    if (chat.title.length > 24) await maybeTitle(chat.id, { backfill: true });
  }
}, 20_000);

const demo = genv("DEMO") === "1";
const providers = createProviders({
  cursorApiKey: cursorApiKey(),
  anthropicApiKey: anthropicApiKey(),
  cursorModel: env.CURSOR_MODEL || "auto",
  claudeModel: env.CLAUDE_MODEL || "sonnet",
  builtinTools: TOOLS,
  demoSdk: demo ? (await import("./demo-sdk.mjs")).demoSdk : null,
});

const runner = createRunner({
  store,
  onFinished: (chatId) => maybeTitle(chatId),
  onCancel: (chatId) => {
    const leftover = asks.cancel(chatId);
    peersHolder.current?.cancelChildren(chatId);
    // An answer held for a question the agent never got to: deliver it as a normal follow-up.
    if (leftover) setTimeout(() => runner.send(chatId, { text: `پاسخ من: ${leftover.answer}`, images: [], intent: runner.isActive(chatId) ? "queue" : "send" }).catch(() => {}), 0);
  },
  onUserCancel: (chatId) => peersHolder.current?.cancelChildren(chatId, { includeDelegates: true }),
  isSoftBusy: (chatId) => Boolean(peersHolder.current?.hasChildren(chatId)),
  isBlocked: (chatId) => asks.isWaiting(chatId),
  providerFor: (chat) => {
    const profile = store.getAgentProfile(chat?.agent || DEFAULT_AGENT);
    const id = normalizeProvider(profile?.provider || chat?.provider);
    return providers[id] || providers[DEFAULT_PROVIDER];
  },
  agentOptions: async (chat) => {
    const agent = chat.agent || DEFAULT_AGENT;
    const caller = chat.caller || "owner";
    const profile = store.getAgentProfile(agent);
    if (!profile) throw new Error(`unknown agent profile: ${agent}`);

    const brokerNames = await toolSource.listNames();
    const jobToolNames = Object.keys(createJobTools({ jobs, targets: () => integrations.targets() }));
    const catalogForSettings = uniqueTools([
      ...(brokerNames || []),
      ...APP_TOOL_NAMES,
      ...jobToolNames,
      "telegram_dialogs",
      "telegram_read",
      "telegram_send",
    ]);
    const settingsTools = bindChatTools(
      createAgentSettingsTools({ store, catalogNames: () => catalogForSettings }),
      chat.id,
    );

    const customTools = {
      ...(await toolSource.customTools(chat.id)),
      [ASK_TOOL]: asks.tool(chat.id),
      [ASK_REQUESTER_TOOL]: asks.requesterTool(chat.id),
      [ASK_AGENT_TOOL]: peersHolder.current.tool(chat.id),
      [DELEGATE_TOOL]: peersHolder.current.delegateTool(chat.id),
      [SUBTASKS_TOOL]: peersHolder.current.subtasksTool(chat.id),
      [PEER_INVITE_TOOL]: peerAuth.inviteTool({ callBroker: callBrokerTool }),
      ...knowledge.tool(chat.id),
      [VISUALIZE_TOOL]: visualizer.tool(chat.id),
      [SHOW_MEDIA_TOOL]: showMedia.tool(chat.id),
      ...createJobTools({ jobs, targets: () => integrations.targets() }),
      ...createIncidentTools({ incidents }),
      ...settingsTools,
    };
    Object.assign(customTools, createAccountTools({ getClient: () => integrations.accountClient() }));

    const cwd = agentCwd(WORKSPACE, agent);
    const peers = store.listAgentProfiles().filter((p) => p.id !== agent);
    installRules(cwd, { agent, caller, peers, profile, knowledgeRoot: KNOWLEDGE_ROOT });

    let filtered = filterToolsByProfile(customTools, profile, { caller });
    const rootCaller = chat.parent_chat_id ? rootCallerOf(store, chat) : caller;
    const rootChatId = store.rootChatId(chat.id);
    const unattended = ["scheduler", "ops"].includes(rootCaller) || Boolean(store.getChat(rootChatId)?.job_id);
    // Irreversible calls in any chain not rooted in the owner need the owner's yes (in code). The
    // question reaches them in Telegram wherever the chain started, so a peer chain asks too
    // instead of refusing outright.
    if (rootCaller !== "owner" && caller !== COVERAGE_CALLER) {
      filtered = guardTools(filtered, {
        chatId: chat.id,
        asks,
        store,
        caller: rootCaller,
        extra: rootCaller === COVERAGE_CALLER ? TEAM_MUTATING : null,
        mode: unattended ? "refuse" : "ask",
      });
    }
    if (caller === COVERAGE_CALLER) {
      const peerLink = store.linksForChat(chat.id).find((l) => l.external_chat && l.external_chat !== "me") || null;
      const peerChat = peerLink?.external_chat || null;
      filtered[END_AGENT_TOOL] = createEndAgentTool({
        onEnd: (note) => {
          if (peerLink) integrations.bridge.scheduleEnd(chat.id, { integrationId: peerLink.integration_id, peer: peerChat, note });
        },
      });
      filtered = guardTeamTools(filtered, { chatId: chat.id, asks, store, peerChat });
    }

    // Loop wall in code: per-run budget over the custom tools, reset on every run.started.
    filtered = budgetFor(chat.id).wrap(filtered);

    const provider = normalizeProvider(profile.provider);
    const defaultModel =
      profile.model ||
      (provider === PROVIDER_CLAUDE ? env.CLAUDE_MODEL || "sonnet" : env.CURSOR_MODEL || "auto");
    return {
      cwd,
      model: { id: chat.model || defaultModel },
      customTools: filtered,
      settingSources: ["project"],
    };
  },
});

peersHolder.current = createPeers({ store, runner });

let modelCache = { at: 0, byProvider: {} };
async function models(provider = null) {
  const want = provider ? normalizeProvider(provider) : null;
  if (Date.now() - modelCache.at < 10 * 60_000 && Object.keys(modelCache.byProvider).length) {
    if (want) return modelCache.byProvider[want] || [];
    return Object.values(modelCache.byProvider).flat();
  }
  const byProvider = {};
  await Promise.all(
    [PROVIDER_CURSOR, PROVIDER_CLAUDE].map(async (id) => {
      try {
        byProvider[id] = await providers[id].listModels();
      } catch (error) {
        console.error(`[models:${id}]`, error?.message || error);
        byProvider[id] = id === PROVIDER_CLAUDE ? (await import("./providers/claude.mjs")).CLAUDE_MODELS.map((m) => ({ ...m, provider: id })) : [];
      }
    }),
  );
  modelCache = { at: Date.now(), byProvider };
  if (want) return byProvider[want] || [];
  return Object.values(byProvider).flat();
}

async function health() {
  const [probe, cursor, claude] = await Promise.all([
    brokerRequest(toolSource.socketPath, "GET", "/probe", undefined, 15_000)
      .then((r) => ({ ok: r.status === 200, ...r.body }))
      .catch((error) => ({ ok: false, error: error.message })),
    providers[PROVIDER_CURSOR].health(),
    providers[PROVIDER_CLAUDE].health(),
  ]);
  return {
    broker: { ok: probe.ok, ...(probe.error ? { error: probe.error } : {}) },
    clusters: probe.clusters || null,
    cursor,
    claude,
    ops: { mode: opsRoom.mode, room: opsRoom.roomId(), pending: opsRoom.pendingCount(), ...intake.status() },
    activeRuns: runner.activeCount(),
  };
}

// Messenger integrations run inside the app (they need the runner and the chat store).
const integrations = createIntegrations({ store, runner, asks, publicUrl: genv("PUBLIC_URL", ""), telegramProxy: parseProxy(genv("TELEGRAM_SOCKS")) });
integrationsHolder.current = integrations;
if (genv("DEMO") !== "1") integrations.startAll();

// Scheduled work: each job runs the agent in its own hidden chat and delivers the answer.
const jobs = createJobs({
  store,
  runner,
  deliver: (chatId, targets, meta) => integrations.deliverChat(chatId, targets, meta),
});
jobs.start();

// Incident intake: Alertmanager of every cluster → grouped incidents → Griffin's ops room (shadow).
const incidents = createIncidentStore(store.db);
const opsRoom = createOpsRoom({ store, runner, incidents, mode: genv("OPS_MODE", "shadow") });
// Optional: a SQL table where your own job records whether the business number dropped.
const readBusiness = createBusinessSource({
  config: genv("BUSINESS_SIGNAL") ? JSON.parse(genv("BUSINESS_SIGNAL")) : null,
  query: async (args) => {
    const { status, body } = await brokerRequest(toolSource.socketPath, "POST", "/tools/pg_query", args, 60_000);
    if (status !== 200 || !body?.ok) throw new Error(body?.error || `broker http ${status}`);
    return body.result.rows || [];
  },
});
const intake = createIntake({
  incidents,
  fetchAlerts: async () => {
    const [{ status, body }, business] = await Promise.all([
      brokerRequest(toolSource.socketPath, "POST", "/tools/alerts_active", {}, 60_000),
      readBusiness(),
    ]);
    if (status !== 200 || !body?.ok) throw new Error(body?.error || `broker http ${status}`);
    return {
      clusters: { ...body.result.clusters, business: { ok: business.ok, error: business.error, watchdog: false, count: business.alerts.length } },
      alerts: [...body.result.alerts, ...business.alerts],
    };
  },
  // Owner-acked (intentional) incidents stay recorded but do not wake the ops room, unless they get worse.
  onChanges: (changes, meta) => opsRoom.push(changes.filter((c) => c.kind === "escalated" || !incidents.isAcked(c.incident)), meta),
});
if (genv("DEMO") !== "1" && opsRoom.mode !== "off") intake.start();

// Human signals: a work DM from a teammate to the owner goes to the ops room as a TeamReport, so
// Griffin can tell whether it already knew (a machine signal covered it) or it was a miss.
store.bus.on("person.message", ({ personId, direction, text }) => {
  if (opsRoom.mode === "off" || direction !== "in") return;
  const person = store.getPerson(personId);
  if (!isTeamReport(person, text)) return;
  const change = incidents.recordHuman({ personId, name: person.display_name, text });
  if (change) opsRoom.push([change]);
});


const peerAuth = createPeerAuth({ store, publicUrl: genv("PUBLIC_URL", "") });
// Server→broker tool call (socket, no model in the loop) — used by peer_invite to move the minted
// token straight into the peer's Infisical project.
const callBrokerTool = async (name, args) => {
  const { status, body } = await brokerRequest(toolSource.socketPath, "POST", `/tools/${name}`, args, 60_000);
  if (status !== 200 || !body?.ok) throw new Error(body?.error || `broker http ${status}`);
  return body.result;
};

// Per-chat tool budget (loop wall). Counters reset on each run.started of that chat.
const toolBudgets = new Map();
function budgetFor(chatId) {
  let budget = toolBudgets.get(chatId);
  if (!budget) {
    budget = createToolBudget();
    store.bus.on(`chat:${chatId}`, (event) => budget.noteEvent(event));
    toolBudgets.set(chatId, budget);
  }
  return budget;
}
const peerTasks = createPeerTasks({
  store,
  runner,
  asks,
  cancelChildren: (chatId) => peersHolder.current?.cancelChildren(chatId, { includeDelegates: true }),
  pendingWork: (chatId) => peersHolder.current?.pendingDelegates(chatId) || 0,
});
setInterval(() => peerTasks.sweep().catch(() => {}), 5 * 60_000).unref();
// A run stuck on an opaque tool call (e.g. the native `task` subagent) never emits another event
// and would otherwise block that chat — and activeRuns-gated deploys — forever.
setInterval(() => runner.sweepStale().catch((error) => console.error(`[runner] sweepStale: ${error.message}`)), 2 * 60_000).unref();
const mcp = createMcpHandler({
  tasks: peerTasks,
  version: genv("VERSION", "dev"),
  record: (call) => store.recordPeerCall(call),
});

const app = createApp({
  store,
  runner,
  asks,
  models,
  auth: genv("AUTH") === "off" && HOST === "127.0.0.1"
    ? undefined
    : createAuth({ dataDir: DATA, store, secureCookie: genv("SECURE_COOKIE") === "1" }),
  version: genv("VERSION", "dev"),
  extraRoutes: (api) => {
    peerAuth.routes(api, { selfMgmtTools: SELF_MGMT_TOOLS });
    api.get("/api/approvals", (c) => c.json({ approvals: store.listApprovals({ limit: Math.min(Number(c.req.query("limit")) || 100, 500) }) }));
    // Owner-only knowledge review gate: only reviewed:true notes are injected into prompts.
    api.get("/api/knowledge", (c) => {
      const agents = {};
      for (const profile of store.listAgentProfiles()) {
        const notes = listAgentNotes(KNOWLEDGE_ROOT, profile.id);
        if (notes.length) agents[profile.id] = notes;
      }
      return c.json({ agents });
    });
    api.post("/api/knowledge/:agent/review", async (c) => {
      const agent = c.req.param("agent");
      if (!store.getAgentProfile(agent)) return c.json({ error: "unknown agent" }, 404);
      const body = await c.req.json().catch(() => ({}));
      const ok = setNoteReviewed(KNOWLEDGE_ROOT, agent, String(body.file || ""), Boolean(body.reviewed));
      if (!ok) return c.json({ error: "note not found" }, 404);
      return c.json({ notes: listAgentNotes(KNOWLEDGE_ROOT, agent) });
    });
    // External agents authenticate with their own Bearer token (not the owner cookie).
    api.get("/peer/v1/whoami", peerAuth.middleware(), (c) => {
      const { userId, clientId, caller, label } = c.get("peer");
      return c.json({ userId, clientId, caller, label });
    });
    // Owner-only: send from the owner's Telegram account through the one live client.
    api.post("/api/telegram/send", async (c) => {
      const body = await c.req.json().catch(() => ({}));
      const tool = createAccountTools({ getClient: () => integrations.accountClient() }).telegram_send;
      const result = await tool.execute({ chat: String(body.chat || ""), text: String(body.text || "") });
      const payload = JSON.parse(result.content?.[0]?.text || "{}");
      return c.json(payload, result.isError ? 400 : 200);
    });
    // Owner-only: read dialogs / a chat from the Owner's own Telegram account (reference lookups).
    api.get("/api/telegram/read", async (c) => {
      const tools = createAccountTools({ getClient: () => integrations.accountClient() });
      const chat = c.req.query("chat");
      const tool = chat ? tools.telegram_read : tools.telegram_dialogs;
      const args = chat
        ? { chat, limit: Math.min(Number(c.req.query("limit")) || 50, 200), ...(c.req.query("search") ? { search: c.req.query("search") } : {}) }
        : { ...(c.req.query("query") ? { query: c.req.query("query") } : {}), limit: Math.min(Number(c.req.query("limit")) || 50, 200) };
      const result = await tool.execute(args);
      const payload = JSON.parse(result.content?.[0]?.text || "{}");
      return c.json(payload, result.isError ? 400 : 200);
    });
    api.post("/mcp", peerAuth.middleware(), mcp.post);
    api.get("/mcp", mcp.notAllowed);
    api.delete("/mcp", mcp.notAllowed);
    api.get("/api/health", async (c) => c.json(await health()));
    api.get("/api/agents", (c) => c.json({ agents: store.listAgentProfiles().map(publicProfile) }));
    api.get("/api/agents/:id", (c) => {
      const profile = store.getAgentProfile(c.req.param("id"));
      if (!profile) return c.json({ error: "not found" }, 404);
      return c.json({ agent: publicProfile(profile) });
    });
    api.patch("/api/agents/:id", async (c) => {
      const id = c.req.param("id");
      if (!store.getAgentProfile(id)) return c.json({ error: "not found" }, 404);
      let body = {};
      try {
        body = await c.req.json();
      } catch {
        body = {};
      }
      const patch = {};
      if (typeof body.label === "string" && body.label.trim()) patch.label = body.label.trim();
      if (typeof body.domain === "string") patch.domain = body.domain;
      if (typeof body.blurb === "string") patch.blurb = body.blurb;
      if (typeof body.provider === "string") patch.provider = normalizeProvider(body.provider);
      if (typeof body.model === "string") patch.model = body.model.trim() || null;
      if (body.model === null) patch.model = null;
      if (Array.isArray(body.tools)) patch.tools = body.tools.map(String);
      if (Array.isArray(body.enable)) {
        store.enableAgentTools(id, body.enable);
      }
      if (Array.isArray(body.disable)) {
        store.disableAgentTools(id, body.disable);
      }
      const updated = Object.keys(patch).length ? store.updateAgentProfile(id, patch) : store.getAgentProfile(id);
      return c.json({ agent: publicProfile(updated) });
    });
    api.get("/api/tool-catalog", async (c) => {
      const broker = await toolSource.listNames();
      const names = uniqueTools([
        ...(broker || []),
        ...APP_TOOL_NAMES,
        "telegram_dialogs",
        "telegram_read",
        "telegram_send",
      ]);
      return c.json({ tools: names.map((name) => ({ name })) });
    });
    // Dead-man's switch for Griffin itself, probed from the clusters (blackbox http_function, strict 200):
    // 200 only while the incident intake has polled and read at least one cluster in the last 5 minutes.
    // Public on purpose; it says nothing but freshness.
    api.get("/api/public/ops/heartbeat", (c) => {
      const s = intake.status();
      const age = (iso) => (iso ? Math.round((Date.now() - new Date(iso).getTime()) / 1000) : null);
      const pollAge = age(s.lastPollAt);
      const okAge = age(s.lastOkAt);
      const ok = opsRoom.mode !== "off" && pollAge !== null && pollAge < 300 && okAge !== null && okAge < 300;
      return c.json({ ok, pollAgeSeconds: pollAge, readAgeSeconds: okAge }, ok ? 200 : 503);
    });
    api.get("/api/incidents", (c) =>
      c.json({
        incidents: incidents.list({ status: c.req.query("status") || "open", limit: c.req.query("limit") || 100 }).map((row) => incidentView({ ...row, ack: incidents.isAcked(row) ? incidents.acksFor(row.key) : null })),
        intake: intake.status(),
        room: opsRoom.roomId(),
      }),
    );
    api.post("/api/incidents/:id/ack", async (c) => {
      const row = incidents.get(c.req.param("id"));
      if (!row) return c.json({ error: "not found" }, 404);
      const body = await c.req.json().catch(() => ({}));
      const member = typeof body.member === "string" ? body.member.slice(0, 300) : "";
      if (body.remove) {
        incidents.unack(row.key, member);
        incidents.log(row.id, "unack", { member, by: "owner-ui" });
      } else {
        const reason = String(body.reason || "").trim();
        if (reason.length < 3) return c.json({ error: "دلیل لازم است" }, 400);
        const until = Number(body.days) > 0 ? new Date(Date.now() + Number(body.days) * 86_400_000).toISOString() : null;
        incidents.ack({ key: row.key, member, reason, by: "owner", until });
        incidents.log(row.id, "ack", { member, reason, until, by: "owner-ui" });
      }
      return c.json({ ok: true, acks: incidents.acksFor(row.key), quiet: incidents.isAcked(incidents.get(row.id)) });
    });
    api.get("/api/incidents/:id", (c) => {
      const row = incidents.get(c.req.param("id"));
      if (!row) return c.json({ error: "not found" }, 404);
      return c.json({ incident: incidentView(row), log: incidents.logs(row.id, 100) });
    });
    integrationRoutes(api, integrations);
    jobRoutes(api, jobs, { targets: () => integrations.targets() });
  },
});
app.use("/assets/*", serveStatic({ root: WEB_DIST }));
app.use("/*", serveStatic({ root: WEB_DIST }));
app.get("*", serveStatic({ path: path.join(WEB_DIST, "index.html") }));

const tls = loadTls(genv("TLS_DIR", path.join(DATA, "tls")));
const server = createDualServer(getRequestListener(app.fetch), { tls });
server.listen(PORT, HOST, () =>
  console.log(`[griffin] listening on ${HOST}:${PORT} (http${server.tls ? " + https" : ""})`),
);

let shuttingDown = false;
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[griffin] ${signal} — cancelling active runs…`);
    Promise.resolve()
      .then(async () => {
        jobs.stop();
        intake.stop();
        integrations.stopAll();
        // Give Cursor a chance to drop "active run" before the process dies; otherwise
        // the next message hits AgentBusyError on resume.
        await runner.shutdown({ timeoutMs: 8_000 });
        await new Promise((resolve) => server.close(resolve));
        store.close();
      })
      .catch((error) => console.error("[griffin] shutdown", error?.message || error))
      .finally(() => process.exit(0));
  });
}
