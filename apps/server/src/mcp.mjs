import { streamSSE } from "hono/streaming";
import { MCP_TOOLS } from "./mcp-tools.mjs";

// Stateless MCP server (streamable HTTP, JSON responses) for external agents such as Claude Code:
//   claude mcp add --transport http griffin https://griffin.example.com/mcp \
//     --header "Authorization: Bearer grf_…"
// The tools are a thin, non-blocking shell over peer tasks (A2A lifecycle): send returns a taskId
// within seconds, wait long-polls for progress, reply answers a question, cancel stops.

const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"];
const MAX_BODY = 256 * 1024;
// Plain JSON responses must finish before a CDN edge cuts slow origins (15 s is a common cap); an SSE
// response starts at once and keeps bytes flowing, so a call may wait much longer.
const HEARTBEAT_MS = 5_000;
export const WAIT_CAP_JSON = 12;
export const WAIT_CAP_SSE = 55;

export { MCP_TOOLS };

const TOOL_NAMES = MCP_TOOLS.map((t) => t.name);

// Hand-rolled clients (and some frameworks) pass the namespaced name they show the model, e.g.
// "mcp__griffin__griffin_send" or "griffin.griffin_send". Accept those rather than answering
// "unknown tool" to an agent that asked for exactly the right thing.
export function resolveToolName(name) {
  const raw = String(name || "");
  if (TOOL_NAMES.includes(raw)) return raw;
  return TOOL_NAMES.find((t) => raw.endsWith(t) && /[^a-z0-9]$|__$|\.$/i.test(raw.slice(0, -t.length))) || null;
}

export function createMcpHandler({ tasks, version = "dev", record = () => {}, log = console }) {
  const calls = {
    griffin_send: (peer, a) => tasks.send(peer, a),
    griffin_wait: (peer, a) => tasks.wait(peer, a),
    griffin_reply: (peer, a) => tasks.reply(peer, a),
    griffin_cancel: (peer, a) => tasks.cancel(peer, a),
    griffin_tasks: (peer, a) => tasks.list(peer, a),
  };

  // One line per call, plus a row the owner can read on the peers page. Argument values stay out
  // of both; the key names are what actually identify a malformed client.
  function note(peer, { method, tool = null, args = null, outcome, detail = null, startedAt }) {
    const ms = Date.now() - startedAt;
    const argKeys = args ? Object.keys(args).join(",") : null;
    try {
      record({ userId: peer?.userId, clientId: peer?.clientId || null, method, tool, argKeys, outcome, detail, ms });
    } catch (error) {
      log.error?.(`[mcp] could not record call: ${error.message}`);
    }
    const where = `${peer?.userId || "?"}/${String(peer?.clientId || "?").slice(0, 8)}`;
    const what = tool ? `${method} ${tool}(${argKeys || ""})` : method;
    const line = `[mcp] ${where} ${what} -> ${outcome}${detail ? ` ${detail}` : ""} ${ms}ms`;
    if (outcome === "ok") log.log?.(line);
    else log.error?.(line);
  }

  async function handle(peer, msg, waitCap) {
    const startedAt = Date.now();
    const { id, method, params } = msg || {};
    const isNotification = id === undefined || id === null;
    const ok = (result) => (isNotification ? null : { jsonrpc: "2.0", id, result });
    const fail = (code, message) => (isNotification ? null : { jsonrpc: "2.0", id, error: { code, message } });

    if (msg?.jsonrpc !== "2.0" || typeof method !== "string") {
      note(peer, { method: String(method || "?"), outcome: "error", detail: "invalid request", startedAt });
      return fail(-32600, "invalid request");
    }
    switch (method) {
      case "initialize": {
        const asked = params?.protocolVersion;
        note(peer, { method, outcome: "ok", detail: `protocol ${asked || "unset"}`, startedAt });
        return ok({
          protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "griffin", version },
          instructions:
            "Griffin runs long operational tasks. griffin_send starts one and returns quickly; poll griffin_wait until the task ends. " +
            "A task in state working is alive — do not treat it as failed.",
        });
      }
      case "ping":
        return ok({});
      case "tools/list":
        note(peer, { method, outcome: "ok", startedAt });
        return ok({ tools: MCP_TOOLS });
      case "tools/call": {
        const name = resolveToolName(params?.name);
        const args = { ...(params?.arguments || {}) };
        if (!name) {
          const detail = `unknown tool: ${params?.name} — this server offers ${TOOL_NAMES.join(", ")}`;
          note(peer, { method, tool: String(params?.name || ""), args, outcome: "error", detail, startedAt });
          return fail(-32602, detail);
        }
        try {
          args.waitSec = Math.min(Number(args.waitSec ?? 10) || 0, waitCap);
          const result = await calls[name](peer, args);
          note(peer, {
            method,
            tool: name,
            args: params?.arguments || {},
            outcome: result?.error ? "error" : "ok",
            detail: result?.error || [result?.state, result?.taskId].filter(Boolean).join(" ") || null,
            startedAt,
          });
          return ok({
            content: [{ type: "text", text: JSON.stringify(result) }],
            structuredContent: result,
            ...(result?.error ? { isError: true } : {}),
          });
        } catch (error) {
          const detail = String(error?.message || error);
          note(peer, { method, tool: name, args: params?.arguments || {}, outcome: "error", detail, startedAt });
          return ok({ content: [{ type: "text", text: JSON.stringify({ error: detail }) }], isError: true });
        }
      }
      default:
        if (method.startsWith("notifications/")) return null;
        note(peer, { method, outcome: "error", detail: "method not found", startedAt });
        return fail(-32601, `method not found: ${method}`);
    }
  }

  return {
    async post(c) {
      const length = Number(c.req.header("content-length") || 0);
      if (length > MAX_BODY) return c.json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "body too large" } }, 413);
      let body;
      try {
        body = await c.req.json();
      } catch {
        return c.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }, 400);
      }
      const peer = c.get("peer");
      const batch = Array.isArray(body);
      const messages = batch ? body : [body];
      const sse = /text\/event-stream/.test(c.req.header("accept") || "") && messages.some((m) => m?.id != null);
      if (!sse) {
        const replies = (await Promise.all(messages.map((m) => handle(peer, m, WAIT_CAP_JSON)))).filter(Boolean);
        if (!replies.length) return c.body(null, 202);
        return c.json(batch ? replies : replies[0]);
      }
      c.header("Cache-Control", "no-cache, no-transform");
      c.header("X-Accel-Buffering", "no");
      return streamSSE(c, async (stream) => {
        const beat = setInterval(() => stream.write(": keepalive\n\n").catch(() => {}), HEARTBEAT_MS);
        try {
          await stream.write(": open\n\n");
          const replies = (await Promise.all(messages.map((m) => handle(peer, m, WAIT_CAP_SSE)))).filter(Boolean);
          for (const reply of replies) await stream.writeSSE({ event: "message", data: JSON.stringify(reply) });
        } finally {
          clearInterval(beat);
        }
      });
    },
    // No server-initiated stream: clients poll griffin_wait.
    notAllowed: (c) => c.json({ error: "method not allowed" }, 405, { Allow: "POST" }),
  };
}
