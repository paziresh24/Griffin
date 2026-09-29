import { ToolInputError } from "./kube.mjs";

// ArvanCloud CDN API (https://napi.arvancloud.ir/cdn/4.0). Auth header value comes from vault
// item `arvan__api-key` verbatim (owner places the full Authorization value). Mutations other
// than cache purge are out of scope until approval routing exists.
// Purge body: https://git.arvancloud.ir/arvancloud/cdn-go-sdk/-/blob/main/docs/CachingPurge.md
//   { "purge": "all" } | { "purge": "individual", "purge_urls": ["https://…"] }

const HOST = "https://napi.arvancloud.ir/cdn/4.0";
const DOMAIN = /^[a-z0-9.-]{3,253}$/;
const URL_RE = /^https?:\/\/[^\s]{1,2000}$/i;
const BIND_MAX = 64 * 1024;

export function createArvanTools({ vault, fetchImpl = fetch }) {
  async function authHeader() {
    try {
      const value = (await vault.item("arvan__api-key")).trim();
      if (!value) throw new Error("empty");
      return value;
    } catch {
      throw new ToolInputError("vault item arvan__api-key is missing or empty");
    }
  }

  async function accountDomains() {
    const { body } = await request("/domains");
    const items = Array.isArray(dataOf(body)) ? dataOf(body) : dataOf(body)?.data || [];
    return (Array.isArray(items) ? items : [])
      .map((d) => String(d.domain || d.name || d.id || "").toLowerCase())
      .filter(Boolean);
  }

  async function request(path, { method = "GET", params, json, raw = false } = {}) {
    const url = new URL(`${HOST}${path}`);
    for (const [k, v] of Object.entries(params || {})) if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
    const body = json !== undefined ? JSON.stringify(json) : undefined;
    let lastError;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const response = await fetchImpl(url, {
        method,
        headers: {
          Authorization: await authHeader(),
          Accept: raw ? "text/plain" : "application/json",
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        body,
        redirect: "manual",
        signal: AbortSignal.timeout(30_000),
      });
      if (response.status >= 500) {
        lastError = new Error(`Arvan ${path} http_${response.status}`);
        await new Promise((r) => setTimeout(r, 400 * attempt));
        continue;
      }
      if (response.status === 401 || response.status === 403) {
        throw new ToolInputError(`Arvan rejected the credential for ${path} (http_${response.status})`);
      }
      if (!response.ok) {
        const text = (await response.text()).slice(0, 200);
        throw new Error(`Arvan ${path} http_${response.status}: ${text}`);
      }
      if (raw) return { text: await response.text() };
      if (response.status === 204) return { body: null };
      return { body: await response.json() };
    }
    throw lastError;
  }

  function requireDomain(value) {
    const domain = String(value || "").trim().toLowerCase();
    if (!DOMAIN.test(domain)) throw new ToolInputError("domain must match ^[a-z0-9.-]{3,253}$");
    return domain;
  }

  // Arvan wraps payloads as { data: … } or { data: { data: … } }; unwrap common shapes.
  function dataOf(body) {
    if (body == null) return body;
    if (Array.isArray(body)) return body;
    if (body.data !== undefined) return dataOf(body.data);
    return body;
  }

  function recordValue(rec) {
    const v = rec.value;
    if (v == null) return "";
    if (typeof v === "string" || typeof v === "number") return String(v);
    if (typeof v === "object") {
      if (v.ip != null) return String(v.ip);
      if (v.host != null) return String(v.host);
      if (v.value != null) return String(v.value);
      if (v.text != null) return String(v.text);
      return JSON.stringify(v).slice(0, 200);
    }
    return String(v);
  }

  return {
    arvan_domains: {
      description: "List domains registered in the ArvanCloud CDN account (read-only).",
      inputSchema: {
        type: "object",
        properties: { search: { type: "string", maxLength: 200, description: "optional name filter (client-side)" } },
        additionalProperties: false,
      },
      async execute(args) {
        const { body } = await request("/domains");
        const items = Array.isArray(dataOf(body)) ? dataOf(body) : dataOf(body)?.data || [];
        const search = args?.search ? String(args.search).toLowerCase() : "";
        const domains = (Array.isArray(items) ? items : [])
          .map((d) => ({
            domain: d.domain || d.name || d.id || "",
            status: d.status || d.domain_status || null,
            plan: d.plan || d.plan_id || null,
            dnsCloud: d.dns_cloud ?? d.dnsCloud ?? d.cloud ?? null,
          }))
          .filter((d) => d.domain && (!search || d.domain.toLowerCase().includes(search)))
          .slice(0, 200);
        return { domains, total: domains.length, source: "arvan-api" };
      },
    },

    arvan_dns_records: {
      description: "List DNS records for an ArvanCloud CDN domain (read-only).",
      inputSchema: {
        type: "object",
        properties: {
          domain: { type: "string", pattern: DOMAIN.source },
          type: { type: "string", maxLength: 20, description: "optional record type filter e.g. A, CNAME" },
          name: { type: "string", maxLength: 253, description: "optional name substring filter" },
        },
        required: ["domain"],
        additionalProperties: false,
      },
      async execute(args) {
        const domain = requireDomain(args.domain);
        const { body } = await request(`/domains/${encodeURIComponent(domain)}/dns-records`);
        const items = Array.isArray(dataOf(body)) ? dataOf(body) : [];
        const type = args.type ? String(args.type).toUpperCase() : "";
        const name = args.name ? String(args.name).toLowerCase() : "";
        const records = items
          .map((r) => ({
            id: r.id || r.uuid || null,
            type: r.type || null,
            name: r.name || r.host || null,
            value: recordValue(r),
            ttl: r.ttl ?? null,
            cloud: r.cloud ?? r.is_cloud ?? r.cloud_status ?? null,
          }))
          .filter((r) => (!type || String(r.type).toUpperCase() === type) && (!name || String(r.name || "").toLowerCase().includes(name)))
          .slice(0, 300);
        return { domain, records, total: records.length, source: "arvan-api" };
      },
    },

    arvan_dns_export: {
      description: "Export DNS records of an ArvanCloud domain as BIND text (read-only).",
      inputSchema: {
        type: "object",
        properties: { domain: { type: "string", pattern: DOMAIN.source } },
        required: ["domain"],
        additionalProperties: false,
      },
      async execute(args) {
        const domain = requireDomain(args.domain);
        const { text } = await request(`/domains/${encodeURIComponent(domain)}/dns-records/export`, { raw: true });
        return { domain, bind: String(text || "").slice(0, BIND_MAX), source: "arvan-api" };
      },
    },

    arvan_dnssec: {
      description: "DNSSEC status for an ArvanCloud CDN domain (read-only).",
      inputSchema: {
        type: "object",
        properties: { domain: { type: "string", pattern: DOMAIN.source } },
        required: ["domain"],
        additionalProperties: false,
      },
      async execute(args) {
        const domain = requireDomain(args.domain);
        const { body } = await request(`/domains/${encodeURIComponent(domain)}/dns-records/dnssec`);
        const data = dataOf(body) || {};
        return {
          domain,
          enabled: data.enabled === true || data.status === "enable" || data.status === true,
          ds: data.ds || data.ds_record || data.DS || undefined,
          source: "arvan-api",
        };
      },
    },

    arvan_cache_settings: {
      description: "Caching settings for an ArvanCloud CDN domain (read-only).",
      inputSchema: {
        type: "object",
        properties: { domain: { type: "string", pattern: DOMAIN.source } },
        required: ["domain"],
        additionalProperties: false,
      },
      async execute(args) {
        const domain = requireDomain(args.domain);
        const { body } = await request(`/domains/${encodeURIComponent(domain)}/caching`);
        return { domain, settings: dataOf(body), source: "arvan-api" };
      },
    },

    arvan_purge_tags: {
      description: "List purge tags configured on an ArvanCloud CDN domain (read-only).",
      inputSchema: {
        type: "object",
        properties: { domain: { type: "string", pattern: DOMAIN.source } },
        required: ["domain"],
        additionalProperties: false,
      },
      async execute(args) {
        const domain = requireDomain(args.domain);
        const { body } = await request(`/domains/${encodeURIComponent(domain)}/purge-tags`);
        const data = dataOf(body);
        const tags = Array.isArray(data) ? data : data?.tags || data?.data || [];
        return { domain, tags: (Array.isArray(tags) ? tags : []).slice(0, 500), source: "arvan-api" };
      },
    },

    arvan_dns_create: {
      description:
        "Create ONE new DNS record (A or CNAME) on an ArvanCloud domain. Create-only: refuses if a record with the same name and type already exists; never edits or deletes. Copy ttl/cloud from a sibling record that already points at the right place.",
      inputSchema: {
        type: "object",
        properties: {
          domain: { type: "string", pattern: DOMAIN.source },
          name: { type: "string", pattern: "^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$", description: "subdomain label(s), not @" },
          type: { type: "string", enum: ["A", "CNAME"] },
          value: { type: "string", maxLength: 253, description: "IPv4 for A, hostname for CNAME" },
          ttl: { type: "integer", minimum: 120, maximum: 86400 },
          cloud: { type: "boolean", description: "proxy through Arvan CDN" },
        },
        required: ["domain", "name", "type", "value"],
        additionalProperties: false,
      },
      async execute(args) {
        const domain = requireDomain(args.domain);
        const name = String(args.name).toLowerCase();
        const type = String(args.type).toLowerCase();
        const value = String(args.value).trim();
        if (type === "a" && !/^(\d{1,3}\.){3}\d{1,3}$/.test(value)) throw new ToolInputError("A record value must be an IPv4 address");
        if (type === "cname" && !/^[a-z0-9.-]{3,253}$/i.test(value)) throw new ToolInputError("CNAME value must be a hostname");
        const { body: listBody } = await request(`/domains/${encodeURIComponent(domain)}/dns-records`);
        const existing = (Array.isArray(dataOf(listBody)) ? dataOf(listBody) : []).filter((r) => String(r.name || "").toLowerCase() === name);
        if (existing.some((r) => String(r.type).toLowerCase() === type || (type === "cname" || String(r.type).toLowerCase() === "cname"))) {
          throw new ToolInputError(`${name}.${domain} already has a conflicting ${existing.map((r) => r.type).join("/")} record — create-only tool, nothing changed`);
        }
        const json = {
          type,
          name,
          value: type === "a" ? [{ ip: value, port: null, weight: 100, country: "" }] : { host: value, host_header: "source" },
          ttl: Number(args.ttl) || 120,
          cloud: Boolean(args.cloud),
        };
        const { body } = await request(`/domains/${encodeURIComponent(domain)}/dns-records`, { method: "POST", json });
        const r = dataOf(body) || {};
        return { domain, created: { id: r.id || null, type: r.type || type, name: r.name || name, value: recordValue(r) || value, ttl: r.ttl ?? json.ttl, cloud: r.cloud ?? json.cloud }, source: "arvan-api" };
      },
    },

    arvan_dns_delete: {
      description:
        "Delete ONE DNS record on an ArvanCloud domain, selected by exact name (and type/value when several share the name). Destructive: ask_owner with the exact record first; refuses NS records and ambiguous matches.",
      inputSchema: {
        type: "object",
        properties: {
          domain: { type: "string", pattern: DOMAIN.source },
          name: { type: "string", pattern: "^(@|\\*|[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*)$", description: "exact record name: label(s), @, or *" },
          type: { type: "string", enum: ["A", "CNAME", "TXT", "MX", "SRV", "CAA"], description: "required when the name has more than one record" },
          value: { type: "string", maxLength: 253, description: "further filter when several of the same name+type exist" },
        },
        required: ["domain", "name"],
        additionalProperties: false,
      },
      async execute(args) {
        const domain = requireDomain(args.domain);
        const name = String(args.name).toLowerCase();
        const { body } = await request(`/domains/${encodeURIComponent(domain)}/dns-records`);
        const all = Array.isArray(dataOf(body)) ? dataOf(body) : [];
        let matches = all.filter((r) => String(r.name || "").toLowerCase() === name);
        const type = args.type ? String(args.type).toUpperCase() : "";
        if (type) matches = matches.filter((r) => String(r.type).toUpperCase() === type);
        if (args.value) matches = matches.filter((r) => String(recordValue(r) || "").includes(String(args.value)));
        if (!matches.length) {
          throw new ToolInputError(`no record named ${name === "@" ? "@" : name}.${domain}${type ? ` of type ${type}` : ""} — nothing deleted`);
        }
        if (matches.length > 1) {
          throw new ToolInputError(
            `${matches.length} records named ${name} (${matches.map((r) => r.type).join("/")}) — pass type (and value) to pick exactly one`,
          );
        }
        const target = matches[0];
        if (String(target.type || "").toUpperCase() === "NS") throw new ToolInputError("refusing: NS records are zone infrastructure");
        const id = target.id || target.uuid;
        if (!id) throw new ToolInputError("record has no id in the API response — refusing to guess");
        await request(`/domains/${encodeURIComponent(domain)}/dns-records/${encodeURIComponent(id)}`, { method: "DELETE" });
        return { domain, deleted: { id, type: target.type, name: target.name, value: recordValue(target) }, source: "arvan-api" };
      },
    },

    arvan_cache_purge: {
      description:
        "Purge ArvanCloud CDN cache for a domain that exists in this Arvan account (discovered live via GET /domains — no static allowlist). Prefer scope 'urls' with the exact changed paths; a full purge (scope 'all') empties the domain's whole cache and the origin takes everything cold — it is owner-approved by the built-in guard question and must never be routed around.",
      inputSchema: {
        type: "object",
        properties: {
          domain: { type: "string", pattern: DOMAIN.source },
          scope: { type: "string", enum: ["all", "urls"] },
          urls: {
            type: "array",
            maxItems: 30,
            items: { type: "string", maxLength: 2000 },
            description: "absolute http(s) URLs; required when scope is urls",
          },
        },
        required: ["domain", "scope"],
        additionalProperties: false,
      },
      async execute(args) {
        const domain = requireDomain(args.domain);
        // Domain must belong to this API key's account — discovered live, not a vault list.
        const owned = await accountDomains();
        if (!owned.includes(domain)) {
          throw new ToolInputError(`domain ${domain} is not in this Arvan account (live list has ${owned.length} domains)`);
        }
        const scope = args.scope;
        // Body shape from CachingPurge model (cdn-go-sdk): purge=all | purge=individual + purge_urls.
        let json;
        if (scope === "all") {
          json = { purge: "all" };
        } else if (scope === "urls") {
          const urls = Array.isArray(args.urls) ? args.urls.map(String) : [];
          if (!urls.length) throw new ToolInputError("urls required when scope is urls");
          if (urls.length > 30) throw new ToolInputError("at most 30 urls");
          for (const u of urls) if (!URL_RE.test(u)) throw new ToolInputError(`invalid url: ${u.slice(0, 80)}`);
          json = { purge: "individual", purge_urls: urls };
        } else {
          throw new ToolInputError('scope must be "all" or "urls"');
        }
        const { body } = await request(`/domains/${encodeURIComponent(domain)}/caching/purge`, { method: "POST", json });
        return { domain, scope, message: dataOf(body)?.message || body?.message || "purged", source: "arvan-api" };
      },
    },
  };
}
