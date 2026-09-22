import { execFile } from "node:child_process";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);

// Keeps the local emergency OpenBao unsealed after restarts and host reboots. The unseal key is
// age-encrypted to the same quarantine identity the broker already holds, so this adds no new
// secret to the host; it only removes the manual step that left the vault sealed after a reboot.
export async function unsealOnce({ url, unsealAge, identity, ageBin = "age", fetchImpl = fetch, log = console }) {
  const status = await (await fetchImpl(`${url}/v1/sys/seal-status`, { signal: AbortSignal.timeout(5_000) })).json();
  if (!status.initialized) return "not-initialized";
  if (!status.sealed) return "unsealed";
  const { stdout } = await run(ageBin, ["-d", "-i", identity, unsealAge], { maxBuffer: 64 * 1024 });
  const key = stdout.trim();
  if (!key) throw new Error("unseal key empty");
  const response = await fetchImpl(`${url}/v1/sys/unseal`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ key }),
    signal: AbortSignal.timeout(10_000),
  });
  const after = await response.json();
  if (!response.ok || after.sealed) throw new Error(`unseal failed http_${response.status}`);
  log.info?.("[unseal] vault was sealed; unsealed");
  return "unsealed-now";
}

async function main() {
  const { genv } = await import("./env.mjs");
  const options = {
    url: genv("BAO_URL", "http://127.0.0.1:18200"),
    unsealAge: genv("UNSEAL_AGE", "/emergency-vault/unseal.b64.age"),
    identity: genv("AGE_IDENTITY", "/emergency-keys/quarantine.age"),
  };
  const intervalMs = Number(genv("UNSEAL_INTERVAL_MS", 15_000));
  let last = "";
  for (;;) {
    let state;
    try {
      state = await unsealOnce(options);
    } catch (error) {
      state = `error: ${error.cause?.code || error.message}`;
    }
    if (state !== last) console.log(`[unseal] ${state}`);
    last = state;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
