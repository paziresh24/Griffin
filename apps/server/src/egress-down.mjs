import { reachableThrough } from "./vpn.mjs";

// A dead VPN used to reach the owner as «ورود یا کلید Claude پذیرفته نشد» or a raw network error
// (2026-11-04: two colleagues' installs, a vless server gone; the OAuth renewal and
// the API call both timed out through it). The login was fine. So before a failed run is worded as a
// login problem, ask the proxy itself: if it cannot open the engine's host, say that.
export const EGRESS_DOWN_CODE = "egress_down";

// Words a dead path produces: the CLI's own network errors, and the login errors it falls back to when
// the token renewal cannot reach the server.
const NETWORKISH = /unable to connect|connection error|connect(?:ion)? (?:refused|reset|timed out)|econn|etimedout|enotfound|eai_again|socket hang up|fetch failed|network|timed out|timeout|oauth|could not be refreshed|failed to authenticate|not logged in|\b401\b/i;
// Codes that already say what happened (a spent plan, a busy renewal, a gone session): never reworded.
const REWORDABLE = new Set([undefined, null, "", "auth_failed"]);

const HOSTS = { claude: "api.anthropic.com", cursor: "api2.cursor.sh" };

export const egressDownMessage = (host) =>
  `وی‌پی‌ان این سرور کار نمی‌کند؛ مشکل از حساب یا ورود شما نیست. اتصال به ${host} از مسیر وی‌پی‌ان باز نشد. وی‌پی‌ان سرور را عوض کنید (یا از مدیر پلتفرم بخواهید) و دوباره امتحان کنید.`;

/**
 * error: the run's { message, code }. Returns it unchanged, or an egress_down error when the engine's
 * host does not open through the configured proxy. `probe` is injectable for tests.
 */
export async function explainEgress(error, { provider = "claude", proxyUrl = process.env.HTTPS_PROXY, probe = reachableThrough } = {}) {
  if (!error || !proxyUrl || !REWORDABLE.has(error.code) || !NETWORKISH.test(String(error.message || ""))) return error;
  const host = HOSTS[String(provider || "").split(/[-:]/)[0]];
  if (!host) return error;
  try {
    // Twice: a CDN-fronted server drops a first connection now and then; two misses is a dead path.
    if ((await probe(proxyUrl, host, 6_000)) || (await probe(proxyUrl, host, 6_000))) return error;
  } catch {
    return error;
  }
  const detail = String(error.message || "").replace(/\s+/g, " ").slice(0, 300);
  return { code: EGRESS_DOWN_CODE, message: `${egressDownMessage(host)} (${detail})` };
}
