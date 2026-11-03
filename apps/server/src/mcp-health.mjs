// Settings → MCP servers → «بررسی اتصال»: a live probe of one configured server, from Griffin itself.
// http: MCP `initialize` (+ `tools/list`) with the stored headers; sse: the stream opens and names its
// endpoint; stdio: the configured command is started for a moment, spoken to over stdin/stdout
// (initialize → tools/list) and always killed. The result carries no header/env value, no response body.
import { spawn } from "node:child_process";

const INIT = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "griffin-health", version: "1" } },
};

// A streamable-http reply is JSON or an SSE stream whose `data:` line is the JSON-RPC message.
function rpcMessage(text) {
  const raw = text.trim();
  if (raw.startsWith("{")) return JSON.parse(raw);
  const line = raw.split("\n").find((l) => l.startsWith("data:"));
  if (!line) throw new Error("not an MCP reply");
  return JSON.parse(line.slice(5));
}

const describe = (error) => {
  const code = error?.cause?.code || error?.cause?.errors?.[0]?.code || error?.code;
  if (error?.name === "TimeoutError" || error?.name === "AbortError") return "timeout";
  return code ? `${code}` : String(error?.cause?.message || error?.message || error).slice(0, 160);
};

// stdio: newline-delimited JSON-RPC. The child gets the server's own env on top of ours; neither the
// env nor its stderr ever reaches the result.
function checkStdio(server, timeoutMs) {
  const started = Date.now();
  return new Promise((resolve) => {
    let child;
    let settled = false;
    let buf = "";
    const out = {};
    const finish = (extra) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child?.stdin.destroy();
        child?.kill("SIGKILL");
      } catch {
        // already gone
      }
      resolve({ checked: true, type: "stdio", ms: Date.now() - started, ...extra });
    };
    const timer = setTimeout(() => finish({ ok: false, reason: "timeout" }), timeoutMs);
    try {
      child = spawn(server.command, Array.isArray(server.args) ? server.args : [], {
        env: { ...baseEnv(), ...(server.env || {}) },
        stdio: ["pipe", "pipe", "ignore"],
      });
    } catch (error) {
      return finish({ ok: false, reason: error?.code === "ENOENT" ? "ENOENT" : "spawn" });
    }
    const send = (msg) => child.stdin.write(`${JSON.stringify(msg)}\n`);
    child.on("error", (error) => finish({ ok: false, reason: error?.code === "ENOENT" ? "ENOENT" : "spawn" }));
    child.stdin.on("error", () => {});
    child.on("exit", () => finish({ ok: false, reason: "exited" }));
    child.stdout.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith("{")) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.id === 1) {
          if (msg.error || !msg.result) return finish({ ok: false, reason: "bad_initialize" });
          out.server = msg.result.serverInfo?.name || null;
          send({ jsonrpc: "2.0", method: "notifications/initialized" });
          send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
        } else if (msg.id === 2) {
          if (Array.isArray(msg.result?.tools)) out.tools = msg.result.tools.length;
          return finish({ ok: true, ...out });
        }
      }
    });
    send(INIT);
  });
}

// What a checked command gets from Griffin's own environment: enough to find and run it (and reach the
// network through the install's proxy), never the rest — app settings and keys stay out (owner 2026-10-29,
// on !351: «ازش بخوام محدودش کنه»). Its own env from the MCP settings comes on top.
const PASS_ENV = ["PATH", "HOME", "LANG", "TZ", "TMPDIR", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "no_proxy", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE"];
export function baseEnv(env = process.env) {
  return Object.fromEntries(PASS_ENV.filter((k) => env[k] !== undefined).map((k) => [k, env[k]]));
}

export async function checkMcpServer(server, { fetchImpl = fetch, timeoutMs = 8000 } = {}) {
  const type = server?.type === "sse" ? "sse" : server?.url && !server?.command ? "http" : server?.type === "http" ? "http" : "stdio";
  if (type === "stdio") return server?.command ? checkStdio(server, Math.min(timeoutMs, 10000)) : { checked: false, type, note: "stdio" };
  const started = Date.now();
  const done = (extra) => ({ checked: true, type, ms: Date.now() - started, ...extra });
  const headers = { ...(server.headers || {}) };
  try {
    if (type === "sse") {
      const res = await fetchImpl(server.url, { headers: { ...headers, Accept: "text/event-stream" }, signal: AbortSignal.timeout(timeoutMs) });
      const reason = res.status === 401 || res.status === 403 ? "auth" : null;
      if (!res.ok) return done({ ok: false, status: res.status, reason: reason || `http_${res.status}` });
      const chunk = await res.body.getReader().read().then((r) => Buffer.from(r.value || []).toString("utf8"), () => "");
      res.body.cancel().catch(() => {});
      return /event:\s*endpoint/.test(chunk) ? done({ ok: true, status: res.status }) : done({ ok: false, status: res.status, reason: "no_endpoint_event" });
    }
    const post = (body, extra = {}) =>
      fetchImpl(server.url, {
        method: "POST",
        headers: { ...headers, ...extra, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    const res = await post(INIT);
    if (res.status === 401 || res.status === 403) return done({ ok: false, status: res.status, reason: "auth" });
    if (!res.ok) return done({ ok: false, status: res.status, reason: `http_${res.status}` });
    const init = rpcMessage(await res.text());
    if (init.error || !init.result) return done({ ok: false, status: res.status, reason: init.error?.message?.slice(0, 160) || "bad_initialize" });
    const out = { ok: true, status: res.status, server: init.result.serverInfo?.name || null };
    try {
      const sid = res.headers.get("mcp-session-id");
      const extra = sid ? { "Mcp-Session-Id": sid } : {};
      await post({ jsonrpc: "2.0", method: "notifications/initialized" }, extra).then((r) => r.body?.cancel()).catch(() => {});
      const list = await post({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, extra);
      const tools = list.ok ? rpcMessage(await list.text()).result?.tools : null;
      if (Array.isArray(tools)) out.tools = tools.length;
    } catch {
      // initialize worked; the tool count is a bonus
    }
    return done(out);
  } catch (error) {
    return done({ ok: false, reason: describe(error) });
  }
}
