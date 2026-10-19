// First: a fresh install is named before persona.mjs and the agent registry read the name.
import "./first-name.mjs";
import { egressDown, installCursorEgress, removeCursorEgress } from "./egress.mjs";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import { Worker } from "node:worker_threads";
import path from "node:path";
import { getRequestListener } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { createApp } from "./app.mjs";
import { createDualServer, loadTls, parseTrustedProxies } from "./listen.mjs";
import { ASK_REQUESTER_TOOL, ASK_TOOL, createAsks } from "./asks.mjs";
import { ASK_AGENT_TOOL, CONSULT_TOOL, DELEGATE_TOOL, SUBTASKS_TOOL, CONSULT_MAX_TURNS, CONSULT_WITHHELD, consultCandidates, consultOf, createPeers, resolveConsultAccounts } from "./peers.mjs";
import { createKnowledge, listAgentNotes, playbookIndex, reviewedRunbooks, setNoteReviewed } from "./knowledge.mjs";
import { createChatTrust } from "./knowledge-trust.mjs";
import { brokerPaths, claudeCodeOptions, createOwnerJobs, jobWriterOf, migrateJobModes, OWNER_JOBS_FLAG, runAccess } from "./jobs/owner-jobs.mjs";
import { createVisualizer, VISUALIZE_TOOL } from "./charts.mjs";
import { createShowMedia, SHOW_MEDIA_TOOL } from "./media.mjs";
import { createPreviews } from "./previews.mjs";
import { createWebTools } from "./web-search.mjs";
import { createAuth } from "./auth.mjs";
import { openStore } from "./db.mjs";
import { createBackups } from "./backup.mjs";
import { genv, resolveDbPath } from "./env.mjs";
import { listPrefsRoutes } from "./list-prefs.mjs";
import { buildRules, installRules } from "./prompt.mjs";
import { buildManifest, recordManifest } from "./manifest.mjs";
import { simulateTools } from "./sim.mjs";
import { createRunner, keptList, ownerTyped } from "./runner.mjs";
import { pickAccountHop, pickFallback, pickRoute, planFallbackMode } from "./plan-fallback.mjs";
import { engineState, isCreditError, probeVerdict, rankByState, sameModelNames } from "./engine-state.mjs";
import { archiveIdleChats } from "./idle-archive.mjs";
import { clip } from "./updates.mjs";
import { createTitler, STUCK_TITLE } from "./titles.mjs";
import { createTimelineCache } from "./timeline-cache.mjs";
import { STT_DEFAULTS, sttRoutes } from "./stt.mjs";
import { chatTreeState, cleanupChatWorktree, currentWorktree, ensureChatWorktree, isValidRepoName, listRepos, parkedTrees, shortId, sweepChatWorktrees, switchChatWorktree, worktreeCreationSettled } from "./worktrees.mjs";
import { createRepoChatTools, repoRules } from "./repo-tools.mjs";
import { createIntegrations, integrationRoutes } from "./integrations/manager.mjs";
import { readTelegramApp } from "./integrations/telegram-app.mjs";
import { createJobs } from "./jobs/index.mjs";
import { jobRoutes } from "./jobs/routes.mjs";
import { createJobTools } from "./jobs/tools.mjs";
import { accountHistory, createAccountTools, parseProxy } from "./integrations/telegram-account.mjs";
import { COVERAGE_CALLER, END_AGENT_TOOL, TEAM_MUTATING, createEndAgentTool, guardTeamTools } from "./integrations/coverage.mjs";
import { createMotherTools, globalContext, isGlobalChat, motherContext, motherInfo, watchJoinedThreads } from "./integrations/mother.mjs";
import { deliverable } from "./integrations/format.mjs";
import { fillPersianNames } from "./integrations/fa-names.mjs";
import { confirmWithOwner, fenceBackdoors, guardTools, isYes, noteOwnerAnswer, secretsGate } from "./guard.mjs";
import { reviewChanges } from "./review.mjs";
import { RELATED_TOOL, channelOf, createPeerChatTools, createRelatedTool, lastHop, openWorkFor, relatedRules, thirdPartyKey } from "./related.mjs";
import { createChatTools, restrictForReadOnlySide, sideIsReadOnly } from "./chat-tools.mjs";
import { createUpdates } from "./update.mjs";
import { readBuildCommit } from "./build-commit.mjs";
import { BUILD_TOOL, createToolBuilder, guardGriffinMerge } from "./tool-builder.mjs";
import { OWNER_CHAT_TOOLS_CONFIG, createOwnerChatToolkit, isOwnerChat, offersOwnerChatTools } from "./owner-chat-tools.mjs";
import { TELEGRAM_LEDGER_CONFIG, ledgerRecorder, ledgerTools } from "./telegram-ledger.mjs";
import { watchListTools } from "./integrations/telegram-watch-list.mjs";
import { INBOX_PROMPT, createInbox, createInboxTools, dmMode, inboxRoutes, restrictForInbox } from "./telegram-inbox.mjs";
import { TELEGRAM_BOT_API_CONFIG } from "./integrations/bots.mjs";
import { OWNER_TASK_TOOL, TODO_TOOL, offersOwnerTask, ownerTaskTool, todoWriteTool, watchTodos } from "./todos.mjs";
import { inboxTool } from "./inbox.mjs";
import { claudeOneShot, claudeCodeLoginKey } from "./providers/claude.mjs";
import { CLAUDE_ENDPOINTS, endpointOf, endpointSettings } from "./providers/claude-endpoint.mjs";
import { createVerifier } from "./verify.mjs";
import { allowsModel, peerSettings } from "./peer-limits.mjs";
import { businessDocsConfig, businessDocsFeature } from "./business-docs.mjs";
import { createPeerAuth, isPeerCaller, PEER_CONNECTION_TOOL, PEER_INVITE_TOOL, peerConnectionTool } from "./peer-auth.mjs";
import { createPeerTasks } from "./peer-tasks.mjs";
import { createMcpHandler } from "./mcp.mjs";
import { brokerRequest, createToolSource } from "./tools.mjs";
import { DEFAULT_AGENT } from "./agents/registry.mjs";
import { agentPayload } from "./agents/import.mjs";
import { griffinStatePaths } from "./providers/state-guard.mjs";
import { hostTarget, runsOnHost } from "./providers/host-spawn.mjs";
import { instructionPathsFor } from "./chat-origin.mjs";
import { filterToolsByProfile, publicProfile, rootCallerOf, APP_TOOL_NAMES, CALLER_LABELS, SELF_MGMT_TOOLS, unique as uniqueTools } from "./agents/profiles.mjs";
import { createIncidentStore, createIntake, incidentView, isTeamReport, vaultAlerts } from "./incidents/index.mjs";
import { createIncidentTools, createOpsRoom } from "./incidents/opsroom.mjs";
import { createBusinessSource } from "./incidents/business.mjs";
import { bindChatTools, createAgentSettingsTools } from "./agents/settings-tools.mjs";
import { createCustomAgent, customCallers, MAX_INSTRUCTIONS } from "./agents/create.mjs";
import { agentCwd, prepareAgentWorkspaces } from "./agents/workspaces.mjs";
import {
  createProviders,
  DEFAULT_PROVIDER,
  normalizeProvider,
  PROVIDER_CLAUDE,
  PROVIDER_CURSOR,
  PROVIDER_OPENAI,
  PROVIDERS,
  kindOf,
  setAccounts,
} from "./providers/index.mjs";
import { effortOf, splitModel, ACCOUNT_ID, KINDS } from "./providers/ids.mjs";
import { createSecretStore } from "./secrets.mjs";
import { accountRoutes } from "./account-routes.mjs";
import { createZaiAccount } from "./zai-account.mjs";
import { createZaiQuotaCache, zaiQuotaFetch } from "./zai-usage.mjs";
import { createPlanUsageCache } from "./plan-usage.mjs";
import { setupChecksRoutes } from "./setup-checks.mjs";
import { createMcpServers } from "./mcp-servers.mjs";
import { createMcpServerTools } from "./mcp-server-tools.mjs";
import { createMcpOauth } from "./mcp-oauth.mjs";
import { checkMcpServer } from "./mcp-health.mjs";
import { createConfig } from "./config.mjs";
import { createClaudeSignin } from "./claude-signin.mjs";
import { accountLoginDir, linkSharedEntries, loginDirKey, mainConfigDir, removeLoginDir } from "./claude-account-dir.mjs";
import { createDoctor, hookConsoleErrors, recentErrors } from "./doctor.mjs";
import { createFeedback } from "./feedback.mjs";
import { agentNameError, currentProduct } from "./identity.mjs";
import { setupPrompt } from "./setup-prompt.mjs";
import { brandRoutes, createBrand, upgradeBrandCss } from "./brand.mjs";
import { shellHandler } from "./shell.mjs";
import { NAMES, randomName } from "./first-name.mjs";
import { probeEgress } from "./egress-probe.mjs";
import { historyImportRoutes } from "./history-import.mjs";
import { agentSlug, bindPersonaStore, gitPrefix, brandLine, liveOwnerName, OWNER, PERSONA, renameAssistant, saveAssistantName } from "./persona.mjs";
import { profileRoutes } from "./profile.mjs";
import { createHostStats } from "./host-stats.mjs";
import { createPush } from "./push.mjs";
import { withinTime } from "./time-limit.mjs";
import { telegramForShares } from "./private-share.mjs";
import { createVpn, VPN_ENV } from "./vpn.mjs";
import { createNetwork } from "./network.mjs";
import { accountOrg, buildReport, createAccounting, keyFingerprint, REPORT_DAYS } from "./accounting.mjs";

const env = process.env;
// Must run before the SDK opens any connection.
const DATA = genv("DATA", "/data");
// Egress proxy: env wins (GRIFFIN_PROXY for everything; CURSOR_PROXY / HTTPS_PROXY as before), else
// <data>/proxy.json from the setup wizard. fetch follows it through setGlobalProxyFromEnv; the agent
// SDKs' own TLS streams through egress.mjs.
const PROXY_FILE = path.join(DATA, "proxy.json");
// setGlobalProxyFromEnv({}) does not take a proxy away; the restore function of the first call does.
let unproxied = null;
function applyProxy(url) {
  if (!url) return;
  const restore = http.setGlobalProxyFromEnv?.({ HTTPS_PROXY: url, HTTP_PROXY: url, NO_PROXY: env.NO_PROXY || "127.0.0.1,localhost,::1" });
  unproxied ||= restore;
  installCursorEgress(url);
}
function clearProxy() {
  unproxied?.();
  unproxied = null;
  removeCursorEgress();
}
const savedProxy = () => {
  try {
    return JSON.parse(fs.readFileSync(PROXY_FILE, "utf8")).url || "";
  } catch {
    return "";
  }
};
const ENV_PROXY = genv("PROXY", "");
installCursorEgress(env.CURSOR_PROXY);
// The wizard's built-in VPN (vpn.mjs): when it has a config and nothing in the environment says
// otherwise, Xray starts with the server and Griffin's traffic (not .ir / LAN) goes through it.
const vpn = createVpn({ dataDir: DATA });
const envProxy = Boolean(ENV_PROXY || env.CURSOR_PROXY || env.HTTPS_PROXY);
if (ENV_PROXY) applyProxy(ENV_PROXY);
else if (!envProxy && vpn.configured()) {
  Object.assign(process.env, VPN_ENV);
  vpn.start();
  applyProxy(VPN_ENV.HTTPS_PROXY);
} else if (!envProxy) applyProxy(savedProxy());
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
  return readSecret("ANTHROPIC_API_KEY", "ANTHROPIC_API_KEY_FILE", "anthropic.api-key") || claudeCodeLoginKey();
}

function openaiApiKey() {
  return readSecret("OPENAI_API_KEY", "OPENAI_API_KEY_FILE", "openai.api-key");
}

fs.mkdirSync(DATA, { recursive: true });
const secrets = createSecretStore({ dataDir: DATA });
// A fresh install gives the built-in agent the engine whose key is present, so the first chat works
// with whichever key the owner brought. Existing profiles are never changed.
const seedProvider = secrets.get("engine/claude") || anthropicApiKey()
  ? "claude"
  : secrets.get("engine/openai") || openaiApiKey() || genv("OPENAI_BASE_URL") ? "openai" : "cursor";
prepareAgentWorkspaces(WORKSPACE);
const store = openStore(resolveDbPath(DATA), { seedProvider });
bindPersonaStore(store);
// Sign-in of the owner's OAuth MCP servers (mcp-oauth.mjs): tokens renewed before a run and every 10 minutes.
const mcpOauth = createMcpOauth({ mcp: createMcpServers(), secrets, log: (line) => console.error(`[mcp] ${line}`) });
setInterval(() => mcpOauth.ensureFresh().catch(() => {}), 10 * 60_000).unref();
const config = createConfig({ store });
const refreshWorkspaces = () => {
  const profiles = store.listAgentProfiles();
  prepareAgentWorkspaces(WORKSPACE, {
    agents: profiles.map((p) => p.id),
    profiles: Object.fromEntries(profiles.map((p) => [p.id, p])),
  });
};
refreshWorkspaces();
const compacted = store.compactLargeEvents((data) => clip(data));
if (compacted) console.log(`[store] compacted ${compacted} oversized events`);

// The broker is optional. Without it Griffin still runs: chats, agents, jobs, charts, files and
// messengers all live in this process; only the credential-holding infrastructure tools are absent.
const BROKER_SOCKET = genv("BROKER_SOCKET", "/run/griffin/broker.sock");
const brokerWanted = Boolean(BROKER_SOCKET) && genv("BROKER", "on") !== "off";
const toolSource = createToolSource({ socketPath: brokerWanted ? BROKER_SOCKET : null, store });
const brokerEnabled = () => brokerWanted && toolSource.available();

// integrationsHolder breaks the cycle: asks needs to tell integrations a question closed, but
// integrations itself is constructed later (it takes asks as an argument). tasksHolder is the
// same trick: a finished run anywhere settles open peer tasks immediately instead of waiting for
// the 5-minute sweep.
const integrationsHolder = { current: null };
// The Telegram inbox (telegram-inbox.mjs) needs the runner, which needs to know the inbox chat.
const inboxHolder = { current: null };
const tasksHolder = { current: null };
const verifyHolder = { current: null };
const asks = createAsks({
  store,
  // Guard approvals from a job the owner wrote reach him (jobs/owner-jobs.mjs; ownerJobs is set below).
  ownerJobApprovals: (rootId) => ownerJobs.fullTools(rootId),
  onSettled: (chatId, info) => {
    integrationsHolder.current?.clearQuestion(chatId, info);
    // An owner's yes/no on an approval-style ask covers the next guarded call in the chain once
    // (double-ask fix). Requester answers never bless anything.
    // Not in a job the owner wrote: nobody watches it, so a yes to one approval must not let the
    // next, different gated call through unasked (jobs/owner-jobs.mjs).
    // The flag is the one asks.mjs recorded when the question was asked, so turning the setting
    // off meanwhile does not bring the blessing back.
    if (info?.by !== "requester" && info?.answer != null && !info?.ownerJobApproval && !ownerJobs.fullTools(chatId)) noteOwnerAnswer(store, chatId, info);
  },
});
const peersHolder = { current: null };
const toolBuilderHolder = { current: null };
// Made on the first owner-chat run that gets the chat-to-chat tools; keeps their rate limits across runs.
let ownerChatToolkit = null;
// Each run's step list (kv todo:<chat>) for the owner's board: native lists copied, cleared at run
// end once no delegated subtask still owes a report.
watchTodos(store, { pendingDelegates: (chatId) => peersHolder.current?.pendingDelegates(chatId) || 0 });
// On by default (owner 2026-10-19): notes the agent wrote in the owner's own clean chats reach his
// later chats without review (knowledge-trust.mjs decides "clean"). GRIFFIN_KNOWLEDGE_AUTO_TRUST=0
// => only owner-reviewed notes, as before.
const KNOWLEDGE_AUTO_TRUST = genv("KNOWLEDGE_AUTO_TRUST", "1") !== "0";
const chatTrust = createChatTrust({ store });
// A job whose prompt the owner wrote runs by its own mode (jobs/owner-jobs.mjs): «بدون پرسیدن» with
// the tools of his attended chats and nothing asking, the asking modes with his tools and gated calls
// asking him, «محدود» on the scheduler's quota. The Telegram-origin check (Karsara !79) plugs in as
// writerVerdict when it is ported. Jobs stored before modes keep how they ran (OWNER_JOBS_FULL_TOOLS).
migrateJobModes(store, { fullToolsFlag: genv(OWNER_JOBS_FLAG) === "1" });
const ownerJobs = createOwnerJobs({ store, ownerRooted: (id) => chatTrust.ownerRooted(id) });
const knowledge = createKnowledge({
  store,
  root: path.join(WORKSPACE, "knowledge"),
  git: genv("DEMO") !== "1",
  autoTrust: KNOWLEDGE_AUTO_TRUST,
  trust: chatTrust,
});
const KNOWLEDGE_ROOT = path.join(WORKSPACE, "knowledge");
// A business knowledge repo (AGENTS.md + docs/ at origin/main), readable by every caller including
// peers (business-docs.mjs). Off unless GRIFFIN_BUSINESS_DOCS_REPO names a
// checkout: no tools, no names in any catalog (agent settings, /api/tool-catalog), no prompt line.
const businessDocs = businessDocsFeature({ config: businessDocsConfig(), store });
// The owner's git clones: a chat may work on one, in its own worktree and branch
// under <REPOS_ROOT>/_wt. The broker and the sandbox see the same path.
const REPOS_ROOT = path.resolve(genv("REPOS_ROOT", path.join(WORKSPACE, "repos")));
// The repo a new chat from the web composer starts on (GRIFFIN_DEFAULT_REPO; none unless set).
const DEFAULT_REPO = genv("DEFAULT_REPO", "");
const showMedia = createShowMedia({
  store,
  workspace: WORKSPACE,
  resolveRoots: (chatId) => {
    const chat = store.getChat(chatId);
    return [agentCwd(WORKSPACE, chat?.agent || DEFAULT_AGENT), WORKSPACE];
  },
});
// Live previews (previews.mjs): apps an agent runs in the sandbox, shown in the chat. The sandbox runs
// the processes (the same box debug_exec uses); /p/<token>/… is proxied to it. exec reaches the broker
// lazily (callBrokerTool is defined further down), so this can be created before the runner.
const previews = createPreviews({
  store,
  exec: (command) => callBrokerTool("debug_exec", { host: "sandbox", command }, 125_000),
  enabled: () => genv("PREVIEW", "on") !== "off",
  previewHost: () => String(genv("PREVIEW_HOST", "")).trim().toLowerCase(),
  publicUrl: () => genv("PUBLIC_URL", ""),
});
// web_search / web_fetch for every engine (web-search.mjs): off with WEB_SEARCH=off.
const webTools = createWebTools({ enabled: () => genv("WEB_SEARCH", "on") !== "off", searchUrl: () => genv("WEB_SEARCH_URL", "") });
const visualizer = createVisualizer({
  store,
  fetchMetrics: genv("DEMO") === "1" ? (await import("./demo-sdk.mjs")).demoMetrics : async (args) => {
    const { status, body } = await brokerRequest(toolSource.socketPath, "POST", "/data/metrics", args, 120_000);
    if (status !== 200 || !body?.ok) throw Object.assign(new Error(body?.error || `broker http ${status}`), { attempts: body?.attempts });
    return body.result;
  },
});

// One tool-less completion (chat titles, the thread classifier's fallback, change reviewers): the
// OpenAI-compatible engine when it has a key, else Claude, else nothing ("" keeps the old title).
async function generateText(prompt, { model = null, effort: forced = null, timeoutMs = 30_000, engine = null } = {}) {
  if (genv("DEMO") === "1") return /[\u0600-\u06FF]/.test(prompt.split("Question:")[1] || "") ? "گفتگوی نمایشی" : "Demo chat";
  const useClaude = engine === PROVIDER_CLAUDE || (!engine && !providerKey(PROVIDER_OPENAI));
  if (useClaude) {
    const apiKey = providerKey(PROVIDER_CLAUDE);
    return apiKey ? claudeOneShot({ apiKey, model: model || genv("TITLE_CLAUDE_MODEL", "haiku"), prompt }) : "";
  }
  const config = providerConfig(PROVIDER_OPENAI);
  const baseUrl = (config.baseUrl ?? genv("OPENAI_BASE_URL", "")) || "https://api.openai.com/v1";
  const key = providerKey(PROVIDER_OPENAI);
  if (!key) return "";
  const effort = config.reasoningEffort ?? genv("OPENAI_REASONING_EFFORT", "");
  const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: model || genv("TITLE_MODEL", "") || config.model || genv("OPENAI_MODEL", "") || providers[PROVIDER_OPENAI]?.defaultModel,
      messages: [{ role: "user", content: prompt }],
      ...(effort ? { reasoning_effort: forced || "low" } : {}),
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`title http ${res.status}`);
  return (await res.json()).choices?.[0]?.message?.content || "";
}
// The two change reviewers (review.mjs): different engines so one model's blind spot is not the
// other's. Both need a working key; with fewer than two engines there is no gate
// (review.mjs skips it), and it only runs with GRIFFIN_REVIEW=on.
function changeReviewers() {
  if (genv("REVIEW") !== "on") return [];
  const reviewers = [];
  if (providerKey(PROVIDER_OPENAI) && !isLimited(PROVIDER_OPENAI)) {
    reviewers.push({ label: "بازبین OpenAI-compatible", ask: (prompt) => generateText(prompt, { engine: PROVIDER_OPENAI, model: genv("REVIEW_OPENAI_MODEL", "") || null, effort: "medium", timeoutMs: 90_000 }) });
  }
  if (providerKey(PROVIDER_CLAUDE) && !isLimited(PROVIDER_CLAUDE)) {
    reviewers.push({ label: "بازبین Claude", ask: (prompt) => claudeOneShot({ apiKey: providerKey(PROVIDER_CLAUDE), model: genv("REVIEW_CLAUDE_MODEL", "sonnet"), prompt }) });
  }
  return reviewers;
}
// Folded timelines in memory: opening a chat, titling it and delivering its answer read only new events.
const timelines = createTimelineCache({ store });
// No OpenAI-compatible key (a capsule on Claude only): Claude Haiku names the chat, as in Karsara.
// It used to answer «گفتگو» for every chat.
const titleText = (prompt) =>
  genv("DEMO") === "1" || providerKey(PROVIDER_OPENAI) ? generateText(prompt) : claudeOneShot({ apiKey: providerKey(PROVIDER_CLAUDE), model: "haiku", prompt });
const maybeTitle = createTitler({ store, timelines, generate: titleText });
// Older chats still carry the first line of the question as title; rename them once, one at a time.
setTimeout(async () => {
  for (const chat of [...store.listChats({ archived: false }), ...store.listChats({ archived: true })]) {
    if (chat.title.length > 24 || chat.title === STUCK_TITLE) await maybeTitle(chat.id, { backfill: true });
  }
}, 20_000);

const demo = genv("DEMO") === "1";
const demoSdk = demo ? (await import("./demo-sdk.mjs")).demoSdk : null;

// Provider settings the owner sets from the UI (kv "provider:<id>"); env stays the fallback.
// Keys live only in 0600 files under DATA and are never sent back to the browser.
// OpenAI-compatible endpoints the owner switches between; keyFile = the key already on disk for it.
const OPENAI_PRESETS = [
  { id: "openai", label: "OpenAI", baseUrl: "https://api.openai.com/v1", keyFile: "openai.api-key" },
  { id: "openrouter", label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", keyFile: "openrouter.api-key" },
  { id: "zai", label: "Z.ai Coding Plan", baseUrl: "https://api.z.ai/api/coding/paas/v4", keyFile: "zai.api-key" },
  // A model on this machine; Ollama ignores the key, the wizard stores a placeholder.
  { id: "ollama", label: "Ollama (local)", baseUrl: "http://host.docker.internal:11434/v1", keyFile: "ollama.api-key" },
];
const SAFE_KEY_FILE = /^[a-z0-9][a-z0-9._-]{0,60}\.api-key$/;

function providerConfig(id) {
  try {
    return JSON.parse(store.getKv(`provider:${id}`) || "{}") || {};
  } catch {
    return {};
  }
}

// Engine accounts (kv "engines"): the three base accounts plus any the owner adds (a second Claude
// account, an OpenRouter one …). Each can be switched off; a switched-off account is never routed to.
// Its settings stay in kv "provider:<id>", its key in the secret store as "engine/<id>".
function accounts() {
  let saved = [];
  try {
    saved = JSON.parse(store.getKv("engines") || "[]") || [];
  } catch {
    saved = [];
  }
  const byId = new Map(saved.filter((a) => ACCOUNT_ID.test(a?.id || "")).map((a) => [a.id, a]));
  const base = KINDS.map((id) => ({ id, ...(byId.get(id) || {}) }));
  const extra = saved.filter((a) => ACCOUNT_ID.test(a?.id || "") && !KINDS.includes(a.id));
  return [...base, ...extra].map((a) => ({ id: a.id, kind: kindOf(a.id) || a.id.split("-")[0], label: a.label || "", enabled: a.enabled !== false }));
}
function saveAccounts(list) {
  store.setKv("engines", JSON.stringify(list.map(({ id, label, enabled }) => ({ id, label, enabled }))));
  setAccounts(list);
}
setAccounts(accounts());
const accountEnabled = (id) => accounts().find((a) => a.id === id)?.enabled ?? false;
// The default engine account (kv "engine-default", «پیش‌فرض کن» on the engines page): every chat
// and agent tries it first, unless the chat pinned a model in the picker (owner 2026-10-18: «پیش‌فرض
// برای همه چت‌ها و ایجنت‌ها اعمال نمی‌شه»). Before, only a Claude login could be the default and
// only a candidate on the base "claude" account saw it. Older installs: kv "claude-active".
function defaultEngine() {
  const id = store.getKv("engine-default") || store.getKv("claude-active");
  return id && accounts().some((a) => a.id === id && a.enabled) ? id : null;
}
// The Claude login a candidate on the base "claude" account tries before it (Karsara's «active
// account», PUT /api/providers/claude/accounts/active); null = the base account itself.
function activeClaude() {
  const id = defaultEngine();
  return id && id !== PROVIDER_CLAUDE && kindOf(id) === PROVIDER_CLAUDE && !claudeEndpoint(id) ? id : null;
}
function setDefaultEngine(id) {
  store.deleteKv("claude-active");
  store.setKv("engine-default", id);
}

// A claude-* account with settings { endpoint: "zai" } runs Claude Code on that vendor's
// Anthropic-compatible endpoint (providers/claude-endpoint.mjs); the base "claude" account never does.
const claudeEndpoint = (id) => (kindOf(id) === PROVIDER_CLAUDE && id !== PROVIDER_CLAUDE ? endpointOf(providerConfig(id)) : null);

function providerKey(id) {
  const stored = secrets.get(`engine/${id}`);
  if (stored) return stored;
  // Older installs: a key file named in the account's settings, then the base account's env/file.
  const file = providerConfig(id).keyFile;
  if (file && SAFE_KEY_FILE.test(file)) {
    const full = path.join(DATA, file);
    return fs.existsSync(full) ? fs.readFileSync(full, "utf8").trim() : "";
  }
  return id === PROVIDER_CURSOR ? cursorApiKey() : id === PROVIDER_CLAUDE ? anthropicApiKey() : id === PROVIDER_OPENAI ? openaiApiKey() : "";
}

function buildProviders() {
  return createProviders({
    accounts: accounts().map(({ id, kind }) => {
      const config = providerConfig(id);
      const base = id === kind;
      const model = config.model
        || (base && kind === PROVIDER_OPENAI ? genv("OPENAI_MODEL", "") : "")
        || (base && kind === PROVIDER_CURSOR ? env.CURSOR_MODEL || "" : "")
        || (base && kind === PROVIDER_CLAUDE ? env.CLAUDE_MODEL || "" : "");
      return {
        id,
        apiKey: providerKey(id),
        baseUrl: config.baseUrl ?? (base && kind === PROVIDER_OPENAI ? genv("OPENAI_BASE_URL", "") : ""),
        model,
        reasoningEffort: config.reasoningEffort ?? (base && kind === PROVIDER_OPENAI ? genv("OPENAI_REASONING_EFFORT", "") : ""),
        endpoint: claudeEndpoint(id),
      };
    }),
    builtinTools: TOOLS,
    demoSdk,
  });
}

// A new engine account of a kind ("claude-2", "claude-work" …); an endpoint preset makes it a
// claude-* account on that vendor (claude-endpoint.mjs). Returns its id, or null for a bad slug.
function addAccount(kind, { slug = "", label = "", endpoint = null } = {}) {
  const s = String(slug || "").toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 16);
  const list = accounts();
  let id = s ? `${kind}-${s}` : `${kind}-2`;
  for (let n = 2; list.some((a) => a.id === id); n += 1) id = s ? `${kind}-${s}${n}` : `${kind}-${n}`;
  if (!ACCOUNT_ID.test(id)) return null;
  saveAccounts([...list, { id, label: String(label || "").trim().slice(0, 40), enabled: true }]);
  store.setKv(`provider:${id}`, JSON.stringify(endpoint ? endpointSettings({}, endpoint).next || {} : {}));
  reconfigureProviders();
  return id;
}

// Mutated in place on reconfigure: the runner looks providers up per run, so the next run uses the
// new settings while a run already in flight finishes on the old object.
const providers = buildProviders();
const probeCache = new Map(); // testEngine below: a changed key or setting is tested afresh
function reconfigureProviders() {
  probeCache.clear();
  for (const id of Object.keys(providers)) if (!PROVIDERS.includes(id)) delete providers[id];
  Object.assign(providers, buildProviders());
  modelCache = { at: 0, byProvider: {} };
  modelCacheGen += 1;
  vpn.setHosts(engineHosts());
}
// The hosts of the engines switched on (an OpenAI-compatible base URL, a Claude vendor endpoint): with the
// built-in VPN they, Telegram and the known AI providers go through it and nothing else does (vpn.mjs).
function engineHosts() {
  const urls = [];
  for (const a of accounts()) {
    if (!a.enabled) continue;
    const base = a.id === a.kind;
    if (a.kind === PROVIDER_OPENAI) urls.push(providerConfig(a.id).baseUrl ?? (base ? genv("OPENAI_BASE_URL", "") : ""));
    urls.push(claudeEndpoint(a.id)?.baseUrl);
  }
  return urls.filter(Boolean);
}
vpn.setHosts(engineHosts());

// The provider and model a chat's next run actually uses: the agent profile decides, the chat's own
// model overrides, the env default fills in. The same answer labels run.started, so the UI shows the
// real model instead of "auto".
const limitedUntil = (provider) => store.getKv(`limited:${provider}`) || 0;
const isLimited = (provider) => limitedUntil(provider) > Date.now();
// Out of credit (engine-state.mjs): kv credit:<id> = when it was seen; cleared by a new key, a
// sign-in, «دوباره امتحان کن» or a passing test.
const creditAt = (provider) => Number(store.getKv(`credit:${provider}`)) || 0;
const clearEngineMarks = (id) => {
  store.deleteKv(`limited:${id}`);
  store.deleteKv(`credit:${id}`);
};
// Candidates in order; the first USABLE one runs (enabled, has a key, not at its plan limit):
//   1. a model the chat pinned in the picker ("claude-2:sonnet")
//   2. colleague-thread routing (TEAM_* for the thread, TEAM_SUB_* for what it delegates)
//   3. the agent's ordered model list (meta.models, set on the Agents page) — "account:model" or
//      just "account" for that account's default model
//   4. the agent's provider/model
//   5. the old one-way fallback: OpenAI-compatible → Claude (FALLBACK_CLAUDE_MODEL), anything else → the OpenAI-compatible engine
//   6. any other usable account, base accounts first
// A plan limit marks the account limited (kv limited:<id>) and the run retries on the next usable
// candidate, so «Claude account 1 hit its limit» just moves to account 2 (owner 2026-10-12).
function modelCandidates(chat) {
  const profile = store.getAgentProfile(chat?.agent || DEFAULT_AGENT);
  const effort = effortOf(chat?.effort) || effortOf(profile?.meta?.effort);
  // A consult (peers.mjs) runs on the model it was asked for and nothing else: its accounts in
  // order, so a plan limit on one moves it to the next account of the same kind.
  const consult = consultOf(store, chat?.id);
  if (consult) return consultCandidates(consult).filter((c) => kindOf(c.provider)).map((c) => ({ ...c, effort }));
  const list = [];
  const add = (provider, model, extraEffort) => {
    if (!kindOf(provider)) return;
    const active = provider === PROVIDER_CLAUDE ? activeClaude() : null;
    const push = (id, m) => list.push({ provider: id, model: m || providers[id]?.defaultModel || "auto", effort: effort || extraEffort || null });
    if (active) push(active, model);
    push(provider, model);
    // Every Claude account runs the same Claude models: the same model on each of the others
    // comes right behind, so a plan limit on one account moves the chat to the next account
    // with the model it asked for (subscription → API key), never to a different engine first.
    // Endpoint accounts (Z.ai …) name other models and are left out.
    if (kindOf(provider) === PROVIDER_CLAUDE && !claudeEndpoint(provider)) {
      const chosen = list.at(-1).model;
      for (const a of accounts()) {
        if (a.id === provider || a.id === active || kindOf(a.id) !== PROVIDER_CLAUDE || claudeEndpoint(a.id)) continue;
        push(a.id, chosen === "auto" ? null : chosen);
      }
    }
  };
  const pinned = splitModel(chat?.model);
  if (pinned) add(pinned.provider, pinned.model);
  const teamRoot = chat?.caller === COVERAGE_CALLER || (chat?.parent_chat_id && rootCallerOf(store, chat) === COVERAGE_CALLER);
  const prefix = chat?.caller === COVERAGE_CALLER ? "TEAM" : "TEAM_SUB";
  const team = teamRoot ? genv(`${prefix}_PROVIDER`, "") : "";
  if (team) add(team, genv(`${prefix}_MODEL`, ""), effortOf(genv(`${prefix}_EFFORT`, "")));
  const own = profile?.provider || chat?.provider;
  // The default engine before the agent's own list; it keeps the agent's model only where that
  // model name means the same thing (the same account, or two plain Claude logins).
  const preferred = defaultEngine();
  if (preferred) {
    const same = sameModelNames(preferred, own, { kindOf, isEndpoint: (id) => Boolean(claudeEndpoint(id)) });
    add(preferred, same ? (pinned ? null : chat?.model) || profile?.model : null);
  }
  for (const entry of profile?.meta?.models || []) {
    const split = splitModel(entry);
    if (split) add(split.provider, split.model);
    else add(String(entry), null);
  }
  if (kindOf(own)) add(own, (pinned ? null : chat?.model) || profile?.model);
  if (kindOf(own) === PROVIDER_OPENAI) add(PROVIDER_CLAUDE, genv("FALLBACK_CLAUDE_MODEL", "haiku"));
  else add(PROVIDER_OPENAI, null);
  for (const a of accounts()) add(a.id, null);
  // A colleague's chain (peer:*) runs only on the models the owner allowed it on this agent
  // (Peers page): the allowed entries are candidates themselves, and nothing else is.
  const rootCaller = chat?.parent_chat_id ? rootCallerOf(store, chat) : chat?.caller;
  const allowed = isPeerCaller(rootCaller) ? peerSettings(profile, rootCaller)?.models || [] : [];
  if (allowed.length) {
    for (const entry of allowed) {
      const split = splitModel(entry);
      if (split) add(split.provider, split.model);
      else add(entry, null);
    }
    return list.filter((c) => allowsModel(allowed, c.provider, c.model));
  }
  return list;
}
// chat_suggest: the named model must be one that account runs now (account null = the chat's own).
async function checkSuggestModel(account, model, chat) {
  const id = account || store.getAgentProfile(chat?.agent || DEFAULT_AGENT)?.provider || chat?.provider;
  if (!kindOf(id)) return `unknown engine account "${id}"; accounts: ${accounts().map((a) => a.id).join(", ")}`;
  if (!accountEnabled(id)) return `engine account "${id}" is turned off`;
  if (!providerKey(id) && !demo) return `engine account "${id}" has no key`;
  if (isLimited(id)) return `engine account "${id}" is at its plan limit until ${new Date(limitedUntil(id)).toISOString()}`;
  const ids = (await models(id).catch(() => [])).map((m) => m.id);
  if (ids.length && !ids.includes(model)) return `engine account "${id}" does not list model "${model}"; valid ids: ${ids.join(", ")}`;
  return null;
}
// consult: the accounts that run `model` now, best first — the one named (or the kind's base
// account), then the other accounts of the same kind. Another account of the openai kind can be
// another vendor (Z.ai, OpenRouter), so it is a fallback only when it lists the model by name.
const consultAccounts = (provider, model) =>
  resolveConsultAccounts({
    provider,
    model,
    accounts: accounts(),
    check: (id) => checkSuggestModel(id, model, null),
    lists: async (id) => (await models(id).catch(() => [])).some((m) => m.id === model),
  });
const stateOf = (id) => engineState({ enabled: accountEnabled(id), keyed: Boolean(providerKey(id)) || demo, limitedUntil: limitedUntil(id), creditAt: creditAt(id) });
const usableAccount = (id) => stateOf(id).state === "ok";
// PLAN_FALLBACK=ask (plan-fallback.mjs; owner install): an owner's own chat never moves to another
// engine by itself at a plan limit — a card asks first. Chats nobody types into (jobs, colleagues'
// threads, subtasks) and consults (same model, account to account) keep the auto-fallback.
const asksBeforeSwitch = (chat) => planFallbackMode(genv("PLAN_FALLBACK", "ask")) === "ask" && ownerTyped(store, chat) && !consultOf(store, chat?.id);
const keyedAccount = (id) => Boolean(providerKey(id)) || demo;
// Auto mode ranks the candidates by usability (engine-state.mjs): the first usable one in the
// chat's own order runs; with none usable, the one whose limit resets soonest; out of credit last.
// Ask mode keeps the chat's own engine first: it waits or asks, never moves by itself.
function routeModel(chat) {
  const ask = asksBeforeSwitch(chat);
  const list = ask ? modelCandidates(chat) : rankByState(modelCandidates(chat), stateOf);
  return pickRoute(list, { usable: usableAccount, enabled: accountEnabled, keyed: keyedAccount, ask, kindOf }) || { provider: DEFAULT_PROVIDER, model: "auto", effort: null };
}
const accountName = (id) => accounts().find((a) => a.id === id)?.label || claudeEndpoint(id)?.label || (kindOf(id) === PROVIDER_CLAUDE ? "Claude" : id);
const runModel = routeModel;

// The Telegram /model menu (integrations/manager.mjs modelMenu → modelChoices): each distinct
// model the chat could run on now, one entry per model with its account(s), in routing order —
// the chat's pinned model ticked, a limited account kept with its reset note, never a live engine
// call. The pick's value is `provider/model`, stored by store.updateChat exactly as the web's
// PATCH /api/chats/:id stores it, so the web picker and the Telegram pin stay the same column.
const modelChoices = async (chat) => {
  const candidates = modelCandidates(chat);
  const now = Date.now();
  const inScope = candidates.filter((c) => accountEnabled(c.provider) && kindOf(c.provider));
  const ordered = [];
  const seenModel = new Map();
  for (const c of inScope) {
    const model = c.model || providers[c.provider]?.defaultModel || "auto";
    const alias = kindOf(c.provider) === PROVIDER_CLAUDE ? (await import("./providers/claude.mjs")).resolveModel?.(model) || model : model;
    const name = model === "auto" ? "auto" : String(alias).replace(/^claude-/i, "").replace(/^gemini-/i, "").replace(/-latest$/, "");
    const existing = seenModel.get(`${kindOf(c.provider)}::${alias}`);
    if (existing) {
      if (limitedUntil(c.provider) > now) existing.accounts.push(accountName(c.provider));
      else if (model !== "auto" && existing.accounts.length && !existing.accounts.at(-1).includes("auto")) existing.accounts.push(accountName(c.provider));
      continue;
    }
    const until = limitedUntil(c.provider);
    const entry = {
      value: `${c.provider}/${model}`,
      model,
      name,
      label: "",
      note: until > now ? `سقف ${accountName(c.provider)} تا ${new Date(until).toLocaleTimeString("fa-IR", { hour: "2-digit", minute: "2-digit" })}` : "",
      accounts: [accountName(c.provider)],
    };
    seenModel.set(`${kindOf(c.provider)}::${alias}`, entry);
    ordered.push(entry);
  }
  const pinned = splitModel(chat?.model);
  const running = chat?.model || null;
  const labelOf = (e) => `${e.name === "auto" ? "انتخاب خودکار" : e.name}${e.accounts.length > 1 ? ` (${e.accounts.join("، ")})` : ""}`;
  for (const e of ordered) e.label = labelOf(e);
  if (pinned && !ordered.some((e) => e.value === `${pinned.provider}/${pinned.model}`)) {
    const entry = { value: `${pinned.provider}/${pinned.model}`, model: pinned.model, name: pinned.model === "auto" ? "auto" : String(pinned.model).replace(/^claude-/i, "").replace(/^gemini-/i, "").replace(/-latest$/, ""), label: "", note: "پین فعلی", accounts: [] };
    entry.label = labelOf(entry);
    ordered.unshift(entry);
  }
  for (const e of ordered) e.current = running ? e.value === `${pinned?.provider}/${pinned?.model}` : false;
  if (!running) {
    const route = routeModel(chat);
    const match = ordered.find((e) => e.value === `${route.provider}/${route.model}`) || ordered.find((e) => e.model === route.model);
    if (match) match.current = true;
  }
  return ordered.slice(0, 20);
};

const runner = createRunner({
  store,
  runLabel: runModel,
  annotate: (chatId) => integrationsHolder.current?.desk?.annotate(chatId) || null,
  onFinished: (chatId) => {
    maybeTitle(chatId);
    tasksHolder.current?.sweep().catch(() => {});
    // Maker/checker: re-run the finished run's read-only probes outside the model; a drifted
    // claim is corrected in-chat on the next turn. verifyHolder is filled once callBrokerTool
    // exists below (same holder trick as tasksHolder).
    verifyHolder.current?.verifyFinishedRun(chatId).catch(() => {});
  },
  // Plan limit on Claude: remember until it resets (or an hour) and retry the run on the profile's
  // provider, so a colleague's message never dies with the owner's Pro quota.
  onPlanLimit: (chat, error, used) => {
    const limited = used || runModel(chat).provider;
    // Out of credit is no plan window: marked apart, tried last, and no reset to wait for.
    if (isCreditError(error?.message)) {
      store.setKv(`credit:${limited}`, Date.now());
      const next = runModel(chat).provider;
      console.error(`[${limited}] out of credit — chat ${chat?.id} moves to ${next}`);
      return next !== limited;
    }
    const until = error.resetsAt && error.resetsAt > Date.now() ? error.resetsAt : Date.now() + 60 * 60_000;
    store.setKv(`limited:${limited}`, until);
    // Per-account usage for the engines page: when it last hit its limit and until when.
    store.setKv(`limitseen:${limited}`, JSON.stringify({ at: Date.now(), until }));
    const next = runModel(chat).provider;
    console.error(`[${limited}] plan limit until ${new Date(until).toISOString()} — chat ${chat?.id} moves to ${next}`);
    return next !== limited;
  },
  // No engine took the run over: it continues by itself once the first of its engines is usable
  // again (onPlanLimit stored each one's reset, or an hour when the engine did not say).
  limitResetAt: (chat) => {
    // Nobody waits for a consult after its call returned: it never continues on its own later.
    if (consultOf(store, chat?.id)) return null;
    // Asking before a switch: the chat waits for its own engine's reset, not for any engine's.
    if (asksBeforeSwitch(chat)) return limitedUntil(routeModel(chat).provider) || null;
    const times = modelCandidates(chat)
      .filter((c) => ["ok", "limited"].includes(stateOf(c.provider).state))
      .map((c) => limitedUntil(c.provider));
    return times.length ? Math.min(...times) || Date.now() : null;
  },
  askFallback: asksBeforeSwitch,
  accountHop: (chat) => pickAccountHop(modelCandidates(chat), routeModel(chat), { enabled: accountEnabled, keyed: keyedAccount, usable: usableAccount, nameOf: accountName, kindOf }),
  fallbackFor: (chat) => pickFallback(modelCandidates(chat), routeModel(chat), { usable: usableAccount, nameOf: accountName, kindOf }),
  autoContinue: () => genv("AUTO_CONTINUE", "on") !== "off",
  promptSuggestions: () => genv("PROMPT_SUGGESTIONS", "on") !== "off",
  onCancel: (chatId) => {
    const leftover = asks.cancel(chatId);
    peersHolder.current?.cancelChildren(chatId);
    // An answer held for a question the agent never got to: deliver it as a normal follow-up.
    if (leftover) setTimeout(() => runner.send(chatId, { text: `پاسخ من: ${leftover.answer}`, images: [], intent: runner.isActive(chatId) ? "queue" : "send" }).catch(() => {}), 0);
  },
  // An explicit stop also clears the chat's step list (kept while delegates ran): nothing is in progress.
  onUserCancel: (chatId) => {
    store.deleteKv(`todo:${chatId}`);
    return peersHolder.current?.cancelChildren(chatId, { includeDelegates: true });
  },
  isSoftBusy: (chatId) => Boolean(peersHolder.current?.hasChildren(chatId)),
  isBlocked: (chatId) => asks.isWaiting(chatId),
  // A consult's caller is gone after a restart: it is never continued (peers.mjs).
  // The Telegram inbox puts its own item back in its queue after a restart: its chat is not continued.
  notResumable: (chat) => Boolean(consultOf(store, chat?.id)) || Boolean(inboxHolder.current?.isInboxChat(chat?.id)),
  providerFor: (chat) => providers[runModel(chat).provider] || providers[DEFAULT_PROVIDER],
  agentOptions: async (chat) => {
    if (genv("CLAUDE_CODE", "off") === "on") await mcpOauth.ensureFresh().catch(() => {});
    const agent = chat.agent || DEFAULT_AGENT;
    const caller = chat.caller || "owner";
    const profile = store.getAgentProfile(agent);
    if (!profile) throw new Error(`unknown agent profile: ${agent}`);

    const brokerNames = await toolSource.listNames();
    const jobToolNames = Object.keys(createJobTools({ jobs, targets: () => integrations.targets() }));
    const catalogForSettings = uniqueTools([
      ...(brokerNames || []),
      ...APP_TOOL_NAMES,
      ...businessDocs.names,
      ...jobToolNames,
      "telegram_dialogs",
      "telegram_read",
      "telegram_media",
      "telegram_watch_list",
      "telegram_send",
    ]);
    const settingsTools = bindChatTools(
      createAgentSettingsTools({ store, catalogNames: () => catalogForSettings, mayRename: (chatId) => chatTrust.ownerRooted(chatId) && chatTrust.isCleanChat(chatId) && !store.getKv(thirdPartyKey(chatId)), confirm: (chatId, question) => asks.confirm(chatId, { question }), engine: { isEngine: (id) => Boolean(kindOf(id)), splitModel } }),
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
      ...network.tools(chat.id),
      [PEER_CONNECTION_TOOL]: peerConnectionTool({ store, defaultUser: chat.person_id ? store.getPerson?.(chat.person_id)?.access?.peerAgent?.user || null : null }),
      ...knowledge.tool(chat.id),
      ...businessDocs.tools(),
      [VISUALIZE_TOOL]: visualizer.tool(chat.id),
      [SHOW_MEDIA_TOOL]: showMedia.tool(chat.id),
      ...webTools.tools(),
      // A chat holding a colleague's words (chat_send, third-party mark) writes jobs as "unknown".
      ...createJobTools({ jobs, targets: () => integrations.targets(), chatId: chat.id, writerOf: jobWriterOf(store, { ownerRooted: (id) => chatTrust.ownerRooted(id) }) }),
      // tell_owner: only the ops room, only in "critical" mode (shadow/record stay silent).
      ...createIncidentTools({ incidents, notify: opsRoom.mode === "critical" && chat.caller === "ops" ? (text) => integrations.notifyOwner(text, chat.id) : null }),
      ...settingsTools,
      ...doctor.tools,
      // A colleague's own conversation may tell an owner chat something (its quota decides).
      ...(isPeerCaller(caller) ? createPeerChatTools({ store, runner, chat }) : {}),
    };
    // Per install (TELEGRAM_LEDGER=on, from Karsara): every telegram_send is written to the send
    // ledger under this chat, and the owner's own chats can read it back (telegram-ledger.mjs).
    // In inbox mode (TELEGRAM_DM_MODE=inbox) the ledger is always kept, and each send closes that
    // person's waiting burst in the inbox (telegram-inbox.mjs).
    Object.assign(customTools, createAccountTools({ getClient: () => integrations.accountClient(), markSent: (id) => integrations.markAccountSent(id), onSent: (peer, text) => {
      integrations.ownerWrote(peer, text);
      // An owner chat that wrote to someone is one of the threads their reply may belong to (desk.mjs askedBy).
      if (isOwnerChat(store, chat)) integrations.askedBy(peer, chat.id, text);
    }, record: ledgerAndInbox(chat.id) }));
    Object.assign(customTools, ledgerTools({ store, chat, enabled: ledgerOn() }));
    Object.assign(customTools, watchListTools({ store }));

    const cwd = agentCwd(WORKSPACE, agent);
    const peers = store.listAgentProfiles().filter((p) => p.id !== agent);
    const rootCaller = chat.parent_chat_id ? rootCallerOf(store, chat) : caller;
    const rootChatId = store.rootChatId(chat.id);
    const unattended = ["scheduler", "ops"].includes(rootCaller) || Boolean(store.getChat(rootChatId)?.job_id);
    // A job the owner wrote, not «محدود»: his attended tools; gated calls ask him, or nothing asks in
    // «بدون پرسیدن» (jobs/owner-jobs.mjs). Every other run: asOwner = his own attended chain,
    // guardMode as before.
    const ownerJob = unattended && ownerJobs.fullTools(chat.id);
    const access = runAccess({ rootCaller, unattended, ownerJob, bypass: ownerJob && ownerJobs.bypass(chat.id), coverage: caller === COVERAGE_CALLER });
    // Suggest a chat / mark a chapter (chat-tools.mjs): only in chats the owner is reading.
    if (access.asOwner) {
      // Run an app in the sandbox and show it live in the chat (previews.mjs).
      if (genv("PREVIEW", "on") !== "off" && genv("DEMO") !== "1") Object.assign(customTools, previews.tools(chat.id));
      Object.assign(customTools, createChatTools({ store, chatId: chat.id, isValidRepo: (repo) => isValidRepoName(REPOS_ROOT, repo), checkModel: checkSuggestModel }));
      // consult: another model answers inside one call (peers.mjs; it refuses in sub-chats itself).
      customTools[CONSULT_TOOL] = peersHolder.current.consultTool(chat.id);
    }
    // chat_list / chat_read / chat_send / notify_owner between the owner's own chats (from Karsara;
    // owner-chat-tools.mjs). On by default on every install (owner 2026-10-19); OWNER_CHAT_TOOLS=off.
    if (offersOwnerChatTools(store, chat, { enabled: genv(OWNER_CHAT_TOOLS_CONFIG, "on") !== "off" })) {
      ownerChatToolkit ??= createOwnerChatToolkit({
        store,
        runner,
        link: (id) => (genv("PUBLIC_URL") ? `${genv("PUBLIC_URL").replace(/\/$/, "")}/#/c/${id}` : null),
        // The owner's existing routes: Web Push to his phone, and one line from his Telegram bot.
        notify: async (target, text) => {
          const [pushed, telegram] = await Promise.all([
            push.notify("notify", target, { summary: text }),
            integrations.notifyOwner(`🔔 ${String(target?.title || "").slice(0, 80)}\n${text}`, target?.id || null).catch(() => false),
          ]);
          return { push: pushed?.sent ?? 0, telegram: Boolean(telegram) };
        },
      });
      Object.assign(customTools, ownerChatToolkit.tools(chat.id));
    }
    // mcp_server_list / _add / _remove: the owner's own chats only (mcp-server-tools.mjs).
    if (access.asOwner) Object.assign(customTools, createMcpServerTools({ store, chatId: chat.id, oauth: mcpOauth, publicUrl: genv("PUBLIC_URL", "") }));
    // A job this conversation made is its own to delete: no owner question for it (2026-10-13, «حذف
    // جاب — id …» reached the owner for a watcher job the agent had made itself an hour before).
    const createJob = customTools.jobs_create;
    if (createJob) {
      customTools.jobs_create = {
        ...createJob,
        async execute(args) {
          const out = await createJob.execute(args);
          const id = out?.isError ? null : JSON.parse(out?.content?.[0]?.text || "{}").id;
          if (id) store.setKv(`jobfrom:${id}`, rootChatId);
          return out;
        },
      };
    }
    const ownJob = (name, args) => name === "jobs_delete" && store.getKv(`jobfrom:${args?.id}`) === rootChatId;
    // The job's own chat runs on the owner's quota instead of the scheduler's lean one (and its
    // rules say so, below).
    const quotaCaller = ownerJob && caller === "scheduler" ? "owner" : caller;
    let filtered = filterToolsByProfile(customTools, profile, { caller: quotaCaller });
    // An unattended run never edits agent profiles, even one the owner wrote.
    if (ownerJob) for (const name of SELF_MGMT_TOOLS) delete filtered[name];
    // Irreversible calls in any chain not rooted in the owner need the owner's yes (in code). The
    // question reaches them in Telegram wherever the chain started, so a peer chain asks too
    // instead of refusing outright.
    filtered = fenceBackdoors(filtered, { chatId: chat.id, store, caller: rootCaller });
    filtered = secretsGate(filtered, {
      chatId: chat.id,
      asks,
      store,
      caller: rootCaller,
      mode: access.guardMode === "refuse" ? "refuse" : "ask",
      ownerProjects: String(genv("OWNER_INFISICAL_PROJECTS", "")).split(",").filter(Boolean),
    });
    if (access.guardMode) {
      filtered = guardTools(filtered, {
        chatId: chat.id,
        asks,
        store,
        caller: rootCaller,
        extra: rootCaller === COVERAGE_CALLER ? TEAM_MUTATING : null,
        allowPass: ownJob,
        mode: access.guardMode,
      });
    }
    // A person's mother chat orchestrates and never closes (integrations/mother.mjs); only
    // send_to_person reaches the colleague, so no telegram_send and no ask_requester there.
    const mother = caller === COVERAGE_CALLER ? motherInfo(store, chat.id) : null;
    if (mother) {
      delete filtered.telegram_send;
      delete filtered[ASK_REQUESTER_TOOL];
      Object.assign(filtered, createMotherTools({
        store, runner, chatId: chat.id, name: mother.name,
        sendToPerson: (text, options) => integrations.desk.sendToPerson(chat.id, text, options),
        editSent: (id, text) => integrations.desk.editSent(chat.id, id, text),
        deleteSent: (id) => integrations.desk.deleteSent(chat.id, id),
        react: (id, emoji) => integrations.desk.reactTo(chat.id, id, emoji),
        forwardToChat: (target, note, why) => integrations.desk.forwardToChat(chat.id, target, note, why),
      }));
    }
    // The global chat («🌐 … — همه»): the assistant's Telegram desk (integrations/desk.mjs).
    const desk = !mother && caller === "owner" && isGlobalChat(store, chat.id);
    if (desk) Object.assign(filtered, integrations.desk.globalTools());
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
    // Every change, in every chain (owner's too), first needs two independent reviewers' yes.
    if (genv("DEMO") !== "1") filtered = reviewChanges(filtered, { chatId: chat.id, store, asks, reviewers: changeReviewers() });
    // The owner's board (todos.mjs, inbox.mjs). One todo tool per engine: Claude has TodoWrite,
    // Cursor updateTodos; decided per run, so a fallback to the OpenAI-compatible engine gets todo_write. A chore for the
    // owner only where he reads the board (offersOwnerTask: his chains and colleagues' Telegram ones,
    // never jobs, the ops room or a peer's /mcp chain); a rehearsal records it (sim.mjs).
    if (kindOf(runModel(chat).provider) === PROVIDER_OPENAI) filtered[TODO_TOOL] = todoWriteTool({ store, chatId: chat.id });
    if (agent === DEFAULT_AGENT && access.asOwner) filtered.inbox_list = inboxTool({ store, asks });
    if (offersOwnerTask(ownerJob ? { rootCaller: "owner", unattended: false } : { rootCaller, unattended })) filtered[OWNER_TASK_TOOL] = ownerTaskTool({ store, chatId: rootChatId, askedIn: chat.id, agent });


    // A chat on a repo (a side chat or a fork: its main chat's) works in that chat's own worktree,
    // made on the first run; any engine gets the file/git tools for it. A fork must: Claude Code
    // keeps the forked session by working folder. A folder switch in flight finishes first, and the
    // chat is read after it (its repo may have moved).
    // A consult works in the folder of the chat that asked.
    const mainId = chat.side_of || store.getKv(`fork-of:${chat.id}`) || consultOf(store, chat.id)?.from;
    await worktreeCreationSettled(REPOS_ROOT, mainId || chat.id);
    const repoChat = mainId ? store.getChat(mainId) || chat : store.getChat(chat.id) || chat;
    let repoContext = null;
    if (repoChat.repo && isValidRepoName(REPOS_ROOT, repoChat.repo)) {
      const dir = await ensureChatWorktree({
        reposRoot: REPOS_ROOT,
        repo: repoChat.repo,
        chatId: repoChat.id,
        currentDir: repoChat.worktree_path || null,
        onCurrent: (current) => store.updateChat(repoChat.id, { worktreePath: current }),
        fetchRepo: brokerEnabled() ? (repo) => callBrokerTool("git_fetch", { repo }, 130_000) : null,
        onNote: (note) => store.appendEvent(chat.id, null, "note", { text: note }),
      });
      const moved = store.getKv(`repomove:${repoChat.id}`);
      repoContext = { repo: repoChat.repo, dir, branch: currentWorktree(REPOS_ROOT, repoChat.id, { currentDir: dir }).branch, moved: moved?.to === repoChat.repo ? moved : null };
      Object.assign(filtered, createRepoChatTools({ ...repoContext, push: (args) => callBrokerTool("git_push", args, 200_000) }));
    }

    // The same requester's open work in other channels: hand a follow-up there instead of
    // starting over (related.mjs). Root conversations only.
    const relatedOpen = !chat.parent_chat_id && !chat.side_of
      ? openWorkFor(store, chat, { isOpen: (id) => runner.isActive(id) || (peersHolder.current?.pendingDelegates(id) || 0) > 0 || asks.isWaiting(id) })
      : [];
    if (relatedOpen.length) filtered[RELATED_TOOL] = createRelatedTool({ store, runner, chat, open: relatedOpen });
    // build_tool: any attended chain may ask for a missing read-only tool; the owner approves it.
    // A merge on the Griffin repo from a build chat or a non-owner chain never touches the fences.
    const builder = toolBuilderHolder.current;
    const buildChat = Boolean(builder?.isBuildChat(rootChatId));
    if (builder && !unattended && !buildChat && !chat.side_of) {
      const root = store.getChat(rootChatId) || chat;
      filtered[BUILD_TOOL] = builder.tool(chat, { requester: `در گفتگوی «${String(root.title || "").slice(0, 70)}»` });
    }
    if (buildChat || rootCaller !== "owner") {
      filtered = guardGriffinMerge(filtered, { chatId: chat.id, buildChat, callBroker: callBrokerTool, confirm: (id, q) => confirmWithOwner(store, asks, id, q), isYes });
    }
    // A chat holding a colleague's text (chat_send) passes nothing on until the owner writes again.
    filtered = lastHop(filtered, { store, chatId: chat.id });
    // A consult answers inside its call: nothing it starts may outlive it (peers.mjs).
    if (consultOf(store, chat.id)) for (const name of CONSULT_WITHHELD) delete filtered[name];
    // A side chat the owner started with «اجازهٔ تغییر فایل» off only reads and asks.
    const readOnlySide = sideIsReadOnly(store, chat);
    if (readOnlySide) filtered = restrictForReadOnlySide(filtered);

    // Outermost: a simulation tree records side effects instead of running them (no approval
    // question reaches the owner either — sim wraps the guard).
    if (store.getChat(rootChatId)?.sim) filtered = simulateTools(filtered);

    // The Telegram inbox chat only routes (telegram-inbox.mjs): its own tools whatever the profile
    // says — no send, no file, no shell, no questions box. Its chat_suggest is this chat's, without
    // repo/model choice; chats started from it inherit its Telegram-origin marker (chat-origin.mjs).
    const inboxChat = inbox.isInboxChat(chat.id);
    if (inboxChat) {
      const suggest = createChatTools({ store, chatId: chat.id }).chat_suggest;
      filtered = restrictForInbox({ ...customTools, ...createInboxTools({ store, runner, chatId: chat.id, suggest }) });
      // The fence (no built-in tool) is the Claude provider's: on any other engine it gets no tool at all.
      if (kindOf(runModel(chat).provider) !== PROVIDER_CLAUDE) filtered = {};
    }

    // Rules are built from the tools this run really has (after caller filtering and guards).
    const ruleOptions = { agent, caller: quotaCaller, peers, profile, knowledgeRoot: KNOWLEDGE_ROOT, tools: Object.keys(filtered), thirdParty: Boolean(store.getKv(thirdPartyKey(chat.id))), mother: Boolean(mother), autoTrust: KNOWLEDGE_AUTO_TRUST && !desk && chatTrust.ownerRooted(chat.id), isTrustedNote: chatTrust.isTrustedNote, businessDocsLabel: "business_docs_search" in filtered ? businessDocs.promptLabel : "" };
    installRules(cwd, ruleOptions);
    const rules = (repoContext ? `${buildRules(ruleOptions)}\n\n${repoRules(repoContext)}` : buildRules(ruleOptions)) + relatedRules(relatedOpen, channelOf(store, chat)) + (mother ? motherContext(mother.name) : desk ? globalContext() : "") + (inboxChat ? INBOX_PROMPT : "");
    const seedMessages = chat.agent_id ? null : seedTurns(chat);
    // «چرا؟»: what this session starts with, kept on the chat (manifest.mjs). Never fails the run.
    try {
      recordManifest(store, chat.id, buildManifest({
        route: runModel(chat),
        agent,
        caller,
        rootCaller,
        mode: chat.mode,
        tools: Object.keys(filtered),
        rules,
        knowledge: reviewedRunbooks(KNOWLEDGE_ROOT, agent),
        playbook: playbookIndex(KNOWLEDGE_ROOT).length,
        repo: repoContext?.repo || null,
        seeded: seedMessages?.length || 0,
        guards: {
          approval: access.guardMode || (caller === COVERAGE_CALLER ? "team" : null),
          ownerJob: Boolean(ownerJob),
          review: genv("DEMO") !== "1",
          sim: Boolean(store.getChat(rootChatId)?.sim),
        },
      }, (text) => store.putBlob(text)));
    } catch (error) {
      console.error(`[manifest] chat ${chat.id}: ${error.message}`);
    }

    // Claude's own file and web tools (providers/file-scope.mjs; owner, 2026-10-13): only in the
    // owner's own chats, and there reading only the workspace and writing only in this chat's folder —
    // never the knowledge store, the agent's state and rules, or a worktree's .git. Any other chain
    // (a colleague, a peer, a job, the ops room, the Telegram desk) gets none.
    const workDir = repoContext?.dir || cwd;
    const fileAccess = access.asOwner && !desk && !inboxChat
      ? { read: [WORKSPACE], write: readOnlySide ? [] : [workDir], deny: [KNOWLEDGE_ROOT, path.join(workDir, ".git"), ...[".cursor", ".claude", ".griffin-openai-sessions", "CLAUDE.md"].map((name) => path.join(cwd, name))] }
      : null;
    // Config CLAUDE_HOST: the owner's full Claude Code runs on the host (providers/host-spawn.mjs). There
    // the data folder is GRIFFIN_CLAUDE_HOST_DATA (the host path of /data), so the guards protect that.
    const onHost = runsOnHost({ claudeCode: Boolean(fileAccess) && genv("CLAUDE_CODE", "off") === "on", ownerJob, mode: genv("CLAUDE_HOST", "off"), chosen: chat.runs_on, bypass: (chat.mode || "agent") === "agent" && Boolean(hostTarget()) });
    const runData = (onHost && genv("CLAUDE_HOST_DATA", "")) || DATA;
    const claudeCode = claudeCodeOptions({ fileAccess, claudeCodeOn: !readOnlySide && genv("CLAUDE_CODE", "off") === "on", stateGuardOn: genv("STATE_GUARD", "on") !== "off", statePaths: () => griffinStatePaths({ knowledgeRoot: KNOWLEDGE_ROOT, data: runData, home: runData === DATA ? os.homedir() : path.join(runData, "home") }), ownerJob, dataDir: runData, jobClosed: brokerPaths(toolSource.socketPath) });

    return {
      // Engines with their own file tools (Claude, Cursor) work in the worktree; the agent's own
      // folder keeps its state (openai sessions) and rules files.
      cwd: workDir,
      fileAccess,
      ...(consultOf(store, chat.id) ? { maxTurns: CONSULT_MAX_TURNS } : {}),
      // The owner's full Claude Code (config CLAUDE_CODE=on): Bash, his settings, skills and MCP servers,
      // beside Griffin's tools — only where he has file tools at all (his own chats, and with
      // GRIFFIN_OWNER_JOBS_FULL_TOOLS=1 his own jobs). Config STATE_GUARD (default on): Bash and every
      // tool also refuse writes into the knowledge store and the data folder (providers/state-guard.mjs).
      ...claudeCode,
      ...(onHost ? { onHost: true } : {}),
      // The chat's permission mode (owner 2026-10-17, as in Claude Desktop): in «auto», «ask» and «edits»
      // a step Claude Code wants a permission for becomes a yes/no card for the owner.
      ...(fileAccess ? { approve: (question) => confirmWithOwner(store, asks, chat.id, question).then(isYes), elicit: (args) => asks.elicit(chat.id, args) } : {}),
      // Config TELEGRAM_INSTRUCTION_GUARD (default on; off turns it off): a chat born from someone else's Telegram
      // message may not write the owner's CLAUDE.md, settings, memory, skills, hooks or core.md
      // (chat-origin.mjs). His own Saved Messages and his own bot chat stay unrestricted.
      ...(claudeCode.claudeCode && genv("TELEGRAM_INSTRUCTION_GUARD", "on") !== "off"
        ? { instructionPaths: instructionPathsFor(store, chat, { configDirs: [process.env.CLAUDE_CONFIG_DIR, path.join(os.homedir(), ".claude"), onHost && runData !== DATA ? path.join(runData, "home", ".claude") : null], reposRoot: REPOS_ROOT }) }
        : {}),
      // Config CLAUDE_BACKGROUND_TASKS (default on, as in Karsara): with full Claude Code in his own chats (not his
      // jobs), background shells and agents outlive the turn, each with its own stop (runner.stopTask).
      ...(claudeCode.claudeCode && !ownerJob && genv("CLAUDE_BACKGROUND_TASKS", "on") !== "off" ? { backgroundTasks: true } : {}),
      // Config PLAN_APPROVAL (default off): in his own chats a Claude plan (ExitPlanMode in plan mode)
      // waits on his question card; his approval, or an exact approval word typed in the box or his
      // Telegram (asks.approvePlanByText), moves the chat to agent mode, as in Karsara.
      // Root chats only: a child or a consult inherits plan mode, and its plan is its parent's to present.
      ...(fileAccess && genv("PLAN_APPROVAL", "off") === "on" && (store.rootChatId?.(chat.id) ?? chat.id) === chat.id
        ? {
            planApproval: {
              ask: (args) => asks.plan(chat.id, args),
              onApproved: () => {
                store.updateChat(chat.id, { mode: "agent" });
                store.bus?.emit?.("chats", { type: "live", chatId: chat.id });
              },
            },
          }
        : {}),
      // Config CLAUDE_STEER (default off; needs CLAUDE_BACKGROUND_TASKS on, whose streaming input it
      // uses): a message sent mid-run goes into the running turn instead of waiting for it to end.
      ...(claudeCode.claudeCode && !ownerJob && genv("CLAUDE_BACKGROUND_TASKS", "on") !== "off" && genv("CLAUDE_STEER", "off") === "on" ? { steer: true } : {}),
      stateDir: cwd,
      rules,
      model: { id: runModel(chat).model },
      customTools: filtered,
      settingSources: ["project"],
      // After a rewind (or agent switch) the session is detached; reseed prior context so the model
      // does not lose the conversation it can still see in the transcript. Providers ignore it on resume.
      seedMessages,
      // A final answer that promises more work is only legitimate while a delegated subtask will
      // wake this chat again (openai provider continues the run otherwise).
      pendingWork: () => (peersHolder.current?.pendingDelegates(chat.id) || 0) + network.pending(chat.id),
    };
  },
});

peersHolder.current = createPeers({ store, runner, consultAccounts });

// A missing read-only tool is built on request (tool-builder.mjs): the owner says yes, a chat of his
// own builds it on the Griffin repo in the container, the report returns to the chat that asked.
toolBuilderHolder.current = createToolBuilder({
  store,
  runner,
  isYes,
  confirm: (chatId, question) => confirmWithOwner(store, asks, chatId, question),
  createBuildChat: async ({ title, text }) => {
    const profile = store.getAgentProfile?.(DEFAULT_AGENT);
    const chat = store.createChat({ title: `🛠 ${title}`, agent: DEFAULT_AGENT, caller: "owner", provider: normalizeProvider(profile?.provider), model: profile?.model || null });
    const repo = listRepos(REPOS_ROOT).includes("griffin-private") ? "griffin-private" : null;
    store.updateChat(chat.id, { ...(repo ? { repo } : {}), runsOn: "container" });
    await runner.send(chat.id, { text, images: [] });
    return chat;
  },
});

// The clones stay current: fetched every 10 minutes and their own checkout fast-forwarded when clean
// (agents read shared clones through it; new chat worktrees start from origin). Needs the broker.
const refreshRepos = () => {
  if (!brokerEnabled()) return;
  for (const repo of listRepos(REPOS_ROOT)) {
    callBrokerTool("git_fetch", { repo, update: true }, 130_000).catch((error) => console.error(`[repos] refresh ${repo}: ${error.message}`));
  }
};
setTimeout(refreshRepos, 30_000).unref();
// The chat search (CHAT_SEARCH_MESSAGES): the first time it is on, a worker thread (search-worker.mjs)
// makes its index (db.mjs enableSearchSchema) and then brings older messages in one short step at a
// time, a pause between steps; while it runs it does the WAL checkpoints, not the server's connection.
// Off, nothing runs and an unfinished backfill waits; once the backfill is done no worker starts (the
// triggers keep the index current). One timer at a time (searchTimer).
let searchWorker = null;
let searchTimer = null;
const searchLater = (ms) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(indexSearch, ms);
  searchTimer.unref();
};
const stopSearchWorker = () => {
  if (!searchWorker) return;
  const worker = searchWorker;
  searchWorker = null;
  worker.removeAllListeners();
  worker.terminate().catch(() => {});
  store.setAutoCheckpoint(1000);
};
const indexSearch = () => {
  searchTimer = null;
  if (genv("CHAT_SEARCH_MESSAGES", "off") !== "on" || store.searchBackfillDone()) {
    stopSearchWorker();
    return void searchLater(60_000);
  }
  if (!searchWorker) {
    searchWorker = new Worker(new URL("./search-worker.mjs", import.meta.url), { workerData: { file: resolveDbPath(DATA) } });
    searchWorker.unref();
    store.setAutoCheckpoint(0);
    const lost = (why) => {
      console.error(`[search] index worker: ${why}`);
      stopSearchWorker();
      searchLater(60_000);
    };
    searchWorker.on("message", ({ more, error }) => {
      if (error) return void lost(error);
      if (more) return void searchLater(50);
      stopSearchWorker();
      searchLater(60_000); // done: from now on only the switch is looked at, once a minute
    });
    searchWorker.on("error", (error) => lost(error.message));
    searchWorker.on("exit", (code) => lost(`exited ${code}`));
  }
  searchWorker.postMessage("step");
};
searchLater(20_000);
setInterval(refreshRepos, 10 * 60_000).unref();

// An archived chat gives its worktree back when nothing would be lost (clean, nothing unpushed);
// otherwise it stays and the chat says why. Worktrees of deleted chats go at startup.
const cleaning = new Set();
store.bus.on("chats", (change) => {
  if (change?.type !== "updated" || cleaning.has(change.chatId)) return;
  const chat = store.getChat(change.chatId);
  if (!chat?.archived || !chat.repo || !(chat.worktree_path || parkedTrees(REPOS_ROOT, chat.id).length)) return;
  cleaning.add(chat.id);
  releaseChatRuns(chat.id)
    .then((stopped) => stopped
      ? cleanupChatWorktree({ reposRoot: REPOS_ROOT, repo: chat.repo, chatId: chat.id })
      : { removed: false, reason: "اجرای چت یا چت کناری‌اش متوقف نشد" })
    .then((result) => {
      if (result.removed) store.updateChat(chat.id, { worktreePath: null });
      else if (result.reason) store.appendEvent(chat.id, null, "note", { text: `worktree نگه داشته شد: ${result.reason}` });
    })
    .catch((error) => console.error(`[worktree] cleanup ${chat.id}: ${error.message}`))
    .finally(() => cleaning.delete(chat.id));
});
// Side chats run in the parent's worktree, so before the tree is checked or removed every side
// chat is stopped, then the parent. False when a run did not stop.
async function releaseChatRuns(chatId) {
  const ids = [...store.listSideChats(chatId).map((side) => side.id), chatId];
  for (const id of ids) {
    if (runner.isActive(id)) await runner.cancel(id).catch((error) => console.error(`[worktree] stop ${id}: ${error.message}`));
  }
  for (const id of ids) {
    for (let waited = 0; runner.isActive(id) && waited < 30_000; waited += 250) await new Promise((r) => setTimeout(r, 250));
    if (runner.isActive(id)) return false;
  }
  return true;
}
// Owner chats on a worktree that sat idle for CHAT_IDLE_DAYS (default 3; 0 = off) go to the archive
// every 6 hours, which gives their worktree back when nothing would be lost (the listener above).
const CHAT_IDLE_MS = Number(genv("CHAT_IDLE_DAYS", "3")) * 86_400_000;
const sweepIdleChats = () => {
  try {
    const archived = archiveIdleChats({
      store,
      idleMs: CHAT_IDLE_MS,
      isBusy: (id) => runner.isActive(id) || asks.isWaiting(id) || keptList(store, id).length > 0 || (peersHolder.current?.pendingDelegates(id) || 0) > 0,
    });
    if (archived.length) console.log(`[chats] archived ${archived.length} idle chat(s): ${archived.join(", ")}`);
  } catch (error) {
    console.error(`[chats] idle archive: ${error.message}`);
  }
};
if (CHAT_IDLE_MS > 0) {
  setTimeout(sweepIdleChats, 10 * 60_000).unref();
  setInterval(sweepIdleChats, 6 * 60 * 60_000).unref();
}

// Moving an open chat to another repo (app.mjs /folder): its tree is set aside whole, the next run
// makes (or takes back) the new repo's tree. Never while the chat or one of its side chats runs.
const folderBusy = (chat) => runner.isActive(chat.id) || store.listSideChats(chat.id).some((side) => runner.isActive(side.id));
const folderSwitch = {
  preview: async (chat, repo) => ({
    ...(await chatTreeState({ reposRoot: REPOS_ROOT, repo: chat.repo, toRepo: repo, chatId: chat.id, currentDir: chat.worktree_path || null })),
    busy: folderBusy(chat),
  }),
  apply: async (chat, repo) => {
    try {
      return await switchChatWorktree({
        reposRoot: REPOS_ROOT,
        chatId: chat.id,
        fromRepo: chat.repo,
        currentDir: chat.worktree_path || null,
        canMove: () => !folderBusy(chat),
        onSwitched: ({ parked }) => {
          store.updateChat(chat.id, { repo, worktreePath: null });
          const note = store.appendEvent(chat.id, null, "note", { text: `گفتگو از ${chat.repo} به ${repo} رفت${parked ? `؛ کار قبلی دست‌نخورده در ${parked} ماند` : ""}.` });
          // noteId: a rewind may not cut back past the switch (app.mjs), or the chat would read as on
          // the old repo while repomove says it moved.
          store.setKv(`repomove:${chat.id}`, { from: chat.repo, to: repo, parked, at: new Date().toISOString(), noteId: note?.id ?? null });
        },
      });
    } catch (error) {
      if (error?.code === "WORKTREE_BUSY") return { error: "busy" };
      console.error(`[worktree] folder switch ${chat.id}: ${error.message}`);
      return { error: error.message };
    }
  },
};
{
  const states = new Map(store.listRepoChats().map((row) => [shortId(row.id), row.archived ? "archived" : "active"]));
  // A tree whose chat this install doesn't know is only "deleted" when it carries this install's own
  // name. Another app may share the repos folder (Karsara beside a Griffin trial, 2026-10-17: 92 of its
  // live chats lost their trees and branches because they were taken for deleted Griffin chats).
  const own = new Set(["griffin", agentSlug(), gitPrefix()]);
  sweepChatWorktrees({ reposRoot: REPOS_ROOT, chatState: (id8, prefix) => states.get(id8) || (own.has(prefix) && prefix !== "karsara" ? "deleted" : "unknown") })
    .then((results) => {
      for (const r of results.filter((x) => x.action === "removed")) console.log(`[worktree] swept ${r.dir} (${r.reason})`);
    })
    .catch((error) => console.error(`[worktree] sweep: ${error.message}`));
}

// What a fresh session starts with: the chat's own earlier turns, and for a side chat the main
// chat's conversation before them (side chats). The message being sent now is added
// by the provider, so a seed ending in it would say it twice.
function seedTurns(chat) {
  const own = store.priorTurns(chat.id);
  while (own.at(-1)?.role === "user") own.pop();
  if (!chat.side_of) return own;
  const main = store.getChat(chat.side_of);
  return [
    {
      role: "user",
      content: `[این یک چت کناری است، کنار گفتگوی «${main?.title || ""}». گفتگوی اصلی تا اینجا در ادامه آمده و فقط زمینه است: به سؤال کناری جواب بده؛ گفتگوی اصلی را ادامه نده.]`,
    },
    ...store.priorTurns(chat.side_of, { limit: 30 }),
    ...own,
  ];
}

let modelCache = { at: 0, byProvider: {} };
let modelCacheGen = 0; // bumped on every clear: a fetch begun before it does not refill the cache
async function models(provider = null) {
  const want = provider ? normalizeProvider(provider) : null;
  if (Date.now() - modelCache.at < 10 * 60_000 && Object.keys(modelCache.byProvider).length) {
    if (want) return modelCache.byProvider[want] || [];
    return Object.values(modelCache.byProvider).flat();
  }
  const byProvider = {};
  const gen = modelCacheGen;
  await Promise.all(
    PROVIDERS.filter((id) => providers[id]).map(async (id) => {
      try {
        byProvider[id] = (await providers[id].listModels()).map((m) => ({ ...m, provider: id }));
      } catch (error) {
        console.error(`[models:${id}]`, error?.message || error);
        byProvider[id] = kindOf(id) === PROVIDER_CLAUDE ? (await import("./providers/claude.mjs")).claudeModelList().map((m) => ({ ...m, provider: id })) : [];
      }
    }),
  );
  if (gen === modelCacheGen) modelCache = { at: Date.now(), byProvider };
  if (want) return byProvider[want] || [];
  return Object.values(byProvider).flat();
}

// Plan quota from the provider (Z.ai: 5-hour + weekly windows) and Griffin's own token totals.
async function usage() {
  const ago = (ms) => new Date(Date.now() - ms).toISOString();
  const quotas = await Promise.all(
    PROVIDERS.map(async (id) => {
      try {
        const q = await providers[id].usage?.();
        return q ? { id, ...q } : null;
      } catch (error) {
        return { id, error: String(error?.message || error) };
      }
    }),
  );
  return {
    providers: quotas.filter(Boolean),
    local: { last5h: store.usageSince(ago(5 * 3600_000)), last7d: store.usageSince(ago(7 * 86400_000)) },
  };
}

async function health() {
  const enabled = accounts().filter((a) => a.enabled && providers[a.id]);
  const [probe, ...checks] = await Promise.all([
    !brokerEnabled()
      ? Promise.resolve({ ok: true, configured: false })
      : brokerRequest(toolSource.socketPath, "GET", "/probe", undefined, 15_000)
          .then((r) => ({ ok: r.status === 200, ...r.body }))
          .catch((error) => ({ ok: false, error: error.message })),
    ...enabled.map((a) => providers[a.id].health().catch((error) => ({ ok: false, error: String(error?.message || error) }))),
  ]);
  const engines = Object.fromEntries(enabled.map((a, i) => [a.id, { ...checks[i], kind: a.kind, label: a.label || a.id }]));
  return {
    broker: { ok: probe.ok, configured: brokerEnabled(), ...(probe.error ? { error: probe.error } : {}) },
    clusters: probe.clusters || null,
    // Kept for older clients: the three base accounts, as before.
    cursor: engines.cursor || { ok: false, error: "disabled" },
    claude: engines.claude || { ok: false, error: "disabled" },
    openai: engines.openai || { ok: false, error: "disabled" },
    engines,
    ops: { mode: opsRoom.mode, room: opsRoom.roomId(), pending: opsRoom.pendingCount(), ...intake.status() },
    activeRuns: runner.activeCount(),
  };
}

// Messenger integrations run inside the app (they need the runner and the chat store).
// peerAuth comes first: the integrations bridge auto-registers peer users for assistant-signed
// messages (bindPeerAgentPerson) and needs createUser's default-quota grant.
const peerAuth = createPeerAuth({ store, publicUrl: genv("PUBLIC_URL", ""), businessDocs: businessDocs.names.length > 0 });
// The agents' network (network.mjs): colleagues' installs find each other and talk over their MCP.
const network = createNetwork({ store, peerAuth, secrets, runner, env: { GRIFFIN_NETWORK_DOMAINS: genv("NETWORK_DOMAINS", "") || undefined, GRIFFIN_NETWORK_SEEDS: genv("NETWORK_SEEDS", "") || undefined }, publicUrl: () => genv("PUBLIC_URL", ""), enabled: () => genv("NETWORK", "on") !== "off" });
// Telegram DMs in inbox mode (config TELEGRAM_DM_MODE=inbox): one dispatcher chat routes them.
const inbox = createInbox({ store, runner, history: (peerId) => accountHistory(integrationsHolder.current?.accountClient(), peerId) });
inboxHolder.current = inbox;
// The send ledger is kept when the install asks for it, and always in inbox mode (routing reads it).
// Every send also closes that person's waiting burst in the inbox.
const ledgerOn = () => genv(TELEGRAM_LEDGER_CONFIG, "off") === "on" || dmMode() === "inbox";
const ledgerAndInbox = (chatId = null) => {
  const ledger = ledgerRecorder({ store, chatId, enabled: ledgerOn() });
  return ({ peerId, messageId }) => {
    ledger?.({ peerId, messageId });
    inboxHolder.current?.onOutgoing(peerId, messageId);
  };
};
const integrations = createIntegrations({
  inbox,
  // A Bot API mirror for Telegram bots on a host that cannot reach api.telegram.org (bots.mjs).
  telegramBotApi: genv(TELEGRAM_BOT_API_CONFIG, ""),
  store, runner, timelines, asks, peerAuth, publicUrl: genv("PUBLIC_URL", ""), telegramProxy: () => parseProxy(genv("TELEGRAM_SOCKS")),
  pendingWork: (chatId) => (peersHolder.current?.pendingDelegates(chatId) || 0) + network.pending(chatId),
  ownerJobApprovals: (chatId) => ownerJobs.fullTools(chatId),
  // A burst of a colleague's messages waits this long after the latest one and becomes one turn.
  burstMs: Number(genv("TG_BURST_SECONDS", "45")) * 1000,
  telegramApp: () => readTelegramApp(DATA),
  // TELEGRAM_FILES=off: messengers get text only (Karsara's behaviour); read per answer, so it is live.
  sendFiles: () => genv("TELEGRAM_FILES", "on") !== "off",
  // /model from the messengers (bots.mjs → manager.mjs modelMenu): the models this chat may run on.
  modelChoices: async (chat) => modelChoices(chat),
});
integrationsHolder.current = integrations;
if (genv("DEMO") !== "1") integrations.startAll();
// Persian names for the Telegram page (fa-names.mjs): a minute after start, then every half hour.
const fillNames = (ids = null) => fillPersianNames({ store, ids, generate: (p) => generateText(p, { timeoutMs: 60_000 }) }).catch((e) => console.error(`[fa-names] ${e.message}`));
if (genv("DEMO") !== "1") {
  setTimeout(fillNames, 60_000).unref?.();
  setInterval(fillNames, 30 * 60_000).unref?.();
}

// Self-check and self-repair (doctor.mjs): agents on a dead engine move to one that answers and
// come back when it heals; stuck runs are cancelled. First pass a minute after start, then every 15.
hookConsoleErrors();
const backups = createBackups({
  store, dbFile: resolveDbPath(DATA), dataDir: DATA,
  config: () => ({ every: genv("BACKUP_EVERY_HOURS", "6"), keep: genv("BACKUP_KEEP", "8"), dir: genv("BACKUP_DIR", "") }),
});
if (genv("DEMO") !== "1") backups.start();
const doctor = createDoctor({
  store, runner, providers, providerKey, providerConfig, integrations, backups,
  openaiBaseUrl: () => genv("OPENAI_BASE_URL", ""),
  engineIds: PROVIDERS, dataDir: DATA,
  onProbe: (id, result) => {
    const verdict = probeVerdict(result);
    // ponytail: a passing Haiku turn clears a limit a run saw on one model's own window (weekly
    // Opus); the next run on that model marks it again. Keep per-model limits if that churns.
    if (verdict === "ok") clearEngineMarks(id);
    else if (verdict === "credit") store.setKv(`credit:${id}`, Date.now());
    else if (verdict === "limited") {
      const until = result.until > Date.now() ? result.until : Date.now() + 60 * 60_000;
      store.setKv(`limited:${id}`, until);
      store.setKv(`limitseen:${id}`, JSON.stringify({ at: Date.now(), until }));
    }
  },
});
// The engines page tests every account when it opens (a real tiny turn each): kept 10 minutes so
// opening the page again does not spend the plan; «تست» asks fresh.
async function testEngine(id, { fresh = false } = {}) {
  const hit = probeCache.get(id);
  if (!fresh && hit && Date.now() - hit.at < 10 * 60_000) return hit.result;
  const result = await doctor.probeEngine(id);
  probeCache.set(id, { at: Date.now(), result });
  return result;
}
if (genv("DEMO") !== "1" && genv("SELF_HEAL") !== "off") {
  const heal = () => doctor.heal().catch((error) => console.error(`[doctor] ${error.message}`));
  setTimeout(heal, 60_000).unref();
  setInterval(heal, 15 * 60_000).unref();
}

// Web Push to the owner's phone (Settings → اعلان‌ها): a finished turn, a question, a background report.
const push = createPush({ store, dataDir: DATA, timelines, subject: genv("PUSH_SUBJECT", "") || genv("PUBLIC_URL", "") || "mailto:owner@griffin.local" });
if (!demo) push.attach();

// Scheduled work: each job runs the agent in its own hidden chat and delivers the answer.
// A due job whose engine (the account its agent would route to now) gets no answer at all — a dead
// proxy, egress cut — is held overdue and fires once when the engine answers again.
const jobs = createJobs({
  store,
  runner,
  deliver: (chatId, targets, meta) => integrations.deliverChat(chatId, targets, meta),
  // An owner-job approval waiting on the owner pauses the job's timeout (jobs/owner-jobs.mjs).
  isWaiting: (chatId) => asks.isWaiting(chatId),
  canRun: async (job) => {
    if (demo) return true;
    const { provider } = routeModel({ agent: job.agent, caller: "scheduler", model: job.model });
    const engine = providers[provider];
    if (!engine) return true;
    return !egressDown(await engine.health().catch((error) => ({ ok: false, error: String(error?.message || error) })));
  },
});
jobs.start();
if (genv("DEMO") !== "1") network.start();

// Central usage accounting (accounting.mjs): this install reports its own usage to the maintainer's
// install (SUPPORT_AGENT) every 15 minutes; on that install the reports of all installs are
// kept, put together per install and per shared Claude account, and watched for alerts.
const urlHost = (url) => {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return "";
  }
};
// fingerprint -> {org, at}: one small Anthropic call per key every 6 hours, for the account id.
const orgOfKey = new Map();
async function keyOrg(key, fingerprint) {
  const hit = orgOfKey.get(fingerprint);
  if (hit && Date.now() - hit.at < (hit.org ? 6 * 3600_000 : 15 * 60_000)) return hit.org;
  const org = await accountOrg(key).catch(() => null);
  orgOfKey.set(fingerprint, { org, at: Date.now() });
  return org;
}
const accounting = createAccounting({
  store,
  network,
  supportHost: () => genv("SUPPORT_AGENT", ""),
  selfHost: () => urlHost(genv("PUBLIC_URL", "")),
  notify: (text) => integrations.notifyOwner(text),
  thresholds: () => ({
    weeklyWarn: Number(genv("ACCOUNTING_WEEKLY_WARN", "")) || undefined,
    sessionWarn: Number(genv("ACCOUNTING_SESSION_WARN", "")) || undefined,
  }),
  async collect() {
    const since = new Date(Date.now() - (REPORT_DAYS + 1) * 86_400_000).toISOString();
    const list = await Promise.all(
      accounts().map(async (a) => {
        const p = a.enabled ? providers[a.id] : null;
        const claude = a.kind === PROVIDER_CLAUDE && !claudeEndpoint(a.id);
        const [quota, who] = await Promise.all([
          claude && p?.usage ? withinTime(p.usage(), 8_000, () => null).catch(() => null) : null,
          claude && typeof p?.account === "function" ? withinTime(p.account(), 8_000, () => null).catch(() => null) : null,
        ]);
        let limit = null;
        try {
          limit = JSON.parse(store.getKv(`limitseen:${a.id}`) || "null");
        } catch {
          limit = null;
        }
        const key = claude ? providerKey(a.id) : "";
        const fingerprint = key ? keyFingerprint(key) : null;
        return {
          ...a,
          // Only a fingerprint of the key and the account id leave this install, never the key.
          fingerprint,
          org: fingerprint && a.enabled ? await keyOrg(key, fingerprint) : null,
          email: who?.email || null,
          windows: quota?.windows || null,
          windowsAt: quota?.seenAt || null,
          limit,
        };
      }),
    );
    return buildReport({
      rows: store.usageRows(since),
      accounts: list,
      install: urlHost(genv("PUBLIC_URL", "")),
      owner: liveOwnerName(OWNER.nameFa || "") || OWNER.fullNameFa || "",
      assistant: PERSONA.name,
      product: currentProduct().latin,
      commit: readBuildCommit() || null,
    });
  },
});
if (genv("DEMO") !== "1" && genv("ACCOUNTING", "on") !== "off") accounting.start();

// Incident intake: Alertmanager of every cluster → grouped incidents → Griffin's ops room (shadow).
const incidents = createIncidentStore(store.db);
// Incident intake needs something to poll; with no broker there are no alert sources at all.
const opsRoom = createOpsRoom({
  store,
  runner,
  incidents,
  mode: brokerEnabled() ? genv("OPS_MODE", "record") : "off",
});
// A colleague's Telegram report of what an open incident already shows goes to the ops room (desk.mjs).
integrations.desk?.setOps?.({
  open: () => incidents.open(),
  isAcked: (row) => incidents.isAcked(row),
  log: (id, kind, data) => incidents.log(id, kind, data),
  relay: (msg) => opsRoom.relay(msg),
  roomId: () => opsRoom.roomId(),
});
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
    const [{ status, body }, business, health] = await Promise.all([
      brokerRequest(toolSource.socketPath, "POST", "/tools/alerts_active", {}, 60_000),
      readBusiness(),
      brokerRequest(toolSource.socketPath, "GET", "/healthz", undefined, 10_000).catch(() => null),
    ]);
    if (status !== 200 || !body?.ok) throw new Error(body?.error || `broker http ${status}`);
    const vault = vaultAlerts(health?.body?.vault);
    return {
      clusters: {
        ...body.result.clusters,
        business: { ok: business.ok, error: business.error, watchdog: false, count: business.alerts.length },
        vault: { ok: health?.status === 200, error: health ? null : "broker /healthz unreachable", watchdog: false, count: vault.length },
      },
      alerts: [...body.result.alerts, ...business.alerts, ...vault],
    };
  },
  // Owner-acked (intentional) incidents stay recorded but do not wake the ops room, unless they get worse.
  onChanges: (changes, meta) => opsRoom.push(changes.filter((c) => c.kind === "escalated" || !incidents.isAcked(c.incident)), meta),
});
if (genv("DEMO") !== "1" && opsRoom.mode !== "off") intake.start();

// A thread another person's mother chat joined reports there too (integrations/mother.mjs).
watchJoinedThreads({
  store,
  runner,
  finalTextOf: async (chatId) => deliverable((await timelines.get(chatId)).timeline.messages.findLast((m) => m.role === "assistant") || { parts: [] }).text,
});

// Human signals: a work DM from a teammate to the owner goes to the ops room as a TeamReport, so
// Griffin can tell whether it already knew (a machine signal covered it) or it was a miss.
store.bus.on("person.message", ({ personId, direction, text }) => {
  if (opsRoom.mode === "off" || direction !== "in") return;
  const person = store.getPerson(personId);
  if (!isTeamReport(person, text)) return;
  const change = incidents.recordHuman({ personId, name: person.display_name, text });
  if (change) opsRoom.push([change]);
});


// Server→broker tool call (socket, no model in the loop) — peer_invite, repos, the sandbox workbench.
// Single-quote for a POSIX shell: wrap and escape embedded quotes.
const shq = (v) => `'${String(v).replaceAll("'", "'\\''")}'`;

const callBrokerTool = async (name, args, timeoutMs = 60_000) => {
  const { status, body } = await brokerRequest(toolSource.socketPath, "POST", `/tools/${name}`, args, timeoutMs);
  if (status !== 200 || !body?.ok) throw new Error(body?.error || `broker http ${status}`);
  return body.result;
};

const peerTasks = createPeerTasks({
  store,
  runner,
  asks,
  cancelChildren: (chatId) => peersHolder.current?.cancelChildren(chatId, { includeDelegates: true }),
  pendingWork: (chatId) => (peersHolder.current?.pendingDelegates(chatId) || 0) + network.pending(chatId),
  childChats: (chatId) => store.listChildChatIds(chatId).map((id) => store.getChat(id)).filter(Boolean),
});
tasksHolder.current = peerTasks;
// Fresh-context checker for finished runs (see verify.mjs); needs callBrokerTool above.
verifyHolder.current = createVerifier({ store, callTool: callBrokerTool, runner });
previews.startReaper();
setInterval(() => peerTasks.sweep().catch(() => {}), 5 * 60_000).unref();
setInterval(() => peerTasks.checkpoint().catch((error) => console.error(`[peer] checkpoint: ${error.message}`)), 30_000).unref();
// A run stuck on an opaque tool call (e.g. the native `task` subagent) never emits another event
// and would otherwise block that chat — and activeRuns-gated deploys — forever.
setInterval(() => runner.sweepStale().catch((error) => console.error(`[runner] sweepStale: ${error.message}`)), 2 * 60_000).unref();
const mcp = createMcpHandler({
  tasks: peerTasks,
  version: genv("VERSION", "dev"),
  record: (call) => store.recordPeerCall(call),
});

// Proxies whose X-Forwarded-For the login rate limit believes (listen.mjs). A bad value is said
// and ignored: loopback only.
function trustedProxies() {
  try {
    return parseTrustedProxies(genv("TRUSTED_PROXIES", ""));
  } catch (error) {
    console.error(`[griffin] ${error.message}; trusting loopback only`);
    return parseTrustedProxies("");
  }
}
const app = createApp({
  previews,
  updates: createUpdates({ dir: path.join(DATA, "update"), current: readBuildCommit(), translate: (prompt) => titleText(prompt) }),
  // When the install's logo last changed: the page puts it on every logo URL, so a new logo is a new
  // URL and no browser shows the old one from its image cache (owner 2026-10-17).
  iconVersion: () => {
    try {
      return String(Math.floor(fs.statSync(path.join(BRAND_DIR, "icon.svg")).mtimeMs));
    } catch {
      return "";
    }
  },
  movedHosts: String(genv("OLD_HOSTS", "")).split(",").map((h) => h.trim().toLowerCase()).filter(Boolean),
  publicUrl: genv("PUBLIC_URL", ""),
  sideChat: () => genv("SIDE_CHAT", "on") !== "off",
  // Private share of one chat with one person (private-share.mjs; Karsara's, 2026-10-15). Off by
  // default: the invite and the code go from the owner's Telegram account, to a PERSON only (a group
  // or channel would hand the chat to everyone in it).
  privateShare: () => genv("PRIVATE_SHARE", "off") === "on",
  // The suggested next message comes back when the box is cleared (as in Claude Code); off: typing
  // puts it aside for good, as before.
  nextStepReturns: () => genv("NEXT_STEP_RETURNS", "off") === "on",
  guestTelegram: () => {
    const client = integrations.accountClient();
    return client ? telegramForShares(client, { store, markSent: (id) => integrations.markAccountSent(id) }) : null;
  },
  // A guest's note (or the share moving to a new device) rings the owner — only the owner: never the
  // messenger chat linked to this conversation (it may be a group), and the guest's words stay out of
  // Telegram (a bot renders Markdown; a name or a note could carry a disguised link). The phone push
  // shows a short plain snippet.
  onGuestActivity: (chat, { kind, from, text = "" }) => {
    if (!chat) return;
    const who = String(from || "").replace(/[\[\]()*_`~>#|\\]/g, " ").trim() || "مهمان";
    const line = kind === "moved" ? `${who} گفتگوی «${chat.title}» را روی دستگاه تازه‌ای باز کرد` : `${who} در «${chat.title}» یادداشت گذاشت`;
    const summary = kind === "note" ? `${line}: ${[...String(text).replace(/\s+/g, " ")].slice(0, 120).join("")}` : line;
    Promise.all([push.notify("notify", chat, { summary }), integrations.notifyOwner(`📝 ${line}`, null).catch(() => false)]).catch(() => {});
  },
  searchMessages: () => genv("CHAT_SEARCH_MESSAGES", "off") === "on",
  store,
  runner,
  timelines,
  isValidRepo: (repo) => isValidRepoName(REPOS_ROOT, repo),
  folderSwitch,
  defaultRepo: () => (isValidRepoName(REPOS_ROOT, DEFAULT_REPO) ? DEFAULT_REPO : null),
  asks,
  models,
  usage,
  auth: genv("AUTH") === "off" && HOST === "127.0.0.1"
    ? undefined
    : createAuth({ dataDir: DATA, store, secureCookie: genv("SECURE_COOKIE") === "1", publicUrl: genv("PUBLIC_URL", ""), trustedProxies: trustedProxies() }),
  version: genv("VERSION", "dev"),
  // A timed note («بعداً») that ran — or did not — is one line on the owner's Telegram.
  onNoteRun: (note, { chat, error }) =>
    integrations.notifyOwner(
      error ? `⏰ یادداشتِ زمان‌دار اجرا نشد (${String(error).slice(0, 120)}): ${note.text.slice(0, 80)}` : `⏰ یادداشتِ زمان‌دار اجرا شد: ${note.text.slice(0, 80)}`,
      chat?.id || note.chatId,
    ),
  extraRoutes: (api) => {
    // Telegram inbox: queue status (owner session only, like every /api/* route).
    inboxRoutes(api, inbox, { store, setMode: (mode) => { config.set({ TELEGRAM_DM_MODE: mode }); store.bus.emit("chats", { type: "config" }); } });
    // A chat's repo picker: the clones under REPOS_ROOT; a new one is cloned by the broker.
    api.get("/api/repos", (c) => c.json({ repos: listRepos(REPOS_ROOT), root: REPOS_ROOT, default: isValidRepoName(REPOS_ROOT, DEFAULT_REPO) ? DEFAULT_REPO : null }));
    api.post("/api/repos/clone", async (c) => {
      const body = await c.req.json().catch(() => ({}));
      try {
        return c.json(await callBrokerTool("git_clone", { project: String(body.project || ""), ...(body.name ? { name: String(body.name) } : {}) }, 11 * 60_000), 201);
      } catch (error) {
        return c.json({ error: error.message }, 400);
      }
    });
    peerAuth.routes(api, { selfMgmtTools: SELF_MGMT_TOOLS });
    // Voice dictation in the composer (stt.mjs); the key is a 0600 file like the engine keys.
    sttRoutes(api, {
      getKey: () => secrets.get("stt") || readSecret("STT_API_KEY", "STT_API_KEY_FILE", "stt.api-key"),
      setKey: (key) => secrets.set("stt", key, { note: "speech to text" }),
      removeKey: () => secrets.delete("stt"),
      // Read per request, so Settings (or the Config page) applies without a restart.
      config: () => ({
        baseUrl: genv("STT_BASE_URL", STT_DEFAULTS.baseUrl),
        model: genv("STT_MODEL", STT_DEFAULTS.model),
        language: genv("STT_LANGUAGE", STT_DEFAULTS.language),
      }),
      saveConfig: ({ baseUrl, model, language }) => config.set({ STT_BASE_URL: baseUrl, STT_MODEL: model, STT_LANGUAGE: language }),
    });
    // The sidebar's alerts (UpdateNotice area): engines at a plan limit or out of credit, from what
    // runs and tests stored — no engine call here, it is polled.
    api.get("/api/engines/alerts", (c) => {
      const nameOf = (a) => {
        const kind = { claude: "Claude", openai: "OpenAI-compatible", cursor: "Cursor" }[a.kind] || a.kind;
        return a.label || claudeEndpoint(a.id)?.label || (a.id === a.kind ? kind : `${kind} · ${a.id.slice(a.kind.length + 1)}`);
      };
      const list = accounts();
      // What a new chat of the default agent runs on now: the engine that works in the meantime.
      const route = routeModel({ agent: DEFAULT_AGENT });
      const now = list.find((a) => a.id === route.provider && usableAccount(a.id));
      return c.json({
        engines: list
          .filter((a) => a.enabled)
          .map((a) => ({ id: a.id, name: nameOf(a), ...stateOf(a.id) }))
          .filter((a) => a.state === "limited" || a.state === "credit"),
        usable: list.some((a) => usableAccount(a.id)),
        meanwhile: now ? nameOf(now) : null,
      });
    });
    // Models & providers page: what each engine runs on, its health, its models, and which agents use it.
    api.get("/api/providers", async (c) => {
      const profiles = store.listAgentProfiles();
      const list = await Promise.all(
        accounts().map(async (account) => {
          const { id, kind } = account;
          const p = providers[id];
          const config = providerConfig(id);
          const [health, list, signedInAs] = await Promise.all([
            // At most 8 s each: one engine behind a filtered network must not hold the whole page.
            account.enabled && p ? withinTime(p.health(), 8_000, () => ({ ok: false, error: "timeout" })).catch((error) => ({ ok: false, error: String(error?.message || error) })) : { ok: false, error: "disabled" },
            account.enabled && p ? withinTime(models(id), 8_000, () => []).catch(() => []) : [],
            // The Claude login's email and plan (claude auth status), as Karsara showed them.
            account.enabled && typeof p?.account === "function" ? withinTime(p.account(), 8_000, () => null).catch(() => null) : null,
          ]);
          let limit = null;
          try {
            limit = JSON.parse(store.getKv(`limitseen:${id}`) || "null");
          } catch {
            limit = null;
          }
          return {
            id,
            kind,
            label: account.label || "",
            enabled: account.enabled,
            removable: id !== kind,
            hasKey: Boolean(providerKey(id)),
            keyIn: secrets.has(`engine/${id}`) ? "secrets" : providerKey(id) ? "legacy" : null,
            defaultModel: p?.defaultModel || null,
            baseUrl: kind === PROVIDER_OPENAI ? config.baseUrl ?? (id === kind ? genv("OPENAI_BASE_URL", "") : "") : claudeEndpoint(id)?.baseUrl || null,
            endpoint: claudeEndpoint(id)?.id || null,
            reasoningEffort: kind === PROVIDER_OPENAI ? config.reasoningEffort ?? (id === kind ? genv("OPENAI_REASONING_EFFORT", "") : "") : null,
            limitedUntil: isLimited(id) ? limitedUntil(id) : null,
            lastLimit: limit,
            // ok / limited / credit / no_key / off (engine-state.mjs); the list comes in this order.
            state: stateOf(id).state,
            creditAt: stateOf(id).state === "credit" ? creditAt(id) : null,
            isDefault: defaultEngine() === id,
            signedInAs,
            health,
            models: list.map((m) => ({ id: m.id, name: m.name || m.id })),
            agents: profiles
              .filter((a) => normalizeProvider(a.provider) === id || (a.meta?.models || []).some((m) => String(m).split(":")[0] === id))
              .map((a) => ({ id: a.id, label: a.label, model: a.model || null })),
          };
        }),
      );
      return c.json({ providers: rankByState(list, stateOf, (p) => p.id), defaultEngine: defaultEngine(), kinds: KINDS, presets: OPENAI_PRESETS.map(({ id, label, baseUrl }) => ({ id, label, baseUrl })), claudeEndpoints: CLAUDE_ENDPOINTS.map(({ id, label, baseUrl }) => ({ id, label, baseUrl })) });
    });
    // A new engine account: a second Claude subscription, an OpenRouter key next to Z.ai, …
    api.post("/api/providers", async (c) => {
      const body = await c.req.json().catch(() => ({}));
      const kind = String(body.kind || "");
      if (!KINDS.includes(kind)) return c.json({ error: "kind must be cursor, claude or openai" }, 400);
      const id = addAccount(kind, { slug: String(body.slug || body.preset || ""), label: body.label });
      if (!id) return c.json({ error: "invalid account id" }, 400);
      return c.json({ id }, 201);
    });
    api.delete("/api/providers/:id", (c) => {
      const id = c.req.param("id");
      if (KINDS.includes(id)) return c.json({ error: "a base engine can be switched off, not removed" }, 400);
      const list = accounts();
      if (!list.some((a) => a.id === id)) return c.json({ error: "unknown provider" }, 404);
      saveAccounts(list.filter((a) => a.id !== id));
      secrets.delete(`engine/${id}`);
      removeLoginDir(DATA, id);
      store.deleteKv(`provider:${id}`);
      if (store.getKv("engine-default") === id) store.deleteKv("engine-default");
      reconfigureProviders();
      return c.json({ ok: true });
    });
    // Claude account sign-in from the browser: the token lands in the secret store, never in a response.
    const claudeSignin = createClaudeSignin({
      // The full login (default, 2026-10-19): `claude auth login --claudeai` into the account's own folder —
      // profile, usage, sessions, connectors, uploads and plugins, which a setup-token lacks.
      // GRIFFIN_CLAUDE_SIGNIN=token keeps the old setup-token flow; accounts made with it keep working.
      ...(genv("CLAUDE_SIGNIN", "full") === "token"
        ? {}
        : {
            loginDir: (id) => accountLoginDir(DATA, id),
            onLogin: async (id, dir) => {
              linkSharedEntries({ dir, main: mainConfigDir() });
              secrets.set(`engine/${id}`, loginDirKey(dir), { note: `Claude account ${id} (full login in its own folder)` });
              clearEngineMarks(id);
              reconfigureProviders();
              const health = await providers[id]?.health().catch(() => null);
              if (!health?.ok) {
                secrets.delete(`engine/${id}`);
                reconfigureProviders();
                removeLoginDir(DATA, id);
                throw new Error("Claude did not accept this login — sign in again");
              }
            },
          }),
      onToken: async (id, token) => {
        secrets.set(`engine/${id}`, token, { note: `Claude account ${id} (browser sign-in)` });
        clearEngineMarks(id);
        reconfigureProviders();
        // A token Claude refuses must not count as a connected account: "auto" routing picks the first
        // account with a key, so a bad one made every chat fail with "Invalid API key" (2026-10-19).
        const health = await providers[id]?.health().catch(() => null);
        if (health?.status === 401) {
          secrets.delete(`engine/${id}`);
          reconfigureProviders();
          throw new Error("Claude did not accept the token that sign-in produced — sign in again");
        }
      },
    });
    // Karsara's account/usage routes (account-routes.mjs) on these same accounts.
    const zaiKey = () => {
      for (const a of accounts().filter((x) => x.enabled)) {
        const z = (a.kind === PROVIDER_CLAUDE && claudeEndpoint(a.id)?.id === "zai") || (a.kind === PROVIDER_OPENAI && /\bz\.ai\b/.test(providerConfig(a.id).baseUrl ?? (a.id === a.kind ? genv("OPENAI_BASE_URL", "") : "")));
        if (z && providerKey(a.id)) return providerKey(a.id);
      }
      return "";
    };
    const planAccount = () => activeClaude() || PROVIDER_CLAUDE;
    const zaiQuota = createZaiQuotaCache({ fetchQuota: () => zaiQuotaFetch({ key: zaiKey() }) });
    accountRoutes(api, {
      signin: claudeSignin,
      engines: {
        isAccount: (id) => accounts().some((a) => a.id === id),
        claudeAccounts: () => accounts().filter((a) => a.kind === PROVIDER_CLAUDE && !claudeEndpoint(a.id)).map((a) => ({ id: a.id, label: a.label, hasKey: Boolean(providerKey(a.id)) })),
        addAccount,
        removeAccount: (id) => {
          saveAccounts(accounts().filter((a) => a.id !== id));
          secrets.delete(`engine/${id}`);
          removeLoginDir(DATA, id);
          store.deleteKv(`provider:${id}`);
          if (store.getKv("claude-active") === id) store.deleteKv("claude-active");
          if (store.getKv("engine-default") === id) store.deleteKv("engine-default");
          reconfigureProviders();
        },
        inUse: (id) => runner.activeChatIds().some((chatId) => routeModel(store.getChat(chatId)).provider === id),
        activeClaude: () => activeClaude() || PROVIDER_CLAUDE,
        setActiveClaude: setDefaultEngine,
        endpointAccount: (endpoint) => accounts().find((a) => a.kind === PROVIDER_CLAUDE && claudeEndpoint(a.id)?.id === endpoint)?.id || null,
        setKey: (id, key) => {
          secrets.set(`engine/${id}`, key, { note: `engine ${id}` });
          clearEngineMarks(id);
          reconfigureProviders();
          zaiQuota.invalidate();
        },
        removeKey: (id) => {
          secrets.delete(`engine/${id}`);
          removeLoginDir(DATA, id);
          reconfigureProviders();
          zaiQuota.invalidate();
        },
        setConfig: (id, patch) => {
          store.setKv(`provider:${id}`, JSON.stringify({ ...providerConfig(id), ...patch }));
          reconfigureProviders();
        },
      },
      planLimits: createPlanUsageCache({ fetchUsage: () => providers[planAccount()]?.planUsage?.() ?? null }),
      zaiQuota,
      zaiAccount: createZaiAccount({
        secrets,
        info: {
          get: () => {
            try {
              return JSON.parse(store.getKv("zai-account") || "null");
            } catch {
              return null;
            }
          },
          set: (value) => (value ? store.setKv("zai-account", JSON.stringify(value)) : store.deleteKv("zai-account")),
        },
      }),
    });
    api.post("/api/providers/:id/signin", async (c) => {
      const id = c.req.param("id");
      if (kindOf(id) !== PROVIDER_CLAUDE) return c.json({ error: "browser sign-in is for Claude accounts" }, 400);
      // An Anthropic token stored on an endpoint account would be sent to the other vendor.
      if (claudeEndpoint(id)) return c.json({ error: `${claudeEndpoint(id).label} takes its own key, not a Claude sign-in` }, 400);
      try {
        return c.json(await claudeSignin.start(id));
      } catch (error) {
        return c.json({ error: error.message }, 400);
      }
    });
    api.post("/api/providers/:id/signin/code", async (c) => {
      const body = await c.req.json().catch(() => ({}));
      try {
        return c.json(await claudeSignin.submit(c.req.param("id"), body.code));
      } catch (error) {
        if (error.restarted) return c.json({ error: error.message, restarted: true, url: error.restarted.url }, 409);
        return c.json({ error: error.message }, 400);
      }
    });
    api.patch("/api/providers/:id", async (c) => {
      const id = c.req.param("id");
      if (!kindOf(id)) return c.json({ error: "unknown provider" }, 404);
      const kind = kindOf(id);
      const body = await c.req.json().catch(() => ({}));
      const next = { ...providerConfig(id) };
      if (kind === PROVIDER_OPENAI && typeof body.preset === "string") {
        const preset = OPENAI_PRESETS.find((p) => p.id === body.preset);
        if (!preset) return c.json({ error: "unknown preset" }, 400);
        next.baseUrl = preset.baseUrl;
        // The preset's old key file still counts until a key is pasted here.
        if (!secrets.has(`engine/${id}`)) next.keyFile = preset.keyFile;
      }
      // A second Claude account on another vendor's Anthropic-compatible endpoint ("" = plain Claude again).
      if (kind === PROVIDER_CLAUDE && typeof body.endpoint === "string") {
        const set = endpointSettings(next, body.endpoint, { base: id === PROVIDER_CLAUDE, hasSecret: secrets.has(`engine/${id}`) });
        if (set.error) return c.json({ error: set.error }, 400);
        for (const key of Object.keys(next)) delete next[key];
        Object.assign(next, set.next);
      }
      if (kind === PROVIDER_OPENAI && typeof body.baseUrl === "string") {
        if (body.baseUrl && !/^https?:\/\/[^\s]+$/.test(body.baseUrl)) return c.json({ error: "invalid base URL" }, 400);
        next.baseUrl = body.baseUrl.trim();
      }
      if (kind === PROVIDER_OPENAI && typeof body.reasoningEffort === "string") {
        if (!["", "low", "medium", "high"].includes(body.reasoningEffort)) return c.json({ error: "invalid reasoning effort" }, 400);
        next.reasoningEffort = body.reasoningEffort;
      }
      if (typeof body.model === "string") next.model = body.model.trim().slice(0, 120);
      if (typeof body.apiKey === "string" && body.apiKey.trim()) {
        secrets.set(`engine/${id}`, body.apiKey.trim(), { note: `engine ${id}` });
        delete next.keyFile;
      }
      if (typeof body.enabled === "boolean" || typeof body.label === "string") {
        saveAccounts(accounts().map((a) => (a.id === id ? {
          ...a,
          ...(typeof body.enabled === "boolean" ? { enabled: body.enabled } : {}),
          ...(typeof body.label === "string" ? { label: body.label.trim().slice(0, 40) } : {}),
        } : a)));
      }
      if (body.clearLimit === true) clearEngineMarks(id);
      if (body.default === true) setDefaultEngine(id);
      store.setKv(`provider:${id}`, JSON.stringify(next));
      reconfigureProviders();
      return c.json({ ok: true });
    });
    // Secrets (Settings → Secrets, `griffin secrets`): "app" = Griffin's own encrypted store (engine
    // keys, anything the app uses); "tools" = the broker's vault (OpenBao when mounted, else the
    // broker's own encrypted box). Names and last-4 only; a value goes in and never comes back out.
    const TOOL_SECRETS = [
      { name: "gitlab__token", note: "GitLab token for gitlab_* and repo tools" },
      { name: "kube__token", note: "Kubernetes API bearer token (kube_* tools)" },
      { name: "ssh-bastion__owner-key", note: "SSH private key for the emergency kube path and shell tools" },
      { name: "infisical__universal-auth", note: "Infisical machine identity (JSON: clientId, clientSecret)" },
      { name: "arvan__api-key", note: "ArvanCloud API key (full Authorization header)" },
      { name: "nsin__api-key", note: "NSIN CDN API key" },
    ];
    // No broker (GRIFFIN_BROKER=off or no socket): app secrets still work, tool secrets say why not.
    const brokerSecrets = (method, body) =>
      brokerEnabled()
        ? brokerRequest(toolSource.socketPath, method, "/secrets", body, 20_000)
        : Promise.resolve({ status: 503, body: { error: "no broker" } });
    api.get("/api/secrets", async (c) => {
      const tools = await brokerSecrets("GET").then((r) => (r.status === 200 ? r.body : { error: r.body?.error || `http_${r.status}` })).catch((error) => ({ error: `tools broker unreachable (${error.message})` }));
      return c.json({ app: secrets.list(), tools: { backend: tools.backend || null, items: tools.items || [], error: tools.error || null }, catalog: TOOL_SECRETS });
    });
    api.put("/api/secrets", async (c) => {
      const body = await c.req.json().catch(() => ({}));
      const name = String(body.name || "");
      const value = String(body.value ?? "");
      try {
        if (body.scope === "tools") {
          const r = await brokerSecrets("PUT", { name, value });
          if (r.status !== 200) return c.json({ error: r.body?.error || `http_${r.status}` }, 400);
        } else {
          secrets.set(name, value, { note: typeof body.note === "string" ? body.note : undefined });
          if (name.startsWith("engine/")) reconfigureProviders();
        }
        return c.json({ ok: true });
      } catch (error) {
        return c.json({ error: error.message }, 400);
      }
    });
    api.delete("/api/secrets", async (c) => {
      const name = c.req.query("name") || "";
      if (c.req.query("scope") === "tools") {
        const r = await brokerSecrets("DELETE", { name }).catch((error) => ({ status: 502, body: { error: error.message } }));
        return r.status === 200 ? c.json({ ok: true }) : c.json({ error: r.body?.error || `http_${r.status}` }, 400);
      }
      const removed = secrets.delete(name);
      if (name.startsWith("engine/")) reconfigureProviders();
      return removed ? c.json({ ok: true }) : c.json({ error: "not found" }, 404);
    });
    // Settings → MCP servers: the owner's user-scope servers in ~/.claude.json (mcp-servers.mjs),
    // loaded only by full Claude Code (CLAUDE_CODE=on) in his own chats.
    const mcpServers = createMcpServers();
    const mcpReply = (c, fn) => {
      try {
        return c.json(fn());
      } catch (error) {
        return c.json({ error: error.message }, 400);
      }
    };
    api.get("/api/mcp-servers", (c) => mcpReply(c, () => ({ servers: mcpServers.list().map((s) => ({ ...s, ...(s.type === "stdio" ? {} : { login: mcpOauth.status(s.name) }) })), file: mcpServers.file, claudeCode: genv("CLAUDE_CODE", "off") === "on" })));
    api.put("/api/mcp-servers", async (c) => {
      const body = await c.req.json().catch(() => ({}));
      return mcpReply(c, () => {
        const server = mcpServers.save(body);
        if (body.previous && body.previous !== server.name) mcpOauth.rename(body.previous, server.name);
        return { server };
      });
    });
    api.delete("/api/mcp-servers/:name", (c) => mcpReply(c, () => {
      mcpOauth.forget(c.req.param("name"));
      return { ok: mcpServers.remove(c.req.param("name")) };
    }));
    // «ورود» of an OAuth server: the page sends its own origin; the browser comes back to the callback.
    api.post("/api/mcp-servers/:name/login", async (c) => {
      const body = await c.req.json().catch(() => ({}));
      try {
        const origin = new URL(String(body.origin || "")).origin;
        return c.json(await mcpOauth.start({ name: c.req.param("name"), redirectUri: `${origin}/api/mcp-oauth/callback` }));
      } catch (error) {
        return c.json({ error: error.message }, 400);
      }
    });
    api.get("/api/mcp-oauth/callback", async (c) => {
      const page = (title, text) => c.html(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><body dir="rtl" style="font-family:sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem"><h3>${title}</h3><p>${text}</p><p><a href="/">بازگشت به Griffin</a></p>`);
      const esc = (t) => String(t).replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]);
      if (c.req.query("error")) return page("ورود انجام نشد", esc(c.req.query("error_description") || c.req.query("error")));
      try {
        const { name } = await mcpOauth.finish({ state: c.req.query("state"), code: c.req.query("code") });
        return page("ورود انجام شد", `سرور «${esc(name)}» از گفتگوی بعدی با همین ورود کار می‌کند. می‌توانید این صفحه را ببندید.`);
      } catch (error) {
        return page("ورود انجام نشد", esc(error.message));
      }
    });
    // «بررسی اتصال»: probe one stored server with its own headers; the answer has no secret in it.
    api.post("/api/mcp-servers/:name/check", async (c) => {
      const server = mcpServers.get(c.req.param("name"));
      return server ? c.json(await checkMcpServer(server)) : c.json({ error: "not found" }, 404);
    });
    // Settings → Configuration: what used to be env-only (config.mjs). Some apply after a restart,
    // which the owner can do from the same page (the container's restart policy brings it back).
    api.get("/api/config", (c) => c.json({ settings: config.view(), activeRuns: runner.activeCount() }));
    api.patch("/api/config", async (c) => {
      try {
        const result = config.set(await c.req.json().catch(() => ({})));
        modelCache = { at: 0, byProvider: {} }; // the model list follows live keys (CLAUDE_FABLE)
        modelCacheGen += 1;
        store.bus.emit("chats", { type: "config" }); // the chat list carries live switches (SIDE_CHAT)
        return c.json(result);
      } catch (error) {
        return c.json({ error: error.message }, 400);
      }
    });
    // Karsara's owner switches (its web and settings): the same live config keys under its names.
    const PREFS = { promptSuggestions: "PROMPT_SUGGESTIONS", autoContinue: "AUTO_CONTINUE" };
    const prefs = () => Object.fromEntries(Object.entries(PREFS).map(([name, key]) => [name, genv(key, "on") !== "off"]));
    listPrefsRoutes(api, { store });
    api.get("/api/prefs", (c) => c.json(prefs()));
    api.put("/api/prefs", async (c) => {
      const body = await c.req.json().catch(() => ({}));
      const given = Object.keys(PREFS).filter((name) => name in (body || {}));
      if (!given.length || given.some((name) => typeof body[name] !== "boolean")) return c.json({ error: `${Object.keys(PREFS).join(" / ")} باید true یا false باشد.` }, 400);
      config.set(Object.fromEntries(given.map((name) => [PREFS[name], body[name] ? "on" : "off"])));
      store.bus.emit("chats", { type: "config" });
      return c.json(prefs());
    });
    api.get("/api/features", (c) => c.json({ sideChat: genv("SIDE_CHAT", "on") !== "off", nextStepReturns: genv("NEXT_STEP_RETURNS", "off") === "on", privateShare: genv("PRIVATE_SHARE", "off") === "on" }));
    api.post("/api/admin/restart", async (c) => {
      const body = await c.req.json().catch(() => ({}));
      const active = runner.activeCount();
      if (active && body.force !== true) return c.json({ error: "runs are in progress", activeRuns: active }, 409);
      console.log("[griffin] restart requested from the UI");
      setTimeout(() => process.kill(process.pid, "SIGTERM"), 300).unref();
      return c.json({ ok: true });
    });
    push.routes(api);
    // Live CPU/RAM/disk/load, this process's RSS and start time — Settings → وضعیت polls it.
    const hostStats = createHostStats();
    api.get("/api/host", async (c) => c.json(await hostStats()));
    // «ارسال بازخورد» / «پشتیبانی» (feedback.mjs): kept here and posted to the maintainer's install;
    // on that install it lands in the inbox, a support request also in the owner's Saved Messages.
    const hostOfUrl = (url) => {
      try {
        return new URL(url).host;
      } catch {
        return "";
      }
    };
    const feedback = createFeedback({
      dataDir: DATA,
      network,
      supportHost: () => genv("SUPPORT_AGENT", ""),
      selfHost: () => hostOfUrl(genv("PUBLIC_URL", "")),
      context: () => ({ commit: readBuildCommit() || null, owner: liveOwnerName(OWNER.nameFa || ""), install: hostOfUrl(genv("PUBLIC_URL", "")), serverErrors: recentErrors() }),
      notifyOwner: async (text, shot) => {
        const client = integrations.accountClient();
        if (!client) throw new Error("Telegram account is not connected");
        if (!shot) return client.sendMessage("me", { message: text, linkPreview: false });
        const { CustomFile } = await import("telegram/client/uploads.js");
        // A caption holds 1024 characters: a longer text goes as its own message first.
        if (text.length > 1000) await client.sendMessage("me", { message: text, linkPreview: false });
        await client.sendFile("me", { file: new CustomFile("page.jpg", shot.length, "", shot), caption: text.length > 1000 ? "🤖 تصویر صفحه" : text });
      },
    });
    feedback.routes(api, peerAuth);
    accounting.routes(api, peerAuth);
    accounting.ownerRoutes(api);
    api.post("/api/feedback", async (c) => {
      const r = await feedback.submit(await c.req.json().catch(() => ({})));
      return c.json(r, r.ok ? 200 : 400);
    });
    // Settings → «بازخوردها»: what colleagues' installs (and this one) sent here.
    api.get("/api/feedback/inbox", (c) => c.json({ items: feedback.inbox() }));
    api.get("/api/feedback/inbox/:id/shot", (c) => {
      const shot = feedback.shotFile(c.req.param("id"));
      if (!shot) return c.json({ error: "not found" }, 404);
      return new Response(fs.readFileSync(shot.full), { headers: { "content-type": shot.type, "cache-control": "private, max-age=86400" } });
    });
    // Periodic database backups (backup.mjs): list/status, and one now.
    api.get("/api/backups", (c) => c.json(backups.status()));
    api.post("/api/backups", async (c) => {
      const r = await backups.run("manual");
      return c.json(r, r.ok ? 200 : 500);
    });
    // Doctor (self-check / self-repair) and the setup wizard (apps/web Setup.jsx).
    api.get("/api/doctor", async (c) => c.json(await doctor.report()));
    api.get("/api/doctor/engine/:id", async (c) => {
      const id = normalizeProvider(c.req.param("id"));
      if (id !== c.req.param("id")) return c.json({ error: "unknown provider" }, 404);
      const fresh = c.req.query("fresh") === "1";
      if (fresh) reconfigureProviders();
      return c.json(await testEngine(id, { fresh }));
    });
    api.post("/api/doctor/fix", async (c) => {
      const body = await c.req.json().catch(() => ({}));
      try {
        return c.json(await doctor.fix(String(body.id || "")));
      } catch (error) {
        return c.json({ error: error.message }, 400);
      }
    });
    api.post("/api/doctor/heal", async (c) => c.json(await doctor.heal()));
    api.get("/api/setup", (c) => {
      const working = PROVIDERS.filter((id) => providerKey(id));
      return c.json({
        done: store.getKv("setup:done") === "1",
        needsEngine: !working.length,
        persona: PERSONA,
        personaFromEnv: Boolean(genv("ASSISTANT_NAME")),
        healed: JSON.parse(store.getKv("doctor:healed") || "[]").slice(-5),
      });
    });
    api.post("/api/setup/persona", async (c) => {
      const body = await c.req.json().catch(() => ({}));
      const name = String(body.name || "").trim();
      let latin = String(body.latin || "").trim();
      if (!name) return c.json({ error: "name required" }, 400);
      // A typed name next to the random name's Latin («نوید» + «Raha»): that Latin is not this name's.
      if (NAMES.some(([fa, en]) => en === latin && fa !== name)) latin = "";
      const invalid = agentNameError(name) || (latin ? agentNameError(latin) : null);
      if (invalid) return c.json({ error: invalid }, 400);
      // persona.json keeps its "owner" block; the name is live from the database (persona.mjs).
      saveAssistantName(store, name, latin);
      if (store.getAgentProfile("griffin")) store.updateAgentProfile("griffin", { label: name });
      return c.json({ ok: true, restart: false });
    });
    // The first page of the wizard: a prompt for the agent the owner already uses (setup-prompt.mjs).
    // GET = the default prompt; POST {agent, engine, proxy, secrets, transfer[]} = the owner's answers on the page.
    const agentPrompt = (c, choices = {}) => {
      const working = PROVIDERS.filter((id) => providerKey(id));
      const origin = genv("PUBLIC_URL") || new URL(c.req.url).origin;
      const missing = working.length ? [] : ["an AI engine (no provider has a working key yet)"];
      const claudeHome = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
      return c.json({ prompt: setupPrompt({ origin: origin.replace(/\/$/, ""), dataDir: DATA, missing, name: PERSONA.name || "", product: currentProduct().latin, claudeHome, choices, access: genv("SETUP_ACCESS") || "" }) });
    };
    api.get("/api/setup/agent-prompt", (c) => agentPrompt(c));
    api.post("/api/setup/agent-prompt", async (c) => agentPrompt(c, await c.req.json().catch(() => ({}))));
    api.get("/api/setup/random-name", (c) => c.json(randomName(Math.random, c.req.query("not") || "")));
    // Which engine hosts this server reaches, directly and through the proxy in use (if any).
    api.get("/api/setup/egress", async (c) => {
      const proxy = env.CURSOR_PROXY || env.HTTPS_PROXY || savedProxy();
      const [direct, viaProxy] = await Promise.all([probeEgress(""), proxy ? probeEgress(proxy) : null]);
      return c.json({ direct, proxy: proxy ? proxy.replace(/\/\/[^@/]*@/, "//***@") : "", viaProxy });
    });
    historyImportRoutes(api, {
      dataDir: DATA,
      roots: [os.homedir(), DATA, WORKSPACE],
      dbFile: resolveDbPath(DATA),
      claudeHome: process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"),
      workspace: WORKSPACE,
      onImported: () => store.bus.emit("chats", { type: "import" }),
    });
    api.get("/api/setup/proxy", (c) => c.json({ url: ENV_PROXY || savedProxy(), fromEnv: envProxy }));
    api.post("/api/setup/proxy", async (c) => {
      const body = await c.req.json().catch(() => ({}));
      const url = String(body.url || "").trim();
      if (url && !/^https?:\/\/[^\s/]+(:\d+)?\/?$/.test(url)) return c.json({ error: "proxy must look like http://host:port" }, 400);
      if (envProxy) return c.json({ error: "proxy is set by the environment; change it there" }, 409);
      fs.writeFileSync(PROXY_FILE, JSON.stringify({ url }));
      if (url) applyProxy(url);
      else clearProxy();
      return c.json({ ok: true, url, restart: false });
    });
    brandRoutes(api, { dir: path.join(DATA, "brand") });
    // The setup checklist (GitLab, VPN link, speech key, company data) and vault-run's loopback route (setup-checks.mjs).
    setupChecksRoutes(api, { secrets, dataDir: DATA, vpn: envProxy ? null : vpn, sttReady: () => Boolean(secrets.get("stt") || readSecret("STT_API_KEY", "STT_API_KEY_FILE", "stt.api-key")), applyProxy: (vars) => { Object.assign(process.env, vars); applyProxy(vars.HTTPS_PROXY); } });
    api.post("/api/setup/done", (c) => {
      store.setKv("setup:done", "1");
      return c.json({ ok: true });
    });
    api.get("/api/approvals", (c) => c.json({ approvals: store.listApprovals({ limit: Math.min(Number(c.req.query("limit")) || 100, 500) }) }));

    // Owner workbench on the sandbox (no creds, no kubeconfig): a shell, a file browser and a web
    // fetcher. All three run as one debug_exec on host "sandbox" — the same box the agent uses.
    // Only with a broker (it holds the sandbox's SSH key).
    const sandbox = (command) => callBrokerTool("debug_exec", { host: "sandbox", command });
    api.post("/api/sandbox/exec", async (c) => {
      const { command, cwd } = await c.req.json().catch(() => ({}));
      if (typeof command !== "string" || !command.trim()) return c.json({ error: "command required" }, 400);
      const full = cwd ? `cd ${shq(cwd)} 2>/dev/null; ${command}` : command;
      try {
        const r = await sandbox(full);
        return c.json({ stdout: r.stdout || "", stderr: r.stderr || "" });
      } catch (error) {
        return c.json({ error: String(error?.message || error) }, 502);
      }
    });
    api.get("/api/sandbox/fs", async (c) => {
      const dir = c.req.query("path") || "/root";
      // One python call returns a JSON listing — names, type, size, mtime — no shell-quoting games.
      const py = `import os,json,sys\np=os.environ['P']\ntry:\n e=sorted(os.scandir(p),key=lambda x:(not x.is_dir(),x.name.lower()))\n out=[]\n for x in e:\n  try:st=x.stat()\n  except:continue\n  out.append({'name':x.name,'dir':x.is_dir(),'size':st.st_size,'mtime':int(st.st_mtime)})\n print(json.dumps({'path':os.path.abspath(p),'entries':out}))\nexcept Exception as ex:\n print(json.dumps({'error':str(ex)}))`;
      try {
        const r = await sandbox(`P=${shq(dir)} python3 -c ${shq(py)}`);
        const parsed = JSON.parse(String(r.stdout || "{}").trim() || "{}");
        if (parsed.error) return c.json({ error: parsed.error }, 400);
        return c.json(parsed);
      } catch (error) {
        return c.json({ error: String(error?.message || error) }, 502);
      }
    });
    api.get("/api/sandbox/file", async (c) => {
      const file = c.req.query("path");
      if (!file) return c.json({ error: "path required" }, 400);
      try {
        const r = await sandbox(`head -c 262144 ${shq(file)}`);
        return c.json({ path: file, content: r.stdout || "", stderr: r.stderr || "" });
      } catch (error) {
        return c.json({ error: String(error?.message || error) }, 502);
      }
    });
    api.post("/api/sandbox/fetch", async (c) => {
      const { url } = await c.req.json().catch(() => ({}));
      if (typeof url !== "string" || !/^https?:\/\//.test(url)) return c.json({ error: "http(s) url required" }, 400);
      try {
        const r = await sandbox(`curl -sSL --max-time 25 -A 'Mozilla/5.0 Griffin' -D /tmp/h -o /tmp/b ${shq(url)} 2>&1; echo "---STATUS $?"; echo "---HEADERS"; cat /tmp/h; echo "---BODY"; head -c 1500000 /tmp/b`);
        const out = String(r.stdout || "");
        const headers = out.split("---HEADERS\n")[1]?.split("\n---BODY\n")[0] || "";
        const body = out.split("\n---BODY\n")[1] || "";
        const ctype = (/content-type:\s*([^\r\n]+)/i.exec(headers) || [])[1] || "";
        return c.json({ url, contentType: ctype.trim(), headers: headers.trim(), body });
      } catch (error) {
        return c.json({ error: String(error?.message || error) }, 502);
      }
    });
    // Live previews (previews.mjs): the chat's card reads its state and link here. The link carries the
    // preview's token, so it goes to the signed-in owner only — never into a tool result or an event.
    api.get("/api/previews", (c) => c.json({ previews: previews.list({ chatId: c.req.query("chat") || null }).map((rec) => previews.view(rec)) }));
    api.get("/api/previews/:id", (c) => {
      const rec = previews.get(c.req.param("id"));
      if (!rec) return c.json({ error: "not found" }, 404);
      previews.touch(rec);
      return c.json({ preview: previews.view(rec) });
    });
    api.get("/api/previews/:id/logs", async (c) => {
      if (!previews.get(c.req.param("id"))) return c.json({ error: "not found" }, 404);
      try {
        return c.json({ log: await previews.logs(c.req.param("id"), Number(c.req.query("lines")) || 120) });
      } catch (error) {
        return c.json({ error: String(error?.message || error) }, 502);
      }
    });
    api.post("/api/previews/:id/stop", async (c) => {
      if (!previews.get(c.req.param("id"))) return c.json({ error: "not found" }, 404);
      try {
        return c.json({ preview: previews.view(await previews.stop(c.req.param("id"))) });
      } catch (error) {
        return c.json({ error: String(error?.message || error) }, 502);
      }
    });
    api.post("/api/previews/:id/restart", async (c) => {
      if (!previews.get(c.req.param("id"))) return c.json({ error: "not found" }, 404);
      try {
        const { rec, outcome, logTail } = await previews.restart(c.req.param("id"));
        return c.json({ preview: previews.view(rec), outcome, log: logTail });
      } catch (error) {
        return c.json({ error: String(error?.message || error) }, 502);
      }
    });
    // Owner-only knowledge review gate: reviewed:true notes are injected into prompts, and with
    // GRIFFIN_KNOWLEDGE_AUTO_TRUST=1 also notes from the owner's clean chats (shown as autoTrusted).
    const rawNote = (agent, file) => {
      try {
        return fs.readFileSync(path.join(KNOWLEDGE_ROOT, "agents", agent, "knowledge", file), "utf8");
      } catch {
        return null;
      }
    };
    const withAutoTrust = (agent) => (note) => ({
      ...note,
      autoTrusted: KNOWLEDGE_AUTO_TRUST && !note.reviewed && !(note.expires && Date.parse(note.expires) <= Date.now()) && chatTrust.isTrustedNote(agent, note.file, rawNote(agent, note.file)),
    });
    api.get("/api/knowledge", (c) => {
      const agents = {};
      for (const profile of store.listAgentProfiles()) {
        const notes = listAgentNotes(KNOWLEDGE_ROOT, profile.id).map(withAutoTrust(profile.id));
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
      return c.json({ notes: listAgentNotes(KNOWLEDGE_ROOT, agent).map(withAutoTrust(agent)) });
    });
    // External agents authenticate with their own Bearer token (not the owner cookie).
    api.get("/peer/v1/whoami", peerAuth.middleware(), (c) => {
      const { userId, clientId, caller, label } = c.get("peer");
      return c.json({ userId, clientId, caller, label });
    });
    // Owner-only: send from the owner's Telegram account through the one live client.
    api.post("/api/telegram/send", async (c) => {
      const body = await c.req.json().catch(() => ({}));
      // Another session wrote to a colleague: the owner is in that conversation now (desk.mjs).
      const tool = createAccountTools({ getClient: () => integrations.accountClient(), markSent: (id) => integrations.markAccountSent(id), onSent: (peer, text) => integrations.ownerWrote(peer, text), record: ledgerAndInbox(null) }).telegram_send;
      const result = await tool.execute({ chat: String(body.chat || ""), text: String(body.text || "") });
      const payload = JSON.parse(result.content?.[0]?.text || "{}");
      return c.json(payload, result.isError ? 400 : 200);
    });
    // Owner-only: correct a message the owner's account sent (Telegram itself refuses anyone else's).
    api.post("/api/telegram/edit", async (c) => {
      const body = await c.req.json().catch(() => ({}));
      const text = String(body.text || "");
      const messageId = Number(body.messageId);
      if (!text || text.length > 4000 || !Number.isInteger(messageId) || messageId < 1) return c.json({ error: "chat, messageId and text (1-4000) are required" }, 400);
      const client = integrations.accountClient();
      if (!client) return c.json({ error: "Telegram account is not connected" }, 503);
      try {
        const entity = await client.getInputEntity(String(body.chat || ""));
        await client.editMessage(entity, { message: messageId, text, linkPreview: false });
        return c.json({ edited: true, messageId });
      } catch (error) {
        return c.json({ error: String(error?.message || error) }, 400);
      }
    });
    // Owner-only: read dialogs / a chat from the Owner's own Telegram account (reference lookups).
    api.get("/api/telegram/read", async (c) => {
      const tools = createAccountTools({ getClient: () => integrations.accountClient(), markSent: (id) => integrations.markAccountSent(id) });
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
    // `route`: the engine/model an unpinned chat of this agent runs on now (its own provider may be off),
    // so the model and effort menus open on that engine, not on a turned-off one (owner 2026-10-16).
    api.get("/api/agents", (c) =>
      c.json({
        agents: store.listAgentProfiles().map((p) => {
          const { provider, model } = routeModel({ agent: p.id, caller: "owner" });
          return { ...publicProfile(p), route: { provider, model } };
        }),
      }),
    );
    api.get("/api/agents/:id", (c) => {
      const profile = store.getAgentProfile(c.req.param("id"));
      if (!profile) return c.json({ error: "not found" }, 404);
      return c.json({ agent: publicProfile(profile) });
    });
    const apiCatalogNames = async () =>
      uniqueTools([
        ...((await toolSource.listNames()) || []),
        ...APP_TOOL_NAMES,
        ...businessDocs.names,
        "telegram_dialogs",
        "telegram_read",
        "telegram_media",
        "telegram_watch_list",
        "telegram_send",
      ]);
    // The agents page makes an agent here; the mother agent makes one with agent_create (and the owner's yes).
    api.post("/api/agents", async (c) => {
      const body = await c.req.json().catch(() => ({}));
      try {
        const made = createCustomAgent({
          store,
          catalogNames: await apiCatalogNames(),
          input: body,
          isEngine: (id) => Boolean(kindOf(id)),
          splitModel,
          defaultProvider: store.getAgentProfile(DEFAULT_AGENT)?.provider || "cursor",
        });
        return c.json({ agent: publicProfile(made) }, 201);
      } catch (error) {
        if (error.code === "invalid") return c.json({ error: error.message }, 400);
        throw error;
      }
    });
    api.delete("/api/agents/:id", (c) => {
      const id = c.req.param("id");
      const profile = store.getAgentProfile(id);
      if (!profile) return c.json({ error: "not found" }, 404);
      if (profile.built_in) return c.json({ error: "ایجنت‌های پیش‌فرض حذف نمی‌شوند" }, 400);
      store.deleteAgentProfile(id);
      return c.json({ ok: true });
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
      if (typeof body.label === "string" && body.label.trim()) {
        const invalid = agentNameError(body.label);
        if (invalid) return c.json({ error: invalid }, 400);
        patch.label = body.label.trim();
      }
      if (typeof body.domain === "string") patch.domain = body.domain;
      if (typeof body.blurb === "string") patch.blurb = body.blurb;
      // How the agent works: a made agent's whole brief; for a built-in one, the owner's extra
      // instructions on top of its written rules (prompt.mjs buildRules).
      if (typeof body.instructions === "string") {
        if (body.instructions.length > MAX_INSTRUCTIONS) return c.json({ error: `دستور حداکثر ${MAX_INSTRUCTIONS} نویسه است` }, 400);
        patch.meta = { ...(patch.meta || {}), instructions: body.instructions.trim() };
      }
      if (typeof body.allTools === "boolean") patch.allTools = body.allTools;
      // Who may call this agent, and with which tools. Callers named here are replaced; the rest stay.
      if (body.callers && typeof body.callers === "object") {
        const current = store.getAgentProfile(id)?.meta?.callers || {};
        const next = { ...current };
        for (const [caller, quota] of Object.entries(body.callers)) {
          if (!/^[a-z0-9][a-z0-9:_-]{0,63}$/.test(caller)) continue;
          if (quota === null) delete next[caller];
          else if (quota?.tools === "*") next[caller] = { tools: "*" };
          else if (Array.isArray(quota?.tools)) next[caller] = { tools: uniqueTools(quota.tools.map(String)) };
        }
        if (!next.owner) next.owner = { tools: "*" };
        patch.meta = { ...(store.getAgentProfile(id)?.meta || {}), ...(patch.meta || {}), callers: next };
      }
      if (typeof body.provider === "string" && kindOf(body.provider)) patch.provider = body.provider;
      if (typeof body.model === "string") patch.model = body.model.trim() || null;
      if (body.model === null) patch.model = null;
      if (Array.isArray(body.tools)) patch.tools = body.tools.map(String);
      // Default reasoning effort for the agent's chats ("" clears it); a chat's own choice wins.
      if ("effort" in body) {
        const current = store.getAgentProfile(id);
        patch.meta = { ...(current.meta || {}), ...(patch.meta || {}), effort: effortOf(body.effort) };
      }
      // Ordered engines/models this agent runs on: the first usable one wins, the rest are its
      // fallbacks («account:model» or just «account» for that account's default model).
      if (Array.isArray(body.models)) {
        const models = [...new Set(body.models.map(String).map((m) => m.trim()).filter((m) => kindOf(m) || splitModel(m)))].slice(0, 12);
        const current = store.getAgentProfile(id);
        patch.meta = { ...(current.meta || {}), ...(patch.meta || {}), models };
        if (models.length) {
          const first = splitModel(models[0]) || { provider: models[0], model: null };
          patch.provider = first.provider;
          patch.model = first.model;
        }
      }
      if (Array.isArray(body.enable)) {
        store.enableAgentTools(id, body.enable);
      }
      if (Array.isArray(body.disable)) {
        store.disableAgentTools(id, body.disable);
      }
      let updated = Object.keys(patch).length ? store.updateAgentProfile(id, patch) : store.getAgentProfile(id);
      // A made agent's quotas follow its tool list (the built-in ones keep theirs).
      if (!updated.built_in && (Array.isArray(body.enable) || Array.isArray(body.disable))) {
        updated = store.updateAgentProfile(id, { meta: { callers: customCallers(updated.tools) } });
      }
      if (id === "griffin" && patch.label) renameAssistant(store, patch.label);
      refreshWorkspaces();
      return c.json({ agent: publicProfile(updated) });
    });
    api.get("/api/tool-catalog", async (c) => {
      const broker = await toolSource.listNames();
      const names = uniqueTools([
        ...(broker || []),
        ...APP_TOOL_NAMES,
        ...businessDocs.names,
        "telegram_dialogs",
        "telegram_read",
        "telegram_media",
        "telegram_watch_list",
        "telegram_send",
      ]);
      return c.json({ tools: names.map((name) => ({ name })) });
    });
    network.routes(api);
    network.ownerRoutes(api);
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
    integrationRoutes(api, integrations, { fillNames });
    profileRoutes(api, { store, dataDir: DATA, telegramProfile: () => integrations.accountProfile(), configuredName: OWNER.custom ? OWNER.fullNameFa || (OWNER.named ? OWNER.nameFa : null) : null });
    // Signed in only (the public brand info carries no owner name): the line under the assistant's
    // name on the home page. An install with no owner configured shows «دستیار هوشمند شخصی شما».
    // `brand` = the install's saved logo/colours (brand.mjs), so the page tints the assistant's cards.
    api.get("/api/brand", (c) => c.json({ ...brandLine(), brand: createBrand(path.join(DATA, "brand")).read() }));
    // Only the page's login cookie writes jobs as "owner" (jobs/routes.mjs requestWriter).
    jobRoutes(api, jobs, { targets: () => integrations.targets() });
  },
});
// Deployed bundles are content-hashed and never change, but index.html must always revalidate —
// without this the browser serves a stale index.html pointing at bundles that no longer exist.
app.use("*", async (c, next) => {
  await next();
  if (c.res && !c.res.headers.has("cache-control")) {
    c.res.headers.set("cache-control", c.req.path.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache");
  }
  // A CDN may keep «no-cache» files for minutes; CDN-Cache-Control is the
  // standard header it can be told to obey. Only the hashed bundles may be kept.
  if (c.res && !c.req.path.startsWith("/api/") && !c.req.path.startsWith("/assets/") && !c.res.headers.has("cdn-cache-control")) {
    c.res.headers.set("cdn-cache-control", "no-store");
  }
});
// Per-install look: the repo ships Griffin's mark and colours; <data>/brand/icon.svg and brand.css override them on one install.
const BRAND_DIR = path.join(DATA, "brand");
for (const route of ["/icon.svg", "/agents/griffin.svg"]) {
  app.get(route, async (c, next) => {
    const svg = await fs.promises.readFile(path.join(BRAND_DIR, "icon.svg")).catch(() => null);
    // Uploaded logos are sanitized (brand.mjs); opened directly, they still may not run or fetch anything.
    return svg ? c.body(svg, 200, { "content-type": "image/svg+xml", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox" }) : next();
  });
}
// The install's own name and colour on the home screen (the static manifest only knew one install).
app.get("/manifest.webmanifest", async (c) => {
  const saved = await fs.promises.readFile(path.join(BRAND_DIR, "brand.json"), "utf8").then(JSON.parse).catch(() => null);
  return c.json({
    name: PERSONA.name,
    short_name: PERSONA.name,
    lang: "fa",
    dir: "rtl",
    start_url: "/",
    display: "standalone",
    background_color: "#1a120c",
    theme_color: saved?.palette?.light?.brand || "#e8873a",
    icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any maskable" }],
  }, 200, { "content-type": "application/manifest+json" });
});
app.get("/brand.css", async (c) => c.body(upgradeBrandCss(await fs.promises.readFile(path.join(BRAND_DIR, "brand.css"), "utf8").catch(() => "")), 200, { "content-type": "text/css" }));
// The web UI is one surface among several (terminal, messengers, MCP, jobs). GRIFFIN_WEB=off runs
// the core headless: the API, the MCP endpoint and every integration stay exactly as they are.
const serveWeb = genv("WEB", "on") !== "off" && fs.existsSync(WEB_DIST);
if (serveWeb) {
  app.use("/assets/*", serveStatic({ root: WEB_DIST, precompressed: true }));
  app.get("/assets/*", (c) => c.text("not found", 404, { "cache-control": "no-store" })); // a bundle a deploy removed: never the SPA shell
  // The shell is served by us (not serveStatic) so brand.css / icon.svg get a version on their URL.
  const shell = shellHandler({ webDist: WEB_DIST, brandDir: BRAND_DIR });
  app.get("/", shell);
  app.get("/index.html", shell);
  app.use("/*", serveStatic({ root: WEB_DIST, precompressed: true }));
  app.get("*", shell);
} else {
  app.get("/", (c) => c.json({ griffin: "headless", ui: false, api: "/api", mcp: "/mcp" }));
}

// Notes («بعداً») whose time has come: checked every 20 s, each run once (claimed first). They
// live in the store, so a restart only delays a due note to the first tick after it.
const notesTimer = setInterval(() => app.notes.runDue().catch((error) => console.error(`[notes] runDue: ${error.message}`)), 20_000);
notesTimer.unref();

const tls = loadTls(genv("TLS_DIR", path.join(DATA, "tls")));
const server = createDualServer(getRequestListener(app.fetch), { tls, onUpgrade: (req, socket, head) => previews.handleUpgrade(req, socket, head) });
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
        clearInterval(notesTimer);
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
