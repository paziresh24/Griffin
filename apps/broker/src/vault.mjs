import { execFile } from "node:child_process";
import { statSync } from "node:fs";
import { promisify } from "node:util";

const run = promisify(execFile);

// Reads items from the host-local OpenBao. The machine token is age-encrypted on disk;
// only the broker container has the identity and the encrypted token mounted.
// local: the broker's own encrypted box (secretbox.mjs). Items set from the UI go there when no
// OpenBao is configured (url/token empty); reads check the box first, then OpenBao.
export function createVault({
  local = null,
  url = "http://127.0.0.1:18200",
  tokenAge = "/emergency-vault/machine.token.age",
  identity = "/emergency-keys/quarantine.age",
  ageBin = "age",
  ttlMs = 5 * 60_000,
  fetchImpl = fetch,
} = {}) {
  const cache = new Map();
  // What the app's incident intake reads from /healthz: a refused token or a failed renewal is an
  // incident before (and while) every tool fails with it.
  const health = { ok: true, ttlHours: null, error: null, at: null };
  const mark = (ok, error = null, ttl = undefined) => {
    Object.assign(health, { ok, error, at: new Date().toISOString() });
    if (ttl !== undefined) health.ttlHours = ttl === null ? null : Math.round(ttl / 3600);
  };
  // OpenBao counts only when its token and identity are actually mounted (a fresh install has none;
  // compose binds /dev/null there, which is not a file).
  const isFile = (f) => {
    try {
      return statSync(f).isFile();
    } catch {
      return false;
    }
  };
  const bao = Boolean(url && tokenAge && identity && isFile(tokenAge) && isFile(identity));

  async function machineToken() {
    try {
      const { stdout } = await run(ageBin, ["-d", "-i", identity, tokenAge], { maxBuffer: 64 * 1024 });
      const token = stdout.trim();
      if (!token) throw new Error("empty");
      return token;
    } catch {
      throw new Error("emergency vault token unavailable");
    }
  }

  return {
    async item(slug) {
      const own = local?.get(slug);
      if (own) return own;
      if (!bao) throw new Error(`secret ${slug} is not set (Settings → Secrets)`);
      const hit = cache.get(slug);
      if (hit && Date.now() - hit.at < ttlMs) return hit.value;
      const response = await fetchImpl(`${url}/v1/emergency/data/items/${encodeURIComponent(slug)}`, {
        headers: { "X-Vault-Token": await machineToken(), Accept: "application/json" },
        signal: AbortSignal.timeout(10_000),
      });
      if (response.status === 401 || response.status === 403) mark(false, `vault read refused (http_${response.status})`);
      if (!response.ok) throw new Error(`emergency vault http_${response.status}`);
      const value = (await response.json())?.data?.data?.value;
      if (typeof value !== "string" || !value) throw new Error(`emergency vault item ${slug} empty`);
      cache.set(slug, { value, at: Date.now() });
      return value;
    },

    // Used by the vault-put CLI to store operator-issued credentials without exposing them.
    async put(slug, value) {
      if (typeof value !== "string" || !value) throw new Error("refusing to store an empty value");
      if (!bao) {
        if (!local) throw new Error("no secret store configured");
        local.set(slug, value);
        return;
      }
      const response = await fetchImpl(`${url}/v1/emergency/data/items/${encodeURIComponent(slug)}`, {
        method: "POST",
        headers: { "X-Vault-Token": await machineToken(), "Content-Type": "application/json" },
        body: JSON.stringify({ data: { value } }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`emergency vault write http_${response.status}`);
      cache.delete(slug);
    },

    // Names only — never values. OpenBao listing needs a token with list on the metadata path.
    async list() {
      const items = (local?.list() || []).map((x) => ({ name: x.name, source: "broker", updatedAt: x.updatedAt, last4: x.last4 }));
      if (!bao) return { backend: "broker", items };
      try {
        const response = await fetchImpl(`${url}/v1/emergency/metadata/items?list=true`, {
          headers: { "X-Vault-Token": await machineToken(), Accept: "application/json" },
          signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) throw new Error(`http_${response.status}`);
        const keys = (await response.json())?.data?.keys || [];
        return { backend: "openbao", items: [...items, ...keys.filter((k) => !items.some((i) => i.name === k)).map((name) => ({ name, source: "openbao" }))] };
      } catch (error) {
        return { backend: "openbao", items, error: `cannot list OpenBao items (${error.message})` };
      }
    },

    // The machine token is periodic: it lives as long as it is renewed within its period. A token
    // with a max TTL that nothing renews eventually expires and every vault read goes 403.
    // Returns the remaining seconds, or null when there is no OpenBao.
    async renew() {
      if (!bao) return null;
      const response = await fetchImpl(`${url}/v1/auth/token/renew-self`, {
        method: "POST",
        headers: { "X-Vault-Token": await machineToken(), "Content-Type": "application/json" },
        body: "{}",
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) {
        mark(false, `renew refused (http_${response.status})`);
        throw new Error(`emergency vault renew http_${response.status}`);
      }
      const ttl = (await response.json())?.auth?.lease_duration ?? null;
      if (ttl !== null && ttl < 7 * 86_400) mark(false, `token expires in ${Math.round(ttl / 3600)}h and is not periodic`, ttl);
      else mark(true, null, ttl);
      return ttl;
    },

    state: () => ({ configured: bao, ...health }),

    async remove(slug) {
      cache.delete(slug);
      if (local?.delete(slug)) return true;
      if (!bao) return false;
      const response = await fetchImpl(`${url}/v1/emergency/metadata/items/${encodeURIComponent(slug)}`, {
        method: "DELETE",
        headers: { "X-Vault-Token": await machineToken() },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok && response.status !== 404) throw new Error(`emergency vault delete http_${response.status}`);
      return response.ok;
    },
  };
}
