import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { baseEnv } from "./mcp-health.mjs";

// Connects Griffin to the owner's configured user-scope MCP servers (~/.claude.json `mcpServers`) so
// non-Claude engines (GLM, Gemini, Codex, OpenAI-compatible) get the same external MCP tools that
// Claude Code loads automatically. Tool lists are cached briefly by config hash; calls redact secrets.

const DEFAULT_LIST_TIMEOUT_MS = 5_000;
const DEFAULT_CALL_TIMEOUT_MS = 60_000;
const DEFAULT_CACHE_TTL_MS = 60_000;
const MAX_RESULT_CHARS = 60_000;

export function mcpToolName(serverName, toolName, used = new Set()) {
  const clean = (s) =>
    String(s || "x")
      .replace(/[^A-Za-z0-9_-]+/g, "_")
      .replace(/^_+|_+$/g, "") || "x";
  const s = clean(serverName);
  const t = clean(toolName);
  const raw = `mcp__${s}__${t}`;
  const fit = (candidate) => {
    if (candidate.length <= 64) return candidate;
    const h = createHash("sha256").update(raw).digest("hex").slice(0, 6);
    return `${candidate.slice(0, 57)}_${h}`;
  };
  let name = fit(raw);
  let i = 2;
  while (used.has(name)) {
    const h = createHash("sha256").update(`${raw}:${i++}`).digest("hex").slice(0, 6);
    name = `${raw.slice(0, 57)}_${h}`;
  }
  used.add(name);
  return name;
}

export function sanitizeToolSchema(schema) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return { type: "object", properties: {} };
  }
  const cleanNode = (node) => {
    if (Array.isArray(node)) return node.map(cleanNode);
    if (!node || typeof node !== "object") return node;
    const out = {};
    for (const [k, v] of Object.entries(node)) {
      if (k === "$schema" || k === "$id") continue;
      out[k] = cleanNode(v);
    }
    return out;
  };
  const out = cleanNode(schema);
  if (out.type !== "object") out.type = "object";
  if (!out.properties || typeof out.properties !== "object") out.properties = {};
  return out;
}

function serverType(s) {
  if (s?.type === "sse") return "sse";
  if (s?.type === "http") return "http";
  if (s?.url && !s?.command) return "http";
  return "stdio";
}

function configHash(server) {
  return createHash("sha256").update(JSON.stringify(server)).digest("hex");
}

function secretValues(server) {
  const out = [];
  for (const bag of [server?.headers, server?.env]) {
    if (!bag || typeof bag !== "object") continue;
    for (const v of Object.values(bag)) {
      if (typeof v === "string" && v.length >= 6) out.push(v);
    }
  }
  return out;
}

function redactSecrets(text, server) {
  let s = String(text || "");
  for (const v of secretValues(server)) {
    if (s.includes(v)) s = s.split(v).join("***");
  }
  return s;
}

function formatCallResult(res) {
  const raw = Array.isArray(res?.content) ? res.content : [];
  const parts = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    if (item.type === "text" && typeof item.text === "string") {
      parts.push(item.text);
    } else if (item.type === "image") {
      parts.push(`[image: ${item.mimeType || "unknown"}, ${item.data ? `${Math.round((item.data.length * 3) / 4 / 1024)} KB` : "empty"}]`);
    } else if (item.type === "resource" && item.resource) {
      if (typeof item.resource.text === "string") parts.push(item.resource.text);
      else parts.push(JSON.stringify({ uri: item.resource.uri, mimeType: item.resource.mimeType }));
    } else {
      parts.push(JSON.stringify(item));
    }
  }
  let text = parts.join("\n").trim();
  if (!text && res?.structuredContent !== undefined) text = JSON.stringify(res.structuredContent);
  if (!text) text = res?.isError ? "MCP tool returned an error with no body." : "ok";
  if (text.length > MAX_RESULT_CHARS) {
    text = `${text.slice(0, MAX_RESULT_CHARS)}\n…(truncated at ${MAX_RESULT_CHARS} chars)`;
  }
  return {
    content: [{ type: "text", text }],
    isError: Boolean(res?.isError),
  };
}

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function openClient(server, timeoutMs) {
  const type = serverType(server);
  const clientInfo = { name: "griffin-mcp-client", version: "1.0.0" };

  const connectWith = async (transport) => {
    const client = new Client(clientInfo, { capabilities: {} });
    await withTimeout(client.connect(transport), timeoutMs, `MCP connect (${server.name})`);
    return {
      client,
      async close() {
        await Promise.allSettled([client.close(), transport.close?.()]);
      },
    };
  };

  if (type === "stdio") {
    if (!server?.command) throw new Error("stdio MCP server has no command");
    const transport = new StdioClientTransport({
      command: server.command,
      args: Array.isArray(server.args) ? server.args.map(String) : [],
      env: { ...baseEnv(), ...(server.env || {}) },
      stderr: "ignore",
    });
    return connectWith(transport);
  }

  if (!server?.url) throw new Error("MCP server has no url");
  const headers = server.headers && typeof server.headers === "object" ? { ...server.headers } : {};
  const url = new URL(server.url);

  if (type === "sse") {
    const transport = new SSEClientTransport(url, {
      requestInit: { headers },
      eventSourceInit: { headers },
    });
    return connectWith(transport);
  }

  // type === "http": try StreamableHTTP first; fall back to SSE if the endpoint rejects POST/404/405.
  try {
    const transport = new StreamableHTTPClientTransport(url, { requestInit: { headers } });
    return await connectWith(transport);
  } catch (error) {
    const code = Number(error?.code);
    const msg = String(error?.message || "");
    if (code === 404 || code === 405 || /\b(404|405)\b/.test(msg)) {
      const sseTransport = new SSEClientTransport(url, {
        requestInit: { headers },
        eventSourceInit: { headers },
      });
      return connectWith(sseTransport);
    }
    throw error;
  }
}

export function createMcpClientManager({
  timeoutMs = DEFAULT_LIST_TIMEOUT_MS,
  callTimeoutMs = DEFAULT_CALL_TIMEOUT_MS,
  cacheTtlMs = DEFAULT_CACHE_TTL_MS,
  log = console,
} = {}) {
  const cache = new Map(); // name -> { hash, expiresAt, tools: [{ rawName, description, inputSchema }] }

  async function discoverServer(server) {
    const hash = configHash(server);
    const now = Date.now();
    const hit = cache.get(server.name);
    if (hit && hit.hash === hash && hit.expiresAt > now) return hit.tools;

    let conn;
    try {
      conn = await openClient(server, timeoutMs);
      const list = [];
      let cursor;
      for (let page = 0; page < 10; page++) {
        const res = await withTimeout(
          conn.client.listTools(cursor ? { cursor } : undefined),
          timeoutMs,
          `MCP listTools (${server.name})`,
        );
        for (const t of res?.tools || []) {
          if (t?.name) {
            list.push({
              rawName: String(t.name),
              description: String(t.description || `MCP tool ${t.name} on ${server.name}`),
              inputSchema: sanitizeToolSchema(t.inputSchema),
            });
          }
        }
        cursor = res?.nextCursor;
        if (!cursor) break;
      }
      cache.set(server.name, { hash, expiresAt: now + cacheTtlMs, tools: list });
      return list;
    } catch (error) {
      const msg = redactSecrets(error?.message || error, server);
      log.warn?.(`[mcp-client] ${server.name}: ${msg}`);
      return hit?.hash === hash ? hit.tools : [];
    } finally {
      await conn?.close?.().catch(() => {});
    }
  }

  return {
    invalidate(name = null) {
      if (name) cache.delete(name);
      else cache.clear();
    },

    async toolsFor(servers = []) {
      const valid = Array.isArray(servers) ? servers.filter((s) => s?.name) : [];
      if (!valid.length) return {};

      const discovered = await Promise.all(valid.map(async (server) => ({ server, tools: await discoverServer(server) })));
      const out = {};
      const used = new Set();

      for (const { server, tools } of discovered) {
        for (const t of tools) {
          const name = mcpToolName(server.name, t.rawName, used);
          out[name] = {
            description: `[MCP ${server.name}] ${t.description}`,
            inputSchema: t.inputSchema,
            async execute(args) {
              let conn;
              try {
                conn = await openClient(server, timeoutMs);
                const res = await withTimeout(
                  conn.client.callTool(
                    { name: t.rawName, arguments: args && typeof args === "object" ? args : {} },
                    undefined,
                    { timeout: callTimeoutMs },
                  ),
                  callTimeoutMs,
                  `MCP call ${server.name}/${t.rawName}`,
                );
                return formatCallResult(res);
              } catch (error) {
                return {
                  content: [{ type: "text", text: redactSecrets(error?.message || error, server) }],
                  isError: true,
                };
              } finally {
                await conn?.close?.().catch(() => {});
              }
            },
          };
        }
      }
      return out;
    },
  };
}
