import crypto from "node:crypto";

// Identity for external agents (MCP now, A2A later). A peer user is a person (one id per human);
// each of their agents/devices is a client with its own Bearer token. Runs started by a peer use
// caller `peer:<user>`, whose tool quota lives in agent_profiles.meta.callers like every other
// caller (fail-closed when a row is missing).

const USER_ID = /^[a-z0-9][a-z0-9-]{1,40}$/;
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 120;

export const PEER_INVITE_TOOL = "peer_invite";

export const peerCaller = (userId) => `peer:${userId}`;
export const isPeerCaller = (caller) => typeof caller === "string" && caller.startsWith("peer:");

export const hashToken = (token) => crypto.createHash("sha256").update(String(token)).digest("hex");

// Conservative default: diagnostics without secrets, raw logs, databases, object storage or any
// mutation. Irreversible tools are refused for peer chains anyway (guard.mjs). The owner widens
// a quota per agent with PATCH /api/agents/:id.
export const PEER_DEFAULT_QUOTA = {
  griffin: ["ask_agent", "delegate", "subtasks", "ask_owner", "ask_requester", "visualize", "show_media", "knowledge_list"],
  "platform": [
    "kube_status", "kube_get", "kube_df", "metrics_query", "alerts_active",
    "gitlab_version", "gitlab_projects", "gitlab_search", "gitlab_file", "gitlab_mr", "gitlab_commits", "gitlab_pipeline",
    "grafana_search", "grafana_dashboard", "grafana_panel_query", "grafana_query",
    "dns_lookup", "http_check", "tls_check", "nsin_edge_ranges",
  ],
  "arvan-ban": [
    "arvan_domains", "arvan_dns_records", "arvan_dns_export", "arvan_dnssec", "arvan_cache_settings", "arvan_purge_tags",
    "arvan_cache_purge", "dns_lookup", "http_check", "tls_check",
  ],
  "nsin-ban": [
    "nsin_domains", "nsin_domain", "nsin_dns_records", "nsin_ssl_status", "nsin_cache_stats", "nsin_cache_keys",
    "nsin_rules", "nsin_analytics_summary", "nsin_analytics_query", "nsin_top_uris", "nsin_request_logs", "nsin_waf_logs",
    "nsin_uptime_live", "nsin_uptime_incidents", "nsin_recommendations", "nsin_check_nameservers", "nsin_edge_ranges",
    "nsin_cache_purge", "nsin_cache_purge_path", "dns_lookup", "http_check", "tls_check",
  ],
};

const esc = (s) => String(s).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);

function pickupPage({ code = null, token = null, mcpUrl = "", gone = false }) {
  const body = gone
    ? `<p>این لینک قبلاً استفاده شده یا منقضی شده. از Owner لینک تازه بخواهید.</p>`
    : token
      ? `<p><b>توکن فقط همین یک‌بار نمایش داده می‌شود.</b> آن را جای امنی (مثلاً Infisical) نگه دارید.</p>
<pre dir="ltr">${esc(token)}</pre>
<p>اتصال Claude Code:</p>
<pre dir="ltr">claude mcp add --transport http griffin ${esc(mcpUrl)} --header "Authorization: Bearer ${esc(token)}"</pre>`
      : `<p>با این دکمه یک توکن اتصال ایجنت به گریفین (MCP) برای شما ساخته می‌شود. لینک یک‌بارمصرف است.</p>
<form method="post" action="/peer/pickup/${esc(code)}"><button type="submit">دریافت توکن</button></form>`;
  return `<!doctype html><html lang="fa" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>گریفین — اتصال ایجنت</title>
<style>body{font-family:Vazirmatn,system-ui,sans-serif;max-width:40rem;margin:2rem auto;padding:0 1rem;line-height:1.8;background:#fafafa;color:#1c1c1c}
pre{background:#fff;border:1px solid #ddd;border-radius:.5rem;padding:.75rem;white-space:pre-wrap;word-break:break-all}
button{font:inherit;background:#e8702a;color:#fff;border:0;border-radius:999px;padding:.6rem 1.4rem;cursor:pointer}
@media (prefers-color-scheme:dark){body{background:#161616;color:#eee}pre{background:#222;border-color:#333}}</style></head>
<body><h1>گریفین</h1>${body}</body></html>`;
}

export function createPeerAuth({ store, now = () => Date.now(), publicUrl = "" }) {
  const hits = new Map(); // clientId -> timestamps

  function rateLimited(clientId) {
    const cutoff = now() - RATE_WINDOW_MS;
    const recent = (hits.get(clientId) || []).filter((t) => t > cutoff);
    recent.push(now());
    hits.set(clientId, recent);
    return recent.length > RATE_MAX;
  }

  function grantDefaultQuota(userId) {
    const caller = peerCaller(userId);
    for (const profile of store.listAgentProfiles()) {
      const tools = PEER_DEFAULT_QUOTA[profile.id];
      if (!tools) continue;
      const callers = { ...(profile.meta?.callers || {}) };
      if (callers[caller]) continue;
      callers[caller] = { tools };
      store.updateAgentProfile(profile.id, { meta: { callers } });
    }
  }

  const api = {
    createUser({ id, label }) {
      const userId = String(id || "").trim().toLowerCase();
      if (!USER_ID.test(userId)) throw new Error("invalid user id (a-z, 0-9, -)");
      if (store.getPeerUser(userId)) throw new Error("user exists");
      const user = store.createPeerUser({ id: userId, label: String(label || userId).slice(0, 80) });
      grantDefaultQuota(userId);
      return user;
    },

    // Returns the plain token once; only its hash is kept.
    issueClient(userId, { label, ttlDays = null } = {}) {
      if (!store.getPeerUser(userId)) throw new Error("unknown user");
      const token = `grf_${crypto.randomBytes(32).toString("base64url")}`;
      const id = crypto.randomUUID();
      const expiresAt = ttlDays ? new Date(now() + Number(ttlDays) * 86_400_000).toISOString() : null;
      store.addPeerClient({ id, userId, label: String(label || "client").slice(0, 80), tokenHash: hashToken(token), expiresAt });
      return { id, token, expiresAt };
    },

    // -> { userId, clientId, caller } | { error, status }
    authenticate(header) {
      const match = /^Bearer\s+(\S+)$/i.exec(String(header || "").trim());
      if (!match) return { error: "missing bearer token", status: 401 };
      const client = store.peerClientByHash(hashToken(match[1]));
      if (!client || client.revoked_at) return { error: "invalid token", status: 401 };
      if (client.expires_at && Date.parse(client.expires_at) <= now()) return { error: "token expired", status: 401 };
      const user = store.getPeerUser(client.user_id);
      if (!user?.enabled) return { error: "user disabled", status: 403 };
      if (rateLimited(client.id)) return { error: "rate limited", status: 429 };
      store.touchPeerClient(client.id);
      return { userId: user.id, clientId: client.id, caller: peerCaller(user.id), label: user.label };
    },

    // Invite link: whoever opens it (once, before it expires) gets a fresh client token. Only the
    // hash of the code is kept and the token is minted at pickup, so no token sits in storage.
    createPickup(userId, { label = "invite", ttlHours = 24 } = {}) {
      if (!store.getPeerUser(userId)) throw new Error("unknown user");
      const code = crypto.randomBytes(24).toString("base64url");
      const expiresAt = new Date(now() + Number(ttlHours) * 3_600_000).toISOString();
      store.setKv(`pickup:${hashToken(code)}`, { userId, label: String(label).slice(0, 80), expiresAt });
      return { code, expiresAt };
    },

    // Owner-driven onboarding in one step: register the peer (default quota), mint the MCP token
    // and store it in the peer's OWN Infisical project. The token travels app→broker on the unix
    // socket only — never through the model, never in a tool result, never in events. What comes
    // back is where the secret lives, so the owner's standing rule (secrets move only through the
    // secret manager) holds by construction.
    inviteTool({ callBroker, key = "GRIFFIN_MCP_TOKEN", environment = "prod", secretPath = "/" } = {}) {
      if (typeof callBroker !== "function") throw new Error("inviteTool needs callBroker");
      return {
        name: PEER_INVITE_TOOL,
        description:
          "Invite a colleague as a peer agent (owner asks only): register them with the default read-only quota, mint their Griffin MCP token and store it in their own Infisical project. The token itself never appears anywhere — the result says the project/path/key to tell them, plus how to connect. Prefer their existing Infisical project name as id.",
        inputSchema: {
          type: "object",
          properties: {
            id: { type: "string", description: "identity slug (a-z, 0-9, -) — usually their secret-manager project name, e.g. sara-karimi" },
            label: { type: "string", description: "Persian display name, e.g. آقای ساجدی" },
            projectId: { type: "string", description: "Infisical project id; omit to resolve by project name = id" },
          },
          required: ["id", "label"],
          additionalProperties: false,
        },
        async execute(args) {
          const userId = String(args?.id || "").trim().toLowerCase();
          if (!USER_ID.test(userId)) return { isError: true, content: [{ type: "text", text: "invalid id: a-z, 0-9, - (2+ chars)" }] };
          const label = String(args?.label || "").trim().slice(0, 80) || userId;

          let projectId = String(args?.projectId || "").trim() || null;
          if (!projectId) {
            const projects = await callBroker("infisical_projects", {});
            const match = (projects?.projects || []).find((p) => String(p.name) === userId);
            if (!match) {
              return {
                isError: true,
                content: [{ type: "text", text: `no Infisical project named "${userId}" — pass projectId, or create their project first. Visible projects: ${(projects?.projects || []).map((p) => p.name).join(", ")}` }],
              };
            }
            projectId = match.id;
          }

          const created = !store.getPeerUser(userId);
          if (created) api.createUser({ id: userId, label });
          const client = api.issueClient(userId, { label: "griffin MCP (via Infisical)" });
          try {
            await callBroker("infisical_upsert", {
              name: key,
              value: client.token,
              projectId,
              environment,
              path: secretPath,
              comment: `Griffin MCP bearer token for ${userId} (peer_invite)`,
            });
          } catch (error) {
            return { isError: true, content: [{ type: "text", text: `peer registered and token minted, but the Infisical write failed: ${error.message} — re-run peer_invite` }] };
          }

          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                peer: userId,
                label,
                created,
                clientId: client.id,
                secret: { manager: "infisical", projectId, environment, path: secretPath, key },
                howToTellThem: `توکن MCP گریفین در Infisical پروژهٔ خودت (${projectId}، ${environment}، مسیر ${secretPath}، کلید ${key}) است؛ اتصال: POST https://<griffin-host>/mcp با هدر Authorization: Bearer <همان توکن>. سهمیه فعلی فقط خواندنی/تشخیصی است.`,
              }),
            }],
          };
        },
      };
    },

    // -> { token, label } once; null when unknown, used or expired.
    redeemPickup(code) {
      const key = `pickup:${hashToken(code)}`;
      const entry = store.getKv(key);
      if (!entry) return null;
      store.db.prepare("DELETE FROM kv WHERE key = ?").run(key);
      if (Date.parse(entry.expiresAt) <= now() || !store.getPeerUser(entry.userId)?.enabled) return null;
      const { token } = api.issueClient(entry.userId, { label: `${entry.label} (invite)` });
      return { token, label: entry.label, userId: entry.userId };
    },

    // Hono middleware: sets c.var.peer, answers 401/403/429 otherwise.
    middleware() {
      return async (c, next) => {
        const result = api.authenticate(c.req.header("authorization"));
        if (result.error) {
          if (result.status === 401) c.header("WWW-Authenticate", 'Bearer realm="griffin"');
          return c.json({ error: result.error }, result.status);
        }
        c.set("peer", result);
        return next();
      };
    },

    // Owner-only admin API (mounted under /api, behind the owner cookie).
    routes(app, { selfMgmtTools = [] } = {}) {
      const quotasOf = (userId) => {
        const caller = peerCaller(userId);
        return store.listAgentProfiles().map((p) => ({ agent: p.id, label: p.label, tools: p.meta?.callers?.[caller]?.tools || null }));
      };
      app.get("/api/peers", (c) =>
        c.json({
          users: store.listPeerUsers().map((u) => ({
            ...u,
            enabled: Boolean(u.enabled),
            caller: peerCaller(u.id),
            clients: store.listPeerClients(u.id),
            quotas: quotasOf(u.id),
          })),
        }),
      );
      // What this peer's client actually sent us — the only record of a call that failed before a
      // task existed (bad tool name, malformed arguments, a client that only ever handshakes).
      app.get("/api/peers/:id/calls", (c) => {
        const userId = c.req.param("id");
        if (!store.getPeerUser(userId)) return c.json({ error: "not found" }, 404);
        return c.json({ calls: store.listPeerCalls(userId, { limit: Number(c.req.query("limit")) || 50 }) });
      });
      app.get("/api/peers/:id/tasks", (c) => {
        const userId = c.req.param("id");
        if (!store.getPeerUser(userId)) return c.json({ error: "not found" }, 404);
        const tasks = store.listTasks(userId, { limit: 50 }).map((t) => ({
          id: t.id,
          chatId: t.chat_id,
          clientId: t.client_id,
          state: t.state,
          reason: t.state_reason,
          title: store.getChat(t.chat_id)?.title || null,
          createdAt: t.created_at,
          updatedAt: t.updated_at,
        }));
        return c.json({ tasks });
      });
      // Replace one agent's quota for this peer. null/[] removes it (fail closed).
      app.put("/api/peers/:id/quota", async (c) => {
        const userId = c.req.param("id");
        if (!store.getPeerUser(userId)) return c.json({ error: "not found" }, 404);
        const body = await c.req.json().catch(() => ({}));
        const profile = store.getAgentProfile(String(body.agent || ""));
        if (!profile) return c.json({ error: "unknown agent" }, 400);
        const tools = Array.isArray(body.tools) ? [...new Set(body.tools.map(String))] : [];
        const forbidden = tools.filter((t) => selfMgmtTools.includes(t) || t === "*");
        if (forbidden.length) return c.json({ error: `not grantable to a peer: ${forbidden.join(", ")}` }, 400);
        const callers = { ...(profile.meta?.callers || {}) };
        if (tools.length) callers[peerCaller(userId)] = { tools };
        else delete callers[peerCaller(userId)];
        store.updateAgentProfile(profile.id, { meta: { callers } });
        return c.json({ quotas: quotasOf(userId) });
      });
      app.post("/api/peers", async (c) => {
        const body = await c.req.json().catch(() => ({}));
        try {
          return c.json({ user: api.createUser(body) }, 201);
        } catch (error) {
          return c.json({ error: error.message }, 400);
        }
      });
      app.patch("/api/peers/:id", async (c) => {
        const body = await c.req.json().catch(() => ({}));
        if (!store.getPeerUser(c.req.param("id"))) return c.json({ error: "not found" }, 404);
        if (body.enabled !== undefined) store.setPeerUserEnabled(c.req.param("id"), Boolean(body.enabled));
        return c.json({ user: store.getPeerUser(c.req.param("id")) });
      });
      app.post("/api/peers/:id/clients", async (c) => {
        const body = await c.req.json().catch(() => ({}));
        try {
          return c.json(api.issueClient(c.req.param("id"), body), 201);
        } catch (error) {
          return c.json({ error: error.message }, 400);
        }
      });
      app.post("/api/peers/:id/pickups", async (c) => {
        const body = await c.req.json().catch(() => ({}));
        try {
          const { code, expiresAt } = api.createPickup(c.req.param("id"), body);
          return c.json({ url: `${publicUrl}/peer/pickup/${code}`, expiresAt }, 201);
        } catch (error) {
          return c.json({ error: error.message }, 400);
        }
      });
      // Public: GET only shows a button (link previews must not consume it); POST redeems once.
      app.get("/peer/pickup/:code", (c) => {
        c.header("Cache-Control", "no-store");
        return c.html(pickupPage({ code: c.req.param("code") }));
      });
      app.post("/peer/pickup/:code", (c) => {
        c.header("Cache-Control", "no-store");
        const got = api.redeemPickup(c.req.param("code"));
        return c.html(pickupPage(got ? { token: got.token, mcpUrl: `${publicUrl}/mcp` } : { gone: true }), got ? 200 : 410);
      });
      app.delete("/api/peers/:id/clients/:clientId", (c) =>
        store.revokePeerClient(c.req.param("id"), c.req.param("clientId"))
          ? c.json({ ok: true })
          : c.json({ error: "not found" }, 404),
      );
    },
  };
  return api;
}
