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

// Built-ins Claude Code may use. No Bash: live ops go through typed broker/MCP tools.
const BUILTIN_TOOLS = ["Read", "Write", "Edit", "Glob", "Grep", "WebSearch", "WebFetch", "TodoWrite"];

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
            "x-api-key": apiKey,
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
  const mcp = buildMcpServer(options.customTools || {});

  return {
    get agentId() {
      return currentSessionId;
    },
    async send(message, sendOptions = {}) {
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

      const modelId = sendOptions.model?.id || options.model?.id || defaultModel;
      const mode = sendOptions.mode === "plan" ? "plan" : "agent";
      const prompt = toPrompt(message);
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
              ...sessionOpts,
              permissionMode: mode === "plan" ? "plan" : "bypassPermissions",
              includePartialMessages: true,
              tools: BUILTIN_TOOLS,
              allowedTools: [...BUILTIN_TOOLS, ...allowedMcp, "mcp__griffin__*"],
              disallowedTools: ["Bash", "BashOutput", "KillShell", "NotebookEdit"],
              mcpServers: mcp ? { griffin: mcp } : {},
              strictMcpConfig: true,
              settingSources: ["project"],
              env: {
                ...process.env,
                ANTHROPIC_API_KEY: apiKey,
              },
            },
          })) {
            if (msg?.session_id) currentSessionId = msg.session_id;
            for (const update of bridge.consume(msg)) {
              await sendOptions.onDelta?.({ update });
            }
            if (msg?.type === "result") {
              const ok = msg.subtype === "success" || msg.is_error === false;
              finish({
                status: abort.signal.aborted ? "cancelled" : ok ? "finished" : "error",
                error: ok
                  ? null
                  : { message: msg.result || msg.errors?.join?.("; ") || msg.subtype || "claude run failed" },
              });
            }
          }
          if (!settled) finish({ status: abort.signal.aborted ? "cancelled" : "finished" });
        } catch (error) {
          finish({
            status: abort.signal.aborted ? "cancelled" : "error",
            error: { message: String(error?.message || error) },
          });
        } finally {
          started = true;
        }
      })();

      return run;
    },
  };
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

function toPrompt(message) {
  if (typeof message === "string") return message;
  const text = message?.text || "";
  const images = message?.images || [];
  if (!images.length) return text;
  // Claude Agent SDK prompt can be a string; attach image note so the model knows they exist.
  // Full multimodal prompt support varies by CLI version — text remains the reliable path.
  return `${text}\n\n[${images.length} image(s) attached]`;
}
