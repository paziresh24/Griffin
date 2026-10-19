import crypto from "node:crypto";

// Ported from Karsara (apps/server/src/zai-account.mjs). Griffin differences: the two JWTs live in
// Griffin's secret store (secrets.mjs, "zai/zcode-jwt" and "zai/account-jwt") and the account name
// in kv; requests go through fetch so Griffin's proxy settings apply.

// Z.ai account sign-in (OAuth) + coding-plan quota reset. Contract read from the open-source
// ZCode client (github.com/zai-org/ZCode, 2026-10-04): packages/services/src/oauth/oauthService.ts
// (cli/init + cli/poll), providers/zaiBusinessTokenResolver.ts (/api/auth/z/login) and
// usage-stats/providers/bigmodelUsageQuotaProvider.ts (coding-plan/reset/status|use).
//   sign-in  POST https://zcode.z.ai/api/v1/oauth/cli/init            {"provider":"zai"} · Authorization: Bearer <random poll token>
//            GET  https://zcode.z.ai/api/v1/oauth/cli/poll/<flowId>    same Bearer → {status:"pending"|"failed"|"ready",
//                                                                        ready: {token:<zcode JWT>, zai:{access_token}, user}}
//            POST https://api.z.ai/api/auth/z/login                    {"token":<zai access_token>} → {data:{access_token}}
//   status   GET  https://zcode.z.ai/api/v1/coding-plan/reset/status   Authorization: Bearer <zcode JWT> ·
//            X-Bigmodel-Authorization: <business JWT, raw, no Bearer> · Bigmodel-Target-Type: PERSONAL
//            → {available_five_hour_resets:[{expire_at}], available_week_resets:[…], …}
//   use      POST https://zcode.z.ai/api/v1/coding-plan/reset/use      {"idempotency_key":<uuid>,"reset_type":"FIVE_HOUR"|"WEEK"}
// The plain API key answers 401 on all of these (probed live 2026-10-04) — reset cards belong to
// the signed-in account, which is why Griffin needs a one-time «ورود با Z.ai» before the buttons
// in the usage popover can work. Tokens live only in the encrypted provider-key store; nothing
// here logs one.

const ZCODE_ORIGIN = "https://zcode.z.ai";
const ZAI_ORIGIN = "https://api.z.ai";
const TIMEOUT_MS = 15_000;

export const RESET_TYPES = ["FIVE_HOUR", "WEEK"];

/** One JSON request; an HTTP error carries its status and, when Z.ai sent one, its message. */
async function fetchJson(url, { method = "GET", headers = {}, body, timeoutMs = TIMEOUT_MS } = {}) {
  const res = await fetch(url, {
    method,
    headers: { Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}), ...headers },
    body: body ? (typeof body === "string" ? body : JSON.stringify(body)) : undefined,
    redirect: "error",
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  if (text.length > 262_144) throw new Error("response too large");
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    throw Object.assign(new Error(`HTTP ${res.status}, response was not JSON`), { status: res.status });
  }
  if (res.status >= 400) {
    const detail = payload && typeof payload === "object" ? payload.msg || payload.error || payload.message : "";
    throw Object.assign(new Error(`HTTP ${res.status}${detail ? `: ${String(detail).slice(0, 200)}` : ""}`), { status: res.status, payload });
  }
  return payload;
}

const str = (v) => (typeof v === "string" && v.trim() ? v.trim() : "");
const isRecord = (v) => Boolean(v) && typeof v === "object" && !Array.isArray(v);

export function parseCliInit(envelope) {
  const data = isRecord(envelope) && envelope.code === 0 && isRecord(envelope.data) ? envelope.data : null;
  const flowId = str(data?.flow_id);
  const authorizeUrl = str(data?.authorize_url);
  if (!data || !flowId || !authorizeUrl || !Number.isFinite(data.expires_at) || !Number.isFinite(data.poll_interval_sec)) {
    return { error: isRecord(envelope) && str(envelope.msg) ? str(envelope.msg) : "invalid response" };
  }
  return { flowId, authorizeUrl, expiresAtMs: data.expires_at * 1_000, pollIntervalMs: Math.max(1, data.poll_interval_sec) * 1_000 };
}

export function parseCliPoll(envelope) {
  if (!isRecord(envelope)) return { error: "invalid response" };
  if (envelope.code !== 0) return { error: str(envelope.msg) || "invalid response" };
  if (!isRecord(envelope.data)) return { error: "invalid response" };
  const data = envelope.data;
  const status = str(data.status);
  if (status === "pending") return { status: "pending" };
  if (status === "failed") return { status: "failed", error: str(envelope.msg) || "OAuth flow 授权失败" };
  if (status !== "ready") return { error: "invalid response" };
  const zcodeJwt = str(data.token);
  const oauthToken = str(isRecord(data.zai) ? data.zai.access_token : "");
  if (!zcodeJwt || !oauthToken) return { error: "invalid response" };
  const user = isRecord(data.user) ? data.user : {};
  return {
    status: "ready",
    zcodeJwt,
    oauthToken,
    user: { id: str(user.user_id), name: str(user.name), email: str(user.email), avatar: str(user.avatar) },
  };
}

// Success codes follow ZCode's isSuccessfulZaiBusinessCode: 0/200 as number or string, or no
// code at all — Z.ai's login answers {code:200,...} (seen 2026-10-05, when the owner's sign-in
// reached Authorization Successful and karsara still reported failure). Failures carry their
// cause, so a broken sign-in says why instead of one opaque label.
const businessCodeOk = (code) => code == null || code === 0 || code === 200 || code === "0" || code === "200";

export function parseBusinessLogin(envelope) {
  if (!isRecord(envelope)) return { error: "invalid response" };
  if (!businessCodeOk(envelope.code) || envelope.success === false) {
    const cause = str(envelope.msg) || (envelope.code != null ? `code ${envelope.code}` : "no code");
    return { error: `zai login failed: ${cause}`.slice(0, 200) };
  }
  const data = isRecord(envelope.data) ? envelope.data : null;
  const token = data ? str(data.access_token) || str(data.accessToken) : "";
  if (!token) return { error: "zai login: no access_token in response" };
  return { token };
}

export function parseResetStatus(envelope) {
  // ZCode tolerates both the full envelope and the bare data object; so do we.
  const data = isRecord(envelope) && (isRecord(envelope.data) || "available_five_hour_resets" in envelope)
    ? (isRecord(envelope.data) ? envelope.data : envelope)
    : null;
  if (!data) {
    const status = isRecord(envelope) && Number.isFinite(envelope.code) ? envelope.code : null;
    return { error: status ? `HTTP ${status}` : "invalid response" };
  }
  const resets = (v) => (Array.isArray(v) ? v.filter((r) => isRecord(r) && Number.isFinite(r.expire_at)).map((r) => ({ expireAt: r.expire_at })) : []);
  const at = (v) => (isRecord(v) && Number.isFinite(v.used_at) ? v.used_at : null);
  return {
    fiveHour: resets(data.available_five_hour_resets),
    week: resets(data.available_week_resets),
    latestFiveHourAt: at(data.latest_five_hour_reset_history),
    latestWeekAt: at(data.latest_week_reset_history),
  };
}

function resetHeaders({ zcodeJwt, accountJwt }) {
  // Header contract copied from ZCode's createCodingPlanResetHeaders: the zcode JWT rides the
  // usual Authorization as Bearer, the coding-plan JWT goes raw in X-Bigmodel-Authorization.
  return {
    Authorization: `Bearer ${zcodeJwt}`,
    "X-Bigmodel-Authorization": accountJwt,
    "Bigmodel-Target-Type": "PERSONAL",
  };
}

/**
 * The owner-facing service: start/poll the sign-in, keep both JWTs in the encrypted key store,
 * and answer reset-count/use questions. The pending sign-in flow lives in memory only — a
 * restart mid-sign-in just means signing in again.
 */
export function createZaiAccount({ secrets, info, now = () => Date.now(), request = fetchJson } = {}) {
  let flow = null; // {flowId, pollToken, expiresAtMs, pollIntervalMs}
  let cachedStatus = null; // {at, value}
  const ZCODE_KEY = "zai/zcode-jwt";
  const ACCOUNT_KEY = "zai/account-jwt";

  const jwts = () => {
    const zcodeJwt = secrets.get(ZCODE_KEY);
    const accountJwt = secrets.get(ACCOUNT_KEY);
    return zcodeJwt && accountJwt ? { zcodeJwt, accountJwt } : null;
  };

  const accountInfo = () => info.get();

  async function exchangeBusinessToken(oauthToken) {
    const envelope = await request(`${ZAI_ORIGIN}/api/auth/z/login`, { method: "POST", body: { token: oauthToken } });
    const parsed = parseBusinessLogin(envelope);
    if (parsed.error) throw new Error(parsed.error);
    return parsed.token;
  }

  return {
    connected() {
      const info = accountInfo();
      const hasTokens = Boolean(jwts());
      return { connected: hasTokens, name: hasTokens ? info?.name || null : null, email: hasTokens ? info?.email || null : null };
    },

    async start() {
      const pollToken = crypto.randomBytes(32).toString("hex");
      const envelope = await request(`${ZCODE_ORIGIN}/api/v1/oauth/cli/init`, {
        method: "POST",
        headers: { Authorization: `Bearer ${pollToken}` },
        body: { provider: "zai" },
      });
      const parsed = parseCliInit(envelope);
      if (parsed.error) throw new Error(parsed.error);
      flow = { flowId: parsed.flowId, pollToken, expiresAtMs: parsed.expiresAtMs, pollIntervalMs: parsed.pollIntervalMs };
      return { authorizeUrl: parsed.authorizeUrl, expiresAtMs: parsed.expiresAtMs };
    },

    /** One poll step. The frontend calls this every few seconds until ready/failed. */
    async poll() {
      if (!flow) return { status: "idle" };
      if (now() >= flow.expiresAtMs) {
        flow = null;
        return { status: "failed", error: "flow expired" };
      }
      let envelope;
      try {
        envelope = await request(`${ZCODE_ORIGIN}/api/v1/oauth/cli/poll/${encodeURIComponent(flow.flowId)}`, {
          headers: { Authorization: `Bearer ${flow.pollToken}` },
        });
      } catch (error) {
        // A single network hiccup must not kill the sign-in — report it as still pending.
        if (error?.status >= 400 && error?.status < 500 && error?.status !== 408 && error?.status !== 429) {
          const message = String(error?.message || error).slice(0, 200);
          flow = null;
          return { status: "failed", error: message };
        }
        return { status: "pending" };
      }
      const parsed = parseCliPoll(envelope);
      if (parsed.status === "pending") return { status: "pending" };
      flow = null;
      if (parsed.status === "failed") return { status: "failed", error: parsed.error || "sign-in failed" };
      if (parsed.error) return { status: "failed", error: parsed.error };
      const accountJwt = await exchangeBusinessToken(parsed.oauthToken);
      secrets.set(ZCODE_KEY, parsed.zcodeJwt, { note: "Z.ai sign-in (ZCode)" });
      secrets.set(ACCOUNT_KEY, accountJwt, { note: "Z.ai sign-in (coding plan)" });
      info.set({ id: parsed.user.id, name: parsed.user.name, email: parsed.user.email, connectedAt: new Date(now()).toISOString() });
      cachedStatus = null;
      return { status: "ready", name: parsed.user.name || parsed.user.email || parsed.user.id };
    },

    cancelSignIn() {
      flow = null;
    },

    signOut() {
      secrets.delete(ZCODE_KEY);
      secrets.delete(ACCOUNT_KEY);
      info.set(null);
      cachedStatus = null;
    },

    /** Reset-card counts; cached 60 s so the usage popover can poll freely. */
    async resetSummary({ fresh = false } = {}) {
      const tokens = jwts();
      if (!tokens) return { connected: false };
      if (!fresh && cachedStatus && now() - cachedStatus.at < 60_000) return cachedStatus.value;
      try {
        const envelope = await request(`${ZCODE_ORIGIN}/api/v1/coding-plan/reset/status`, { headers: resetHeaders(tokens) });
        const parsed = parseResetStatus(envelope);
        if (parsed.error) throw new Error(parsed.error);
        const value = {
          connected: true,
          fiveHour: parsed.fiveHour.length,
          week: parsed.week.length,
          fiveHourExpireAt: parsed.fiveHour[0] ? new Date(parsed.fiveHour[0].expireAt).toISOString() : null,
          weekExpireAt: parsed.week[0] ? new Date(parsed.week[0].expireAt).toISOString() : null,
          latestFiveHourAt: parsed.latestFiveHourAt ? new Date(parsed.latestFiveHourAt).toISOString() : null,
          latestWeekAt: parsed.latestWeekAt ? new Date(parsed.latestWeekAt).toISOString() : null,
        };
        cachedStatus = { at: now(), value };
        return value;
      } catch (error) {
        const value = { connected: true, error: String(error?.message || error).slice(0, 200) };
        cachedStatus = { at: now(), value };
        return value;
      }
    },

    /** Consume one reset card. Guards on a FRESH status read so an empty wallet never fires. */
    async use({ resetType }) {
      if (!RESET_TYPES.includes(resetType)) return { error: "invalid resetType" };
      const tokens = jwts();
      if (!tokens) return { error: "not_connected" };
      const envelope = await request(`${ZCODE_ORIGIN}/api/v1/coding-plan/reset/status`, { headers: resetHeaders(tokens) });
      const status = parseResetStatus(envelope);
      if (status.error) return { error: "status_failed", detail: status.error };
      const have = resetType === "FIVE_HOUR" ? status.fiveHour.length : status.week.length;
      if (!have) return { error: "no_reset_available" };
      const useEnvelope = await request(`${ZCODE_ORIGIN}/api/v1/coding-plan/reset/use`, {
        method: "POST",
        headers: resetHeaders(tokens),
        body: { idempotency_key: crypto.randomUUID(), reset_type: resetType },
      });
      const code = isRecord(useEnvelope) ? useEnvelope.code : null;
      if (code !== 0 && code !== 200) {
        return { error: "reset_failed", detail: str(useEnvelope?.msg).slice(0, 200) || `code ${code}` };
      }
      cachedStatus = null;
      return { used: true };
    },
  };
}
