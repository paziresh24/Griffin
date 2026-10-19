import { autoMovesOn, claudeLimitCode, isClaudePlanLimit } from "../plan-fallback.mjs";
import { isCreditError } from "../engine-state.mjs";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { query, tool, createSdkMcpServer, forkSession as sdkForkSession } from "@anthropic-ai/claude-agent-sdk";
import { jsonSchemaToZodShape } from "./json-schema-zod.mjs";
import { createClaudeEventBridge, mcpToolCall, limitClosed } from "./claude-events.mjs";
import { ASK_TOOL, isPlanApprovalText } from "../asks.mjs";
import { inertText, maskText } from "../redact.mjs";
import { NO_FILE_TOOLS, fileGuard, fileGuardHooks } from "./file-scope.mjs";
import { stateGuard, denyOutput, instructionGuardOptions } from "./state-guard.mjs";
import { hostSpawner, hostTarget } from "./host-spawn.mjs";
import { isLoginDirKey, loginDirOf } from "../claude-account-dir.mjs";
import { genv } from "../env.mjs";
import { agentSlug } from "../persona.mjs";
// The in-process MCP server carries the assistant's own name, so the model sees mcp__<name>__kube_get,
// never mcp__griffin__… (each install's agent goes by its own name).
const mcpName = () => agentSlug();
import { endpointEnv, endpointModel, isEndpointPlanLimit, zaiQuota } from "./claude-endpoint.mjs";
import { resetFromText } from "../plan-fallback.mjs";
import { fromRunWindows } from "../plan-usage.mjs";
import { execFile } from "node:child_process";
import { claudeBinary } from "../claude-signin.mjs";

export const PROVIDER_CLAUDE = "claude";

// Map the short names the picker/env use to a full id the INSTALLED claude-agent-sdk accepts.
// The Anthropic API does not resolve bare "opus"/"sonnet" (404 "model: opus"), and
// the bundled CLI rejects a model newer than itself ("does not support this model;
// version X+ required"), so these must name an id the SDK knows — bump them together with the SDK
// version (check: grep -roE 'claude-(opus|sonnet)-[0-9-]+' node_modules/@anthropic-ai/claude-agent-sdk).
// SDK 0.3.296 knows the 5-5 line.
const MODEL_ALIAS = { opus: "claude-opus-5-5", fable: "claude-fable-5-1", sonnet: "claude-sonnet-5-5", haiku: "claude-haiku-5-5" };
export const resolveModel = (id) => MODEL_ALIAS[String(id || "").toLowerCase()] || id;

// Claude Code's own default effort per model — from the model catalog baked into the bundled CLI
// (SDK 0.3.296: grep its binary for `default_effort`). It is what a turn uses when Griffin sends no
// effort, so the effort panel marks it «پیشنهادی». A model missing here falls back to "high", as
// Claude Code does. Bump with the SDK, like MODEL_ALIAS.
const DEFAULT_EFFORT = {
  "claude-opus-5-5": "medium",
  "claude-sonnet-5-5": "medium",
  "claude-haiku-5-5": "medium",
  "claude-fable-5-1": "high",
  "claude-fable-5": "high",
  "claude-opus-5": "high",
  "claude-sonnet-5": "high",
  "claude-opus-4-8": "high",
  "claude-opus-4-7": "xhigh",
  "claude-mythos-5-1": "high",
};
export const defaultEffortOf = (id) => DEFAULT_EFFORT[resolveModel(id)] || "high";

// The model and version an alias runs today, as Claude Code's own menu writes it: "Opus 5.5"
// (from MODEL_ALIAS, so it moves with the SDK bump). The Karsara skin shows it; the Griffin skin keeps `name`.
export const versionLabel = (id) => {
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d+))?$/.exec(resolveModel(id));
  return m ? `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] ? `.${m[3]}` : ""}` : null;
};

// GRIFFIN_CLAUDE_FABLE=1 (a host whose Claude plan has Fable): Fable is listed after
// Opus. Off by default, so other installs' menus stay as they are. A live Settings
// key (CLAUDE_FABLE): built on every ask, so a change shows without a restart.
export function claudeModelList(env = process.env) {
  const fable = /^(1|true|on|yes)$/i.test(String(genv("CLAUDE_FABLE", "", env)));
  return [
    { id: "opus", name: "Claude Opus" },
    ...(fable ? [{ id: "fable", name: "Claude Fable" }] : []),
    { id: "sonnet", name: "Claude Sonnet" },
    { id: "haiku", name: "Claude Haiku" },
  ].map((m) => ({ ...m, label: versionLabel(m.id), defaultEffort: defaultEffortOf(m.id) }));
}
export const CLAUDE_MODELS = claudeModelList();

// The menu with what Claude Code itself offers this login (Query.supportedModels).
// The aliases come first. A family the CLI
// offers that the menu lacks joins as its alias — Fable comes as «claude-fable-5-1[1m]» (a [1m] id
// is a current flagship), so it shows without CLAUDE_FABLE. Any other model it
// lists (a dated, older one) is added behind `more`.
export function withCliModels(base, list) {
  const ids = new Set(base.map((m) => m.id));
  const main = [...base];
  const extra = [];
  for (const m of Array.isArray(list) ? list : []) {
    const id = typeof m?.value === "string" ? m.value.trim() : "";
    if (!id || id === "default" || id.length > 100 || ids.has(id)) continue;
    const family = MODEL_ALIAS[id] ? id : /^claude-([a-z]+)-[\d-]+\[1m\]$/i.exec(id)?.[1]?.toLowerCase();
    if (family && MODEL_ALIAS[family]) {
      if (ids.has(family)) continue;
      ids.add(family);
      main.push({ id: family, name: `Claude ${family[0].toUpperCase()}${family.slice(1)}`, label: versionLabel(family), defaultEffort: defaultEffortOf(family) });
      continue;
    }
    if (/\[1m\]$/i.test(id)) continue;
    ids.add(id);
    const name = String(m.displayName || id).slice(0, 80);
    extra.push({ id, name, label: name, ...(m.description ? { description: String(m.description).slice(0, 120) } : {}), more: true });
  }
  const order = ["opus", "fable", "sonnet", "haiku"];
  const rank = (m) => (order.includes(m.id) ? order.indexOf(m.id) : order.length);
  return [...main.sort((x, y) => rank(x) - rank(y)), ...extra];
}

// `claude auth status --json`: who this login is. A full Claude Code login names the email and the
// plan; a setup-token (sk-ant-oat…) says only «oauth_token» — Anthropic refuses its profile (403,
// no profile scope), so there is no email to show for it.
export function accountFromStatus(raw) {
  let s = raw;
  if (typeof raw === "string") {
    try {
      s = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!s || typeof s !== "object" || s.loggedIn !== true) return null;
  const str = (v) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 120) : null);
  return { email: str(s.email), name: str(s.displayName || s.name || s.orgName), plan: str(s.subscriptionType), method: str(s.authMethod) };
}

// Built-ins Claude Code may use in the owner's own chats, within the file scope the run brings
// (file-scope.mjs; no scope = NO_FILE_TOOLS). No Bash: live ops go through typed broker/MCP tools.
// The rules' «tools you actually have (authoritative)» list names Griffin's tools only; without this
// line the model refused Bash in full mode.
const FULL_NOTE = "This is the owner's own chat with his full Claude Code: besides the tools listed above you also have every Claude Code built-in (Bash, Read, Write, Edit, Glob, Grep, WebFetch, WebSearch, …), his skills and his own MCP servers. Use them like his own terminal; the app's own tools stay the way to reach clusters, vaults and people.";
// options.onHost (config CLAUDE_HOST): the same chat, but on the server as the owner's own Unix user.
// Griffin's tools act as Griffin's own identity: their refusals (and their «do not hunt other
// credentials» hints) are about that identity, not the owner's own access.
const HOST_NOTE = "This is the owner's own chat with their full Claude Code, running on this server as their own Unix user, the way their own terminal does: their ssh keys and ~/.ssh/config hosts, kubectl through them, gh, git with their own forge token, their skills and memory. Besides the tools listed above you have every Claude Code built-in (Bash, Read, Write, Edit, …). Use Bash for what they would do from their own terminal. The app's own tools run as the app's own identity: their refusals and their hints not to look for other credentials are about that identity, not about the owner. When one refuses, try the owner's own access in Bash before you report a missing permission. Never print secret values; irreversible changes still need the owner's yes.";
// options.ownerJob (jobs/owner-jobs.mjs): the same full Claude Code, in the owner's scheduled job —
// nobody is reading along, so the note must not tell the model this is his own chat.
const OWNER_JOB_NOTE = "This is the owner's scheduled job, running unattended with his full Claude Code: nobody is reading along, and it is not his chat. Besides the tools listed above you also have every Claude Code built-in (Bash, Read, Write, Edit, Glob, Grep, WebFetch, WebSearch, …), his skills and his own MCP servers. Bash is not approval-gated here: run only what the job's own instruction needs, and nothing irreversible that it does not plainly ask for. the app's own tools stay the way to reach clusters, vaults and people; their gated calls still wait for the owner's yes.";
const BUILTIN_TOOLS = ["Read", "Write", "Edit", "Glob", "Grep", "WebSearch", "WebFetch", "TodoWrite"];

// One more PreToolUse entry, for every tool (no matcher): the state guard and the instruction-file
// guard (state-guard.mjs), the first refusal wins.
function withStateGuard(hooks, ...guards) {
  const active = guards.filter(Boolean);
  if (!active.length) return hooks;
  const entry = {
    hooks: [
      async (input) => {
        for (const guard of active) {
          const why = guard(input?.tool_name, input?.tool_input || {}, input?.cwd || null);
          if (why) return denyOutput(why);
        }
        return {};
      },
    ],
  };
  return { ...hooks, PreToolUse: [...(hooks.PreToolUse || []), entry] };
}

// `claude setup-token` gives a subscription OAuth token (sk-ant-oat…); it goes in
// CLAUDE_CODE_OAUTH_TOKEN and as a Bearer header, never as x-api-key.
const isOAuth = (key) => String(key || "").startsWith("sk-ant-oat");
// Host install (no container): GRIFFIN_CLAUDE_LOGIN=claude-code makes the base Claude account use
// Claude Code's own login (the .credentials.json in CLAUDE_CONFIG_DIR, else ~/.claude) instead of a
// key Griffin stores. This marker stands in for the key so every "has a key" check passes; it is not
// a secret and is never sent anywhere: claudeAuthEnv leaves the login to Claude Code.
export const CLAUDE_CODE_LOGIN = "claude-code-login";
export const claudeCodeLoginKey = (env = process.env) => (genv("CLAUDE_LOGIN", "", env) === "claude-code" ? CLAUDE_CODE_LOGIN : "");
export function claudeAuthEnv(key) {
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.CLAUDE_CODE_OAUTH_TOKEN;
  if (key === CLAUDE_CODE_LOGIN) return env;
  // A full `claude auth login` of its own folder: Claude Code reads the login there, nothing in env.
  if (isLoginDirKey(key)) {
    env.CLAUDE_CONFIG_DIR = loginDirOf(key);
    return env;
  }
  env[isOAuth(key) ? "CLAUDE_CODE_OAUTH_TOKEN" : "ANTHROPIC_API_KEY"] = key;
  return env;
}
// GRIFFIN_CLAUDE_BIN: a host-installed Claude Code instead of the SDK's bundled one (empty = bundled).
export const claudeExecutableOption = (env = process.env) => {
  const bin = genv("CLAUDE_BIN", "", env);
  return bin ? { pathToClaudeCodeExecutable: bin } : {};
};

const WINDOW_LABELS = { five_hour: "۵ ساعته", seven_day: "هفتگی", seven_day_opus: "هفتگی Opus", seven_day_sonnet: "هفتگی Sonnet" };
export function planWindows(windows) {
  return Object.entries(windows || {})
    .filter(([key, w]) => WINDOW_LABELS[key] && w && w.utilization != null)
    .map(([key, w]) => ({ label: WINDOW_LABELS[key], percentage: Math.round(Number(w.utilization) * 100), resetAt: w.resetsAt ? w.resetsAt * 1000 : null }));
}

// The env of a run: the account's Anthropic login, or (endpoint account) the vendor's endpoint and key.
const runEnv = (apiKey, endpoint, modelId) => (endpoint ? endpointEnv(endpoint, apiKey, modelId) : claudeAuthEnv(apiKey));

// What a failed result says to the runner: plan_limit / engine_unavailable (plan-fallback.mjs), else
// a gone session. An endpoint account's spent plan (Z.ai 1308/1310) is a plan limit like Claude's,
// with the reset time Z.ai writes in the text.
function resultError(message, limit, endpoint) {
  if (endpoint && isEndpointPlanLimit(message)) return { message, code: "plan_limit", autoFallback: true, resetsAt: resetFromText(message) };
  const code = claudeLimitCode(message, limit);
  return code ? { message, code, autoFallback: autoMovesOn(message, limit), resetsAt: limit?.resetsAt ? limit.resetsAt * 1000 : null } : sessionGone(message);
}

// A login or key the endpoint refused, as Claude Code words it in a `result` (an
// expired OAuth login can come back as subtype "success" + is_error true + zero tokens).
const AUTH_RESULT = /failed to authenticate|oauth|\b401\b|invalid api key|not logged in/i;
export const NO_ANSWER = "پاسخی دریافت نشد";

// «Prompt is too long»: the session no longer fits the model's window. Claude Code compacts on its
// own only between the turns it runs; a resumed session that already overflows is refused at its
// first request and nothing compacts it (a chat at ~880k tokens died with it and only a
// hand-typed /compact recovered it). So the send itself compacts — before, when the last
// reading (getContextUsage) is near the window, and after, when the engine refuses the turn.
export const PROMPT_TOO_LONG = /prompt is too long/i;
export function contextPressure(usage, ratio) {
  const total = Number(usage?.totalTokens);
  const max = Number(usage?.rawMaxTokens || usage?.maxTokens);
  return ratio > 0 && total > 0 && max > 0 && total / max >= ratio;
}
// Updates that are bookkeeping, never something the turn showed the owner.
const NOT_OUTPUT = new Set(["turn-ended", "request-usage", "checkpoint", "fast-mode", "api-retry", "rate-limit"]);
export const isOutput = (update) => !NOT_OUTPUT.has(update?.type);

// How a turn's `result` ended (resultOutcome): null = an answer, else the runner's error.
// is_error wins over subtype. `produced`: the turn showed something (text, a tool call). A success
// with nothing at all — no text, no tool, no output token — is never a silent finished run.
export function resultFailure(msg, { produced = false, limit = null, endpoint = null } = {}) {
  if (msg.subtype === "success" && !msg.is_error) {
    const silent = !produced && !msg.local_command && !String(msg.result || "").trim() && msg.usage != null && !(Number(msg.usage.output_tokens) > 0);
    return silent ? { message: NO_ANSWER } : null;
  }
  const raw = msg.result || msg.errors?.join?.("; ") || msg.subtype || "claude run failed";
  const error = resultError(raw, limit, endpoint);
  if (error.code || !AUTH_RESULT.test(raw)) return error;
  const who = endpoint ? `کلید ${endpoint.label} پذیرفته نشد` : "ورود یا کلید Claude پذیرفته نشد";
  return { ...error, message: `${who}؛ در تنظیمات ← موتورها دوباره وارد شوید یا کلید تازه بگذارید (${maskText(String(raw)).slice(0, 2_000)})` };
}

// Why Griffin's own tools are not usable in this session, or null. `connected` alone is not enough:
// a server whose tools/list failed is connected with no tools.
export function mcpInitProblem(msg) {
  if (!Array.isArray(msg?.mcp_servers)) return "missing";
  const server = msg.mcp_servers.find((entry) => entry?.name === mcpName());
  if (!server) return "missing";
  if (server.status !== "connected") return String(server.status || "unknown");
  if (Array.isArray(msg.tools) && !msg.tools.some((name) => String(name).startsWith(`mcp__${mcpName()}__`))) return "connected, no tools";
  return null;
}

// The init message is a snapshot: on the host (ssh) Claude Code may say it before Griffin's
// in-process server has finished joining, and a kept process says it again for later turns. A
// problem in it is only final once Claude Code's own live status agrees (chats stopped with «MCP: missing» while a retry a few
// seconds later had every tool).
export async function confirmMcpProblem(q, problem, { waitMs = 8_000, stepMs = 500 } = {}) {
  if (!problem || typeof q?.mcpServerStatus !== "function") return problem;
  const until = Date.now() + waitMs;
  let last = problem;
  for (;;) {
    try {
      const servers = await Promise.race([q.mcpServerStatus(), new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), stepMs * 4).unref?.())]);
      const server = Array.isArray(servers) ? servers.find((entry) => entry?.name === mcpName()) : null;
      if (server?.status === "connected") return null;
      last = server ? String(server.status || "unknown") : "missing";
      if (server && server.status !== "pending") return last;
    } catch {
      /* keep the init's verdict unless the live status answers */
    }
    if (Date.now() >= until) return last;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
}

const mcpNames = (msg) => (Array.isArray(msg?.mcp_servers) ? msg.mcp_servers.map((s) => `${s?.name}:${s?.status}`).join(",") : "none");

// What a probe turn says about the account: out of credit, at a plan limit (with its reset), or
// usable. A window at 100٪ is a limit even when the tiny turn itself still got through.
export function probeOutcome({ failure = null, closed = null, windows = null, now = Date.now() }) {
  const detail = failure ? maskText(failure).slice(0, 300) : undefined;
  if (failure && isCreditError(failure)) return { ok: false, state: "credit", detail };
  const full = Object.values(windows || {}).filter((w) => w && Number(w.utilization) >= 1 && Number(w.resetsAt) * 1000 > now);
  const until = closed?.resetsAt ? closed.resetsAt * 1000 : full.length ? Math.min(...full.map((w) => w.resetsAt * 1000)) : null;
  if (closed || (failure && isClaudePlanLimit(failure)) || full.length) return { ok: false, state: "limited", until: until || resetFromText(failure) || null, detail };
  if (failure) return { ok: false, detail };
  return { ok: true };
}

// queryImpl: the SDK's query (a test passes a fake Claude Code process). endpoint
// (claude-endpoint.mjs): run Claude Code against another vendor's Anthropic-compatible endpoint
// with apiKey as that vendor's key; null = Claude itself.
// statusImpl(env): `claude auth status --json` output (a test passes a fake).
const cliStatus = (env, timeoutMs = 15_000) =>
  new Promise((resolve) => {
    const bin = claudeBinary();
    if (!bin) return resolve(null);
    execFile(bin, ["auth", "status", "--json"], { env, timeout: timeoutMs, maxBuffer: 65_536 }, (error, stdout) => resolve(error ? null : stdout));
  });

export function createClaudeProvider({ apiKey, defaultModel = "sonnet", queryImpl = query, endpoint = null, fetchImpl = fetch, statusImpl = cliStatus } = {}) {
  // Last plan windows this account's runs saw (one subscription per account).
  const lastLimits = { windows: null, at: null };
  const zai = Boolean(endpoint && /\bz\.ai\b/.test(endpoint.baseUrl));
  // Claude Code's model list and the login's identity change rarely: asked once an hour / ten minutes.
  const live = { models: null, modelsAt: 0, modelsAsk: null, account: undefined, accountAt: 0 };
  const signedIn = () => Boolean(apiKey) && (isOAuth(apiKey) || apiKey === CLAUDE_CODE_LOGIN || isLoginDirKey(apiKey));
  // A throwaway Claude Code process that is never sent a prompt (like planUsage): no model call.
  async function cliModels(timeoutMs) {
    const abort = new AbortController();
    try {
      const q = queryImpl({
        prompt: (async function* () {
          await new Promise((resolve) => abort.signal.addEventListener("abort", resolve));
        })(),
        options: { abortController: abort, env: claudeAuthEnv(apiKey), tools: [], settingSources: [], strictMcpConfig: true, persistSession: false, ...claudeExecutableOption() },
      });
      if (typeof q?.supportedModels !== "function") return null;
      return await Promise.race([q.supportedModels(), new Promise((resolve) => setTimeout(() => resolve(null), timeoutMs).unref?.())]);
    } catch {
      return null;
    } finally {
      abort.abort();
    }
  }
  return {
    id: PROVIDER_CLAUDE,
    defaultModel: endpoint ? endpointModel(endpoint, defaultModel) : defaultModel,
    endpoint,
    async listModels({ waitMs = 6_000 } = {}) {
      if (endpoint) return endpoint.models.map(({ id, name }) => ({ id, name, provider: PROVIDER_CLAUDE }));
      const base = claudeModelList();
      const withProvider = (list) => list.map((m) => ({ ...m, provider: PROVIDER_CLAUDE }));
      // A subscription login's menu depends on its plan; an API key keeps the built-in aliases.
      if (!signedIn()) return withProvider(base);
      if (!live.models || Date.now() - live.modelsAt > 60 * 60_000) {
        // One ask at a time; a slow CLI does not hold the menu: it shows the aliases and the next open has the rest.
        live.modelsAsk ??= cliModels(20_000).then((list) => {
          if (Array.isArray(list) && list.length) {
            live.models = list;
            live.modelsAt = Date.now();
          }
          live.modelsAsk = null;
        });
        await Promise.race([live.modelsAsk, new Promise((resolve) => setTimeout(resolve, waitMs).unref?.())]);
      }
      return withProvider(live.models ? withCliModels(base, live.models) : base);
    },
    // Who this account is signed in as ({ email, name, plan, method }), or null (an API key, an
    // endpoint, nothing signed in, or the CLI not answering).
    async account() {
      if (endpoint || !signedIn()) return null;
      if (live.account !== undefined && Date.now() - live.accountAt < 10 * 60_000) return live.account;
      const found = accountFromStatus(await statusImpl(claudeAuthEnv(apiKey)));
      live.account = found;
      live.accountAt = Date.now();
      return found;
    },
    async health() {
      if (!apiKey) return { ok: false, error: endpoint ? `no ${endpoint.label} key` : "no anthropic api key" };
      if (endpoint) {
        // Z.ai: its quota page answers with the key (401 = refused). Another endpoint: the first run tells.
        if (!zai) return { ok: true, status: 0, ms: 0 };
        const started = Date.now();
        try {
          const q = await zaiQuota(endpoint.baseUrl, apiKey, fetchImpl);
          return { ok: q.ok, status: q.status, ...(q.ok ? {} : { error: `http_${q.status}` }), ms: Date.now() - started };
        } catch (error) {
          return { ok: false, error: error?.name === "TimeoutError" ? "timeout" : String(error?.cause?.code || error?.message), ms: Date.now() - started };
        }
      }
      // Claude Code's own login: nothing for Griffin to ping with; the first run shows whether it works.
      if (apiKey === CLAUDE_CODE_LOGIN) return { ok: true, status: 0, ms: 0, login: "claude-code" };
      // A folder login: nothing to ping with; `claude auth status` says whether the login still stands
      // (a missing or refused login answers 401 like a rejected token, so nothing routes to it).
      if (isLoginDirKey(apiKey)) {
        const asked = Date.now();
        const found = accountFromStatus(await statusImpl(claudeAuthEnv(apiKey)));
        return found ? { ok: true, status: 200, ms: Date.now() - asked, login: "claude-login" } : { ok: false, status: 401, error: "ورود این حساب معتبر نیست", ms: Date.now() - asked };
      }
      const started = Date.now();
      try {
        const response = await fetch("https://api.anthropic.com/v1/models", {
          method: "GET",
          headers: {
            ...(isOAuth(apiKey)
              ? { authorization: `Bearer ${apiKey}`, "anthropic-beta": "oauth-2025-04-20" }
              : { "x-api-key": apiKey }),
            "anthropic-version": "2023-06-01",
          },
          signal: AbortSignal.timeout(8_000),
        });
        // 401 is a rejected key (a valid setup-token answers 200 here); 429 is a
        // working key that is busy.
        return {
          ok: response.ok || response.status === 429,
          status: response.status,
          ...(response.status === 401 ? { error: "کلید رد شد (401)" } : {}),
          ms: Date.now() - started,
        };
      } catch (error) {
        return {
          ok: false,
          error: error?.name === "TimeoutError" ? "timeout" : String(error?.cause?.code || error?.message),
          ms: Date.now() - started,
        };
      }
    },
    // A real, tiny turn (Haiku, no tools) the way every run goes: the only way to see a spent plan or
    // a spent credit — /v1/models answers 200 either way (every engine said «ready»
    // while its limit was hit). -> { ok, state?: "limited"|"credit", until?, detail? }
    async probe({ timeoutMs = 45_000 } = {}) {
      if (endpoint || !apiKey) return null;
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), timeoutMs);
      timer.unref?.();
      let closed = null;
      let failure = null;
      try {
        for await (const msg of queryImpl({
          prompt: "Reply with: ok",
          options: { abortController: abort, model: resolveModel("haiku"), maxTurns: 1, tools: [], allowedTools: [], settingSources: [], strictMcpConfig: true, persistSession: false, systemPrompt: "Reply with: ok", env: claudeAuthEnv(apiKey), ...claudeExecutableOption() },
        })) {
          const info = msg?.type === "rate_limit_event" ? msg.rate_limit_info : null;
          if (info?.unifiedWindows) Object.assign(lastLimits, { windows: info.unifiedWindows, at: new Date().toISOString() });
          if (limitClosed(info)) closed = info;
          if (msg?.type === "result" && (msg.subtype !== "success" || msg.is_error)) failure = String(msg.result || msg.errors?.join?.("; ") || msg.subtype || "failed");
        }
      } catch (error) {
        failure = abort.signal.aborted ? "timeout" : String(error?.message || error);
      } finally {
        clearTimeout(timer);
      }
      return probeOutcome({ failure, closed, windows: lastLimits.windows });
    },
    // Pro plan windows. A setup-token has no profile scope, so /usage returns no rate_limits;
    // every run's rate_limit_event carries them instead (unifiedWindows, utilization 0-1).
    async usage() {
      if (endpoint) {
        if (!apiKey || !zai) return null;
        try {
          const q = await zaiQuota(endpoint.baseUrl, apiKey, fetchImpl);
          return q.ok ? { provider: PROVIDER_CLAUDE, windows: q.windows } : { error: `http ${q.status}` };
        } catch (error) {
          return { error: error?.name === "TimeoutError" ? "timeout" : String(error?.message || error) };
        }
      }
      // A Claude Code login (host install) is a subscription too: its runs carry the same windows.
      if (!apiKey || !(isOAuth(apiKey) || apiKey === CLAUDE_CODE_LOGIN || isLoginDirKey(apiKey))) return null;
      return { provider: PROVIDER_CLAUDE, windows: planWindows(lastLimits.windows), seenAt: lastLimits.at };
    },
    // Exact plan limits (the data behind `/usage`, plan-usage.mjs), asked of a throwaway Claude Code
    // process that is never sent a prompt: no model call, no tokens.
    // A login without the profile scope (setup-token) answers no rate_limits: the windows this
    // account's last run reported stand in. Endpoint accounts have no Claude plan.
    async planUsage({ timeoutMs = 20_000 } = {}) {
      if (endpoint || !apiKey) return null;
      const fallback = () => fromRunWindows(lastLimits.windows);
      const abort = new AbortController();
      let q = null;
      try {
        q = queryImpl({
          prompt: (async function* () {
            await new Promise((resolve) => abort.signal.addEventListener("abort", resolve));
          })(),
          options: { abortController: abort, env: claudeAuthEnv(apiKey), tools: [], settingSources: [], strictMcpConfig: true, persistSession: false, ...claudeExecutableOption() },
        });
        if (typeof q?.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET !== "function") return fallback();
        const raw = await Promise.race([
          q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true }),
          new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), timeoutMs).unref?.()),
        ]);
        return raw?.rate_limits && raw.rate_limits_available !== false ? raw : fallback() || raw;
      } catch (error) {
        const seen = fallback();
        if (seen) return seen;
        throw error;
      } finally {
        abort.abort();
      }
    },
    create(options) {
      return makeAgent(null, options, { apiKey, defaultModel, lastLimits, queryImpl, endpoint });
    },
    resume(sessionId, options) {
      return makeAgent(sessionId, options, { apiKey, defaultModel, lastLimits, queryImpl, endpoint });
    },
    // A copy of a conversation up to one entry (SDK forkSession), written next to the source in
    // Claude Code's projects folder, so the fork must run in the same folder. Returns the new id.
    async forkSession(sessionId, { upToMessageId = null } = {}) {
      const result = await sdkForkSession(sessionId, upToMessageId ? { upToMessageId } : {});
      if (!result?.sessionId) throw new Error("fork returned no session");
      return result.sessionId;
    },
    // Files back to their state before the owner message with this id (Query.rewindFiles; only what
    // the file-editing tools changed). A short process resumes the session in its folder, rewinds and
    // exits; nothing is sent. Once more after 3 s when the last turn's process still holds the session.
    // dryRun: only what would change ({ canRewind, filesChanged, insertions, deletions }).
    async rewindFiles(sessionId, userMessageId, { cwd, dryRun = false, timeoutMs = 30_000 } = {}) {
      for (let tries = 0; ; tries += 1) {
        const abort = new AbortController();
        const q = queryImpl({
          prompt: (async function* () {
            await new Promise((resolve) => abort.signal.addEventListener("abort", resolve));
          })(),
          options: { abortController: abort, cwd, resume: sessionId, enableFileCheckpointing: true, settingSources: [], env: runEnv(apiKey, endpoint, endpoint ? endpointModel(endpoint, defaultModel) : null), ...claudeExecutableOption() },
        });
        try {
          // A real rewind leaves filesChanged empty (a created file was removed, count
          // 0); the dry run in the same process names the files.
          const rewind = async () => {
            const preview = await q.rewindFiles(userMessageId, { dryRun: true });
            if (!preview?.canRewind || dryRun) return preview;
            const done = await q.rewindFiles(userMessageId);
            return done?.canRewind && !done.filesChanged?.length ? { ...done, filesChanged: preview.filesChanged || [] } : done;
          };
          return await Promise.race([
            rewind(),
            new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), timeoutMs).unref?.()),
          ]);
        } catch (error) {
          if (tries || !/already in use/i.test(String(error?.message || error))) throw error;
          await new Promise((resolve) => setTimeout(resolve, 3_000));
        } finally {
          abort.abort();
        }
      }
    },
  };
}

// Plan approval (config PLAN_APPROVAL): in plan mode Claude Code's
// ExitPlanMode is the owner's call, like the desktop app's "approve plan" dialog. It goes to the
// ask_owner card (and Telegram) and only an explicit approval lets it through. ask(args) is
// asks.plan(chatId, …) and resolves with { answered, answer, selected }.
export const PLAN_APPROVE = "Approve plan";
export const PLAN_KEEP = "Keep planning";
// Claude Code writes the plan to a file (settings.plansDirectory) and puts its text into
// ExitPlanMode's input (plan, planFilePath). The folder is inside the chat's own folder, the only
// place the file guard lets it write. An approved plan's file is removed so it never lands in a
// commit of the chat's worktree; a plan still being worked on stays.
export const PLANS_DIR = ".griffin-plans";
function removePlanFile(input, cwd) {
  if (!cwd || typeof input?.planFilePath !== "string") return;
  const dir = path.resolve(cwd, PLANS_DIR);
  const file = path.resolve(cwd, input.planFilePath);
  if (path.dirname(file) !== dir || !file.endsWith(".md")) return;
  try {
    fs.rmSync(file, { force: true });
    if (!fs.readdirSync(dir).length) fs.rmdirSync(dir);
  } catch {
    /* best effort */
  }
}

export async function planDecision(input, ask, { emit = async () => {}, toolUseID = null, cwd = null } = {}) {
  const plan = typeof input?.plan === "string" ? input.plan : ""; // never cut: the owner approves the whole plan
  // Never a blind approval: with no plan to show, the owner is not asked.
  if (!plan.trim()) return { behavior: "deny", message: "There is no plan to approve: write the plan to the plan file first, then call ExitPlanMode again." };
  const args = {
    question: `Approve this plan?\n\n${plan}`,
    options: [
      { label: PLAN_APPROVE, description: "leave plan mode and carry it out" },
      { label: PLAN_KEEP, description: "stay in plan mode and refine it" },
    ],
    multiSelect: false,
  };
  // `<native callId>:ask:plan` — the web hides the raw ExitPlanMode twin behind this card (Work.jsx).
  const callId = `${toolUseID || randomUUID()}:ask:plan`;
  await emit({ type: "tool-call-started", callId, toolCall: mcpToolCall(ASK_TOOL, args) });
  let answer = { answered: false, reason: "no answer" };
  try {
    answer = (await ask(args)) || answer;
  } catch {
    // no answer: the plan stays unapproved
  }
  await emit({ type: "tool-call-completed", callId, toolCall: { ...mcpToolCall(ASK_TOOL, args), result: answer } });
  const approved = Boolean(answer?.answered) && (answer.selected?.includes(PLAN_APPROVE) || answer.answer === PLAN_APPROVE || isPlanApprovalText(answer.answer));
  // Approved: straight to agent mode (bypassPermissions), the mode an agent-mode chat runs in, so
  // nothing is allowed afterwards that an agent-mode turn would not allow.
  if (approved) removePlanFile(input, cwd);
  if (approved) return { behavior: "allow", updatedInput: input, updatedPermissions: [{ type: "setMode", mode: "bypassPermissions", destination: "session" }] };
  const note = answer?.answered && answer.answer && answer.answer !== PLAN_KEEP ? ` Owner's note: ${answer.answer}` : "";
  return { behavior: "deny", message: `The owner did not approve the plan; keep planning.${note}` };
}

function makeAgent(sessionId, options, { apiKey, defaultModel, lastLimits = {}, queryImpl = query, endpoint = null }) {
  // Stable id from the start so runner can persist agent_id before the first stream frame.
  let currentSessionId = sessionId || randomUUID();
  let started = Boolean(sessionId);
  // A fresh session for a chat that already talked (its session was lost: busy/gone, rewind, an
  // engine move) gets the conversation so far with its first message. Without it Claude started
  // blank and told the owner «no work reached me» mid-task.
  let seed = sessionId ? "" : seedText(options.seedMessages);
  // The Claude Code process of the previous send. The runner calls the turn done at its «result», but
  // the process lives on (the next-message suggestion comes after it); a queued turn started then got
  // «Session ID … is already in use» (each within a second of the turn before).
  let last = null; // { closed: Promise, done, abort, resultAt }
  // The session's context window as Claude Code itself counts it (getContextUsage, the data behind
  // `/context`), read at each turn's result while the process is still up — never a process of its own.
  let lastContext = null;
  // Config PLAN_APPROVAL (options.planApproval: { ask, onApproved }, index.mjs; absent = no permission
  // handler at all, as before). The mode of the turn in flight and where its timeline goes, read by
  // the handler: an approval moves this session to agent mode at once.
  let liveMode = "agent";
  let emitNow = async () => {};
  const planGate = options.planApproval
    ? async (toolName, toolInput, ctx = {}) => {
        if (liveMode === "plan") {
          if (toolName === "ExitPlanMode") {
            const decision = await planDecision(toolInput, options.planApproval.ask, { emit: emitNow, toolUseID: ctx.toolUseID || null, cwd: options.cwd || null });
            if (decision.behavior === "allow") {
              liveMode = "agent";
              // The kept process is in agent mode now: the next send must not switch it again.
              if (proc?.settings) proc.settings = { ...proc.settings, mode: "agent" };
              try {
                await options.planApproval.onApproved?.();
              } catch {
                /* the chat record is best effort; the session already left plan mode */
              }
            }
            return decision;
          }
          // Asking the owner is not a change: Griffin's own question card stays open while planning.
          if (toolName === `mcp__${mcpName()}__${ASK_TOOL}`) return { behavior: "allow", updatedInput: toolInput };
          return { behavior: "deny", message: "Plan mode: make no changes. Present the plan with ExitPlanMode for the owner to approve." };
        }
        // Every other mode keeps main's yes/no card for what still asks (in agent mode: a safety check,
        // an ask rule, a hook's ask); main gives the owner's chats askOwnerTool always.
        if (options.approve) return askOwnerTool(options.approve)(toolName, toolInput, ctx);
        // No owner to ask (a chain nobody started from the web): refused.
        return { behavior: "deny", message: "This needs the owner's own approval and cannot run from here." };
      }
    : null;

  // ---- Config CLAUDE_BACKGROUND_TASKS (options.backgroundTasks; off = everything below is unused) ----
  // The kept Claude Code process: { q, input, abort, me, closeMe, tasks, route, waiting, cliTurn, … }.
  // A one-shot run's process ends at its result and takes its background shells with it; this one is
  // fed by a held-open streaming input, so it stays while a background task runs, and the next send
  // is pushed into it instead of starting another process on the same session.
  let proc = null;
  let backgroundListener = null;
  const IDLE_CLOSE_MS = options.idleCloseMs ?? 3_000; // tasks done, nothing running: close the input
  const CLI_TURN_QUIET_MS = options.cliTurnQuietMs ?? 15_000; // a turn of Claude's own that went silent
  const tellBackground = (event) => bestEffort(() => backgroundListener?.(event));
  const taskList = (p) => [...(p?.tasks.values() || [])].map((task) => ({ ...task }));
  const tasksChanged = (p) => tellBackground({ type: "tasks", tasks: taskList(p) });

  function trackTask(p, msg) {
    if (msg?.type !== "system") return null;
    const ambient = Boolean(msg.ambient || msg.skip_transcript);
    const lateBackground = msg.subtype === "task_updated" && msg.patch?.is_backgrounded === true && !p.tasks.has(String(msg.task_id));
    if (((msg.subtype === "task_started" && msg.is_backgrounded !== false) || lateBackground) && msg.task_id && !ambient) {
      p.tasks.set(String(msg.task_id), { id: String(msg.task_id), description: String(msg.description || msg.patch?.description || "").slice(0, 300), type: msg.task_type || null, toolUseId: msg.tool_use_id ? String(msg.tool_use_id) : null, subagentType: msg.subagent_type ? String(msg.subagent_type) : null, startedAt: Date.now() });
      tasksChanged(p);
      return null;
    }
    const ended = msg.subtype === "task_notification" || (msg.subtype === "task_updated" && ["completed", "failed", "stopped", "killed"].includes(msg.patch?.status));
    if (!ended || !p.tasks.has(String(msg.task_id))) return null;
    const task = p.tasks.get(String(msg.task_id));
    p.tasks.delete(task.id);
    tasksChanged(p);
    return { task, status: msg.status || msg.patch?.status || "completed", summary: String(msg.summary || "").slice(0, 2_000), outputFile: typeof msg.output_file === "string" && msg.output_file ? msg.output_file : null };
  }

  function scheduleClose(p) {
    clearTimeout(p.idleTimer);
    if (p.closing || p.route || p.waiting.length || p.tasks.size) return;
    p.idleTimer = setTimeout(() => {
      if (p.route || p.waiting.length || p.tasks.size) return;
      if (p.cliTurn && Date.now() - p.lastMessageAt < CLI_TURN_QUIET_MS) return scheduleClose(p);
      p.closing = true;
      p.input.close();
      // A CLI that does not exit once its input ends is stopped.
      setTimeout(() => p.me.done || p.abort.abort(), 10_000).unref?.();
    }, IDLE_CLOSE_MS);
    p.idleTimer.unref?.();
  }

  // The next waiting turn goes into the process once nothing else is running in it.
  function startNext(p) {
    if (p.route || !p.waiting.length) return;
    // A turn of Claude's own is running: the message waits for its result — or for it to go quiet.
    if (p.cliTurn && Date.now() - p.lastMessageAt < CLI_TURN_QUIET_MS) {
      clearTimeout(p.nextTimer);
      p.nextTimer = setTimeout(() => startNext(p), CLI_TURN_QUIET_MS);
      p.nextTimer.unref?.();
      return;
    }
    p.cliTurn = false;
    const route = p.waiting.shift();
    p.route = route;
    route.started = true;
    // Another model or mode for this message: switched just before it goes in, never mid-turn.
    const want = route.want;
    // A switch that never answers must not wedge the process: 5 s each, like interrupt().
    const timed = (fn) => Promise.race([Promise.resolve().then(fn), new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 5_000).unref?.())]);
    const switches = [];
    if (want && want.modelId !== p.settings.modelId && typeof p.q?.setModel === "function") switches.push(timed(() => p.q.setModel(want.modelId)).then(() => (p.settings = { ...p.settings, modelId: want.modelId })));
    if (want && want.mode !== p.settings.mode && typeof p.q?.setPermissionMode === "function") switches.push(timed(() => p.q.setPermissionMode(PERMISSION_MODES[want.mode] || "bypassPermissions")).then(() => (p.settings = { ...p.settings, mode: want.mode })));
    if (!switches.length) {
      route.pushed = true;
      return p.input.push(route.userMessage);
    }
    route.switching = true;
    Promise.allSettled(switches).then(() => {
      route.switching = false;
      // Stopped while it was being switched: it never goes in.
      if (route.cancelled || p.closing) {
        if (p.route === route) p.route = null;
        route.finish({ status: "cancelled", error: null });
        startNext(p);
        scheduleClose(p);
        return;
      }
      // A mode that could not be switched: the message is not run on the wrong permissions.
      if (want.mode !== p.settings.mode) {
        if (p.route === route) p.route = null;
        route.finish({ status: "error", error: { message: "حالت گفتگو (طرح/اجرا) در Claude Code باز عوض نشد؛ دوباره بفرستید" } });
        startNext(p);
        scheduleClose(p);
        return;
      }
      route.pushed = true;
      p.input.push(route.userMessage);
    });
  }

  async function pump(p, sendOptionsOfFirst) {
    let commandsAsked = false;
    let gotAny = false;
    try {
      for await (const msg of p.q) {
        gotAny = true;
        started = true;
        p.lastMessageAt = Date.now();
        if (msg?.session_id) currentSessionId = msg.session_id;
        const ended = trackTask(p, msg);
        const route = p.route;
        if (msg?.type === "prompt_suggestion") {
          // Only for the owner's own last turn, never after a turn of Claude's own.
          if (p.lastResultOwn) bestEffort(() => p.lastSendOptions?.onSuggestion?.(String(msg.suggestion ?? "")));
          continue;
        }
        // A task that ended is said in the chat, during a turn or between turns.
        if (ended) tellBackground({ type: "ended", ...ended });
        // Claude Code usually answers a finished task in a turn of its own; the owner's next message
        // waits for that turn's result, or for it to go quiet (startNext).
        if (ended && !route) p.cliTurn = true;
        if (sendOptionsOfFirst.onCommands && !commandsAsked && typeof p.q.supportedCommands === "function") {
          commandsAsked = true;
          Promise.resolve().then(() => p.q.supportedCommands()).then(sendOptionsOfFirst.onCommands).catch(() => {});
        }
        if (msg?.type === "system" && msg.subtype === "commands_changed") {
          bestEffort(() => sendOptionsOfFirst.onCommands?.(msg.commands));
          continue;
        }
        const info = msg?.type === "rate_limit_event" ? msg.rate_limit_info : null;
        if (info?.unifiedWindows) Object.assign(lastLimits, { windows: info.unifiedWindows, at: new Date().toISOString() });
        // A result names the user message(s) it answers; one that does not name this route's is
        // Claude's own turn (it answers a task notification), not the owner's.
        const answers = msg?.type === "result" ? [msg.user_message_uuid, ...(Array.isArray(msg.user_message_uuids) ? msg.user_message_uuids : [])].filter(Boolean) : [];
        const foreign = route && answers.length && !answers.some((id) => id === route.uuid || route.steered.includes(id));
        if (!route || foreign) {
          // Between the owner's turns Claude may answer a finished task in a turn of its own: its
          // text stays in the session, so the owner's next turn sees it.
          if (msg?.type === "result") {
            p.cliTurn = false;
            p.lastResultOwn = false;
            startNext(p);
          } else if (!route && (msg?.type === "assistant" || msg?.type === "stream_event")) p.cliTurn = true;
          scheduleClose(p);
          continue;
        }
        if (limitClosed(info)) route.setLimit(info);
        // Only the process's first init: later turns of a kept process say it again (and a background
        // agent may say its own); the server was confirmed when the process started.
        const firstInit = msg?.type === "system" && msg.subtype === "init" && p.mcp && !p.initSeen;
        if (msg?.type === "system" && msg.subtype === "init") p.initSeen = true;
        const mcpProblem = firstInit ? await confirmMcpProblem(p.q, mcpInitProblem(msg)) : null;
        if (firstInit && mcpProblem) console.error(`[claude] init mcp_servers=${mcpNames(msg)}`);
        if (mcpProblem) {
          const why = `ابزارهای ایجنت به Claude نرسید (MCP: ${mcpProblem})`;
          console.error(`[claude] ${why}`);
          route.finish({ status: "error", error: { message: why } });
          p.abort.abort();
          break;
        }
        for (const update of route.bridge.consume(msg)) {
          if (isOutput(update)) route.produced = true;
          await route.onDelta?.({ update });
        }
        // A message steered into this turn (config CLAUDE_STEER) that Claude Code answers in a turn of
        // its own right after: the owner's turn stays open until that answer.
        if (msg?.type === "result" && answers.length) route.steered = route.steered.filter((id) => !answers.includes(id));
        // Only a successful answer waits for the rest: Stop, an error or a limit ends the turn now.
        if (msg?.type === "result" && answers.length && route.steered.length && !route.cancelled && msg.subtype === "success" && !msg.is_error) continue;
        if (msg?.type === "result") {
          if (typeof p.q.getContextUsage === "function") {
            Promise.resolve()
              .then(() => p.q.getContextUsage({ detail: "summary" }))
              .then((usage) => usage && (lastContext = usage))
              .catch(() => {});
          }
          const failure = resultFailure(msg, { produced: Boolean(route.produced), limit: route.getLimit(), endpoint });
          route.finish({
            status: route.cancelled ? "cancelled" : failure ? "error" : "finished",
            error: route.cancelled ? null : failure,
          });
          p.lastSendOptions = route.sendOptions;
          p.me.resultAt = Date.now();
          p.lastResultOwn = true;
          p.route = null;
          startNext(p);
          scheduleClose(p);
        }
      }
      if (!gotAny && p.route) throw new Error("Claude Code exited before answering");
    } catch (error) {
      const route = p.route;
      route?.finish({ status: p.abort.signal.aborted ? "cancelled" : "error", error: p.abort.signal.aborted ? null : sessionGone(String(error?.message || error)) });
    } finally {
      clearTimeout(p.idleTimer);
      clearTimeout(p.nextTimer);
      p.closing = true;
      p.route?.finish({ status: p.abort.signal.aborted ? "cancelled" : "finished" });
      for (const route of p.waiting) route.finish({ status: "error", error: { message: "Claude Code بسته شد پیش از این پیام" } });
      p.waiting = [];
      if (p.tasks.size) {
        tellBackground({ type: "lost", tasks: taskList(p) });
        p.tasks.clear();
        tasksChanged(p);
      }
      if (proc === p) proc = null;
      started = true;
      p.me.done = true;
      p.closeMe();
    }
  }

  function sendKept({ message, sendOptions, run, finish, abort, mcp, queryOptions, checkpoint, me, closeMe, prev, bridge, getLimit, setLimit, isSettled, settings }) {
    // Every pushed message carries its own id, so its result is told apart from Claude's own turns.
    const uuid = checkpoint || randomUUID();
    const route = { uuid, steered: [], sendOptions, onDelta: sendOptions.onDelta, bridge, finish, getLimit, setLimit, cancelled: false, started: false };
    let p0 = proc && !proc.closing && !proc.me.done ? proc : null;
    // Another model, effort, mode or fast setting: with no task running, a fresh process takes it;
    // with tasks running, the kept one is switched where Claude Code allows it (model, mode).
    // Effort and fast cannot be switched in a running process: they stay until it is replaced.
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    if (p0 && !same(p0.settings, settings)) {
      if (!p0.tasks.size && !p0.route && !p0.waiting.length) {
        p0.closing = true;
        clearTimeout(p0.idleTimer);
        p0.input.close();
        prev = p0.me;
        p0 = null;
      }
    }
    // A kept process may have been switched by a message queued before this one: every message
    // carries the settings it wants, compared only when it goes in (startNext).
    route.want = settings;
    run.cancel = async () => {
      if (isSettled()) return; // its turn is over: nothing of it to stop (never the kept process)
      route.cancelled = true;
      const p = proc;
      if (p?.waiting.includes(route)) {
        p.waiting = p.waiting.filter((r) => r !== route);
        finish({ status: "cancelled", error: null });
        scheduleClose(p);
        return;
      }
      if (!p || p.route !== route) return finish({ status: "cancelled", error: null });
      if (route.switching) return; // never pushed: startNext finishes it as cancelled
      // Stop ends the turn, not the background tasks: interrupt() when the CLI offers it; the hard
      // stop only when it is missing or does not answer. A message steered into this turn (config
      // CLAUDE_STEER) waits in Claude Code's own queue, where a plain interrupt keeps it and runs it as
      // a turn the owner never sees: cancelQueued drops it too. The owner's queued messages wait in
      // Griffin, not there.
      if (p.q && typeof p.q.interrupt === "function") {
        try {
          await Promise.race([route.steered.length ? p.q.interrupt({ cancelQueued: true }) : p.q.interrupt(), new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 5_000).unref?.())]);
          return;
        } catch {
          /* fall through to the hard stop */
        }
      }
      p.abort.abort();
    };
    // Config CLAUDE_STEER (options.steer): a message the owner sends while this turn runs goes into
    // the same streaming input — Claude Code reads it on its next request inside the turn — instead
    // of waiting for the turn to end. Anything not plainly running falls back to the queue.
    if (options.steer) {
      run.steer = async (steerMessage) => {
        const p = proc;
        // Only once this turn's own message is in: a steer must never go in ahead of it.
        if (isSettled() || route.cancelled || route.switching || !route.pushed || !p?.q || p.route !== route || p.closing || p.me.done) return "revert_to_followup";
        const id = randomUUID();
        route.steered.push(id);
        p.input.push(userMessageOf(steerMessage, () => currentSessionId, id));
        return "complete_delivered";
      };
    }
    if (p0) {
      // The kept process takes this turn; this send's own process bookkeeping is not used.
      me.done = true;
      closeMe();
      if (last === me) last = p0.me;
      route.userMessage = userMessageOf(message, () => currentSessionId, uuid);
      p0.waiting.push(route);
      clearTimeout(p0.idleTimer);
      startNext(p0);
      return run;
    }
    const input = pushIterable();
    const p = { q: null, input, abort, me, closeMe, mcp, settings, lastResultOwn: false, tasks: new Map(), route, waiting: [], cliTurn: false, closing: false, idleTimer: null, nextTimer: null, lastMessageAt: Date.now(), lastSendOptions: null };
    route.started = true;
    proc = p;
    (async () => {
      try {
        if (!apiKey) throw new Error("Anthropic API key missing");
        if (prev && !prev.done) {
          const within = (ms) => Promise.race([prev.closed, new Promise((resolve) => setTimeout(resolve, ms))]);
          await within(prev.resultAt || prev.abort.signal.aborted ? 10_000 : 2_000);
          if (!prev.done) prev.abort.abort();
          await within(5_000);
        }
        input.push(userMessageOf(message, () => currentSessionId, uuid));
        route.pushed = true;
        p.q = queryImpl({ prompt: input.iterable, options: queryOptions(started) });
      } catch (error) {
        finish({ status: "error", error: { message: String(error?.message || error) } });
        proc = proc === p ? null : proc;
        me.done = true;
        closeMe();
        return;
      }
      await pump(p, sendOptions);
    })();
    return run;
  }

  const agent = {
    get agentId() {
      return currentSessionId;
    },
    contextUsage() {
      return lastContext;
    },
    // Config CLAUDE_BACKGROUND_TASKS: the background tasks of the kept process, a stop for each, a
    // listener for their changes (runner), and close() (archive, delete, shutdown).
    backgroundTasks() {
      return taskList(proc);
    },
    async stopTask(taskId, { timeoutMs = 10_000 } = {}) {
      const p = proc;
      if (!p?.q || typeof p.q.stopTask !== "function" || !p.tasks.has(String(taskId))) return false;
      await Promise.race([p.q.stopTask(String(taskId)), new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), timeoutMs).unref?.())]);
      return true;
    },
    // The open process's MCP servers (null without one) and their reconnect / on-off.
    hasOpenProcess() {
      return Boolean(proc?.q && !proc.closing);
    },
    async mcpStatus({ timeoutMs = 10_000 } = {}) {
      const p = proc;
      if (!p?.q || p.closing || typeof p.q.mcpServerStatus !== "function") return null;
      return Promise.race([p.q.mcpServerStatus(), new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), timeoutMs).unref?.())]);
    },
    async mcpControl(action, name, enabled, { timeoutMs = 30_000 } = {}) {
      const p = proc;
      if (!p?.q || p.closing) return false;
      const call = action === "reconnect" && typeof p.q.reconnectMcpServer === "function" ? p.q.reconnectMcpServer(String(name)) : action === "toggle" && typeof p.q.toggleMcpServer === "function" ? p.q.toggleMcpServer(String(name), Boolean(enabled)) : null;
      if (!call) return false;
      await Promise.race([call, new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), timeoutMs).unref?.())]);
      return true;
    },
    setBackgroundListener(fn) {
      backgroundListener = typeof fn === "function" ? fn : null;
    },
    close() {
      const p = proc;
      if (!p) return;
      p.closing = true;
      p.abort.abort();
    },
    // One turn, with the context kept in reach: see PROMPT_TOO_LONG. A «/…» command is sent as is.
    // Config CLAUDE_COMPACT_AT (a fraction of the window, default 0.8; 0 = off) is the "before" trigger.
    async send(message, sendOptions = {}) {
      if (seed) {
        message = withSeed(message, seed);
        seed = "";
      }
      const text = typeof message === "string" ? message : message?.text || "";
      const ratio = Number(genv("CLAUDE_COMPACT_AT", "0.8"));
      if (!(ratio > 0) || /^\s*\//.test(text)) return agent.sendTurn(message, sendOptions);
      let current = null;
      let cancelled = false;
      // /compact on this session: its own turn, no file checkpoint and no next-message guess.
      const compact = async (why) => {
        console.error(`[claude] ${why} — compacting session ${currentSessionId}`);
        const turn = await agent.sendTurn("/compact", { ...sendOptions, userMessageId: undefined, onSuggestion: null, onCommands: null });
        current = turn;
        if (cancelled) await turn.cancel?.();
        const result = await turn.wait();
        lastContext = null;
        return result?.status === "finished" && !result.error;
      };
      if (contextPressure(lastContext, ratio)) {
        const used = Math.round((Number(lastContext.totalTokens) / Number(lastContext.rawMaxTokens || lastContext.maxTokens)) * 100);
        await compact(`context at ${used}% of the window`);
      }
      const run = await agent.sendTurn(message, sendOptions);
      current = run;
      return {
        ...run,
        supports: (cap) => (current.supports ? current.supports(cap) : cap === "cancel"),
        async cancel() {
          cancelled = true;
          await current.cancel?.();
        },
        steer: (...args) => (current.steer ? current.steer(...args) : "revert_to_followup"),
        async wait() {
          const result = await run.wait();
          if (cancelled || result?.status !== "error" || !PROMPT_TOO_LONG.test(String(result.error?.message || ""))) return result;
          if (!(await compact("the engine refused the turn: prompt too long"))) return result;
          if (cancelled) return { status: "cancelled" };
          // Once only: a second refusal after a compaction is the owner's to see.
          current = await agent.sendTurn(message, sendOptions);
          return current.wait();
        },
      };
    },
    async sendTurn(message, sendOptions = {}) {
      // A fresh in-process MCP server per send: the runner caches this agent, and one server
      // instance holds a single transport — a send that started while the previous query was still
      // closing its transport came up with «MCP: failed».
      const mcp = buildMcpServer(options.customTools || {});
      const abort = new AbortController();
      const bridge = createClaudeEventBridge();
      let settle;
      const done = new Promise((resolve) => {
        settle = resolve;
      });
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        settle(result);
      };

      const runId = randomUUID();
      // The owner's own chats (not his jobs) checkpoint the files each message's turn edits, so a
      // rewind puts them back (rewindFiles above): the message carries the runner's id for it.
      const checkpoint = options.fileAccess && !options.ownerJob && sendOptions.userMessageId ? sendOptions.userMessageId : null;
      // Plan limit (Pro): a rejected rate_limit_event before the run fails turns its error into
      // code "plan_limit" so the runner can move the work to another provider.
      let limit = null;
      let mcpDown = null;
      const run = {
        id: runId,
        supports: (cap) => cap === "cancel",
        async cancel() {
          abort.abort();
        },
        async steer() {
          return "revert_to_followup";
        },
        wait: () => done,
        // What a rewind to this message needs (runner records it with the run).
        ...(checkpoint ? { checkpoint: { sessionId: currentSessionId, userMessageId: checkpoint, cwd: options.cwd } } : {}),
      };

      const modelId = endpoint ? endpointModel(endpoint, sendOptions.model?.id || options.model?.id || defaultModel) : resolveModel(sendOptions.model?.id || options.model?.id || defaultModel);
      // Claude-only extras (effort, fast mode, the next-message guess) stay off on another vendor's
      // endpoint: GLM takes no effort level, and the guess spends its plan.
      const extras = endpoint ? { ...sendOptions, effort: null, fast: false, onSuggestion: null } : sendOptions;
      const mode = PERMISSION_MODES[sendOptions.mode] ? sendOptions.mode : "agent";
      liveMode = mode;
      emitNow = async (update) => sendOptions.onDelta?.({ update });
      const allowedMcp = Object.keys(options.customTools || {}).map((name) => `mcp__${mcpName()}__${name}`);
      // options.fileAccess (index.mjs): { read, write, deny } in the owner's own chats, else none.
      const scope = options.fileAccess || null;
      // options.claudeCode (the owner's own chats, alongside the app's tools):
      // the owner's full Claude Code in his own chats — Bash and every built-in, his user/project/local
      // settings, skills and MCP servers — next to Griffin's tools. File tools still may not touch the
      // knowledge store or the agent's state (scope.deny); Bash is his, like his own terminal — unguarded
      // only under STATE_GUARD=off (below; on by default).
      const full = Boolean(scope && options.claudeCode);
      // A folder login lives in the app's data folder, which the host does not see: it runs here.
      const host = full && options.onHost && !isLoginDirKey(apiKey) ? hostTarget() : null;
      if (full && options.onHost && !host) console.error("[claude] CLAUDE_HOST is set but GRIFFIN_CLAUDE_HOST_TARGET/_KEY are not: running in the container");
      const keep = full && Boolean(options.backgroundTasks);
      const builtins = full ? null : scope ? BUILTIN_TOOLS : NO_FILE_TOOLS;
      // options.stateGuard (index.mjs, config STATE_GUARD, on by default): { protect, except } — with full Claude
      // Code, Bash and every other tool also may not write the knowledge store or the data folder
      // (state-guard.mjs). STATE_GUARD=off: as before.
      const protectState = full && options.stateGuard?.protect?.length ? stateGuard({ ...options.stateGuard, cwd: options.cwd || process.cwd() }) : null;
      // options.instructionPaths (index.mjs, config TELEGRAM_INSTRUCTION_GUARD, on by default; chat-origin.mjs): a
      // chat born from someone else's Telegram message may not write the owner's instruction files.
      // Empty for every other chat.
      const protectInstructions = full && options.instructionPaths?.length ? stateGuard({ ...instructionGuardOptions(options.instructionPaths), cwd: options.cwd || process.cwd() }) : null;
      // options.readGuard (jobs/owner-jobs.mjs, an owner job only): { protect, except, readable:false } —
      // literal paths into the data folder and the broker socket refused for reading as well (a speed
      // bump, not a boundary: a path built at run time passes).
      const protectReads = full && options.readGuard?.protect?.length ? stateGuard({ ...options.readGuard, cwd: options.cwd || process.cwd() }) : null;
      const hooks = full
        ? withStateGuard(fileGuardHooks(fileGuard({ cwd: options.cwd, read: ["/"], write: ["/"], deny: scope.deny || [] })), protectState, protectInstructions, protectReads)
        : scope
          ? fileGuardHooks(fileGuard({ cwd: options.cwd, ...scope }))
          : null;
      const prev = last;
      let closeMe;
      const me = { closed: new Promise((resolve) => (closeMe = resolve)), done: false, abort, resultAt: 0 };
      last = me;
      let gotAny = false;
      let produced = false;

      // One Claude Code process per session at a time: wait for the previous one to exit. A turn that
      // already gave its result only lingers for its suggestion (10 s); one the runner gave up on is
      // stopped. Never waits forever.
      async function afterPrevious() {
        if (!prev || prev.done) return;
        const within = (ms) => Promise.race([prev.closed, new Promise((resolve) => setTimeout(resolve, ms))]);
        await within(prev.resultAt || prev.abort.signal.aborted ? 10_000 : 2_000);
        if (prev.done) return;
        prev.abort.abort();
        await within(5_000);
      }

      // The Claude Code options of this send (shared by the one-shot and the kept-process paths).
      const queryOptions = (resume) => ({
            abortController: abort,
            cwd: options.cwd,
            model: modelId,
            ...(extras.effort ? { effort: extras.effort } : {}),
            // Claude Code's guess at the owner's next message, after the result (runner decides who gets one).
            ...(extras.onSuggestion ? { promptSuggestions: true } : {}),
            // Fast mode is an SDK opt-in: only a settings value turns it on (billed from extra usage, Opus only).
            ...(extras.fast || planGate ? { settings: { ...(extras.fast ? { fastMode: true } : {}), ...(planGate ? { plansDirectory: PLANS_DIR } : {}) } } : {}),
            ...(resume ? { resume: currentSessionId } : { sessionId: currentSessionId }),
            ...(checkpoint ? { enableFileCheckpointing: true } : {}),
            permissionMode: PERMISSION_MODES[mode],
            // Always there in the owner's chats: a mode switched mid-process (setPermissionMode) still asks.
            ...(options.approve ? { canUseTool: askOwnerTool(options.approve, { askTool: options.customTools?.[ASK_TOOL], emit: (update) => emitNow(update) }) } : {}),
            // options.elicit (index.mjs, the owner's own chats): an MCP sign-in link or form goes to his card.
            ...(options.elicit ? { onElicitation: (request) => answerElicitation(request, options.elicit) } : {}),
            includePartialMessages: true,
            ...(options.maxTurns ? { maxTurns: options.maxTurns } : {}),
            ...(builtins ? { tools: planGate ? [...builtins, "ExitPlanMode"] : builtins, allowedTools: [...builtins, ...allowedMcp, `mcp__${mcpName()}__*`] } : { allowedTools: [...allowedMcp, `mcp__${mcpName()}__*`] }),
            // Config PLAN_APPROVAL: the handler, and leave to switch to agent mode on approval.
            ...(planGate ? { canUseTool: planGate, allowDangerouslySkipPermissions: true } : {}),
            ...(hooks ? { hooks } : {}),
            // With a handler Claude Code would offer its own question tool (no card here) and EnterPlanMode
            // (plan mode is the owner's choice from the chat): both off, as without a handler.
            ...(full && !planGate ? {} : { disallowedTools: [...(full ? [] : ["Bash", "BashOutput", "KillShell", "NotebookEdit"]), ...(planGate ? ["AskUserQuestion", "EnterPlanMode"] : [])] }),
            mcpServers: mcp ? { [mcpName()]: mcp } : {},
            strictMcpConfig: !full,
            // Rules come with the run, not from the shared workspace CLAUDE.md: concurrent chats of
            // one agent rewrite that file, so a colleague thread could run on the owner's rules.
            ...(options.rules
              ? { systemPrompt: { type: "preset", preset: "claude_code", append: full ? `${options.rules}\n\n${options.ownerJob ? OWNER_JOB_NOTE : host ? HOST_NOTE : FULL_NOTE}` : options.rules }, settingSources: full ? ["user", "project", "local"] : [] }
              : { settingSources: full ? ["user", "project", "local"] : ["project"] }),
            env: runEnv(apiKey, endpoint, modelId),
            ...claudeExecutableOption(),
            // options.onHost (index.mjs, config CLAUDE_HOST): the process runs on the host as the owner.
            ...(host ? { spawnClaudeCodeProcess: hostSpawner(host) } : {}),
            // options.backgroundTasks (index.mjs, config CLAUDE_BACKGROUND_TASKS, on by default): each
            // background task can be stopped on its own, so Stop ends the turn and leaves them running.
            ...(keep ? { perTaskStopAffordance: true } : {}),
      });

      // Config CLAUDE_BACKGROUND_TASKS: the owner's full Claude Code keeps its process (and the
      // background shells and agents it started) after the turn, and the next send goes into it.
      if (keep) return sendKept({ message, sendOptions, run, finish, abort, mcp, queryOptions, checkpoint, me, closeMe, prev, bridge, getLimit: () => limit, setLimit: (value) => (limit = value), isSettled: () => settled, settings: { modelId, mode, effort: extras.effort || null, fast: Boolean(extras.fast) } });

      async function attempt(resume) {
        const q = queryImpl({
          prompt: toPrompt(message, () => currentSessionId, checkpoint),
          options: queryOptions(resume),
        });
        let commandsAsked = false;
        for await (const msg of q) {
          // The session exists from the process's first message: a later send resumes it.
          gotAny = true;
          started = true;
          if (msg?.session_id) currentSessionId = msg.session_id;
          // A resumed session first answers what it owes itself — a background task's
          // <task-notification> — in a turn of its own. That result names another user message; it is
          // not this turn's end (it once closed the owner's run 16 s in and the answer streamed
          // into a finished run nobody saw). Results that name no message keep the old rule.
          if (msg?.type === "result" && checkpoint) {
            const answers = [msg.user_message_uuid, ...(Array.isArray(msg.user_message_uuids) ? msg.user_message_uuids : [])].filter(Boolean);
            if (answers.length && !answers.includes(checkpoint)) continue;
          }
          // The composer's «/» list: asked once the engine answers, replaced when Claude Code says it changed.
          if (sendOptions.onCommands) {
            if (!commandsAsked && typeof q.supportedCommands === "function") {
              commandsAsked = true;
              Promise.resolve().then(() => q.supportedCommands()).then(sendOptions.onCommands).catch(() => {});
            }
            if (msg?.type === "system" && msg.subtype === "commands_changed") {
              bestEffort(() => sendOptions.onCommands(msg.commands));
              continue;
            }
          }
          // Arrives after the result and is no turn of its own: handed over, never streamed.
          if (msg?.type === "prompt_suggestion") {
            bestEffort(() => sendOptions.onSuggestion?.(String(msg.suggestion ?? "")));
            continue;
          }
          const info = msg?.type === "rate_limit_event" ? msg.rate_limit_info : null;
          if (limitClosed(info)) limit = info;
          if (info?.unifiedWindows) Object.assign(lastLimits, { windows: info.unifiedWindows, at: new Date().toISOString() });
          // An MCP server that fails to start leaves the model with built-ins only, silently — it then
          // answers without any app tool. Stop the run with a clear error instead.
          const isInit = msg?.type === "system" && msg.subtype === "init" && mcp;
          const mcpProblem = isInit ? await confirmMcpProblem(q, mcpInitProblem(msg)) : null;
          if (isInit && mcpProblem) console.error(`[claude] init mcp_servers=${mcpNames(msg)}`);
          if (mcpProblem) {
            mcpDown = `ابزارهای ایجنت به Claude نرسید (MCP: ${mcpProblem})`;
            console.error(`[claude] ${mcpDown}`);
            abort.abort();
            break;
          }
          for (const update of bridge.consume(msg)) {
            if (isOutput(update)) produced = true;
            await sendOptions.onDelta?.({ update });
          }
          if (msg?.type === "result") {
            me.resultAt = Date.now();
            // 'summary': the last response's real usage plus local estimates, no token-count call.
            // Not awaited: the turn's answer never waits on the gauge.
            if (typeof q.getContextUsage === "function") {
              Promise.resolve()
                .then(() => q.getContextUsage({ detail: "summary" }))
                .then((usage) => usage && (lastContext = usage))
                .catch(() => {});
            }
            // is_error wins over subtype: an expired login can arrive as "success" + is_error (seen in the wild).
            // plan_limit, or engine_unavailable (429, overload, unknown model: 8d4b48b) — the
            // runner moves on both in auto mode, as before; ask mode asks only on plan_limit.
            const failure = resultFailure(msg, { produced, limit, endpoint });
            finish({
              status: abort.signal.aborted ? "cancelled" : failure ? "error" : "finished",
              error: failure,
            });
          }
        }
      }

      (async () => {
        try {
          if (!apiKey) throw new Error(endpoint ? `${endpoint.label} key missing` : "Anthropic API key missing");
          await afterPrevious();
          try {
            await attempt(started);
          } catch (error) {
            if (gotAny || abort.signal.aborted || !/already in use/i.test(String(error?.message || error))) throw error;
            // Still held by a process that had not exited: once more, resuming it.
            console.error(`[claude] session ${currentSessionId} in use — retrying once`);
            await new Promise((resolve) => setTimeout(resolve, 2_000));
            await attempt(true);
          }
          if (mcpDown) finish({ status: "error", error: { message: mcpDown } });
          if (!settled) finish({ status: abort.signal.aborted ? "cancelled" : "finished" });
        } catch (error) {
          finish({
            status: abort.signal.aborted && !mcpDown ? "cancelled" : "error",
            error: mcpDown ? { message: mcpDown } : sessionGone(String(error?.message || error)),
          });
        } finally {
          started = true;
          me.done = true;
          closeMe();
        }
      })();

      return run;
    },
  };
  return agent;
}

function bestEffort(fn) {
  try {
    fn();
  } catch {
    /* the «/» list and the suggestion are best effort */
  }
}

// Resume is lazy here, so a session Claude no longer has (chat moved from another engine, or its
// store was lost) only fails at send — a thread would die on every message with
// "No conversation found with session ID". Tag it so the runner starts a fresh session.
// Only the CLI's exact resume failures: an auth error such as «Invalid session
// token» also says "session", and a fresh session would not fix it.
function sessionGone(message) {
  return /no conversation found with session id|failed to resume session/i.test(message) ? { message, code: "agent_not_found" } : { message };
}

function buildMcpServer(customTools) {
  const names = Object.keys(customTools || {});
  if (!names.length) return null;
  const tools = names.map((name) => {
    const def = customTools[name];
    return tool(
      name,
      def.description || name,
      jsonSchemaToZodShape(def.inputSchema || { type: "object", properties: {} }),
      async (args) => {
        const result = await def.execute(args || {});
        return toCallToolResult(result);
      },
      { alwaysLoad: true },
    );
  });
  return createSdkMcpServer({
    name: mcpName(),
    version: "1.0.0",
    tools,
    alwaysLoad: true,
  });
}

function toCallToolResult(result) {
  if (!result || typeof result !== "object") {
    return { content: [{ type: "text", text: String(result ?? "") }] };
  }
  const content = Array.isArray(result.content)
    ? result.content.map(normalizeContentPart).filter(Boolean)
    : [{ type: "text", text: JSON.stringify(result) }];
  return {
    content: content.length ? content : [{ type: "text", text: "" }],
    ...(result.isError ? { isError: true } : {}),
  };
}

function normalizeContentPart(part) {
  if (!part || typeof part !== "object") return null;
  if (part.type === "text") return { type: "text", text: String(part.text ?? "") };
  if (part.type === "image" && part.data) {
    return {
      type: "image",
      data: String(part.data),
      mimeType: part.mimeType || "image/png",
    };
  }
  return { type: "text", text: JSON.stringify(part) };
}

// A held-open streaming input: the process lives while it is open (config CLAUDE_BACKGROUND_TASKS).
function pushIterable() {
  const queue = [];
  let wake = null;
  let closed = false;
  return {
    push(value) {
      if (closed) return;
      queue.push(value);
      wake?.();
    },
    close() {
      closed = true;
      wake?.();
    },
    iterable: (async function* () {
      for (;;) {
        while (queue.length) yield queue.shift();
        if (closed) return;
        await new Promise((resolve) => (wake = resolve));
        wake = null;
      }
    })(),
  };
}

// The one user message toPrompt yields, as a value to push into a streaming input.
function userMessageOf(message, sessionId, uuid) {
  const text = typeof message === "string" ? message : message?.text || "";
  const images = (message?.images || []).filter((image) => image?.data);
  const pdfs = (message?.files || []).filter((file) => file?.data && file.mimeType === "application/pdf");
  const content = [
    ...images.map((image) => ({ type: "image", source: { type: "base64", media_type: image.mimeType || "image/png", data: String(image.data) } })),
    ...pdfs.map((file) => ({ type: "document", title: inertText(file.name || "file.pdf"), source: { type: "base64", media_type: "application/pdf", data: String(file.data) } })),
    { type: "text", text: text || (pdfs.length ? "(file)" : images.length ? "(image)" : "") },
  ];
  return { type: "user", message: { role: "user", content }, parent_tool_use_id: null, session_id: sessionId(), ...(uuid ? { uuid } : {}) };
}

// uuid: the message's own id (a file checkpoint), which only streaming input can carry.
// A chat's permission mode (as in Claude Desktop's mode menu): «agent» is the old
// default, no prompts. In «auto», «ask» and «edits» Claude Code asks before a step it needs a permission
// for (canUseTool), and that becomes a yes/no card for the owner; no way to ask = denied.
export const PERMISSION_MODES = { agent: "bypassPermissions", plan: "plan", auto: "auto", ask: "default", edits: "acceptEdits" };

export function permissionQuestion(name, input = {}) {
  const what = typeof input.description === "string" && input.description.trim() ? input.description.trim() : null;
  const detail = input.command || input.file_path || input.path || input.url || input.pattern || JSON.stringify(input).slice(0, 300);
  const tool = String(name).replace(/^mcp__[a-z0-9-]+__/, "");
  return `Claude می‌خواهد ${tool} را اجرا کند${what ? `: ${what}` : ""}\n${String(detail).slice(0, 600)}\nاجازه می‌دهید؟`;
}

// An MCP server's question to the owner (Claude Code elicitation): a sign-in link
// («وارد شدم» / «لغو») or each field of a form as its own card. ask(args) is asks.elicit(chatId, …)
// and resolves with { answered, answer, selected }. No ask (a chain the owner did not start): declined.
export const ELICIT_DONE = "وارد شدم";
export const ELICIT_CANCEL = "لغو";
const ELICIT_YES = "بله";
const ELICIT_NO = "خیر";
const picked = (answer) => String(answer?.selected?.length ? answer.selected[0] : answer?.answer || "");
export async function answerElicitation(request, ask) {
  if (typeof ask !== "function") return { action: "decline" };
  const once = (args) => Promise.resolve(ask(args)).catch(() => ({ answered: false }));
  const server = String(request?.displayName || request?.serverName || "MCP");
  const message = String(request?.title || request?.message || "").trim();
  if (request?.mode === "url" && request.url) {
    // The link is on the card (args.link), not in the question text: the text is masked and
    // mirrored to Telegram, where a cut link would be useless.
    const answer = await once({
      question: `${server} می‌خواهد وارد شوید${message ? `: ${message}` : ""}. لینک ورود روی کارت همین سؤال در گفتگوست؛ بعد از ورود «${ELICIT_DONE}» را بزنید.`,
      header: "ورود MCP",
      link: String(request.url),
      options: [{ label: ELICIT_DONE, description: "ورود در صفحهٔ باز شده تمام شد" }, { label: ELICIT_CANCEL, description: "بدون ورود ادامه بده" }],
    });
    return answer?.answered && picked(answer) !== ELICIT_CANCEL ? { action: "accept" } : { action: "cancel" };
  }
  const schema = request?.requestedSchema || {};
  const properties = schema.properties && typeof schema.properties === "object" ? schema.properties : {};
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  const content = {};
  for (const [field, spec] of Object.entries(properties)) {
    const title = String(spec?.title || spec?.description || field);
    const choices = Array.isArray(spec?.enum) ? spec.enum.map(String) : spec?.type === "boolean" ? [ELICIT_YES, ELICIT_NO] : [];
    const answer = await once({
      question: `${server}${message ? ` — ${message}` : ""}\n\n${title}${required.has(field) ? "" : " (اختیاری)"}`,
      header: "درخواست MCP",
      ...(choices.length ? { options: choices.slice(0, 6).map((label) => ({ label })) } : {}),
    });
    if (!answer?.answered) return { action: "cancel" };
    const raw = picked(answer).trim();
    if (!raw) {
      if (required.has(field)) return { action: "decline" };
      continue;
    }
    // A typed answer to a choice must be one of the choices.
    if (Array.isArray(spec?.enum) && !spec.enum.map(String).includes(raw)) return { action: "decline" };
    if (spec?.type === "boolean") content[field] = raw === ELICIT_YES || /^(true|yes|1)$/i.test(raw);
    else if (spec?.type === "number" || spec?.type === "integer") {
      const value = Number(raw.replace(/[۰-۹]/g, (d) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d))));
      if (!Number.isFinite(value)) return { action: "decline" };
      content[field] = spec.type === "integer" ? Math.trunc(value) : value;
    } else content[field] = raw;
  }
  return { action: "accept", content };
}

// askTool (the chat's ask_owner tool): Claude Code's own AskUserQuestion becomes the owner's question
// card instead of a yes/no «may Claude run AskUserQuestion?» with its answers left empty.
export function askOwnerTool(approve, { askTool = null, emit = async () => {} } = {}) {
  return async (name, input, ctx = {}) => {
    // Plan mode ends with the plan in the answer, as before; approving it is the owner's next message.
    if (name === "ExitPlanMode") return { behavior: "deny", message: "Stay in plan mode: give the plan as your answer and stop." };
    if (name === "AskUserQuestion" && typeof askTool?.execute === "function") return canUseAskUserQuestion(input, askTool, { emit, toolUseID: ctx.toolUseID || null });
    if (typeof approve !== "function") return { behavior: "deny", message: "No one is here to approve this step." };
    const yes = await approve(permissionQuestion(name, input)).catch(() => false);
    return yes ? { behavior: "allow", updatedInput: input } : { behavior: "deny", message: "The owner did not allow this step. Do not retry it; say what you would need." };
  };
}

// AskUserQuestion has no answer surface under a headless SDK host but canUseTool. Each of
// its 1–4 questions goes through ask_owner (card, Telegram) one at a time, shown as an ask_owner call
// in the timeline (`emit`), and the picks go back in `answers` (question -> answer), the shape
// AskUserQuestion expects; the call is then allowed as already answered.
export async function canUseAskUserQuestion(input, askTool, { emit = async () => {}, toolUseID = null } = {}) {
  const answers = {};
  const base = toolUseID || randomUUID();
  let index = 0;
  for (const q of input?.questions || []) {
    const args = {
      question: q.question,
      options: (q.options || []).map((o) => ({ label: o.label, ...(o.description ? { description: o.description } : {}) })),
      multiSelect: Boolean(q.multiSelect),
    };
    const callId = `${base}:ask:${index++}`;
    await emit({ type: "tool-call-started", callId, toolCall: mcpToolCall(ASK_TOOL, args) });
    let answer = { answered: false, reason: "no answer" };
    try {
      const text = (await askTool.execute(args))?.content?.[0]?.text;
      if (text) answer = JSON.parse(text);
    } catch {
      // no answer
    }
    await emit({ type: "tool-call-completed", callId, toolCall: { ...mcpToolCall(ASK_TOOL, args), result: answer } });
    // Nag guard (asks.mjs): answered a few minutes ago — the model gets that answer back.
    if (answer.duplicate) return { behavior: "deny", message: String(answer.reason || "") };
    answers[q.question] = answer.answered ? answer.answer || (answer.selected ?? []).join(", ") : "";
  }
  return { behavior: "allow", updatedInput: { ...input, answers } };
}

const SEED_MAX = 60_000; // ponytail: newest turns up to a fixed size; summarize if long chats need more

export function seedText(turns) {
  if (!Array.isArray(turns) || !turns.length) return "";
  const lines = turns
    .filter((t) => t && (t.role === "user" || t.role === "assistant") && typeof t.content === "string" && t.content.trim())
    .map((t) => `${t.role === "user" ? "User" : "You"}: ${t.content.trim()}`);
  let out = "";
  for (let i = lines.length - 1; i >= 0 && out.length + lines[i].length < SEED_MAX; i -= 1) out = `${lines[i]}\n\n${out}`;
  return out.trim();
}

export function withSeed(message, seed) {
  const note = `[This conversation started earlier; its session was lost, so here is the conversation so far. Continue from it — do not start over or say nothing has been asked.]\n${inertText(seed)}\n[End of earlier conversation. The new message follows.]\n\n`;
  if (typeof message === "string") return note + message;
  return { ...message, text: note + (message?.text || "") };
}

export function toPrompt(message, sessionId = () => "", uuid = null) {
  const text = typeof message === "string" ? message : message?.text || "";
  const images = (message?.images || []).filter((image) => image?.data);
  // A PDF the owner attached (attachments.mjs; text files are already inside the text).
  const pdfs = (message?.files || []).filter((file) => file?.data && file.mimeType === "application/pdf");
  if (!images.length && !pdfs.length && !uuid) return text;
  // Images and PDFs need streaming input: one user message with image and document blocks.
  const content = [
    ...images.map((image) => ({
      type: "image",
      source: { type: "base64", media_type: image.mimeType || "image/png", data: String(image.data) },
    })),
    ...pdfs.map((file) => ({
      type: "document",
      title: inertText(file.name || "file.pdf"),
      source: { type: "base64", media_type: "application/pdf", data: String(file.data) },
    })),
    { type: "text", text: text || (pdfs.length ? "(file)" : "(image)") },
  ];
  return (async function* () {
    yield { type: "user", message: { role: "user", content }, parent_tool_use_id: null, session_id: sessionId(), ...(uuid ? { uuid } : {}) };
  })();
}

// One question, one answer, no tools — for the change reviewers (review.mjs). The prompt quotes a
// requester's words and an agent's tool arguments, so it goes inert (no live "@path" or "/").
export async function claudeOneShot({ apiKey, model = "sonnet", prompt, cwd = "/tmp" }) {
  if (!apiKey) throw new Error("Anthropic API key missing");
  let text = "";
  for await (const msg of query({
    prompt: inertText(prompt),
    options: {
      cwd,
      model: resolveModel(model),
      maxTurns: 1,
      tools: [],
      allowedTools: [],
      settingSources: [],
      systemPrompt: "Answer exactly as instructed in the user message.",
      env: claudeAuthEnv(apiKey),
      ...claudeExecutableOption(),
    },
  })) {
    if (msg?.type === "result") {
      if (msg.subtype !== "success" || msg.is_error) throw new Error(String(msg.result || msg.subtype).slice(0, 120));
      text = msg.result || "";
    }
  }
  return text;
}
