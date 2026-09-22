import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

// Reads items from the capsule-local OpenBao. The machine token is age-encrypted on disk;
// only the broker container has the identity and the encrypted token mounted.
export function createVault({
  url = "http://127.0.0.1:18200",
  tokenAge = "/emergency-vault/machine.token.age",
  identity = "/emergency-keys/quarantine.age",
  ageBin = "age",
  ttlMs = 5 * 60_000,
  fetchImpl = fetch,
} = {}) {
  const cache = new Map();

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
      const hit = cache.get(slug);
      if (hit && Date.now() - hit.at < ttlMs) return hit.value;
      const response = await fetchImpl(`${url}/v1/emergency/data/items/${encodeURIComponent(slug)}`, {
        headers: { "X-Vault-Token": await machineToken(), Accept: "application/json" },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`emergency vault http_${response.status}`);
      const value = (await response.json())?.data?.data?.value;
      if (typeof value !== "string" || !value) throw new Error(`emergency vault item ${slug} empty`);
      cache.set(slug, { value, at: Date.now() });
      return value;
    },

    // Used by the vault-put CLI to store operator-issued credentials without exposing them.
    async put(slug, value) {
      if (typeof value !== "string" || !value) throw new Error("refusing to store an empty value");
      const response = await fetchImpl(`${url}/v1/emergency/data/items/${encodeURIComponent(slug)}`, {
        method: "POST",
        headers: { "X-Vault-Token": await machineToken(), "Content-Type": "application/json" },
        body: JSON.stringify({ data: { value } }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`emergency vault write http_${response.status}`);
      cache.delete(slug);
    },
  };
}
