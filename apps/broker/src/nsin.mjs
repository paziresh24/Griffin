import { ToolInputError } from "./kube.mjs";

// NSIN CDN API (https://api.nsin.ir) — docs: https://nsin.ir/docs/api/rest-reference/
// Auth: vault item `nsin__api-key` = raw key (nsin_…) or full "Bearer …" / "X-Api-Key: …".
// OpenAPI: https://nsin.ir/docs/openapi.yaml
// Public edge CIDR list (no auth): https://nsin.ir/ips.txt

const HOST = "https://api.nsin.ir";
const IPS_URL = "https://nsin.ir/ips.txt";
const DOMAIN = /^[a-z0-9.-]{3,253}$/;
const CIDR = /^(?:\d{1,3}\.){3}\d{1,3}\/(?:[0-9]|[12][0-9]|3[0-2])$/;
const PERIODS = new Set(["3h", "6h", "12h", "24h", "7d", "30d"]);
const RECORD_TYPES = new Set([
  "A",
  "AAAA",
  "CNAME",
  "ANAME",
  "MX",
  "TXT",
  "NS",
  "SRV",
  "CAA",
  "PTR",
]);
const RULE_KINDS = new Set([
  "cache",
  "waf",
  "drop",
  "rate-limit",
  "captcha",
  "bot-route",
  "fingerprint",
  "redirect",
  "rewrite",
  "header",
  "origin_pool",
  "origin_route",
  "basic_auth",
  "error-page",
  "optimize",
]);

export function createNsinTools({ vault, fetchImpl = fetch } = {}) {
  async function apiKey() {
    if (!vault) throw new ToolInputError("vault required for NSIN API tools");
    try {
      let value = (await vault.item("nsin__api-key")).trim();
      if (!value) throw new Error("empty");
      // Accept raw key, "Bearer …", or "X-Api-Key: …"
      value = value.replace(/^(?:Authorization:\s*)?Bearer\s+/i, "").replace(/^X-Api-Key:\s*/i, "").trim();
      if (!value) throw new Error("empty");
      return value;
    } catch {
      throw new ToolInputError("vault item nsin__api-key is missing or empty");
    }
  }

  async function request(path, { method = "GET", params, json, okStatuses } = {}) {
    const url = new URL(path.startsWith("http") ? path : `${HOST}${path}`);
    for (const [k, v] of Object.entries(params || {})) {
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
    }
    const body = json !== undefined ? JSON.stringify(json) : undefined;
    let lastError;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const response = await fetchImpl(url, {
        method,
        headers: {
          "X-Api-Key": await apiKey(),
          Accept: "application/json",
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        body,
        redirect: "manual",
        signal: AbortSignal.timeout(45_000),
      });
      if (response.status >= 500) {
        lastError = new Error(`NSIN ${path} http_${response.status}`);
        await new Promise((r) => setTimeout(r, 400 * attempt));
        continue;
      }
      if (response.status === 401 || response.status === 403) {
        const text = (await response.text()).slice(0, 200);
        throw new ToolInputError(`NSIN rejected the credential for ${path} (http_${response.status}): ${text}`);
      }
      const allowed = okStatuses || [200, 201, 202, 204];
      if (!allowed.includes(response.status)) {
        const text = (await response.text()).slice(0, 300);
        throw new Error(`NSIN ${path} http_${response.status}: ${text}`);
      }
      if (response.status === 204) return { status: response.status, body: null };
      const text = await response.text();
      if (!text) return { status: response.status, body: null };
      try {
        return { status: response.status, body: JSON.parse(text) };
      } catch {
        return { status: response.status, body: { raw: text.slice(0, 2000) } };
      }
    }
    throw lastError;
  }

  function requireDomain(value) {
    const domain = String(value || "").trim().toLowerCase();
    if (!DOMAIN.test(domain)) throw new ToolInputError("domain must match ^[a-z0-9.-]{3,253}$");
    return domain;
  }

  function periodOf(value) {
    const p = String(value || "24h");
    if (!PERIODS.has(p)) throw new ToolInputError(`period must be one of ${[...PERIODS].join(", ")}`);
    return p;
  }

  function requireKind(value) {
    const kind = String(value || "").trim();
    if (!RULE_KINDS.has(kind)) {
      throw new ToolInputError(`kind must be one of ${[...RULE_KINDS].join(", ")}`);
    }
    return kind;
  }

  async function ensureDomain(domain) {
    const { body } = await request("/domains/");
    const items = Array.isArray(body) ? body : body?.data || [];
    const names = (Array.isArray(items) ? items : [])
      .map((d) => String(d.name || d.domain || "").toLowerCase())
      .filter(Boolean);
    if (!names.includes(domain)) {
      throw new ToolInputError(`domain ${domain} is not in this NSIN account (live check)`);
    }
    return names;
  }

  function compactDomain(d) {
    return {
      id: d.id ?? null,
      name: d.name || d.domain || "",
      status: d.status || null,
      dnsMode: d.dns_mode || d.dnsMode || null,
      ssl: d.ssl || null,
      plan: d.subscription?.effective_features?.plan_name || d.subscription?.plan_name || null,
      suspended: Boolean(d.suspended),
    };
  }

  function compactRecord(r) {
    return {
      id: r.id,
      name: r.name,
      type: r.type,
      destination: r.destination ?? r.dns_content ?? null,
      dnsContent: r.dns_content ?? null,
      ttl: r.ttl ?? null,
      proxied: r.proxied ?? null,
      captcha: r.captcha ?? null,
      scheme: r.scheme ?? null,
      port: r.port ?? null,
      hostHeader: r.host_header ?? r.hostHeader ?? null,
    };
  }

  return {
    nsin_edge_ranges: {
      description:
        "Fetch the published NSIN edge CIDR list from https://nsin.ir/ips.txt (live, no API key). Compare it with mikrotik_print of the address list that holds the edge ranges.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      async execute() {
        const response = await fetchImpl(IPS_URL, {
          headers: { Accept: "text/plain" },
          signal: AbortSignal.timeout(20_000),
          redirect: "follow",
        });
        if (!response.ok) throw new Error(`nsin.ir/ips.txt http_${response.status}`);
        const text = await response.text();
        const ranges = [];
        for (const line of text.split(/\r?\n/)) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith(";")) continue;
          const token = trimmed.split(/\s+/)[0];
          if (!CIDR.test(token)) throw new ToolInputError(`invalid CIDR in nsin.ir/ips.txt: ${token.slice(0, 40)}`);
          ranges.push(token);
        }
        return { ranges, count: ranges.length, source: "nsin.ir/ips.txt" };
      },
    },

    nsin_domains: {
      description: "List domains in the NSIN account (panel/API). Prefer this over asking the owner for domain names.",
      inputSchema: {
        type: "object",
        properties: { search: { type: "string", maxLength: 200, description: "optional name filter (client-side)" } },
        additionalProperties: false,
      },
      async execute(args) {
        const { body } = await request("/domains/");
        const items = Array.isArray(body) ? body : body?.data || [];
        const search = args?.search ? String(args.search).toLowerCase() : "";
        const domains = (Array.isArray(items) ? items : [])
          .map(compactDomain)
          .filter((d) => d.name && (!search || d.name.toLowerCase().includes(search)))
          .slice(0, 200);
        return { domains, total: domains.length, source: "nsin-api" };
      },
    },

    nsin_domain: {
      description: "Full details for one NSIN domain (settings, SSL summary, plan).",
      inputSchema: {
        type: "object",
        properties: { domain: { type: "string", description: "domain name, e.g. example.com" } },
        required: ["domain"],
        additionalProperties: false,
      },
      async execute(args) {
        const domain = requireDomain(args.domain);
        const { body } = await request(`/domains/${domain}`);
        return { domain, details: body, source: "nsin-api" };
      },
    },

    nsin_dns_records: {
      description: "List DNS records for a NSIN domain (ids, type, destination, proxied, origin overrides).",
      inputSchema: {
        type: "object",
        properties: {
          domain: { type: "string" },
          type: { type: "string", description: "optional record type filter (A, CNAME, …)" },
          name: { type: "string", description: "optional name substring filter" },
          proxied: { type: "boolean", description: "optional proxied filter" },
        },
        required: ["domain"],
        additionalProperties: false,
      },
      async execute(args) {
        const domain = requireDomain(args.domain);
        const { body } = await request(`/domains/${domain}/records/`);
        const items = Array.isArray(body) ? body : body?.data || [];
        let records = (Array.isArray(items) ? items : []).map(compactRecord);
        if (args.type) {
          const t = String(args.type).toUpperCase();
          records = records.filter((r) => String(r.type).toUpperCase() === t);
        }
        if (args.name) {
          const n = String(args.name).toLowerCase();
          records = records.filter((r) => String(r.name || "").toLowerCase().includes(n));
        }
        if (typeof args.proxied === "boolean") {
          records = records.filter((r) => Boolean(r.proxied) === args.proxied);
        }
        return { domain, records: records.slice(0, 500), total: records.length, source: "nsin-api" };
      },
    },

    nsin_dns_create: {
      description:
        "Create a DNS record on a NSIN domain. For proxied A/AAAA/CNAME/ANAME, destination is the origin. Call ask_owner before mutating live DNS.",
      inputSchema: {
        type: "object",
        properties: {
          domain: { type: "string" },
          name: { type: "string", description: "relative name; @ for apex" },
          type: { type: "string", description: "A, AAAA, CNAME, ANAME, MX, TXT, …" },
          destination: { type: "string", description: "IP, hostname, or text" },
          proxied: { type: "boolean" },
          ttl: { type: "integer", minimum: 1, maximum: 604800 },
          mx_priority: { type: "integer", minimum: 0, maximum: 65535 },
          captcha: { type: "boolean" },
          scheme: { type: "string", description: "origin scheme when proxied (http/https)" },
          port: { type: "integer", minimum: 1, maximum: 65535 },
          host_header: { type: "string", description: "Host header override toward origin" },
        },
        required: ["domain", "name", "type", "destination"],
        additionalProperties: false,
      },
      async execute(args) {
        const domain = requireDomain(args.domain);
        await ensureDomain(domain);
        const type = String(args.type || "").toUpperCase();
        if (!RECORD_TYPES.has(type)) throw new ToolInputError(`unsupported record type: ${type}`);
        const json = {
          name: String(args.name).trim(),
          type,
          destination: String(args.destination).trim(),
        };
        if (args.proxied != null) json.proxied = Boolean(args.proxied);
        if (args.ttl != null) json.ttl = Number(args.ttl);
        if (args.mx_priority != null) json.mx_priority = Number(args.mx_priority);
        if (args.captcha != null) json.captcha = Boolean(args.captcha);
        if (args.scheme) json.scheme = String(args.scheme);
        if (args.port != null) json.port = Number(args.port);
        if (args.host_header) json.host_header = String(args.host_header);
        const { body } = await request(`/domains/${domain}/records/`, { method: "POST", json });
        return { domain, record: compactRecord(body || {}), source: "nsin-api" };
      },
    },

    nsin_dns_update: {
      description: "Update an existing DNS record by id. Call ask_owner before mutating live DNS.",
      inputSchema: {
        type: "object",
        properties: {
          domain: { type: "string" },
          recordId: { type: "integer", minimum: 1 },
          name: { type: "string" },
          type: { type: "string" },
          destination: { type: "string" },
          proxied: { type: "boolean" },
          ttl: { type: "integer", minimum: 1, maximum: 604800 },
          mx_priority: { type: "integer", minimum: 0, maximum: 65535 },
          captcha: { type: "boolean" },
          scheme: { type: "string" },
          port: { type: "integer", minimum: 1, maximum: 65535 },
          host_header: { type: "string" },
        },
        required: ["domain", "recordId"],
        additionalProperties: false,
      },
      async execute(args) {
        const domain = requireDomain(args.domain);
        await ensureDomain(domain);
        const id = Number(args.recordId);
        if (!Number.isInteger(id) || id < 1) throw new ToolInputError("recordId must be a positive integer");
        const json = {};
        for (const key of ["name", "destination", "scheme", "host_header"]) {
          if (args[key] != null) json[key === "host_header" ? "host_header" : key] = String(args[key]);
        }
        if (args.type) json.type = String(args.type).toUpperCase();
        if (args.proxied != null) json.proxied = Boolean(args.proxied);
        if (args.ttl != null) json.ttl = Number(args.ttl);
        if (args.mx_priority != null) json.mx_priority = Number(args.mx_priority);
        if (args.captcha != null) json.captcha = Boolean(args.captcha);
        if (args.port != null) json.port = Number(args.port);
        if (!Object.keys(json).length) throw new ToolInputError("provide at least one field to update");
        const { body } = await request(`/domains/${domain}/records/${id}`, { method: "PUT", json });
        return { domain, record: compactRecord(body || { id }), source: "nsin-api" };
      },
    },

    nsin_dns_delete: {
      description: "Delete a DNS record by id. Call ask_owner first.",
      inputSchema: {
        type: "object",
        properties: { domain: { type: "string" }, recordId: { type: "integer", minimum: 1 } },
        required: ["domain", "recordId"],
        additionalProperties: false,
      },
      async execute(args) {
        const domain = requireDomain(args.domain);
        await ensureDomain(domain);
        const id = Number(args.recordId);
        await request(`/domains/${domain}/records/${id}`, { method: "DELETE", okStatuses: [200, 204] });
        return { domain, deleted: id, source: "nsin-api" };
      },
    },

    nsin_ssl_status: {
      description: "SSL/certificate status for a NSIN domain (validity, expiry, issuer).",
      inputSchema: {
        type: "object",
        properties: { domain: { type: "string" } },
        required: ["domain"],
        additionalProperties: false,
      },
      async execute(args) {
        const domain = requireDomain(args.domain);
        const { body } = await request(`/domains/${domain}/ssl/`);
        return { domain, ssl: body, source: "nsin-api" };
      },
    },

    nsin_ssl_issue: {
      description: "Request certificate issuance now (instead of waiting for the cycle). Call ask_owner first.",
      inputSchema: {
        type: "object",
        properties: { domain: { type: "string" } },
        required: ["domain"],
        additionalProperties: false,
      },
      async execute(args) {
        const domain = requireDomain(args.domain);
        await ensureDomain(domain);
        const { status, body } = await request(`/domains/${domain}/ssl/issue`, { method: "POST", okStatuses: [200, 202] });
        return { domain, httpStatus: status, result: body, source: "nsin-api" };
      },
    },

    nsin_check_nameservers: {
      description: "Re-test nameserver delegation for a pending domain and activate it when ready.",
      inputSchema: {
        type: "object",
        properties: { domain: { type: "string" } },
        required: ["domain"],
        additionalProperties: false,
      },
      async execute(args) {
        const domain = requireDomain(args.domain);
        const { body } = await request(`/domains/${domain}/check-ns`, { method: "POST" });
        return { domain, result: body, source: "nsin-api" };
      },
    },

    nsin_developer_mode: {
      description:
        "Enable or disable developer mode (bypass edge cache; temporary). Call ask_owner before enabling on production.",
      inputSchema: {
        type: "object",
        properties: {
          domain: { type: "string" },
          enabled: { type: "boolean", description: "true = enable (POST), false = disable (DELETE)" },
        },
        required: ["domain", "enabled"],
        additionalProperties: false,
      },
      async execute(args) {
        const domain = requireDomain(args.domain);
        await ensureDomain(domain);
        const method = args.enabled ? "POST" : "DELETE";
        const { status, body } = await request(`/domains/${domain}/developer-mode`, {
          method,
          okStatuses: [200, 201, 202, 204],
        });
        return { domain, enabled: Boolean(args.enabled), httpStatus: status, result: body, source: "nsin-api" };
      },
    },

    nsin_cache_stats: {
      description: "Cached object/byte footprint for a domain (per edge node).",
      inputSchema: {
        type: "object",
        properties: { domain: { type: "string" } },
        required: ["domain"],
        additionalProperties: false,
      },
      async execute(args) {
        const domain = requireDomain(args.domain);
        const { body } = await request("/cache/stats/", { params: { domain } });
        return { domain, stats: body, source: "nsin-api" };
      },
    },

    nsin_cache_keys: {
      description: "Browse cached entries (host, path, node, size). Optionally filter by path/hostname.",
      inputSchema: {
        type: "object",
        properties: {
          domain: { type: "string" },
          path: { type: "string", description: "path filter, e.g. /assets/*" },
          hostname: { type: "string" },
          node: { type: "string" },
          limit: { type: "integer", minimum: 1, maximum: 200 },
        },
        required: ["domain"],
        additionalProperties: false,
      },
      async execute(args) {
        const domain = requireDomain(args.domain);
        const { body } = await request(`/domains/${domain}/cache/keys`, {
          params: {
            path: args.path,
            hostname: args.hostname,
            node: args.node,
            limit: args.limit ?? 50,
          },
        });
        return { domain, keys: body, source: "nsin-api" };
      },
    },

    nsin_cache_purge: {
      description:
        "Purge the entire NSIN edge cache for a domain (blunt). Prefer nsin_cache_purge_path for deploys. Call ask_owner first.",
      inputSchema: {
        type: "object",
        properties: { domain: { type: "string" } },
        required: ["domain"],
        additionalProperties: false,
      },
      async execute(args) {
        const domain = requireDomain(args.domain);
        await ensureDomain(domain);
        const { status, body } = await request(`/domains/${domain}/cache/`, {
          method: "DELETE",
          okStatuses: [200, 202],
        });
        return { domain, httpStatus: status, result: body, source: "nsin-api" };
      },
    },

    nsin_cache_purge_path: {
      description:
        "Purge or refresh cache entries matching a path pattern (e.g. /assets/*). Everyday post-deploy purge. Call ask_owner for production all-domain wipes; path-scoped is usually fine after naming the path.",
      inputSchema: {
        type: "object",
        properties: {
          domain: { type: "string" },
          path: { type: "string", description: "path wildcard, e.g. /assets/* or /" },
          hostname: { type: "string" },
          node: { type: "string" },
          mode: { type: "string", enum: ["delete", "refresh"], description: "default delete" },
        },
        required: ["domain", "path"],
        additionalProperties: false,
      },
      async execute(args) {
        const domain = requireDomain(args.domain);
        await ensureDomain(domain);
        const path = String(args.path || "").trim();
        if (!path.startsWith("/")) throw new ToolInputError("path must start with /");
        const filter = { path };
        if (args.hostname) filter.hostname = String(args.hostname);
        if (args.node) filter.node = String(args.node);
        const json = { mode: args.mode === "refresh" ? "refresh" : "delete", filter };
        const { status, body } = await request(`/domains/${domain}/cache/keys/purge`, {
          method: "POST",
          json,
          okStatuses: [200, 202],
        });
        return { domain, httpStatus: status, result: body, source: "nsin-api" };
      },
    },

    nsin_rules: {
      description: "List edge rules of one kind in evaluation order (cache, waf, drop, redirect, …).",
      inputSchema: {
        type: "object",
        properties: {
          domain: { type: "string" },
          kind: {
            type: "string",
            description: `one of: ${[...RULE_KINDS].join(", ")}`,
          },
        },
        required: ["domain", "kind"],
        additionalProperties: false,
      },
      async execute(args) {
        const domain = requireDomain(args.domain);
        const kind = requireKind(args.kind);
        const { body } = await request(`/domains/${domain}/rules/${kind}/`);
        const items = Array.isArray(body) ? body : body?.data || [];
        return {
          domain,
          kind,
          rules: (Array.isArray(items) ? items : []).slice(0, 200),
          total: Array.isArray(items) ? items.length : 0,
          source: "nsin-api",
        };
      },
    },

    nsin_rule_toggle: {
      description: "Enable or disable one edge rule by id. Call ask_owner before disabling security/WAF rules.",
      inputSchema: {
        type: "object",
        properties: {
          domain: { type: "string" },
          kind: { type: "string" },
          ruleId: { type: "integer", minimum: 1 },
          enabled: { type: "boolean" },
        },
        required: ["domain", "kind", "ruleId", "enabled"],
        additionalProperties: false,
      },
      async execute(args) {
        const domain = requireDomain(args.domain);
        const kind = requireKind(args.kind);
        await ensureDomain(domain);
        const id = Number(args.ruleId);
        const { body } = await request(`/domains/${domain}/rules/${kind}/${id}/toggle`, {
          method: "PATCH",
          json: { enabled: Boolean(args.enabled) },
        });
        return { domain, kind, ruleId: id, enabled: Boolean(args.enabled), result: body, source: "nsin-api" };
      },
    },

    nsin_analytics_summary: {
      description: "Traffic summary for a domain: requests, bandwidth, visitors, cache ratio, errors.",
      inputSchema: {
        type: "object",
        properties: {
          domain: { type: "string" },
          period: { type: "string", description: "3h|6h|12h|24h|7d|30d (default 24h)" },
          hostname: { type: "string" },
        },
        required: ["domain"],
        additionalProperties: false,
      },
      async execute(args) {
        const domain = requireDomain(args.domain);
        const { body } = await request("/analytics/summary", {
          params: { domain, period: periodOf(args.period), hostname: args.hostname },
        });
        return { domain, period: periodOf(args.period), summary: body, source: "nsin-api" };
      },
    },

    nsin_top_uris: {
      description: "Most-requested URIs for a domain over a period.",
      inputSchema: {
        type: "object",
        properties: {
          domain: { type: "string" },
          period: { type: "string" },
          hostname: { type: "string" },
          limit: { type: "integer", minimum: 1, maximum: 100 },
        },
        required: ["domain"],
        additionalProperties: false,
      },
      async execute(args) {
        const domain = requireDomain(args.domain);
        const { body } = await request("/analytics/top-uris", {
          params: {
            domain,
            period: periodOf(args.period),
            hostname: args.hostname,
            limit: args.limit ?? 20,
          },
        });
        return { domain, period: periodOf(args.period), top: body, source: "nsin-api" };
      },
    },

    nsin_request_logs: {
      description: "Raw request logs (plan feature). Filter by status, URI, cache, IP, ray id.",
      inputSchema: {
        type: "object",
        properties: {
          domain: { type: "string" },
          period: { type: "string" },
          status: { type: "integer" },
          uri: { type: "string" },
          hostname: { type: "string" },
          remoteAddr: { type: "string" },
          rayId: { type: "string" },
          limit: { type: "integer", minimum: 1, maximum: 200 },
        },
        required: ["domain"],
        additionalProperties: false,
      },
      async execute(args) {
        const domain = requireDomain(args.domain);
        const { body } = await request("/analytics/logs", {
          params: {
            domain,
            period: periodOf(args.period),
            status: args.status,
            uri: args.uri,
            hostname: args.hostname,
            remoteAddr: args.remoteAddr,
            rayId: args.rayId,
            limit: args.limit ?? 50,
          },
        });
        return { domain, period: periodOf(args.period), logs: body, source: "nsin-api" };
      },
    },

    nsin_waf_logs: {
      description: "WAF/firewall events for a domain.",
      inputSchema: {
        type: "object",
        properties: {
          domain: { type: "string" },
          period: { type: "string" },
          limit: { type: "integer", minimum: 1, maximum: 200 },
        },
        required: ["domain"],
        additionalProperties: false,
      },
      async execute(args) {
        const domain = requireDomain(args.domain);
        const { body } = await request("/analytics/waf-logs", {
          params: { domain, period: periodOf(args.period), limit: args.limit ?? 50 },
        });
        return { domain, period: periodOf(args.period), events: body, source: "nsin-api" };
      },
    },

    nsin_analytics_query: {
      description:
        "Custom read-only SQL SELECT over the requests table (ClickHouse). Use when dedicated analytics tools are not enough. Only SELECT/WITH … SELECT.",
      inputSchema: {
        type: "object",
        properties: {
          sql: { type: "string", minLength: 8, maxLength: 8000, description: "single SELECT over requests" },
        },
        required: ["sql"],
        additionalProperties: false,
      },
      async execute(args) {
        const sql = String(args.sql || "").trim();
        if (!/^(with|select)\b/i.test(sql)) throw new ToolInputError("sql must start with SELECT or WITH");
        if (/;/.test(sql.slice(0, -1))) throw new ToolInputError("only a single statement is allowed");
        const { body } = await request("/analytics/query", { method: "POST", json: { sql } });
        return { result: body, source: "nsin-api" };
      },
    },

    nsin_uptime_live: {
      description: "Live origin health per hostname — is the site down right now?",
      inputSchema: {
        type: "object",
        properties: { domain: { type: "string" } },
        required: ["domain"],
        additionalProperties: false,
      },
      async execute(args) {
        const domain = requireDomain(args.domain);
        const { body } = await request("/uptime/live", { params: { domain } });
        return { domain, live: body, source: "nsin-api" };
      },
    },

    nsin_uptime_incidents: {
      description: "Uptime / outage incident history for a domain.",
      inputSchema: {
        type: "object",
        properties: { domain: { type: "string" } },
        required: ["domain"],
        additionalProperties: false,
      },
      async execute(args) {
        const domain = requireDomain(args.domain);
        const { body } = await request("/uptime", { params: { domain } });
        return { domain, incidents: body, source: "nsin-api" };
      },
    },

    nsin_recommendations: {
      description: "NSIN advisory checklist for a domain (SSL expiry, misconfig, …).",
      inputSchema: {
        type: "object",
        properties: { domain: { type: "string" } },
        required: ["domain"],
        additionalProperties: false,
      },
      async execute(args) {
        const domain = requireDomain(args.domain);
        const { body } = await request("/recommendations", { params: { domain } });
        return { domain, recommendations: body, source: "nsin-api" };
      },
    },
  };
}
