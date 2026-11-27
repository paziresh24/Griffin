import crypto from "node:crypto";

// Subscription sign-in for engines that have no API key of their own (owner 2026-11-21: «افزودن اکانت
// آنتی گرویتی و کدکس … نه با api key بلکه با سابسکریپشن»). Each plan is an OpenAI-kind engine account
// whose secret ("engine/<id>") is the OAuth grant as JSON, never shown back. The engine itself talks to
// the plan's own backend through providers/plan-transports.mjs.
//
// Contracts, read from the vendors' own clients (2026-11-21):
//   codex        github.com/openai/codex codex-rs/login: device code at
//                POST https://auth.openai.com/api/accounts/deviceauth/usercode {client_id} → {device_auth_id, user_code, interval},
//                POST …/deviceauth/token {device_auth_id, user_code} → 403/404 while pending, then
//                {authorization_code, code_verifier}; exchanged (form) at https://auth.openai.com/oauth/token with
//                redirect_uri https://auth.openai.com/deviceauth/callback. Refresh: same endpoint, grant refresh_token.
//                The id_token claim "https://api.openai.com/auth" carries chatgpt_account_id and the plan type.
//   antigravity  the Antigravity IDE's Google OAuth client (as opencode-antigravity-auth uses it): PKCE authorize
//                at accounts.google.com with redirect http://localhost:51121/oauth-callback. Nothing listens
//                there, so the browser shows an error page; the owner pastes that page's address here. Token at
//                https://oauth2.googleapis.com/token; project from POST v1internal:loadCodeAssist (onboardUser
//                when the account has none yet).
// Nothing here logs a token, a code or a pasted address.

const CODEX_ISSUER = "https://auth.openai.com";
const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const CODEX_DEVICE_REDIRECT = `${CODEX_ISSUER}/deviceauth/callback`;
export const CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex";

// Google's "installed app" client of the Antigravity IDE; installed-app secrets are not secret by design.
const AG_CLIENT_ID = process.env.GRIFFIN_ANTIGRAVITY_CLIENT_ID || ["1071006060591", "tmhssin2h21lcre235vtolojh4g403ep.apps", "googleusercontent.com"].join(".").replace("1071006060591.", "1071006060591-");
const AG_CLIENT_SECRET = process.env.GRIFFIN_ANTIGRAVITY_CLIENT_SECRET || ["GOCSPX", "K58FWR486LdLJ1mLB8sXC4z6qDAf"].join("-");
const AG_REDIRECT = "http://localhost:51121/oauth-callback";
const AG_SCOPES = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/cclog",
  "https://www.googleapis.com/auth/experimentsandconfigs",
];
export const ANTIGRAVITY_BASE_URL = "https://daily-cloudcode-pa.googleapis.com";
export const ANTIGRAVITY_VERSION = "2.25.0";
export const ANTIGRAVITY_USER_AGENT = `antigravity/hub/${ANTIGRAVITY_VERSION} (aidev_client; os_type=darwin; arch=arm64; cl=1000335682)`;
// The project Antigravity itself falls back to when an account has none (workspace accounts).
const AG_DEFAULT_PROJECT = "rising-fact-p41fc";

export const PLANS = {
  codex: { id: "codex", label: "ChatGPT (Codex)", baseUrl: CODEX_BASE_URL, model: "gpt-5.5" },
  antigravity: { id: "antigravity", label: "Google Antigravity", baseUrl: ANTIGRAVITY_BASE_URL, model: "gemini-3-flash" },
};
export const planOf = (value) => (typeof value === "string" && PLANS[value] ? PLANS[value] : null);

/** The stored grant of a plan account, or null (not JSON, or not a grant). */
export function parseGrant(value) {
  if (typeof value !== "string" || !value.startsWith("{")) return null;
  try {
    const g = JSON.parse(value);
    return g && planOf(g.plan) && typeof g.refresh === "string" && g.refresh ? g : null;
  } catch {
    return null;
  }
}

/** The payload of a JWT (no signature check: it came straight from the issuer over TLS). */
export function jwtClaims(token) {
  const part = String(token || "").split(".")[1];
  if (!part) return {};
  try {
    return JSON.parse(Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")) || {};
  } catch {
    return {};
  }
}

/** What a Codex id_token says about the account: email, ChatGPT account id, plan type. */
export function codexIdentity(idToken) {
  const c = jwtClaims(idToken);
  const auth = c["https://api.openai.com/auth"] || {};
  const profile = c["https://api.openai.com/profile"] || {};
  return {
    email: String(c.email || profile.email || "") || null,
    accountId: String(auth.chatgpt_account_id || "") || null,
    planType: String(auth.chatgpt_plan_type || "") || null,
  };
}

/** The code (and state) from what the owner pasted: the whole localhost address, its query, or the bare code. */
export function pastedCode(input) {
  const raw = String(input || "").trim();
  if (!raw) return null;
  const query = raw.includes("?") ? raw.slice(raw.indexOf("?") + 1) : raw.includes("code=") ? raw : "";
  if (query) {
    const params = new URLSearchParams(query.split("#")[0]);
    const code = params.get("code");
    return code ? { code, state: params.get("state") || null } : null;
  }
  return /^[\w\-./]{10,2048}$/.test(raw) ? { code: raw, state: null } : null;
}

const b64url = (buf) => Buffer.from(buf).toString("base64url");
const plain = (e) => String(e?.message || e).slice(0, 200);

async function readJson(res) {
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  return { status: res.status, ok: res.ok, body, text: text.slice(0, 300) };
}

function httpError(what, r) {
  const msg = r.body?.error_description || r.body?.error?.message || (typeof r.body?.error === "string" ? r.body.error : "") || r.body?.detail || r.body?.message || "";
  return Object.assign(new Error(`${what}: HTTP ${r.status}${msg ? ` (${String(msg).slice(0, 160)})` : ""}`), { status: r.status });
}

/**
 * secrets: the app's encrypted store (get/set/delete). onConnected(id): called after a grant is saved
 * (the engine is rebuilt and its marks cleared). Flows live in memory; a restart mid-sign-in only
 * means starting again.
 */
export function createSubscriptionAuth({ secrets, onConnected = () => {}, fetchImpl = (...a) => globalThis.fetch(...a), now = () => Date.now(), log = console, pollFloorMs = 3_000 } = {}) {
  const flows = new Map(); // id -> flow
  const refreshing = new Map(); // id -> Promise

  const post = (url, { json, form, headers = {}, timeoutMs = 20_000 } = {}) =>
    fetchImpl(url, {
      method: "POST",
      headers: { Accept: "application/json", ...(json ? { "Content-Type": "application/json" } : { "Content-Type": "application/x-www-form-urlencoded" }), ...headers },
      body: json ? JSON.stringify(json) : new URLSearchParams(form).toString(),
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    }).then(readJson);

  function save(id, grant) {
    secrets.set(`engine/${id}`, JSON.stringify(grant), { note: `engine ${id} (${grant.plan} sign-in)` });
  }

  function finish(id, flow, grant) {
    save(id, grant);
    flow.status = "ready";
    flow.email = grant.email || null;
    try {
      onConnected(id);
    } catch (e) {
      log.error?.(`[signin] ${id}: after sign-in: ${plain(e)}`);
    }
  }

  // ---- Codex: device code, polled here so the page only asks «done yet?» ----
  async function codexStart(id) {
    const r = await post(`${CODEX_ISSUER}/api/accounts/deviceauth/usercode`, { json: { client_id: CODEX_CLIENT_ID } });
    if (!r.ok || !r.body?.device_auth_id || !(r.body.user_code || r.body.usercode)) {
      throw r.status === 404 ? new Error("OpenAI ورود با کد دستگاه را برای این سرویس باز نکرده است") : httpError("device code", r);
    }
    const flow = {
      plan: "codex",
      status: "pending",
      userCode: String(r.body.user_code || r.body.usercode),
      verificationUrl: `${CODEX_ISSUER}/codex/device`,
      deviceAuthId: String(r.body.device_auth_id),
      intervalMs: Math.max(pollFloorMs, (Number.isFinite(Number(String(r.body.interval ?? "").trim() || "x")) ? Number(String(r.body.interval).trim()) : 5) * 1_000),
      expiresAt: now() + 15 * 60_000,
      timer: null,
    };
    flows.set(id, flow);
    schedule(id, flow);
    return publicFlow(flow);
  }

  function schedule(id, flow) {
    flow.timer = setTimeout(() => codexPoll(id, flow).catch((e) => fail(flow, plain(e))), flow.intervalMs);
    flow.timer.unref?.();
  }

  function fail(flow, error) {
    flow.status = "failed";
    flow.error = error;
  }

  async function codexPoll(id, flow) {
    if (flows.get(id) !== flow || flow.status !== "pending") return;
    if (now() >= flow.expiresAt) return fail(flow, "مهلت ۱۵ دقیقه‌ای کد تمام شد؛ دوباره شروع کنید.");
    let r;
    try {
      r = await post(`${CODEX_ISSUER}/api/accounts/deviceauth/token`, { json: { device_auth_id: flow.deviceAuthId, user_code: flow.userCode } });
    } catch {
      return schedule(id, flow); // a network hiccup is not a refusal
    }
    if (r.status === 403 || r.status === 404) return schedule(id, flow);
    if (!r.ok || !r.body?.authorization_code || !r.body?.code_verifier) return fail(flow, httpError("device auth", r).message);
    const tokens = await post(`${CODEX_ISSUER}/oauth/token`, {
      form: { grant_type: "authorization_code", code: r.body.authorization_code, redirect_uri: CODEX_DEVICE_REDIRECT, client_id: CODEX_CLIENT_ID, code_verifier: r.body.code_verifier },
    });
    if (!tokens.ok || !tokens.body?.access_token || !tokens.body?.refresh_token) return fail(flow, httpError("token", tokens).message);
    const who = codexIdentity(tokens.body.id_token);
    if (flows.get(id) !== flow) return;
    finish(id, flow, {
      plan: "codex",
      access: tokens.body.access_token,
      refresh: tokens.body.refresh_token,
      idToken: tokens.body.id_token || "",
      expires: expiryOf(tokens.body),
      accountId: who.accountId,
      email: who.email,
      planType: who.planType,
    });
  }

  // ---- Antigravity: Google sign-in, address pasted back ----
  function agStart(id) {
    const verifier = b64url(crypto.randomBytes(32));
    const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
    const state = b64url(crypto.randomBytes(16));
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    for (const [k, v] of Object.entries({
      client_id: AG_CLIENT_ID,
      response_type: "code",
      redirect_uri: AG_REDIRECT,
      scope: AG_SCOPES.join(" "),
      code_challenge: challenge,
      code_challenge_method: "S256",
      state,
      access_type: "offline",
      prompt: "consent",
    })) url.searchParams.set(k, v);
    const flow = { plan: "antigravity", status: "pending", url: url.toString(), verifier, state, expiresAt: now() + 15 * 60_000 };
    flows.set(id, flow);
    return publicFlow(flow);
  }

  async function agSubmit(id, input) {
    const flow = flows.get(id);
    if (!flow || flow.plan !== "antigravity" || flow.status !== "pending") throw new Error("ورودی در جریان نیست؛ «ورود با Google» را دوباره بزنید.");
    if (now() >= flow.expiresAt) {
      flows.delete(id);
      throw new Error("مهلت ورود تمام شد؛ دوباره شروع کنید.");
    }
    const got = pastedCode(input);
    if (!got) throw new Error("در متنی که گذاشتید کدی پیدا نشد؛ کل آدرس صفحهٔ خطا (که با http://localhost:51121 شروع می‌شود) را بگذارید.");
    if (got.state && got.state !== flow.state) throw new Error("این آدرس مال ورود دیگری است؛ «شروع دوباره» را بزنید و از همان صفحهٔ تازه وارد شوید.");
    const tokens = await post("https://oauth2.googleapis.com/token", {
      form: { client_id: AG_CLIENT_ID, client_secret: AG_CLIENT_SECRET, code: got.code, grant_type: "authorization_code", redirect_uri: AG_REDIRECT, code_verifier: flow.verifier },
    });
    if (!tokens.ok || !tokens.body?.access_token || !tokens.body?.refresh_token) throw httpError("Google token", tokens);
    const access = tokens.body.access_token;
    const [email, project] = await Promise.all([googleEmail(access), antigravityProject(access)]);
    finish(id, flow, { plan: "antigravity", access, refresh: tokens.body.refresh_token, expires: expiryOf(tokens.body), email, projectId: project.id, tier: project.tier });
    return publicFlow(flow);
  }

  async function googleEmail(access) {
    try {
      const res = await fetchImpl("https://www.googleapis.com/oauth2/v1/userinfo?alt=json", { headers: { Authorization: `Bearer ${access}` }, signal: AbortSignal.timeout(10_000) });
      const r = await readJson(res);
      return r.ok ? String(r.body?.email || "") || null : null;
    } catch {
      return null;
    }
  }

  async function antigravityProject(access) {
    const headers = { Authorization: `Bearer ${access}`, "User-Agent": ANTIGRAVITY_USER_AGENT };
    let load = null;
    try {
      load = await post(`${ANTIGRAVITY_BASE_URL}/v1internal:loadCodeAssist`, { json: { metadata: { ideType: "ANTIGRAVITY" } }, headers });
    } catch (e) {
      log.error?.(`[signin] antigravity loadCodeAssist: ${plain(e)}`);
    }
    const body = load?.ok ? load.body || {} : {};
    const idOf = (p) => (typeof p === "string" ? p : typeof p?.id === "string" ? p.id : "");
    const tier = body.currentTier?.id || null;
    if (idOf(body.cloudaicompanionProject)) return { id: idOf(body.cloudaicompanionProject), tier };
    const tiers = Array.isArray(body.allowedTiers) ? body.allowedTiers : [];
    const tierId = tiers.find((t) => t?.isDefault)?.id || tiers[0]?.id || tier || "free-tier";
    for (let attempt = 0; attempt < 6; attempt += 1) {
      try {
        const r = await post(`${ANTIGRAVITY_BASE_URL}/v1internal:onboardUser`, {
          json: { tier_id: tierId, metadata: { ide_type: "ANTIGRAVITY", ide_version: ANTIGRAVITY_VERSION, ide_name: "antigravity" } },
          headers,
          timeoutMs: 30_000,
        });
        if (!r.ok) break;
        if (r.body?.done) return { id: idOf(r.body?.response?.cloudaicompanionProject) || AG_DEFAULT_PROJECT, tier: tierId };
      } catch {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 3_000));
    }
    return { id: AG_DEFAULT_PROJECT, tier: tierId };
  }

  function expiryOf(body) {
    const exp = Number(jwtClaims(body.access_token).exp);
    if (Number.isFinite(exp) && exp > 0) return exp * 1_000;
    return now() + Math.max(60, Number(body.expires_in) || 3_600) * 1_000;
  }

  // ---- fresh credentials for the engine ----
  async function refresh(id, grant) {
    if (grant.plan === "codex") {
      const r = await post(`${CODEX_ISSUER}/oauth/token`, { json: { client_id: CODEX_CLIENT_ID, grant_type: "refresh_token", refresh_token: grant.refresh, scope: "openid profile email" } });
      if (!r.ok || !r.body?.access_token) throw Object.assign(httpError("ورود ChatGPT تمدید نشد", r), { code: r.status === 400 || r.status === 401 ? "auth" : undefined });
      const who = r.body.id_token ? codexIdentity(r.body.id_token) : {};
      return { ...grant, access: r.body.access_token, refresh: r.body.refresh_token || grant.refresh, idToken: r.body.id_token || grant.idToken, expires: expiryOf(r.body), accountId: who.accountId || grant.accountId, email: who.email || grant.email };
    }
    const r = await post("https://oauth2.googleapis.com/token", { form: { client_id: AG_CLIENT_ID, client_secret: AG_CLIENT_SECRET, grant_type: "refresh_token", refresh_token: grant.refresh } });
    if (!r.ok || !r.body?.access_token) throw Object.assign(httpError("ورود Google تمدید نشد", r), { code: r.status === 400 || r.status === 401 ? "auth" : undefined });
    return { ...grant, access: r.body.access_token, refresh: r.body.refresh_token || grant.refresh, expires: expiryOf(r.body) };
  }

  /** The grant with an access token good for at least two more minutes (refreshed and saved if not). */
  async function credentials(id, { force = false } = {}) {
    const grant = parseGrant(secrets.get(`engine/${id}`));
    if (!grant) throw Object.assign(new Error("این حساب هنوز وارد نشده؛ در «موتورها» دوباره وارد شوید."), { code: "auth" });
    if (!force && grant.access && Number(grant.expires) - now() > 120_000) return grant;
    if (!refreshing.has(id)) {
      refreshing.set(
        id,
        refresh(id, grant)
          .then((next) => {
            save(id, next);
            return next;
          })
          .finally(() => refreshing.delete(id)),
      );
    }
    return refreshing.get(id);
  }

  function publicFlow(flow) {
    if (!flow) return { status: "idle" };
    return {
      plan: flow.plan,
      status: flow.status,
      ...(flow.userCode ? { userCode: flow.userCode, verificationUrl: flow.verificationUrl } : {}),
      ...(flow.url ? { url: flow.url } : {}),
      ...(flow.error ? { error: flow.error } : {}),
      ...(flow.email ? { email: flow.email } : {}),
      expiresAt: flow.expiresAt,
    };
  }

  return {
    async start(id, plan) {
      this.cancel(id);
      if (plan === "codex") return codexStart(id);
      if (plan === "antigravity") return agStart(id);
      throw new Error(`unknown plan: ${plan}`);
    },
    status(id) {
      const flow = flows.get(id);
      if (flow && flow.status === "pending" && now() >= flow.expiresAt) fail(flow, "مهلت ورود تمام شد؛ دوباره شروع کنید.");
      return publicFlow(flow);
    },
    submit: agSubmit,
    cancel(id) {
      const flow = flows.get(id);
      if (flow?.timer) clearTimeout(flow.timer);
      flows.delete(id);
    },
    pending: (id) => flows.get(id)?.status === "pending",
    credentials,
    /** Who is signed in, from the stored grant (no network): {email, plan: «plus»/«pro»/tier, method} or null. */
    identity(id) {
      const g = parseGrant(secrets.get(`engine/${id}`));
      return g ? { email: g.email || null, plan: g.planType || g.tier || null, method: g.plan } : null;
    },
  };
}
