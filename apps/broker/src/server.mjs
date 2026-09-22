import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { createKube, ToolInputError } from "./kube.mjs";
import { createProbe } from "./probe.mjs";
import { createSsh } from "./ssh.mjs";
import { createTools } from "./tools.mjs";
import { createVault } from "./vault.mjs";
import { loadSite } from "./site.mjs";

// Tiny JSON API on a unix socket. Only the app container shares the socket directory;
// secrets (vault token, age identity, SSH key) never leave this container.
//   GET  /tools         -> [{ name, description, inputSchema }]
//   POST /tools/:name   -> { ok: true, result } | { ok: false, error, attempts? }
//   GET  /probe         -> every cluster path, API checked with a real authenticated read
//   POST /data/metrics  -> full Prometheus series for charts (not exposed to the agent)
export function createBrokerServer({ tools, probe, log = console }) {
  return http.createServer(async (req, res) => {
    const send = (status, body) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    try {
      if (req.method === "GET" && req.url === "/healthz") return send(200, { ok: true });
      if (req.method === "GET" && req.url === "/probe" && probe) return send(200, await probe());
      if (req.method === "GET" && req.url === "/tools") {
        return send(200, Object.entries(tools).map(([name, tool]) => ({ name, description: tool.description, inputSchema: tool.inputSchema })));
      }
      // Full series for the app's chart renderer; deliberately not listed as an agent tool.
      if (req.method === "POST" && req.url === "/data/metrics" && tools.metricsData) {
        try {
          return send(200, { ok: true, result: await tools.metricsData(await readJson(req)) });
        } catch (error) {
          return send(error instanceof ToolInputError ? 400 : 502, { ok: false, error: error.message, ...(error.attempts ? { attempts: error.attempts } : {}) });
        }
      }
      const match = req.method === "POST" && req.url.match(/^\/tools\/([a-z0-9_]+)$/);
      if (!match) return send(404, { ok: false, error: "not found" });
      const tool = tools[match[1]];
      if (!tool) return send(404, { ok: false, error: `unknown tool ${match[1]}` });
      const args = await readJson(req);
      const started = Date.now();
      try {
        const result = await tool.execute(args);
        log.info?.(`[broker] ${match[1]} ok ${Date.now() - started}ms ${result?.source || ""}`);
        return send(200, { ok: true, result });
      } catch (error) {
        const status = error instanceof ToolInputError ? 400 : 502;
        log.info?.(`[broker] ${match[1]} failed ${Date.now() - started}ms: ${error.message}`);
        return send(status, { ok: false, error: error.message, ...(error.attempts ? { attempts: error.attempts } : {}) });
      }
    } catch (error) {
      log.error?.("[broker]", error);
      return send(500, { ok: false, error: "internal error" });
    }
  });
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 256_000) reject(new ToolInputError("body too large"));
    });
    req.on("end", () => {
      try {
        const value = body ? JSON.parse(body) : {};
        resolve(value && typeof value === "object" ? value : {});
      } catch {
        reject(new ToolInputError("invalid JSON"));
      }
    });
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { genv } = await import("./env.mjs");
  const env = process.env;
  const socketPath = genv("BROKER_SOCKET", "/run/griffin/broker.sock");
  const vault = createVault({
    url: genv("BAO_URL"),
    tokenAge: genv("BAO_TOKEN_AGE"),
    identity: genv("AGE_IDENTITY"),
  });
  const site = loadSite();
  const sshRun = createSsh({ vault, knownHosts: genv("SSH_KNOWN_HOSTS", site.sshKnownHosts || "/config/ssh_known_hosts") });
  const clusters = genv("CLUSTERS") ? JSON.parse(genv("CLUSTERS")) : site.clusters;
  const kube = createKube({ vault, sshRun, clusters });
  const server = createBrokerServer({ tools: createTools({ kube, vault, sshRun, site: { ...site, clusters } }), probe: createProbe({ clusters, kube }) });
  fs.mkdirSync(path.dirname(socketPath), { recursive: true });
  fs.rmSync(socketPath, { force: true });
  server.listen(socketPath, () => {
    fs.chmodSync(socketPath, 0o660);
    console.log(`[broker] listening on ${socketPath}`);
  });
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => server.close(() => process.exit(0)));
}
