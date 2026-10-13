import { egressDown, installCursorEgress } from "./egress.mjs";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { getRequestListener } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { createApp } from "./app.mjs";
import { createDualServer, loadTls } from "./listen.mjs";
import { ASK_REQUESTER_TOOL, ASK_TOOL, createAsks } from "./asks.mjs";
import { ASK_AGENT_TOOL, DELEGATE_TOOL, SUBTASKS_TOOL, createPeers } from "./peers.mjs";
import { createKnowledge, listAgentNotes, playbookIndex, reviewedRunbooks, setNoteReviewed } from "./knowledge.mjs";
import { createVisualizer, VISUALIZE_TOOL } from "./charts.mjs";
import { createShowMedia, SHOW_MEDIA_TOOL } from "./media.mjs";
import { createAuth } from "./auth.mjs";
import { openStore } from "./db.mjs";
import { genv, resolveDbPath } from "./env.mjs";
import { buildRules, installRules } from "./prompt.mjs";
import { buildManifest, recordManifest } from "./manifest.mjs";
import { simulateTools } from "./sim.mjs";
import { createRunner, keptList } from "./runner.mjs";
import { archiveIdleChats } from "./idle-archive.mjs";
import { clip } from "./updates.mjs";
import { createTitler } from "./titles.mjs";
import { createTimelineCache } from "./timeline-cache.mjs";
import { STT_DEFAULTS, sttRoutes } from "./stt.mjs";
import { chatTreeState, cleanupChatWorktree, currentWorktree, ensureChatWorktree, isValidRepoName, listRepos, parkedTrees, shortId, sweepChatWorktrees, switchChatWorktree, worktreeCreationSettled } from "./worktrees.mjs";
import { createRepoChatTools, repoRules } from "./repo-tools.mjs";
import { createIntegrations, integrationRoutes } from "./integrations/manager.mjs";
import { createJobs } from "./jobs/index.mjs";
import { jobRoutes } from "./jobs/routes.mjs";
import { createJobTools } from "./jobs/tools.mjs";
import { createAccountTools, parseProxy } from "./integrations/telegram-account.mjs";
import { COVERAGE_CALLER, END_AGENT_TOOL, TEAM_MUTATING, createEndAgentTool, guardTeamTools } from "./integrations/coverage.mjs";
import { createMotherTools, globalContext, isGlobalChat, motherContext, motherInfo, watchJoinedThreads } from "./integrations/mother.mjs";
import { deliverable } from "./integrations/format.mjs";
import { fillPersianNames } from "./integrations/fa-names.mjs";
import { fenceBackdoors, guardTools, noteOwnerAnswer } from "./guard.mjs";
import { reviewChanges } from "./review.mjs";
import { RELATED_TOOL, channelOf, createPeerChatTools, createRelatedTool, lastHop, openWorkFor, relatedRules, thirdPartyKey } from "./related.mjs";
import { createChatTools } from "./chat-tools.mjs";
import { OWNER_TASK_TOOL, TODO_TOOL, offersOwnerTask, ownerTaskTool, todoWriteTool, watchTodos } from "./todos.mjs";
import { inboxTool } from "./inbox.mjs";
import { claudeOneShot } from "./providers/claude.mjs";
import { createVerifier } from "./verify.mjs";
import { allowsModel, peerSettings } from "./peer-limits.mjs";
import { createPeerAuth, isPeerCaller, PEER_CONNECTION_TOOL, PEER_INVITE_TOOL, peerConnectionTool } from "./peer-auth.mjs";
import { createPeerTasks } from "./peer-tasks.mjs";
import { createMcpHandler } from "./mcp.mjs";
import { brokerRequest, createToolSource } from "./tools.mjs";
import { DEFAULT_AGENT } from "./agents/registry.mjs";
import { agentPayload } from "./agents/import.mjs";
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
  PROVIDER_OPENAI,
  PROVIDERS,
  kindOf,
  setAccounts,
} from "./providers/index.mjs";
import { effortOf, splitModel, ACCOUNT_ID, KINDS } from "./providers/ids.mjs";
import { createSecretStore } from "./secrets.mjs";
import { createConfig } from "./config.mjs";
import { createClaudeSignin } from "./claude-signin.mjs";
import { createDoctor, hookConsoleErrors } from "./doctor.mjs";
import { PERSONA, PERSONA_FILE } from "./persona.mjs";
import { profileRoutes } from "./profile.mjs";
import { createHostStats } from "./host-stats.mjs";
import { createPush } from "./push.mjs";

const env = process.env;
// Must run before the SDK opens any connection.
const DATA = genv("DATA", "/data");
// Egress proxy: env wins (GRIFFIN_PROXY for everything; CURSOR_PROXY / HTTPS_PROXY as before), else
// <data>/proxy.json from the setup wizard. fetch follows it through setGlobalProxyFromEnv; the agent
// SDKs' own TLS streams through egress.mjs.
const PROXY_FILE = path.join(DATA, "proxy.json");
function applyProxy(url) {
  if (!url) return;
  http.setGlobalProxyFromEnv?.({ HTTPS_PROXY: url, HTTP_PROXY: url, NO_PROXY: env.NO_PROXY || "127.0.0.1,localhost,::1" });
  installCursorEgress(url);
}
const savedProxy = () => {
  try {
    return JSON.parse(fs.readFileSync(PROXY_FILE, "utf8")).url || "";
  } catch {
    return "";
  }
};
const ENV_PROXY = genv("PROXY", "");
const proxyFromEnv = Boolean(ENV_PROXY || env.CURSOR_PROXY || env.HTTPS_PROXY);
if (ENV_PROXY) applyProxy(ENV_PROXY);
else {
  installCursorEgress(env.CURSOR_PROXY);
  if (!proxyFromEnv) applyProxy(savedProxy());
}
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
const store = openStore(resolveDbPath(DATA), { seedProvider });
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
const tasksHolder = { current: null };
const verifyHolder = { current: null };
const asks = createAsks({
  store,
  onSettled: (chatId, info) => {
    integrationsHolder.current?.clearQuestion(chatId, info);
    // An owner's yes/no on an approval-style ask covers the next guarded call in the chain once
    // (double-ask fix). Requester answers never bless anything.
    if (info?.by !== "requester" && info?.answer != null) noteOwnerAnswer(store, chatId, info);
  },
});
const peersHolder = { current: null };
// Each run's step list (kv todo:<chat>) for the owner's board: native lists copied, cleared at run
// end once no delegated subtask still owes a report.
watchTodos(store, { pendingDelegates: (chatId) => peersHolder.current?.pendingDelegates(chatId) || 0 });
const knowledge = createKnowledge({
  store,
  root: path.join(WORKSPACE, "knowledge"),
  git: genv("DEMO") !== "1",
});
const KNOWLEDGE_ROOT = path.join(WORKSPACE, "knowledge");
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
const maybeTitle = createTitler({ store, timelines, generate: generateText });
// Older chats still carry the first line of the question as title; rename them once, one at a time.
setTimeout(async () => {
  for (const chat of [...store.listChats({ archived: false }), ...store.listChats({ archived: true })]) {
    if (chat.title.length > 24) await maybeTitle(chat.id, { backfill: true });
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
      };
    }),
    builtinTools: TOOLS,
    demoSdk,
  });
}

// Mutated in place on reconfigure: the runner looks providers up per run, so the next run uses the
// new settings while a run already in flight finishes on the old object.
const providers = buildProviders();
function reconfigureProviders() {
  for (const id of Object.keys(providers)) if (!PROVIDERS.includes(id)) delete providers[id];
  Object.assign(providers, buildProviders());
  modelCache = { at: 0, byProvider: {} };
}

// The provider and model a chat's next run actually uses: the agent profile decides, the chat's own
// model overrides, the env default fills in. The same answer labels run.started, so the UI shows the
// real model instead of "auto".
const limitedUntil = (provider) => store.getKv(`limited:${provider}`) || 0;
const isLimited = (provider) => limitedUntil(provider) > Date.now();
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
  const list = [];
  const add = (provider, model, extraEffort) => {
    if (!kindOf(provider)) return;
    list.push({ provider, model: model || providers[provider]?.defaultModel || "auto", effort: effort || extraEffort || null });
  };
  const pinned = splitModel(chat?.model);
  if (pinned) add(pinned.provider, pinned.model);
  const teamRoot = chat?.caller === COVERAGE_CALLER || (chat?.parent_chat_id && rootCallerOf(store, chat) === COVERAGE_CALLER);
  const prefix = chat?.caller === COVERAGE_CALLER ? "TEAM" : "TEAM_SUB";
  const team = teamRoot ? genv(`${prefix}_PROVIDER`, "") : "";
  if (team) add(team, genv(`${prefix}_MODEL`, ""), effortOf(genv(`${prefix}_EFFORT`, "")));
  for (const entry of profile?.meta?.models || []) {
    const split = splitModel(entry);
    if (split) add(split.provider, split.model);
    else add(String(entry), null);
  }
  const own = profile?.provider || chat?.provider;
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
const usableAccount = (id) => accountEnabled(id) && !isLimited(id) && (Boolean(providerKey(id)) || demo);
function routeModel(chat) {
  const list = modelCandidates(chat);
  return list.find((c) => usableAccount(c.provider)) || list.find((c) => accountEnabled(c.provider)) || list[0] || { provider: DEFAULT_PROVIDER, model: "auto", effort: null };
}
const runModel = routeModel;

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
  // Plan limit: remember until it resets (or an hour) and retry the run on the other engine, if any.
  onPlanLimit: (chat, error) => {
    const limited = runModel(chat).provider;
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
    const times = modelCandidates(chat)
      .filter((c) => accountEnabled(c.provider) && (Boolean(providerKey(c.provider)) || demo))
      .map((c) => limitedUntil(c.provider));
    return times.length ? Math.min(...times) || Date.now() : null;
  },
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
  providerFor: (chat) => providers[runModel(chat).provider] || providers[DEFAULT_PROVIDER],
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
      "telegram_media",
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
      [PEER_CONNECTION_TOOL]: peerConnectionTool({ store, defaultUser: chat.person_id ? store.getPerson?.(chat.person_id)?.access?.peerAgent?.user || null : null }),
      ...knowledge.tool(chat.id),
      [VISUALIZE_TOOL]: visualizer.tool(chat.id),
      [SHOW_MEDIA_TOOL]: showMedia.tool(chat.id),
      ...createJobTools({ jobs, targets: () => integrations.targets() }),
      ...createIncidentTools({ incidents }),
      ...settingsTools,
      ...doctor.tools,
      // A colleague's own conversation may tell an owner chat something (its quota decides).
      ...(isPeerCaller(caller) ? createPeerChatTools({ store, runner, chat }) : {}),
    };
    Object.assign(customTools, createAccountTools({ getClient: () => integrations.accountClient(), markSent: (id) => integrations.markAccountSent(id), onSent: (peer, text) => integrations.ownerWrote(peer, text) }));

    const cwd = agentCwd(WORKSPACE, agent);
    const peers = store.listAgentProfiles().filter((p) => p.id !== agent);
    const rootCaller = chat.parent_chat_id ? rootCallerOf(store, chat) : caller;
    const rootChatId = store.rootChatId(chat.id);
    const unattended = ["scheduler", "ops"].includes(rootCaller) || Boolean(store.getChat(rootChatId)?.job_id);
    // Suggest a chat / mark a chapter (chat-tools.mjs): only in chats the owner is reading.
    if (rootCaller === "owner" && !unattended) Object.assign(customTools, createChatTools({ store, chatId: chat.id, isValidRepo: (repo) => isValidRepoName(REPOS_ROOT, repo), checkModel: checkSuggestModel }));
    let filtered = filterToolsByProfile(customTools, profile, { caller });
    // Irreversible calls in any chain not rooted in the owner need the owner's yes (in code). The
    // question reaches them in Telegram wherever the chain started, so a peer chain asks too
    // instead of refusing outright.
    filtered = fenceBackdoors(filtered, { chatId: chat.id, store, caller: rootCaller });
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
    // A person's mother chat orchestrates and never closes (integrations/mother.mjs); only
    // send_to_person reaches the colleague, so no telegram_send and no ask_requester there.
    const mother = caller === COVERAGE_CALLER ? motherInfo(store, chat.id) : null;
    if (mother) {
      delete filtered.telegram_send;
      delete filtered[ASK_REQUESTER_TOOL];
      Object.assign(filtered, createMotherTools({
        store, runner, chatId: chat.id, name: mother.name,
        sendToPerson: (text) => integrations.desk.sendToPerson(chat.id, text),
        editSent: (id, text) => integrations.desk.editSent(chat.id, id, text),
        deleteSent: (id) => integrations.desk.deleteSent(chat.id, id),
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
    if (agent === DEFAULT_AGENT && rootCaller === "owner" && !unattended) filtered.inbox_list = inboxTool({ store, asks });
    if (offersOwnerTask({ rootCaller, unattended })) filtered[OWNER_TASK_TOOL] = ownerTaskTool({ store, chatId: rootChatId, agent });


    // A chat on a repo (a side chat or a fork: its main chat's) works in that chat's own worktree,
    // made on the first run; any engine gets the file/git tools for it. A fork must: Claude Code
    // keeps the forked session by working folder. A folder switch in flight finishes first, and the
    // chat is read after it (its repo may have moved).
    const mainId = chat.side_of || store.getKv(`fork-of:${chat.id}`);
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
    // A chat holding a colleague's text (chat_send) passes nothing on until the owner writes again.
    filtered = lastHop(filtered, { store, chatId: chat.id });

    // Outermost: a simulation tree records side effects instead of running them (no approval
    // question reaches the owner either — sim wraps the guard).
    if (store.getChat(rootChatId)?.sim) filtered = simulateTools(filtered);

    // Rules are built from the tools this run really has (after caller filtering and guards).
    const ruleOptions = { agent, caller, peers, profile, knowledgeRoot: KNOWLEDGE_ROOT, tools: Object.keys(filtered), thirdParty: Boolean(store.getKv(thirdPartyKey(chat.id))), mother: Boolean(mother) };
    installRules(cwd, ruleOptions);
    const rules = (repoContext ? `${buildRules(ruleOptions)}\n\n${repoRules(repoContext)}` : buildRules(ruleOptions)) + relatedRules(relatedOpen, channelOf(store, chat)) + (mother ? motherContext(mother.name) : desk ? globalContext() : "");
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
          approval: rootCaller !== "owner" && caller !== COVERAGE_CALLER ? (unattended ? "refuse" : "ask") : caller === COVERAGE_CALLER ? "team" : null,
          review: genv("DEMO") !== "1",
          sim: Boolean(store.getChat(rootChatId)?.sim),
        },
      }, (text) => store.putBlob(text)));
    } catch (error) {
      console.error(`[manifest] chat ${chat.id}: ${error.message}`);
    }

    return {
      // Engines with their own file tools (Claude, Cursor) work in the worktree; the agent's own
      // folder keeps its state (openai sessions) and rules files.
      cwd: repoContext?.dir || cwd,
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
      pendingWork: () => peersHolder.current?.pendingDelegates(chat.id) || 0,
    };
  },
});

peersHolder.current = createPeers({ store, runner });

// The clones stay current: fetched every 10 minutes and their own checkout fast-forwarded when clean
// (agents read shared clones through it; new chat worktrees start from origin). Needs the broker.
const refreshRepos = () => {
  if (!brokerEnabled()) return;
  for (const repo of listRepos(REPOS_ROOT)) {
    callBrokerTool("git_fetch", { repo, update: true }, 130_000).catch((error) => console.error(`[repos] refresh ${repo}: ${error.message}`));
  }
};
setTimeout(refreshRepos, 30_000).unref();
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
  sweepChatWorktrees({ reposRoot: REPOS_ROOT, chatState: (id8) => states.get(id8) || "deleted" })
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
async function models(provider = null) {
  const want = provider ? normalizeProvider(provider) : null;
  if (Date.now() - modelCache.at < 10 * 60_000 && Object.keys(modelCache.byProvider).length) {
    if (want) return modelCache.byProvider[want] || [];
    return Object.values(modelCache.byProvider).flat();
  }
  const byProvider = {};
  await Promise.all(
    PROVIDERS.filter((id) => providers[id]).map(async (id) => {
      try {
        byProvider[id] = (await providers[id].listModels()).map((m) => ({ ...m, provider: id }));
      } catch (error) {
        console.error(`[models:${id}]`, error?.message || error);
        byProvider[id] = kindOf(id) === PROVIDER_CLAUDE ? (await import("./providers/claude.mjs")).CLAUDE_MODELS.map((m) => ({ ...m, provider: id })) : [];
      }
    }),
  );
  modelCache = { at: Date.now(), byProvider };
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
const peerAuth = createPeerAuth({ store, publicUrl: genv("PUBLIC_URL", "") });
const integrations = createIntegrations({
  store, runner, timelines, asks, peerAuth, publicUrl: genv("PUBLIC_URL", ""), telegramProxy: parseProxy(genv("TELEGRAM_SOCKS")),
  pendingWork: (chatId) => peersHolder.current?.pendingDelegates(chatId) || 0,
  // A burst of a colleague's messages waits this long after the latest one and becomes one turn.
  burstMs: Number(genv("TG_BURST_SECONDS", "45")) * 1000,
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
const doctor = createDoctor({
  store, runner, providers, providerKey, providerConfig, integrations,
  openaiBaseUrl: () => genv("OPENAI_BASE_URL", ""),
  engineIds: PROVIDERS, dataDir: DATA,
});
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
  canRun: async (job) => {
    if (demo) return true;
    const { provider } = routeModel({ agent: job.agent, caller: "scheduler", model: job.model });
    const engine = providers[provider];
    if (!engine) return true;
    return !egressDown(await engine.health().catch((error) => ({ ok: false, error: String(error?.message || error) })));
  },
});
jobs.start();

// Incident intake: Alertmanager of every cluster → grouped incidents → Griffin's ops room (shadow).
const incidents = createIncidentStore(store.db);
// Incident intake needs something to poll; with no broker there are no alert sources at all.
const opsRoom = createOpsRoom({
  store,
  runner,
  incidents,
  mode: brokerEnabled() ? genv("OPS_MODE", "record") : "off",
});
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
  pendingWork: (chatId) => peersHolder.current?.pendingDelegates(chatId) || 0,
  childChats: (chatId) => store.listChildChatIds(chatId).map((id) => store.getChat(id)).filter(Boolean),
});
tasksHolder.current = peerTasks;
// Fresh-context checker for finished runs (see verify.mjs); needs callBrokerTool above.
verifyHolder.current = createVerifier({ store, callTool: callBrokerTool, runner });
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

const app = createApp({
  movedHosts: String(genv("OLD_HOSTS", "")).split(",").map((h) => h.trim().toLowerCase()).filter(Boolean),
  publicUrl: genv("PUBLIC_URL", ""),
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
    : createAuth({ dataDir: DATA, store, secureCookie: genv("SECURE_COOKIE") === "1" }),
  version: genv("VERSION", "dev"),
  // A timed note («بعداً») that ran — or did not — is one line on the owner's Telegram.
  onNoteRun: (note, { chat, error }) =>
    integrations.notifyOwner(
      error ? `⏰ یادداشتِ زمان‌دار اجرا نشد (${String(error).slice(0, 120)}): ${note.text.slice(0, 80)}` : `⏰ یادداشتِ زمان‌دار اجرا شد: ${note.text.slice(0, 80)}`,
      chat?.id || note.chatId,
    ),
  extraRoutes: (api) => {
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
      config: {
        baseUrl: genv("STT_BASE_URL", STT_DEFAULTS.baseUrl),
        model: genv("STT_MODEL", STT_DEFAULTS.model),
        language: genv("STT_LANGUAGE", STT_DEFAULTS.language),
      },
    });
    // Models & providers page: what each engine runs on, its health, its models, and which agents use it.
    api.get("/api/providers", async (c) => {
      const profiles = store.listAgentProfiles();
      const list = await Promise.all(
        accounts().map(async (account) => {
          const { id, kind } = account;
          const p = providers[id];
          const config = providerConfig(id);
          const [health, list] = await Promise.all([
            account.enabled && p ? p.health().catch((error) => ({ ok: false, error: String(error?.message || error) })) : { ok: false, error: "disabled" },
            account.enabled && p ? models(id).catch(() => []) : [],
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
            baseUrl: kind === PROVIDER_OPENAI ? config.baseUrl ?? (id === kind ? genv("OPENAI_BASE_URL", "") : "") : null,
            reasoningEffort: kind === PROVIDER_OPENAI ? config.reasoningEffort ?? (id === kind ? genv("OPENAI_REASONING_EFFORT", "") : "") : null,
            limitedUntil: isLimited(id) ? limitedUntil(id) : null,
            lastLimit: limit,
            health,
            models: list.map((m) => ({ id: m.id, name: m.name || m.id })),
            agents: profiles
              .filter((a) => normalizeProvider(a.provider) === id || (a.meta?.models || []).some((m) => String(m).split(":")[0] === id))
              .map((a) => ({ id: a.id, label: a.label, model: a.model || null })),
          };
        }),
      );
      return c.json({ providers: list, kinds: KINDS, presets: OPENAI_PRESETS.map(({ id, label, baseUrl }) => ({ id, label, baseUrl })) });
    });
    // A new engine account: a second Claude subscription, an OpenRouter key next to Z.ai, …
    api.post("/api/providers", async (c) => {
      const body = await c.req.json().catch(() => ({}));
      const kind = String(body.kind || "");
      if (!KINDS.includes(kind)) return c.json({ error: "kind must be cursor, claude or openai" }, 400);
      const slug = String(body.slug || body.preset || "").toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 16);
      const list = accounts();
      let id = slug ? `${kind}-${slug}` : `${kind}-2`;
      for (let n = 2; list.some((a) => a.id === id); n += 1) id = slug ? `${kind}-${slug}${n}` : `${kind}-${n}`;
      if (!ACCOUNT_ID.test(id)) return c.json({ error: "invalid account id" }, 400);
      saveAccounts([...list, { id, label: String(body.label || "").trim().slice(0, 40), enabled: true }]);
      store.setKv(`provider:${id}`, JSON.stringify({}));
      reconfigureProviders();
      return c.json({ id }, 201);
    });
    api.delete("/api/providers/:id", (c) => {
      const id = c.req.param("id");
      if (KINDS.includes(id)) return c.json({ error: "a base engine can be switched off, not removed" }, 400);
      const list = accounts();
      if (!list.some((a) => a.id === id)) return c.json({ error: "unknown provider" }, 404);
      saveAccounts(list.filter((a) => a.id !== id));
      secrets.delete(`engine/${id}`);
      store.deleteKv(`provider:${id}`);
      reconfigureProviders();
      return c.json({ ok: true });
    });
    // Claude account sign-in from the browser: the token lands in the secret store, never in a response.
    const claudeSignin = createClaudeSignin({
      onToken: (id, token) => {
        secrets.set(`engine/${id}`, token, { note: `Claude account ${id} (browser sign-in)` });
        store.deleteKv(`limited:${id}`);
        reconfigureProviders();
      },
    });
    api.post("/api/providers/:id/signin", async (c) => {
      const id = c.req.param("id");
      if (kindOf(id) !== PROVIDER_CLAUDE) return c.json({ error: "browser sign-in is for Claude accounts" }, 400);
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
      if (body.clearLimit === true) store.deleteKv(`limited:${id}`);
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
    // Settings → Configuration: what used to be env-only (config.mjs). Some apply after a restart,
    // which the owner can do from the same page (the container's restart policy brings it back).
    api.get("/api/config", (c) => c.json({ settings: config.view(), activeRuns: runner.activeCount() }));
    api.patch("/api/config", async (c) => {
      try {
        return c.json(config.set(await c.req.json().catch(() => ({}))));
      } catch (error) {
        return c.json({ error: error.message }, 400);
      }
    });
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
    // Doctor (self-check / self-repair) and the setup wizard (apps/web Setup.jsx).
    api.get("/api/doctor", async (c) => c.json(await doctor.report()));
    api.get("/api/doctor/engine/:id", async (c) => {
      const id = normalizeProvider(c.req.param("id"));
      if (id !== c.req.param("id")) return c.json({ error: "unknown provider" }, 404);
      reconfigureProviders();
      return c.json(await doctor.probeEngine(id));
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
      const name = String(body.name || "").trim().slice(0, 40);
      const latin = String(body.latin || "").trim().slice(0, 40);
      if (!name) return c.json({ error: "name required" }, 400);
      fs.writeFileSync(PERSONA_FILE, JSON.stringify({ name, latin: latin || name }));
      return c.json({ ok: true, restart: name !== PERSONA.name || (latin || name) !== PERSONA.latin });
    });
    api.get("/api/setup/proxy", (c) => c.json({ url: ENV_PROXY || savedProxy(), fromEnv: proxyFromEnv }));
    api.post("/api/setup/proxy", async (c) => {
      const body = await c.req.json().catch(() => ({}));
      const url = String(body.url || "").trim();
      if (url && !/^https?:\/\/[^\s/]+(:\d+)?\/?$/.test(url)) return c.json({ error: "proxy must look like http://host:port" }, 400);
      if (proxyFromEnv) return c.json({ error: "proxy is set by the environment; change it there" }, 409);
      fs.writeFileSync(PROXY_FILE, JSON.stringify({ url }));
      if (url) applyProxy(url);
      else http.setGlobalProxyFromEnv?.({});
      // Clearing leaves the agent-stream tunnel on the old proxy until a restart.
      return c.json({ ok: true, url, restart: !url });
    });
    api.post("/api/setup/done", (c) => {
      store.setKv("setup:done", "1");
      return c.json({ ok: true });
    });
    api.get("/api/approvals", (c) => c.json({ approvals: store.listApprovals({ limit: Math.min(Number(c.req.query("limit")) || 100, 500) }) }));

    // Owner workbench on the sandbox (no creds, no kubeconfig): a shell, a file browser and a web
    // fetcher. All three run as one debug_exec on host "sandbox" — the same box the agent uses.
    // Only with a broker (it holds the sandbox's SSH key).
    const sandbox = (command) => callBrokerTool("debug_exec", { host: "sandbox", command });
    if (brokerWanted) {
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
    }
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
      // Another session wrote to a colleague: the owner is in that conversation now (desk.mjs).
      const tool = createAccountTools({ getClient: () => integrations.accountClient(), markSent: (id) => integrations.markAccountSent(id), onSent: (peer, text) => integrations.ownerWrote(peer, text) }).telegram_send;
      const result = await tool.execute({ chat: String(body.chat || ""), text: String(body.text || "") });
      const payload = JSON.parse(result.content?.[0]?.text || "{}");
      return c.json(payload, result.isError ? 400 : 200);
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
    api.get("/api/agents", (c) => c.json({ agents: store.listAgentProfiles().map(publicProfile) }));
    api.get("/api/agents/:id", (c) => {
      const profile = store.getAgentProfile(c.req.param("id"));
      if (!profile) return c.json({ error: "not found" }, 404);
      return c.json({ agent: publicProfile(profile) });
    });
    api.post("/api/agents", async (c) => {
      let body = {};
      try {
        body = await c.req.json();
      } catch {
        body = {};
      }
      let payload;
      try {
        payload = agentPayload(body);
      } catch (error) {
        return c.json({ error: error.message }, 400);
      }
      if (store.getAgentProfile(payload.id)) return c.json({ error: `agent "${payload.id}" already exists` }, 409);
      const created = store.upsertAgentProfile(payload);
      refreshWorkspaces();
      return c.json({ agent: publicProfile(created) }, 201);
    });
    api.delete("/api/agents/:id", (c) => {
      const id = c.req.param("id");
      const profile = store.getAgentProfile(id);
      if (!profile) return c.json({ error: "not found" }, 404);
      if (id === DEFAULT_AGENT) return c.json({ error: "the default agent cannot be deleted" }, 400);
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
      if (typeof body.label === "string" && body.label.trim()) patch.label = body.label.trim();
      if (typeof body.domain === "string") patch.domain = body.domain;
      if (typeof body.blurb === "string") patch.blurb = body.blurb;
      if (typeof body.instructions === "string") patch.instructions = body.instructions;
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
        patch.meta = { ...(store.getAgentProfile(id)?.meta || {}), callers: next };
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
      const updated = Object.keys(patch).length ? store.updateAgentProfile(id, patch) : store.getAgentProfile(id);
      refreshWorkspaces();
      return c.json({ agent: publicProfile(updated) });
    });
    api.get("/api/tool-catalog", async (c) => {
      const broker = await toolSource.listNames();
      const names = uniqueTools([
        ...(broker || []),
        ...APP_TOOL_NAMES,
        "telegram_dialogs",
        "telegram_read",
        "telegram_media",
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
    integrationRoutes(api, integrations, { fillNames });
    profileRoutes(api, { store, telegramProfile: () => integrations.accountProfile() });
    jobRoutes(api, jobs, { targets: () => integrations.targets() });
  },
});
// The web UI is one surface among several (terminal, messengers, MCP, jobs). GRIFFIN_WEB=off runs
// the core headless: the API, the MCP endpoint and every integration stay exactly as they are.
const serveWeb = genv("WEB", "on") !== "off" && fs.existsSync(WEB_DIST);
if (serveWeb) {
  // Deployed bundles are content-hashed and never change, but index.html must always revalidate —
  // without this the browser serves a stale index.html pointing at bundles that no longer exist.
  app.use("*", async (c, next) => {
    await next();
    if (c.res && !c.res.headers.has("cache-control")) {
      c.res.headers.set("cache-control", c.req.path.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache");
    }
  });
  app.use("/assets/*", serveStatic({ root: WEB_DIST, precompressed: true }));
  app.use("/*", serveStatic({ root: WEB_DIST, precompressed: true }));
  app.get("*", serveStatic({ path: path.join(WEB_DIST, "index.html") }));
} else {
  app.get("/", (c) => c.json({ griffin: "headless", ui: false, api: "/api", mcp: "/mcp" }));
}

// Notes («بعداً») whose time has come: checked every 20 s, each run once (claimed first). They
// live in the store, so a restart only delays a due note to the first tick after it.
const notesTimer = setInterval(() => app.notes.runDue().catch((error) => console.error(`[notes] runDue: ${error.message}`)), 20_000);
notesTimer.unref();

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
