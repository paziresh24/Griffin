// Settings → MCP servers → «بررسی اتصال»: a live probe of one configured server, from Griffin itself.
// http: MCP `initialize` (+ `tools/list`) with the stored headers; sse: the stream opens and names its
// endpoint. stdio servers are child processes of Claude Code — nothing to probe from here; their
// state is the «وضعیت زنده» block. The result carries no header value and no response body.

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

export async function checkMcpServer(server, { fetchImpl = fetch, timeoutMs = 8000 } = {}) {
  const type = server?.type === "sse" ? "sse" : server?.url && !server?.command ? "http" : server?.type === "http" ? "http" : "stdio";
  if (type === "stdio") return { checked: false, type, note: "stdio" };
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
