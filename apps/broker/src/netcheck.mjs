import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import { ToolInputError } from "./kube.mjs";

// Shell-free network diagnostics. Used by the edge/CDN agent to prove what the edge and
// origin actually answer, without giving the model a shell.
// http_check uses node:http(s) (not fetch) so Host and TLS servername can be overridden:
// point url at the origin IP and set hostHeader to the real hostname.

const IPV4 = /^(?:\d{1,3}\.){3}\d{1,3}$/;
const HOSTNAME = /^[a-z0-9._-]{1,253}$/i;
const HEADER_KEEP = new Set([
  "server", "x-cache", "age", "cache-control", "expires", "etag",
  "content-type", "content-length", "location", "via", "x-request-id",
  "cf-cache-status", "x-arvan-cache",
]);
const DNS_TYPES = new Set(["A", "AAAA", "CNAME", "MX", "TXT", "NS", "SOA"]);

export function createNetTools({
  dnsResolver = (opts) => new dns.promises.Resolver(opts),
  httpRequest = http.request,
  httpsRequest = https.request,
  tlsConnect = tls.connect,
} = {}) {
  return {
    dns_lookup: {
      description:
        "DNS lookup (A/AAAA/CNAME/MX/TXT/NS/SOA) via Node resolver — no shell. NXDOMAIN is a result, not an error.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", minLength: 1, maxLength: 253 },
          type: { type: "string", enum: [...DNS_TYPES] },
          resolver: { type: "string", pattern: IPV4.source, description: "optional recursive resolver IPv4" },
        },
        required: ["name"],
        additionalProperties: false,
      },
      async execute(args) {
        const name = String(args.name || "").trim();
        if (!name || name.length > 253) throw new ToolInputError("invalid name");
        const type = String(args.type || "A").toUpperCase();
        if (!DNS_TYPES.has(type)) throw new ToolInputError(`type must be one of ${[...DNS_TYPES].join(", ")}`);
        if (args.resolver !== undefined && !IPV4.test(String(args.resolver))) throw new ToolInputError("resolver must be an IPv4");
        const resolver = dnsResolver({ timeout: 5000, tries: 2 });
        if (args.resolver) resolver.setServers([String(args.resolver)]);
        const started = Date.now();
        try {
          const method = {
            A: "resolve4",
            AAAA: "resolve6",
            CNAME: "resolveCname",
            MX: "resolveMx",
            TXT: "resolveTxt",
            NS: "resolveNs",
            SOA: "resolveSoa",
          }[type];
          const raw = await resolver[method](name);
          const records = normalizeDns(type, raw);
          return { name, type, resolver: args.resolver ? String(args.resolver) : "system", records, ms: Date.now() - started, source: "dns" };
        } catch (error) {
          const code = error?.code || error?.errno || "";
          if (code === "ENOTFOUND" || code === "ENODATA" || code === "ESERVFAIL" || /NXDOMAIN/i.test(String(error?.message))) {
            return {
              name,
              type,
              resolver: args.resolver ? String(args.resolver) : "system",
              records: [],
              error: code === "ENOTFOUND" || /NXDOMAIN/i.test(String(error?.message)) ? "NXDOMAIN" : String(code || error.message),
              ms: Date.now() - started,
              source: "dns",
            };
          }
          throw error;
        }
      },
    },

    http_check: {
      description:
        "HTTP(S) check with controllable Host/SNI (no shell). Point url at an origin IP and set hostHeader to the hostname to tell an edge fault from an origin fault. Returns status, selected cache headers, timings and redirect chain.",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string", maxLength: 2000 },
          hostHeader: { type: "string", maxLength: 253 },
          method: { type: "string", enum: ["HEAD", "GET"] },
          followRedirects: { type: "boolean" },
          bodySnippet: { type: "boolean" },
        },
        required: ["url"],
        additionalProperties: false,
      },
      async execute(args) {
        let current;
        try {
          current = new URL(String(args.url || ""));
        } catch {
          throw new ToolInputError("invalid url");
        }
        if (current.protocol !== "http:" && current.protocol !== "https:") throw new ToolInputError("url scheme must be http or https");
        const method = args.method === "GET" ? "GET" : "HEAD";
        const follow = args.followRedirects !== false;
        const wantBody = Boolean(args.bodySnippet) && method === "GET";
        const hostHeader = args.hostHeader ? String(args.hostHeader).trim() : "";
        if (hostHeader && !HOSTNAME.test(hostHeader)) throw new ToolInputError("invalid hostHeader");

        const redirects = [];
        const totalStarted = Date.now();
        let last;
        for (let hop = 0; hop < 6; hop += 1) {
          last = await oneRequest({
            url: current,
            method,
            hostHeader,
            wantBody,
            httpRequest,
            httpsRequest,
          });
          if (last.status >= 300 && last.status < 400 && last.headers.location && follow && hop < 5) {
            redirects.push({ status: last.status, location: last.headers.location, url: current.href });
            try {
              current = new URL(last.headers.location, current);
            } catch {
              break;
            }
            if (current.protocol !== "http:" && current.protocol !== "https:") break;
            continue;
          }
          break;
        }
        if (redirects.length >= 5 && last.status >= 300 && last.status < 400) {
          return {
            url: String(args.url),
            error: "too many redirects",
            redirects,
            timings: { total: Date.now() - totalStarted },
            source: "http",
          };
        }
        return {
          url: String(args.url),
          finalUrl: current.href,
          status: last.status,
          statusText: last.statusText,
          headers: last.headers,
          timings: { ...last.timings, total: Date.now() - totalStarted },
          redirects,
          ...(wantBody && last.bodySnippet !== undefined ? { bodySnippet: last.bodySnippet } : {}),
          ...(last.error ? { error: last.error } : {}),
          source: "http",
        };
      },
    },

    tls_check: {
      description:
        "Inspect a TLS certificate (issuer, expiry, SANs, protocol). Uses rejectUnauthorized:false on purpose so a bad cert can still be inspected.",
      inputSchema: {
        type: "object",
        properties: {
          host: { type: "string", minLength: 1, maxLength: 253 },
          port: { type: "integer", minimum: 1, maximum: 65535 },
          servername: { type: "string", maxLength: 253 },
        },
        required: ["host"],
        additionalProperties: false,
      },
      async execute(args) {
        const host = String(args.host || "").trim();
        if (!host || host.length > 253) throw new ToolInputError("invalid host");
        const port = Number(args.port) || 443;
        const servername = args.servername ? String(args.servername).trim() : host;
        const started = Date.now();
        return new Promise((resolve) => {
          // rejectUnauthorized:false is deliberate — the point is to inspect a bad certificate.
          const socket = tlsConnect(
            { host, port, servername, rejectUnauthorized: false, timeout: 10_000 },
            () => {
              const cert = socket.getPeerCertificate();
              const validTo = cert.valid_to ? new Date(cert.valid_to) : null;
              const daysLeft = validTo ? Math.floor((validTo.getTime() - Date.now()) / 86_400_000) : null;
              const altNames = String(cert.subjectaltname || "")
                .split(",")
                .map((s) => s.trim().replace(/^DNS:/i, ""))
                .filter(Boolean);
              resolve({
                host,
                port,
                servername,
                subject: { CN: cert.subject?.CN || null },
                issuer: { O: cert.issuer?.O || null, CN: cert.issuer?.CN || null },
                validFrom: cert.valid_from || null,
                validTo: cert.valid_to || null,
                daysLeft,
                altNames,
                protocol: socket.getProtocol?.() || null,
                authorized: socket.authorized,
                authorizationError: socket.authorizationError ? String(socket.authorizationError) : null,
                ms: Date.now() - started,
                source: "tls",
              });
              socket.end();
            },
          );
          socket.on("error", (error) => {
            resolve({
              host,
              port,
              servername,
              error: error.code || error.message,
              ms: Date.now() - started,
              source: "tls",
            });
          });
          socket.on("timeout", () => {
            socket.destroy();
            resolve({ host, port, servername, error: "timeout", ms: Date.now() - started, source: "tls" });
          });
        });
      },
    },
  };
}

function normalizeDns(type, raw) {
  if (type === "SOA") return [raw];
  if (type === "TXT") return (raw || []).map((parts) => (Array.isArray(parts) ? parts.join("") : String(parts)));
  if (type === "MX") return (raw || []).map((r) => ({ exchange: r.exchange, priority: r.priority }));
  return (raw || []).map(String);
}

function pickHeaders(raw) {
  const out = {};
  for (const [k, v] of Object.entries(raw || {})) {
    if (HEADER_KEEP.has(k.toLowerCase())) out[k.toLowerCase()] = Array.isArray(v) ? v.join(", ") : String(v);
  }
  return out;
}

function oneRequest({ url, method, hostHeader, wantBody, httpRequest, httpsRequest }) {
  return new Promise((resolve) => {
    const isTls = url.protocol === "https:";
    const requestFn = isTls ? httpsRequest : httpRequest;
    const started = Date.now();
    const timings = { dns: null, connect: null, tls: null, firstByte: null, total: null };
    const headers = { Accept: "*/*", "User-Agent": "griffin-netcheck/1" };
    if (hostHeader) headers.Host = hostHeader;
    const options = {
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || (isTls ? 443 : 80),
      path: `${url.pathname}${url.search}`,
      method,
      headers,
      timeout: 15_000,
      ...(isTls ? { servername: hostHeader || url.hostname, rejectUnauthorized: false } : {}),
    };
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      timings.total = Date.now() - started;
      resolve({ ...value, timings });
    };
    const req = requestFn(options, (res) => {
      timings.firstByte = Date.now() - started;
      const chunks = [];
      let size = 0;
      res.on("data", (chunk) => {
        if (!wantBody) {
          res.resume();
          return;
        }
        if (size < 8 * 1024) {
          const take = chunk.subarray(0, 8 * 1024 - size);
          chunks.push(take);
          size += take.length;
        }
      });
      res.on("end", () => {
        done({
          status: res.statusCode,
          statusText: res.statusMessage || "",
          headers: pickHeaders(res.headers),
          ...(wantBody ? { bodySnippet: Buffer.concat(chunks).toString("utf8") } : {}),
        });
      });
    });
    req.on("socket", (socket) => {
      socket.on("lookup", () => {
        timings.dns = Date.now() - started;
      });
      socket.on("connect", () => {
        timings.connect = Date.now() - started;
      });
      if (isTls) {
        socket.on("secureConnect", () => {
          timings.tls = Date.now() - started;
        });
      }
    });
    req.on("timeout", () => {
      req.destroy();
      done({ error: "timeout", status: null, statusText: "", headers: {} });
    });
    req.on("error", (error) => {
      done({ error: error.code || error.message, status: null, statusText: "", headers: {} });
    });
    req.end();
  });
}
