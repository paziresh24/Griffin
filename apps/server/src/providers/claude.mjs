import { randomUUID } from "node:crypto";
import { query, tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { jsonSchemaToZodShape } from "./json-schema-zod.mjs";
import { createClaudeEventBridge } from "./claude-events.mjs";

export const PROVIDER_CLAUDE = "claude";

export const CLAUDE_MODELS = [
  { id: "opus", name: "Claude Opus" },
  { id: "sonnet", name: "Claude Sonnet" },
  { id: "haiku", name: "Claude Haiku" },
];

// Map the short names the picker/env use to a full id the INSTALLED claude-agent-sdk accepts.
// 2026-10-10: the Anthropic API stopped resolving bare "opus"/"sonnet" (404 "model: opus").
// 2026-10-11: the bundled CLI rejects a model newer than itself ("does not support this model;
// version X+ required"), so these must name an id the SDK knows — bump them together with the SDK
// version (check: grep -roE 'claude-(opus|sonnet)-[0-9-]+' node_modules/@anthropic-ai/claude-agent-sdk).
// SDK 0.3.296 knows the 5-5 line.
const MODEL_ALIAS = { opus: "claude-opus-5-5", sonnet: "claude-sonnet-5-5", haiku: "claude-haiku-5-5" };
export const resolveModel = (id) => MODEL_ALIAS[String(id || "").toLowerCase()] || id;

// Built-ins Claude Code may use. No Bash: live ops go through typed broker/MCP tools.
const BUILTIN_TOOLS = ["Read", "Write", "Edit", "Glob", "Grep", "WebSearch", "WebFetch", "TodoWrite"];

// `claude setup-token` gives a subscription OAuth token (sk-ant-oat…); it goes in
// CLAUDE_CODE_OAUTH_TOKEN and as a Bearer header, never as x-api-key.
const isOAuth = (key) => String(key || "").startsWith("sk-ant-oat");
export function claudeAuthEnv(key) {
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.CLAUDE_CODE_OAUTH_TOKEN;
  env[isOAuth(key) ? "CLAUDE_CODE_OAUTH_TOKEN" : "ANTHROPIC_API_KEY"] = key;
  return env;
}

const WINDOW_LABELS = { five_hour: "۵ ساعته", seven_day: "هفتگی", seven_day_opus: "هفتگی Opus", seven_day_sonnet: "هفتگی Sonnet" };
export function planWindows(windows) {
  return Object.entries(windows || {})
    .filter(([key, w]) => WINDOW_LABELS[key] && w && w.utilization != null)
    .map(([key, w]) => ({ label: WINDOW_LABELS[key], percentage: Math.round(Number(w.utilization) * 100), resetAt: w.resetsAt ? w.resetsAt * 1000 : null }));
}
// Last plan windows any run saw (process-wide; one subscription).
const lastLimits = { windows: null, at: null };

export function createClaudeProvider({ apiKey, defaultModel = "sonnet" } = {}) {
  return {
    id: PROVIDER_CLAUDE,
    defaultModel,
    async listModels() {
      return CLAUDE_MODELS.map((m) => ({ ...m, provider: PROVIDER_CLAUDE }));
    },
    async health() {
      if (!apiKey) return { ok: false, error: "no anthropic api key" };
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
        return { ok: response.ok || response.status === 401, status: response.status, ms: Date.now() - started };
      } catch (error) {
        return {
          ok: false,
          error: error?.name === "TimeoutError" ? "timeout" : String(error?.cause?.code || error?.message),
          ms: Date.now() - started,
        };
      }
    },
    // Pro plan windows. A setup-token has no profile scope, so /usage returns no rate_limits;
    // every run's rate_limit_event carries them instead (unifiedWindows, utilization 0-1).
    async usage() {
      if (!apiKey || !isOAuth(apiKey)) return null;
      return { provider: PROVIDER_CLAUDE, windows: planWindows(lastLimits.windows), seenAt: lastLimits.at };
    },
    create(options) {
      return makeAgent(null, options, { apiKey, defaultModel });
    },
    resume(sessionId, options) {
      return makeAgent(sessionId, options, { apiKey, defaultModel });
    },
  };
}

function makeAgent(sessionId, options, { apiKey, defaultModel }) {
  // Stable id from the start so runner can persist agent_id before the first stream frame.
  let currentSessionId = sessionId || randomUUID();
  let started = Boolean(sessionId);

  return {
    get agentId() {
      return currentSessionId;
    },
    async send(message, sendOptions = {}) {
      // A fresh in-process MCP server per send: the runner caches this agent, and one server
      // instance holds a single transport — a send that started while the previous query was still
      // closing its transport came up with «MCP: failed» (2026-10-08, verify correction 1s later).
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
      // Plan limit (Pro): a rejected rate_limit_event before the run fails turns its error into
      // code "plan_limit" so the runner can move the work to another provider (2026-10-08).
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
      };

      const modelId = resolveModel(sendOptions.model?.id || options.model?.id || defaultModel);
      const mode = sendOptions.mode === "plan" ? "plan" : "agent";
      const prompt = toPrompt(message, () => currentSessionId);
      const allowedMcp = Object.keys(options.customTools || {}).map((name) => `mcp__griffin__${name}`);
      const sessionOpts = started
        ? { resume: currentSessionId }
        : { sessionId: currentSessionId };

      (async () => {
        try {
          if (!apiKey) throw new Error("Anthropic API key missing");
          for await (const msg of query({
            prompt,
            options: {
              abortController: abort,
              cwd: options.cwd,
              model: modelId,
              ...(sendOptions.effort ? { effort: sendOptions.effort } : {}),
              ...sessionOpts,
              permissionMode: mode === "plan" ? "plan" : "bypassPermissions",
              includePartialMessages: true,
              tools: BUILTIN_TOOLS,
              allowedTools: [...BUILTIN_TOOLS, ...allowedMcp, "mcp__griffin__*"],
              disallowedTools: ["Bash", "BashOutput", "KillShell", "NotebookEdit"],
              mcpServers: mcp ? { griffin: mcp } : {},
              strictMcpConfig: true,
              // Rules come with the run, not from the shared workspace CLAUDE.md: concurrent chats of
              // one agent rewrite that file, so a colleague thread could run on the owner's rules.
              ...(options.rules
                ? { systemPrompt: { type: "preset", preset: "claude_code", append: options.rules }, settingSources: [] }
                : { settingSources: ["project"] }),
              env: claudeAuthEnv(apiKey),
            },
          })) {
            if (msg?.session_id) currentSessionId = msg.session_id;
            const info = msg?.type === "rate_limit_event" ? msg.rate_limit_info : null;
            if (info?.status === "rejected" && !info.overageInUse) limit = info;
            if (info?.unifiedWindows) Object.assign(lastLimits, { windows: info.unifiedWindows, at: new Date().toISOString() });
            // An MCP server that fails to start leaves the model with built-ins only, silently — it then
            // answers without any Griffin tool (2026-10-08). Stop the run with a clear error instead.
            if (msg?.type === "system" && msg.subtype === "init" && mcp) {
              const griffin = (msg.mcp_servers || []).find((server) => server.name === "griffin");
              if (griffin?.status !== "connected") {
                mcpDown = `ابزارهای گریفین به Claude نرسید (MCP: ${griffin?.status || "missing"})`;
                console.error(`[claude] ${mcpDown}`);
                abort.abort();
                break;
              }
            }
            for (const update of bridge.consume(msg)) {
              await sendOptions.onDelta?.({ update });
            }
            if (msg?.type === "result") {
              // is_error wins over subtype: an expired login can arrive as "success" + is_error (seen in the wild).
              const ok = msg.subtype === "success" && !msg.is_error;
              const message = msg.result || msg.errors?.join?.("; ") || msg.subtype || "claude run failed";
              finish({
                status: abort.signal.aborted ? "cancelled" : ok ? "finished" : "error",
                error: ok
                  ? null
                  : limit || /usage limit|rate limit|limit reached|hit your limit|unknown model|model code|not[_ ]?found|overloaded|\b429\b/i.test(message)
                    ? { message, code: "plan_limit", resetsAt: limit?.resetsAt ? limit.resetsAt * 1000 : null }
                    : sessionGone(message),
              });
            }
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
        }
      })();

      return run;
    },
  };
}

// Resume is lazy here, so a session Claude no longer has (chat moved from another engine, or its
// store was lost) only fails at send — 2026-10-10 a colleague thread died on every message with
// "No conversation found with session ID". Tag it so the runner starts a fresh session.
function sessionGone(message) {
  return /no conversation found/i.test(message) ? { message, code: "agent_not_found" } : { message };
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
    name: "griffin",
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

export function toPrompt(message, sessionId = () => "") {
  if (typeof message === "string") return message;
  const text = message?.text || "";
  const images = (message?.images || []).filter((image) => image?.data);
  if (!images.length) return text;
  // Images need streaming input: one user message with image content blocks.
  const content = [
    ...images.map((image) => ({
      type: "image",
      source: { type: "base64", media_type: image.mimeType || "image/png", data: String(image.data) },
    })),
    { type: "text", text: text || "(image)" },
  ];
  return (async function* () {
    yield { type: "user", message: { role: "user", content }, parent_tool_use_id: null, session_id: sessionId() };
  })();
}

// One question, one answer, no tools — for the change reviewers (review.mjs).
export async function claudeOneShot({ apiKey, model = "sonnet", prompt, cwd = "/tmp" }) {
  if (!apiKey) throw new Error("Anthropic API key missing");
  let text = "";
  for await (const msg of query({
    prompt,
    options: {
      cwd,
      model: resolveModel(model),
      maxTurns: 1,
      tools: [],
      allowedTools: [],
      settingSources: [],
      systemPrompt: "Answer exactly as instructed in the user message.",
      env: claudeAuthEnv(apiKey),
    },
  })) {
    if (msg?.type === "result") {
      if (msg.subtype !== "success" || msg.is_error) throw new Error(String(msg.result || msg.subtype).slice(0, 120));
      text = msg.result || "";
    }
  }
  return text;
}
