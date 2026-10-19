import crypto from "node:crypto";

// Sign-in for the owner's http/sse MCP servers that use OAuth (Settings → MCP servers → «ورود», and
// the mcp_server_login tool). The standard MCP flow done by Griffin itself: discovery
// (/.well-known/oauth-protected-resource, then the authorization server's metadata), dynamic client
// registration, authorization code + PKCE (S256, public client), refresh. Griffin has no terminal
// for Claude Code's own /mcp, and its token cache is not a documented place to write — so the
// result goes where a server's credentials already go: the entry's `Authorization` header in
// ~/.claude.json (mcp-servers.mjs), which Claude Code sends from the next chat on. The full token
// set (incl. the refresh token) lives only in Griffin's secret store (secrets.mjs, «mcp-oauth/<name>»);
// no API or tool returns a value. ensureFresh() renews tokens that are about to expire.

const TIMEOUT_MS = 15_000;
const PENDING_MS = 10 * 60_000;
const SOON_MS = 10 * 60_000;
const DEFAULT_LIFETIME_S = 3600;
const key = (name) => `mcp-oauth/${name}`;
const b64url = (buf) => Buffer.from(buf).toString("base64url");

export function createMcpOauth({ mcp, secrets, fetchImpl = fetch, now = () => Date.now(), log = () => {} }) {
  const pending = new Map(); // state -> { name, verifier, clientId, tokenEndpoint, redirectUri, resource, at }

  async function request(url, init = {}) {
    const response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
    const text = await response.text();
    let body = {};
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = {};
    }
    return { ok: response.ok, status: response.status, body };
  }

  async function discover(serverUrl) {
    const u = new URL(serverUrl);
    let issuer = u.origin;
    for (const path of [`/.well-known/oauth-protected-resource${u.pathname === "/" ? "" : u.pathname}`, "/.well-known/oauth-protected-resource"]) {
      const r = await request(`${u.origin}${path}`).catch(() => null);
      if (r?.ok && r.body?.authorization_servers?.[0]) {
        issuer = String(r.body.authorization_servers[0]);
        break;
      }
    }
    const base = new URL(issuer);
    for (const path of ["/.well-known/oauth-authorization-server", "/.well-known/openid-configuration"]) {
      const r = await request(`${base.origin}${path}${base.pathname === "/" ? "" : base.pathname}`).catch(() => null);
      if (r?.ok && r.body?.authorization_endpoint && r.body?.token_endpoint) return r.body;
    }
    throw new Error("this server does not publish OAuth metadata (no sign-in needed, or it uses a fixed token)");
  }

  const serverOf = (name) => {
    const server = mcp.get(name);
    if (!server) throw new Error(`no MCP server named «${name}»`);
    if (!server.url || server.command) throw new Error("sign-in is for http/sse servers only");
    return server;
  };

  const load = (name) => {
    try {
      return JSON.parse(secrets.get(key(name)) || "null");
    } catch {
      return null;
    }
  };
  const save = (name, data) => secrets.set(key(name), JSON.stringify(data), { note: "MCP OAuth tokens" });

  function apply(name, data) {
    mcp.setHeader(name, "Authorization", `${data.tokenType === "bearer" || !data.tokenType ? "Bearer" : data.tokenType} ${data.accessToken}`);
  }

  function take(data, body, previous = {}) {
    if (!body.access_token) throw new Error("the server's token answer has no access_token");
    return {
      ...previous,
      ...data,
      accessToken: String(body.access_token),
      refreshToken: String(body.refresh_token || previous.refreshToken || ""),
      tokenType: String(body.token_type || "bearer").toLowerCase(),
      expiresAt: now() + (Number(body.expires_in) > 0 ? Number(body.expires_in) : DEFAULT_LIFETIME_S) * 1000,
    };
  }

  const form = (obj) => ({ method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body: new URLSearchParams(obj).toString() });

  return {
    /** -> { url }: where the owner signs in. */
    async start({ name, redirectUri }) {
      const server = serverOf(name);
      if (!/^https?:\/\/[^\s/]+\/api\/mcp-oauth\/callback$/.test(redirectUri)) throw new Error("bad redirect address");
      const meta = await discover(server.url);
      let clientId = load(name)?.redirectUri === redirectUri ? load(name)?.clientId : "";
      if (!clientId) {
        if (!meta.registration_endpoint) throw new Error("this server needs a client registered by hand (no dynamic registration)");
        const r = await request(meta.registration_endpoint, {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify({ client_name: "Griffin", redirect_uris: [redirectUri], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" }),
        });
        clientId = r.body?.client_id;
        if (!r.ok || !clientId) throw new Error(`client registration failed (${r.status})`);
      }
      for (const [state, p] of pending) if (now() - p.at > PENDING_MS) pending.delete(state);
      const state = b64url(crypto.randomBytes(24));
      const verifier = b64url(crypto.randomBytes(32));
      pending.set(state, { name, verifier, clientId, tokenEndpoint: meta.token_endpoint, redirectUri, resource: server.url, at: now() });
      const url = new URL(meta.authorization_endpoint);
      for (const [k, v] of Object.entries({ response_type: "code", client_id: clientId, redirect_uri: redirectUri, state, code_challenge: b64url(crypto.createHash("sha256").update(verifier).digest()), code_challenge_method: "S256", resource: server.url })) url.searchParams.set(k, v);
      return { url: url.toString() };
    },

    /** The browser came back with ?code&state. -> { name }. */
    async finish({ state, code }) {
      const p = pending.get(String(state || ""));
      pending.delete(String(state || ""));
      if (!p || now() - p.at > PENDING_MS) throw new Error("this sign-in link expired; start again");
      if (!code) throw new Error("no code in the answer");
      const r = await request(p.tokenEndpoint, form({ grant_type: "authorization_code", code: String(code), redirect_uri: p.redirectUri, client_id: p.clientId, code_verifier: p.verifier, resource: p.resource }));
      if (!r.ok) throw new Error(`the server refused the code (${r.status}${r.body?.error ? ` ${r.body.error}` : ""})`);
      const data = take({ clientId: p.clientId, redirectUri: p.redirectUri, tokenEndpoint: p.tokenEndpoint, resource: p.resource }, r.body);
      save(p.name, data);
      apply(p.name, data);
      return { name: p.name };
    },

    /** Renews every login whose token ends soon, and puts the stored token back in the entry's header. */
    async ensureFresh() {
      for (const server of mcp.list()) {
        const data = load(server.name);
        if (!data) continue;
        try {
          let current = data;
          if (data.refreshToken && data.expiresAt - now() < SOON_MS) {
            const r = await request(data.tokenEndpoint, form({ grant_type: "refresh_token", refresh_token: data.refreshToken, client_id: data.clientId, resource: data.resource }));
            if (!r.ok) throw new Error(`refresh refused (${r.status}${r.body?.error ? ` ${r.body.error}` : ""})`);
            current = take(data, r.body, data);
            save(server.name, current);
          }
          apply(server.name, current);
        } catch (error) {
          log(`mcp-oauth ${server.name}: ${error.message}`);
        }
      }
    },

    status(name) {
      const data = load(name);
      return data ? { signedIn: true, expiresAt: new Date(data.expiresAt).toISOString() } : { signedIn: false };
    },
    forget(name) {
      return secrets.delete(key(name));
    },
    rename(from, to) {
      const data = load(from);
      if (!data) return;
      save(to, data);
      secrets.delete(key(from));
    },
  };
}
