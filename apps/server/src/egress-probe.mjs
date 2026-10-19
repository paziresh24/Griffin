import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { connectTunnel } from "./egress.mjs";

// Does this server need a proxy? (setup wizard, owner 2026-10-17: «پراکسی … خیلی سخت و نامفهومه»)
// One plain HTTPS GET per engine host, without a key, directly and through the proxy. Any HTTP answer
// means the path works (a 401 is fine: no key was sent); a 403/451 to a request without a key is the
// vendor refusing this country; no answer at all is a filter, DNS or firewall.
export const ENGINE_HOSTS = [
  { host: "api.anthropic.com", label: "Claude (Anthropic)", path: "/v1/models" },
  { host: "api.openai.com", label: "OpenAI", path: "/v1/models" },
  { host: "api2.cursor.sh", label: "Cursor", path: "/" },
  { host: "openrouter.ai", label: "OpenRouter", path: "/api/v1/models" },
  { host: "api.z.ai", label: "Z.ai", path: "/api/paas/v4/models" },
];

const REGION = /region|country|territor|not available in your|unsupported_country|sanction|access denied|not allowed/i;

/** ok | region | proxy (the proxy itself failed) | unreachable */
export function classifyProbe({ status = 0, text = "", error = "", viaProxy = false } = {}) {
  if (status) return status === 403 || status === 451 || (status >= 400 && REGION.test(text)) ? "region" : "ok";
  if (viaProxy && /proxy CONNECT|ECONNREFUSED|EHOSTUNREACH|proxy:/i.test(String(error))) return "proxy";
  return "unreachable";
}

function get({ host, path }, proxy, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (r) => {
      if (settled) return;
      settled = true;
      resolve(r);
    };
    // No agent: with one, https ignores createConnection (and the global proxy agent would take over).
    const createConnection = () => {
      // A socket we open ourselves: egress.mjs leaves tls.connect alone when one is given, so "direct"
      // really is direct even when the Cursor/Anthropic tunnel is installed.
      const raw = proxy ? connectTunnel(new URL(proxy), host, 443) : net.connect(443, host);
      raw.on("error", (e) => done({ error: proxy && e.code === "ECONNREFUSED" ? `proxy: ${e.code}` : String(e.code || e.message) }));
      return tls.connect({ socket: raw, servername: host, ALPNProtocols: ["http/1.1"] });
    };
    const req = https.request({ host, path, method: "GET", createConnection, headers: { "user-agent": "griffin-setup" }, timeout: timeoutMs }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (c) => {
        if (text.length < 2000) text += c;
      });
      res.on("end", () => done({ status: res.statusCode, text }));
      res.on("error", () => done({ status: res.statusCode, text }));
    });
    req.on("timeout", () => {
      req.destroy();
      done({ error: "timeout" });
    });
    req.on("error", (e) => done({ error: String(e.code || e.message) }));
    req.end();
  });
}

/** Every engine host, in parallel; `proxy` = an http://host:port URL to go through, or none. */
export async function probeEgress(proxy = "", { timeoutMs = 6000, hosts = ENGINE_HOSTS, request = get } = {}) {
  return Promise.all(
    hosts.map(async (h) => {
      const started = Date.now();
      const r = await request(h, proxy || null, timeoutMs);
      return { host: h.host, label: h.label, result: classifyProbe({ ...r, viaProxy: Boolean(proxy) }), status: r.status || null, error: r.error || null, ms: Date.now() - started };
    }),
  );
}
