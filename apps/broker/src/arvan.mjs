import net from "node:net";
import { ToolInputError } from "./kube.mjs";

// ArvanCloud CDN API (https://napi.arvancloud.ir/cdn/4.0). Auth header value comes from vault
// item `arvan__api-key` verbatim (owner places the full Authorization value). Mutations other
// than cache purge are out of scope until approval routing exists.
// Purge body: https://git.arvancloud.ir/arvancloud/cdn-go-sdk/-/blob/main/docs/CachingPurge.md
//   { "purge": "all" } | { "purge": "individual", "purge_urls": ["https://…"] }

const HOST = "https://napi.arvancloud.ir/cdn/4.0";
const DOMAIN = /^[a-z0-9.-]{3,253}$/;
const DNS_DELETE_NAME = "^(@|\\*|[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*)$";
const DNS_DELETE_TYPES = ["A", "CNAME", "TXT", "MX", "SRV", "CAA"];
const URL_RE = /^https?:\/\/[^\s]{1,2000}$/i;
const BIND_MAX = 64 * 1024;
// Page-rule settings copied from a sibling by arvan_page_rule_create (everything but identity/url/seq).
const PAGE_RULE_COPY = ["url_type", "load_balancer", "edge_compute_id", "cache_level", "waf_status", "fw_status", "acceleration", "slink_status", "status"];
// Reports API facts (tested live 2026-10-22): /reports/status and /reports/status/summary honour
// since/until (hourly buckets up to a day, daily beyond); /reports/error-logs(/chart) ignore
// since/until and answer only for `period` ending now, so the window is covered by the smallest
// period and the chart buckets are clipped to it. No endpoint filters by subdomain/host or path.
const REPORT_PERIODS = [["1h", 3_600_000], ["3h", 10_800_000], ["6h", 21_600_000], ["12h", 43_200_000], ["24h", 86_400_000], ["7d", 604_800_000], ["30d", 2_592_000_000]];
const REPORT_MAX_WINDOW = 7 * 86_400_000;
const STATUS_FILTER = /^(all|[1-5]xx|[1-5]\d\d)$/;
const pageRuleSummary = (r) => ({ id: r.id, seq: r.seq, url: r.url, url_type: r.url_type, load_balancer: r.load_balancer ?? null, cache_level: r.cache_level, waf: r.waf_status, firewall: r.fw_status, status: r.status });
// Read view of a rule: the summary plus host/cache settings and timestamps when the API carries them.
const pageRuleView = (r, lbNames = new Map()) => {
  const lb = r.load_balancer && typeof r.load_balancer === "object" ? r.load_balancer : null;
  const lbKey = lb ? lb.id ?? lb.name : r.load_balancer;
  return {
    ...pageRuleSummary(r),
    load_balancer: lbKey == null ? null : { id: lb?.id ?? lbNames.get(String(lbKey))?.id ?? lbKey, name: lb?.name ?? lbNames.get(String(lbKey))?.name ?? null },
    host_header: r.host_header ?? null,
    cache_ignore_cc: r.cache_ignore_cc ?? null,
    cache_developer_mode: r.cache_developer_mode ?? null,
    created_at: r.created_at ?? null,
    updated_at: r.updated_at ?? null,
  };
};
// Does a page-rule pattern cover this URL? `*` is a wildcard; a regex-type rule is also tried as a regex.
function pageRuleMatches(rule, target) {
  const pattern = String(rule.url || "");
  const bare = (u) => u.replace(/^https?:\/\//i, "");
  const wild = new RegExp(`^${bare(pattern).split("*").map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`, "i");
  if (wild.test(bare(target))) return true;
  if (rule.url_type === "regex") {
    try {
      return new RegExp(pattern, "i").test(target);
    } catch {
      return false;
    }
  }
  return false;
}

const SECRET_KEY = /pass(word)?|secret|token|api[-_]?key|private/i;
function maskSecrets(value, depth = 0) {
  if (depth > 8) return value;
  if (Array.isArray(value)) return value.map((v) => maskSecrets(v, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, SECRET_KEY.test(k) ? "***" : maskSecrets(v, depth + 1)]));
  }
  return value;
}

// ---- security rules (arvan_security_rules) --------------------------------------------------
// Paths from cdn-go-sdk docs (FirewallAPI, WAFAPI, RateLimitingAPI, DDoSAPI, AccountLevelFirewallAPI,
// ListAPI); every call is a GET. Firewall filters are Wireshark-like expressions, e.g.
// `ip.src in {1.2.3.0/24} and http.host eq "a.example.com"`, `ip.geoip.country in {"DE"}`, `ip.src in $list`.
const SECURITY_SECTIONS = ["firewall", "waf", "ratelimit", "ddos"];
const IP_TOKEN = /(?<![\w:.])((?:\d{1,3}\.){3}\d{1,3}(?:\/\d{1,2})?|[0-9a-f]{0,4}(?::[0-9a-f]{0,4}){2,7}(?:\/\d{1,3})?)(?![\w:.])/gi;

function ipToBig(ip) {
  const kind = net.isIP(ip);
  if (kind === 4) return { v: 4, n: ip.split(".").reduce((acc, o) => (acc << 8n) + BigInt(Number(o)), 0n) };
  if (kind === 6) {
    let text = ip.toLowerCase();
    const v4 = text.match(/(\d+\.\d+\.\d+\.\d+)$/);
    if (v4) {
      const n = ipToBig(v4[1]).n;
      text = text.replace(v4[1], `${(n >> 16n).toString(16)}:${(n & 0xffffn).toString(16)}`);
    }
    const [head, tail] = text.split("::");
    const h = head ? head.split(":") : [];
    const t = tail !== undefined && tail ? tail.split(":") : [];
    const groups = tail === undefined ? h : [...h, ...Array(8 - h.length - t.length).fill("0"), ...t];
    return { v: 6, n: groups.reduce((acc, g) => (acc << 16n) + BigInt(parseInt(g || "0", 16)), 0n) };
  }
  return null;
}

// Does `cidr` (an address or address/prefix) contain `ip`?
export function cidrContains(cidr, ip) {
  const [base, bits] = String(cidr).trim().split("/");
  const a = ipToBig(base);
  const b = ipToBig(String(ip).trim());
  if (!a || !b || a.v !== b.v) return false;
  const width = a.v === 4 ? 32 : 128;
  const prefix = bits === undefined ? width : Number(bits);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > width) return false;
  const shift = BigInt(width - prefix);
  return a.n >> shift === b.n >> shift;
}

const ipTokens = (text) => [...String(text || "").matchAll(IP_TOKEN)].map((m) => m[1]).filter((t) => ipToBig(t.split("/")[0]));
// Walk any JSON value and collect the strings that are an IP or CIDR (list contents, sources…).
function ipStrings(value, out = [], depth = 0) {
  if (depth > 6 || value == null) return out;
  if (typeof value === "string") {
    for (const part of value.split(/[\s,]+/)) if (part && ipToBig(part.split("/")[0])) out.push(part);
  } else if (Array.isArray(value)) value.forEach((v) => ipStrings(v, out, depth + 1));
  else if (typeof value === "object") Object.values(value).forEach((v) => ipStrings(v, out, depth + 1));
  return out;
}

// How a firewall expression relates to one IP: matched (a literal or a referenced list holds it),
// no_ip_condition (it filters on country/ASN/path/…, so it may apply to any IP), or other_ips.
function expressionIpRelation(expr, ip, lists) {
  const text = String(expr || "");
  const hits = ipTokens(text).filter((c) => cidrContains(c, ip));
  const listHits = [];
  const unresolved = [];
  for (const m of text.matchAll(/\$([A-Za-z0-9_.-]+)/g)) {
    const entry = lists.get(m[1].toLowerCase());
    if (!entry) unresolved.push(m[1]);
    else if (entry.ips.some((c) => cidrContains(c, ip))) listHits.push(m[1]);
  }
  const negated = /\bnot\b|!=|\bne\b/i.test(text);
  if (hits.length || listHits.length) return { relation: "matched", cidrs: hits, lists: listHits, negated };
  if (unresolved.length) return { relation: "unknown_list", lists: unresolved, negated };
  if (!/ip\.src|ip\.addr|\bip\b\s*(in|eq|==)/i.test(text) || /ip\.geoip|asnum|asn/i.test(text)) {
    return { relation: /ip\.src|ip\.addr/i.test(text) ? "matched_by_other_terms" : "no_ip_condition", negated };
  }
  return { relation: negated ? "negated_other_ips" : "other_ips", negated };
}

// How an expression relates to one host: matched, no_host_condition (applies to every host), or other_hosts.
function expressionHostRelation(expr, host) {
  const text = String(expr || "");
  if (!/http\.host|http\.request\.full_uri|http\.request\.uri|hostname/i.test(text)) return { relation: "no_host_condition" };
  const quoted = [...text.matchAll(/"([^"]*)"/g)].map((m) => m[1].toLowerCase());
  const hit = quoted.some((q) => q === host || (q && host.endsWith(q.replace(/^\*/, "")) && q.startsWith("*")) || (q && q.includes(host)));
  const negated = /\bnot\b|!=|\bne\b/i.test(text);
  if (hit) return { relation: "matched", negated };
  return { relation: negated ? "negated_other_hosts" : "other_hosts", negated };
}

// Rate-limit / DDoS url_pattern (`*` and `?` wildcards): does it cover the host? A pattern with
// no host part (just a path) covers every host.
function urlPatternCoversHost(pattern, host) {
  const bare = String(pattern || "").replace(/^https?:\/\//i, "");
  const hostPart = bare.split("/")[0];
  if (!hostPart || !hostPart.includes(".") || bare.startsWith("/")) return true;
  const re = new RegExp(`^${hostPart.split("").map((c) => (c === "*" ? ".*" : c === "?" ? "." : c.replace(/[.+^${}()|[\]\\]/g, "\\$&"))).join("")}$`, "i");
  return re.test(host);
}

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

  async function allPageRules(domain) {
    const out = [];
    for (let page = 1; page <= 20; page += 1) {
      const { body } = await request(`/domains/${encodeURIComponent(domain)}/page-rules`, { params: { page, per_page: 100 } });
      const items = Array.isArray(body?.data) ? body.data : [];
      out.push(...items);
      if (!items.length || page >= Number(body?.meta?.last_page || page)) break;
    }
    return out;
  }

  // Load balancers come in pages of 50 by default; follow meta.last_page / links.next, and keep going
  // while a page comes back full in case the account answers without either.
  async function allLoadBalancers(domain) {
    const out = [];
    const seen = new Set();
    let total = null;
    let pages = 0;
    const perPage = 100;
    for (let page = 1; page <= 50; page += 1) {
      const { body } = await request(`/domains/${encodeURIComponent(domain)}/load-balancers`, { params: { page, per_page: perPage } });
      pages = page;
      const listed = dataOf(body);
      const items = Array.isArray(listed) ? listed : Array.isArray(listed?.data) ? listed.data : [];
      const meta = body?.meta || body?.data?.meta || {};
      if (meta.total != null && Number.isFinite(Number(meta.total))) total = Number(meta.total);
      let fresh = 0;
      for (const lb of items) {
        const key = lb?.id != null ? `id:${lb.id}` : `name:${lb?.name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(lb);
        fresh += 1;
      }
      if (!items.length || !fresh) break;
      const lastPage = Number(meta.last_page);
      if (Number.isFinite(lastPage) && lastPage > 0) {
        if (page >= lastPage) break;
        continue;
      }
      const next = body?.links?.next ?? body?.data?.links?.next;
      if (next === null || next === "") break;
      if (next) continue;
      if (total != null && out.length >= total) break;
      if (items.length < Math.min(perPage, 50)) break;
    }
    return { items: out, total: total ?? out.length, pages };
  }

  // DNS records come in pages (300 per page by default on large zones): follow meta.last_page /
  // links.next, and keep going while pages bring new records in case the answer carries neither.
  async function allDnsRecords(domain) {
    const out = [];
    const seen = new Set();
    let total = null;
    let pages = 0;
    const perPage = 100;
    for (let page = 1; page <= 100; page += 1) {
      const { body } = await request(`/domains/${encodeURIComponent(domain)}/dns-records`, { params: { page, per_page: perPage } });
      pages = page;
      const listed = dataOf(body);
      const items = Array.isArray(listed) ? listed : [];
      const meta = body?.meta || {};
      if (meta.total != null && Number.isFinite(Number(meta.total))) total = Number(meta.total);
      let fresh = 0;
      for (const r of items) {
        const key = r?.id ?? r?.uuid ?? JSON.stringify([r?.type, r?.name, r?.value]);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(r);
        fresh += 1;
      }
      if (!items.length || !fresh) break;
      const lastPage = Number(meta.last_page);
      if (Number.isFinite(lastPage) && lastPage > 0) {
        if (page >= lastPage) break;
        continue;
      }
      const next = body?.links?.next;
      if (next === null || next === "") break;
      if (next) continue;
      if (total != null && out.length >= total) break;
      if (items.length < perPage) break;
    }
    return { items: out, total: total ?? out.length, pages };
  }

  // Generic GET list with full pagination (meta.last_page / links.next, else stop on a short or
  // repeated page). Used by arvan_security_rules.
  async function allPages(path, { perPage = 100, maxPages = 50, params } = {}) {
    const out = [];
    const seen = new Set();
    let pages = 0;
    for (let page = 1; page <= maxPages; page += 1) {
      const { body } = await request(path, { params: { ...(params || {}), page, per_page: perPage } });
      pages = page;
      const listed = dataOf(body);
      const items = Array.isArray(listed) ? listed : Array.isArray(listed?.data) ? listed.data : [];
      let fresh = 0;
      for (const item of items) {
        const key = item?.id != null ? `id:${item.id}` : JSON.stringify(item);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(item);
        fresh += 1;
      }
      if (!items.length || !fresh) break;
      const meta = body?.meta || {};
      const lastPage = Number(meta.last_page);
      if (Number.isFinite(lastPage) && lastPage > 0) {
        if (page >= lastPage) break;
        continue;
      }
      const next = body?.links?.next;
      if (next === null || next === "") break;
      if (next) continue;
      if (items.length < perPage) break;
    }
    return { items: out, pages };
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
      description:
        "List DNS records for an ArvanCloud CDN domain (read-only). Reads every page of the zone before filtering; `total` is the zone's record count from the API, `matched` the count after type/name filters. `summary:true` returns only counts per type; `offset`/`limit` page through large results (default 300).",
      inputSchema: {
        type: "object",
        properties: {
          domain: { type: "string", pattern: DOMAIN.source },
          type: { type: "string", maxLength: 20, description: "optional record type filter e.g. A, CNAME" },
          name: { type: "string", maxLength: 253, description: "optional name substring filter" },
          summary: { type: "boolean", description: "only counts per type plus total, no records" },
          offset: { type: "integer", minimum: 0, maximum: 100000, description: "skip this many matched records" },
          limit: { type: "integer", minimum: 1, maximum: 500, description: "max records returned (default 300)" },
        },
        required: ["domain"],
        additionalProperties: false,
      },
      async execute(args) {
        const domain = requireDomain(args.domain);
        const { items, total, pages } = await allDnsRecords(domain);
        const type = args.type ? String(args.type).toUpperCase() : "";
        const name = args.name ? String(args.name).toLowerCase() : "";
        const matched = items
          .map((r) => ({
            id: r.id || r.uuid || null,
            type: r.type || null,
            name: r.name || r.host || null,
            value: recordValue(r),
            ttl: r.ttl ?? null,
            cloud: r.cloud ?? r.is_cloud ?? r.cloud_status ?? null,
          }))
          .filter((r) => (!type || String(r.type).toUpperCase() === type) && (!name || String(r.name || "").toLowerCase().includes(name)));
        if (args.summary) {
          const byType = {};
          for (const r of matched) {
            const t = String(r.type || "?").toUpperCase();
            byType[t] = (byType[t] || 0) + 1;
          }
          return { domain, total, fetched: items.length, matched: matched.length, byType, pages, source: "arvan-api" };
        }
        const offset = Math.max(0, Number(args.offset) || 0);
        const limit = Math.min(500, Math.max(1, Number(args.limit) || 300));
        const records = matched.slice(offset, offset + limit);
        const nextOffset = offset + records.length < matched.length ? offset + records.length : null;
        return { domain, records, total, fetched: items.length, matched: matched.length, offset, nextOffset, pages, source: "arvan-api" };
      },
    },

    arvan_dns_export: {
      description:
        "Export DNS records of an ArvanCloud domain as BIND text (read-only). `grep` keeps only lines containing that substring (case-insensitive); `offset`/`limit` page by line (default 400 lines). `totalLines` is the whole export's line count.",
      inputSchema: {
        type: "object",
        properties: {
          domain: { type: "string", pattern: DOMAIN.source },
          grep: { type: "string", maxLength: 200, description: "optional substring filter on lines" },
          offset: { type: "integer", minimum: 0, maximum: 100000, description: "skip this many (filtered) lines" },
          limit: { type: "integer", minimum: 1, maximum: 2000, description: "max lines returned (default 400)" },
        },
        required: ["domain"],
        additionalProperties: false,
      },
      async execute(args) {
        const domain = requireDomain(args.domain);
        const { text } = await request(`/domains/${encodeURIComponent(domain)}/dns-records/export`, { raw: true });
        const all = String(text || "").split("\n");
        if (all.length && all[all.length - 1] === "") all.pop();
        const grep = args.grep ? String(args.grep).toLowerCase() : "";
        const lines = grep ? all.filter((l) => l.toLowerCase().includes(grep)) : all;
        const offset = Math.max(0, Number(args.offset) || 0);
        const limit = Math.min(2000, Math.max(1, Number(args.limit) || 400));
        let picked = lines.slice(offset, offset + limit);
        let bind = picked.join("\n");
        if (bind.length > BIND_MAX) {
          // keep whole lines under the byte cap
          let size = 0;
          let n = 0;
          for (; n < picked.length && size + picked[n].length + 1 <= BIND_MAX; n += 1) size += picked[n].length + 1;
          picked = picked.slice(0, Math.max(1, n));
          bind = picked.join("\n").slice(0, BIND_MAX);
        }
        const nextOffset = offset + picked.length < lines.length ? offset + picked.length : null;
        return { domain, bind, totalLines: all.length, matchedLines: lines.length, offset, nextOffset, source: "arvan-api" };
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
      description:
        "Caching settings for an ArvanCloud CDN domain (read-only). cache_developer_mode=true means the cache is OFF for the WHOLE domain (everything BYPASS, all traffic to origin) — it is not 'respect origin Cache-Control'; that is cache_ignore_cc=false on one page rule.",
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

    arvan_load_balancer_get: {
      description:
        "Read ArvanCloud CDN load balancers of a domain (read-only): origins (ip/port/weight/priority/enabled/host_header), health-check config, timeouts/retries/keepalive, SSL/HTTP settings. Reads every page of the list (total/pages in the result). Without `name` lists all load balancers (summary); with `name` (or id, case-insensitive) returns that one in full; a miss lists similar names.",
      inputSchema: {
        type: "object",
        properties: {
          domain: { type: "string", pattern: DOMAIN.source },
          name: { type: "string", maxLength: 200, description: "load balancer name (e.g. hamravesh-doctors) or id" },
        },
        required: ["domain"],
        additionalProperties: false,
      },
      async execute(args) {
        const domain = requireDomain(args.domain);
        const base = `/domains/${encodeURIComponent(domain)}/load-balancers`;
        const { items, total, pages } = await allLoadBalancers(domain);
        const want = String(args.name || "").trim().toLowerCase();
        if (!want) {
          return {
            domain,
            loadBalancers: items.map((lb) => ({
              id: lb.id ?? null,
              name: lb.name ?? null,
              origins: Array.isArray(lb.origins) ? lb.origins.length : null,
              status: lb.status ?? lb.enable ?? null,
            })),
            total,
            listed: items.length,
            pages,
            source: "arvan-api",
          };
        }
        const match = items.find((lb) => String(lb.name || "").toLowerCase() === want || String(lb.id || "").toLowerCase() === want);
        if (!match) {
          const near = items.filter((lb) => String(lb.name || "").toLowerCase().includes(want) || String(lb.id || "").toLowerCase().includes(want));
          const names = (near.length ? near : items).map((lb) => lb.name || lb.id).filter(Boolean);
          throw new ToolInputError(`no load balancer ${args.name} on ${domain} (searched all ${items.length} of ${total} in ${pages} page(s)); ${near.length ? "similar" : "available"}: ${names.slice(0, 300).join(", ") || "none"}`);
        }
        let detail = match;
        if (match.id) {
          try {
            const one = await request(`${base}/${encodeURIComponent(match.id)}`);
            const d = dataOf(one.body);
            if (d && typeof d === "object" && !Array.isArray(d)) detail = { ...match, ...d };
          } catch {
            // the list entry already carries the settings on some accounts
          }
        }
        return { domain, loadBalancer: maskSecrets(detail), searched: items.length, total, pages, source: "arvan-api" };
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
        "Create ONE new DNS record (A or CNAME) on an ArvanCloud domain. Create-only: refuses if a record with the same name and type already exists; never edits or deletes. Copy ttl/cloud from a sibling record. For a proxied CNAME, host_header rewrites the Host the origin sees — serving one hostname's traffic to an origin that expects another is often this one record, no other layer to touch.",
      inputSchema: {
        type: "object",
        properties: {
          domain: { type: "string", pattern: DOMAIN.source },
          name: { type: "string", pattern: "^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$", description: "subdomain label(s), not @" },
          type: { type: "string", enum: ["A", "CNAME"] },
          value: { type: "string", maxLength: 253, description: "IPv4 for A, hostname for CNAME" },
          ttl: { type: "integer", minimum: 120, maximum: 86400 },
          cloud: { type: "boolean", description: "proxy through Arvan CDN" },
          host_header: { type: "string", pattern: "^[a-z0-9.-]{3,253}$", description: "CNAME only: Host header the origin receives (default 'source' = keep the requested hostname)" },
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
        const hostHeader = type === "cname" ? String(args.host_header || "source").toLowerCase() : undefined;
        if (hostHeader && !/^(source|[a-z0-9.-]{3,253})$/.test(hostHeader)) throw new ToolInputError("host_header must be 'source' or a hostname");
        const existing = (await allDnsRecords(domain)).items.filter((r) => String(r.name || "").toLowerCase() === name);
        if (existing.some((r) => String(r.type).toLowerCase() === type || (type === "cname" || String(r.type).toLowerCase() === "cname"))) {
          throw new ToolInputError(`${name}.${domain} already has a conflicting ${existing.map((r) => r.type).join("/")} record — create-only tool, nothing changed`);
        }
        const json = {
          type,
          name,
          value: type === "a" ? [{ ip: value, port: null, weight: 100, country: "" }] : { host: value, host_header: hostHeader || "source" },
          ttl: Number(args.ttl) || 120,
          cloud: Boolean(args.cloud),
        };
        const { body } = await request(`/domains/${encodeURIComponent(domain)}/dns-records`, { method: "POST", json });
        const r = dataOf(body) || {};
        return { domain, created: { id: r.id || null, type: r.type || type, name: r.name || name, value: recordValue(r) || value, ttl: r.ttl ?? json.ttl, cloud: r.cloud ?? json.cloud, ...(hostHeader && hostHeader !== "source" ? { host_header: hostHeader } : {}) }, source: "arvan-api" };
      },
    },

    arvan_dns_delete: {
      description:
        "Delete DNS records on an ArvanCloud domain, each selected by exact name (and type/value when several share the name). Several records of one cleanup go in ONE call via `records` (up to 50): the owner is asked once for the whole list, never once per record — do not ask_owner first, the call asks him itself. Every record is resolved before anything is deleted: an ambiguous match or an NS record refuses the whole call; a name that no longer exists is reported in notFound (already gone). Destructive.",
      inputSchema: {
        type: "object",
        properties: {
          domain: { type: "string", pattern: DOMAIN.source },
          name: { type: "string", pattern: DNS_DELETE_NAME, description: "one record: exact name — label(s), @, or *" },
          type: { type: "string", enum: DNS_DELETE_TYPES, description: "required when the name has more than one record" },
          value: { type: "string", maxLength: 253, description: "further filter when several of the same name+type exist" },
          records: {
            type: "array",
            minItems: 1,
            maxItems: 50,
            description: "several records in one call (instead of name/type/value)",
            items: {
              type: "object",
              properties: {
                name: { type: "string", pattern: DNS_DELETE_NAME },
                type: { type: "string", enum: DNS_DELETE_TYPES },
                value: { type: "string", maxLength: 253 },
              },
              required: ["name"],
              additionalProperties: false,
            },
          },
        },
        required: ["domain"],
        additionalProperties: false,
      },
      async execute(args) {
        const domain = requireDomain(args.domain);
        const single = !Array.isArray(args.records);
        const wanted = single ? [{ name: args.name, type: args.type, value: args.value }] : args.records;
        if (single && !args.name) throw new ToolInputError("pass name (one record) or records (several)");
        if (!single && args.name) throw new ToolInputError("pass either name or records, not both");
        const all = (await allDnsRecords(domain)).items;
        const targets = [];
        const notFound = [];
        for (const want of wanted) {
          const name = String(want.name).toLowerCase();
          let matches = all.filter((r) => String(r.name || "").toLowerCase() === name);
          const type = want.type ? String(want.type).toUpperCase() : "";
          if (type) matches = matches.filter((r) => String(r.type).toUpperCase() === type);
          if (want.value) matches = matches.filter((r) => String(recordValue(r) || "").includes(String(want.value)));
          if (!matches.length) {
            if (single) throw new ToolInputError(`no record named ${name === "@" ? "@" : name}.${domain}${type ? ` of type ${type}` : ""} — nothing deleted`);
            notFound.push({ name, ...(type ? { type } : {}) });
            continue;
          }
          if (matches.length > 1) {
            throw new ToolInputError(`${matches.length} records named ${name} (${matches.map((r) => r.type).join("/")}) — pass type (and value) to pick exactly one; nothing deleted`);
          }
          const target = matches[0];
          if (String(target.type || "").toUpperCase() === "NS") throw new ToolInputError(`refusing: ${name} is an NS record (zone infrastructure); nothing deleted`);
          if (!(target.id || target.uuid)) throw new ToolInputError(`record ${name} has no id in the API response — refusing to guess; nothing deleted`);
          if (!targets.includes(target)) targets.push(target);
        }
        const deleted = [];
        const failed = [];
        for (const target of targets) {
          const id = target.id || target.uuid;
          const row = { id, type: target.type, name: target.name, value: recordValue(target) };
          try {
            await request(`/domains/${encodeURIComponent(domain)}/dns-records/${encodeURIComponent(id)}`, { method: "DELETE" });
            deleted.push(row);
          } catch (err) {
            if (single) throw err;
            failed.push({ ...row, error: String(err?.message || err).slice(0, 200) });
          }
        }
        if (single) return { domain, deleted: deleted[0], source: "arvan-api" };
        return { domain, deleted, notFound, failed, source: "arvan-api" };
      },
    },

    arvan_reports: {
      description:
        "ArvanCloud CDN traffic reports for a past window (read-only, max 7 days): response counts per status class (2xx…5xx) as a time series, totals per exact status code (e.g. 503), and origin/upstream connection errors (Arvan error logs: message, count, origin address+path) with their own time series. The API is per DOMAIN only — it cannot filter by subdomain/host (users.example.com) or by request path; `path` only narrows the upstream addresses of the error logs. Bucket size is what Arvan returns (hourly up to a day, daily beyond; error charts 30 min–12 h by period) and is reported. Error logs are only queryable as a period ending now, so they cover the smallest such period that includes `from` and the chart is clipped to the window; the error list counts the whole period.",
      inputSchema: {
        type: "object",
        properties: {
          domain: { type: "string", pattern: DOMAIN.source, description: "Arvan domain, e.g. example.com (not the subdomain)" },
          from: { type: "string", maxLength: 40, description: "window start, ISO UTC e.g. 2026-10-21T16:30:00Z" },
          to: { type: "string", maxLength: 40, description: "window end, ISO UTC (default now)" },
          status: { type: "string", maxLength: 3, description: "all (default) | a class like 5xx | an exact code like 503" },
          host: { type: "string", maxLength: 253, description: "subdomain the question is about; the API cannot filter by it — echoed with a note" },
          path: { type: "string", maxLength: 200, description: "optional substring to keep only matching upstream addresses in the error logs, e.g. /webhook" },
        },
        required: ["domain", "from"],
        additionalProperties: false,
      },
      async execute(args) {
        const domain = requireDomain(args.domain);
        const now = Date.now();
        const from = Date.parse(String(args.from || ""));
        const to = args.to ? Date.parse(String(args.to)) : now;
        if (!Number.isFinite(from) || !Number.isFinite(to)) throw new ToolInputError("from/to must be ISO 8601 UTC dates, e.g. 2026-10-21T16:30:00Z");
        if (to <= from) throw new ToolInputError("to must be after from");
        if (to - from > REPORT_MAX_WINDOW) throw new ToolInputError("window is at most 7 days");
        if (from > now) throw new ToolInputError("from is in the future");
        const status = String(args.status || "all").toLowerCase();
        if (!STATUS_FILTER.test(status)) throw new ToolInputError("status must be all, a class like 5xx, or a code like 503");
        const pathNeedle = String(args.path || "").toLowerCase();
        const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
        const window = { since: iso(from), until: iso(Math.min(to, now)) };
        const base = `/domains/${encodeURIComponent(domain)}/reports`;
        const period = REPORT_PERIODS.find(([, ms]) => ms >= now - from);
        const [statusRes, summaryRes, chartRes, listRes] = await Promise.all([
          request(`${base}/status`, { params: window }),
          request(`${base}/status/summary`, { params: window }),
          period ? request(`${base}/error-logs/chart`, { params: { period: period[0] } }) : null,
          period ? request(`${base}/error-logs`, { params: { period: period[0] } }) : null,
        ]);
        const bucketOf = (cats) => (cats.length > 1 ? Math.round((Date.parse(cats[1]) - Date.parse(cats[0])) / 1000) : null);
        const classOf = (name) => String(name).match(/([1-5]xx)/)?.[1] || String(name);
        const keepClass = (cls) => status === "all" || cls === (status.endsWith("xx") ? status : `${status[0]}xx`);
        const keepCode = (code) => status === "all" || (status.endsWith("xx") ? String(code)[0] === status[0] : String(code) === status);

        const sc = dataOf(statusRes.body) || {};
        const sChart = sc.charts?.status_code || {};
        const sCats = Array.isArray(sChart.categories) ? sChart.categories : [];
        const sSeries = (Array.isArray(sChart.series) ? sChart.series : []).filter((s) => keepClass(classOf(s.name)));
        const series = sCats.map((t, i) => ({ t, ...Object.fromEntries(sSeries.map((s) => [classOf(s.name), Number(s.data?.[i] ?? 0)])) }));
        const totals = Object.fromEntries(
          Object.entries(sc.statistics?.status_codes || {})
            .map(([k, v]) => [classOf(k), Number(v)])
            .filter(([k]) => keepClass(k)),
        );
        const summary = dataOf(summaryRes.body) || {};
        const codes = Object.fromEntries(
          (Array.isArray(summary.charts?.status_code) ? summary.charts.status_code : [])
            .filter((c) => keepCode(c.name))
            .map((c) => [String(c.name), Number(c.y ?? 0)])
            .sort((a, b) => b[1] - a[1])
            .slice(0, 60),
        );

        let originErrors = null;
        if (period) {
          const ec = dataOf(chartRes.body) || {};
          const eChart = ec.charts?.status_code || {};
          const eCats = Array.isArray(eChart.categories) ? eChart.categories : [];
          const eBucket = bucketOf(eCats);
          const lo = from - (eBucket || 0) * 1000;
          const idx = eCats.map((t, i) => [Date.parse(t), i]).filter(([t]) => t >= lo && t < to).map(([, i]) => i);
          const chart = (Array.isArray(eChart.series) ? eChart.series : [])
            .map((s) => {
              const data = idx.map((i) => Number(s.data?.[i] ?? 0));
              return { error: String(s.name || "").slice(0, 300), total: data.reduce((a, b) => a + b, 0), data };
            })
            .filter((s) => s.total > 0)
            .sort((a, b) => b.total - a.total)
            .slice(0, 15);
          const items = Array.isArray(dataOf(listRes.body)) ? dataOf(listRes.body) : [];
          const list = items
            .map((e) => {
              const upstreams = (Array.isArray(e.upstreams) ? e.upstreams : [])
                // Query strings can carry tokens; the path is what tells origins apart.
                .map((u) => ({ address: String(u.address || "").split("?")[0].slice(0, 300), count: Number(u.count ?? 0) }))
                .filter((u) => !pathNeedle || u.address.toLowerCase().includes(pathNeedle));
              return { error: String(e.name || "").slice(0, 300), count: Number(e.count ?? 0), upstreams: upstreams.slice(0, 10), upstreamsMatched: upstreams.length };
            })
            .filter((e) => !pathNeedle || e.upstreamsMatched > 0)
            .slice(0, 20);
          originErrors = {
            period: period[0],
            bucketSeconds: eBucket,
            categories: idx.map((i) => eCats[i]),
            chart,
            list,
            listCovers: `the whole last ${period[0]} (Arvan error logs cannot be cut to since/until)`,
          };
        }

        const notes = [];
        if (args.host) notes.push(`Arvan reports are per domain: numbers are for all of ${domain}, not only ${String(args.host).slice(0, 253)}.`);
        if (/^\d{3}$/.test(status)) notes.push(`The time series has no per-code breakdown; it shows the ${status[0]}xx class. codes.${status} is the exact total for the window.`);
        if (!period) notes.push("Error logs only reach back 30 days from now; origin errors omitted.");
        if (to > now) notes.push("to is in the future; the window ends now.");
        return {
          domain,
          window: { from: window.since, to: window.until },
          filter: { status, path: pathNeedle || null },
          bucketSeconds: bucketOf(sCats),
          series,
          totals,
          codes,
          originErrors,
          notes,
          source: "arvan-api",
        };
      },
    },

    arvan_page_rules: {
      description:
        "Read page rules of an ArvanCloud domain (read-only, all pages): id, seq, url pattern, status, load_balancer (origin id + name), host_header, cache_level, cache_ignore_cc, cache_developer_mode, waf/firewall, created/updated. Filter with `search` (substring of the url or load balancer, e.g. \"api\"), or pass `host` (+ optional `path`) to get the rules whose pattern covers that URL, sorted by seq. With `id` returns that one rule's full body. Use it before arvan_page_rule_create to pick the sibling rule to copy.",
      inputSchema: {
        type: "object",
        properties: {
          domain: { type: "string", pattern: DOMAIN.source },
          id: { type: "string", pattern: "^[0-9a-zA-Z-]{1,64}$", description: "one rule id: returns its full body" },
          search: { type: "string", maxLength: 200 },
          host: { type: "string", pattern: DOMAIN.source, description: "e.g. api.example.com — returns the rules that match host+path" },
          path: { type: "string", maxLength: 1000, description: "e.g. /orders/v1/items (default /)" },
        },
        required: ["domain"],
        additionalProperties: false,
      },
      async execute(args) {
        const domain = requireDomain(args.domain);
        const lbNames = new Map();
        try {
          const { body } = await request(`/domains/${encodeURIComponent(domain)}/load-balancers`);
          const listed = dataOf(body);
          for (const lb of Array.isArray(listed) ? listed : Array.isArray(listed?.data) ? listed.data : []) {
            const entry = { id: lb.id ?? null, name: lb.name ?? null };
            if (lb.id != null) lbNames.set(String(lb.id), entry);
            if (lb.name != null) lbNames.set(String(lb.name), entry);
          }
        } catch {
          // names are a convenience; the rule still carries its load_balancer key
        }
        if (args.id) {
          const { body } = await request(`/domains/${encodeURIComponent(domain)}/page-rules/${encodeURIComponent(args.id)}`);
          const rule = dataOf(body);
          if (!rule || typeof rule !== "object" || Array.isArray(rule)) throw new ToolInputError(`no page rule ${args.id} on ${domain}`);
          return { domain, rule: { ...pageRuleView(rule, lbNames), full: maskSecrets(rule) }, source: "arvan-api" };
        }
        const rules = await allPageRules(domain);
        if (args.host) {
          const host = String(args.host).trim().toLowerCase();
          if (host !== domain && !host.endsWith(`.${domain}`)) throw new ToolInputError(`host must be on ${domain}`);
          const rawPath = String(args.path || "/").trim();
          const target = `https://${host}${rawPath.startsWith("/") ? rawPath : `/${rawPath}`}`;
          const matches = rules
            .filter((r) => pageRuleMatches(r, target))
            .sort((a, b) => (Number(a.seq) || 0) - (Number(b.seq) || 0))
            .map((r) => pageRuleView(r, lbNames));
          return { domain, url: target, total: rules.length, matched: matches.length, rules: matches, note: "every rule whose pattern covers the url, by seq; inactive rules (status=false) are included", source: "arvan-api" };
        }
        const needle = String(args.search || "").toLowerCase();
        const shown = rules
          .filter((r) => !needle || `${r.url} ${typeof r.load_balancer === "object" ? JSON.stringify(r.load_balancer) : r.load_balancer || ""}`.toLowerCase().includes(needle))
          .map((r) => pageRuleView(r, lbNames));
        return { domain, total: rules.length, shown: shown.length, rules: shown.slice(0, 300), source: "arvan-api" };
      },
    },

    arvan_page_rule_create: {
      description:
        "Create ONE page rule on an ArvanCloud domain by copying every setting (origin load_balancer, cache_level, WAF/firewall, acceleration, status) from an existing sibling rule (copy_from = its id from arvan_page_rules) and changing only the url pattern. Create-only: refuses if a rule with the same url exists; never edits or deletes. seq defaults to the highest existing seq + 1 (a later rule); pass seq to place it before a broader rule that would otherwise shadow it.",
      inputSchema: {
        type: "object",
        properties: {
          domain: { type: "string", pattern: DOMAIN.source },
          url: { type: "string", maxLength: 500, description: "full pattern, e.g. https://api.example.com/orders/v1/search*" },
          copy_from: { type: "string", pattern: "^[0-9a-f-]{36}$", description: "id of the sibling rule whose settings to copy" },
          seq: { type: "integer", minimum: 1, maximum: 100000 },
        },
        required: ["domain", "url", "copy_from"],
        additionalProperties: false,
      },
      async execute(args) {
        const domain = requireDomain(args.domain);
        const url = String(args.url || "").trim();
        let host;
        try {
          host = new URL(url.replace(/\*/g, "x")).hostname.toLowerCase();
        } catch {
          throw new ToolInputError("url must be a full https://host/path pattern");
        }
        if (!/^https?:\/\//i.test(url) || (host !== domain && !host.endsWith(`.${domain}`))) {
          throw new ToolInputError(`url must be on ${domain} (got host ${host})`);
        }
        const rules = await allPageRules(domain);
        if (rules.some((r) => String(r.url).toLowerCase() === url.toLowerCase())) {
          throw new ToolInputError(`a page rule for ${url} already exists — create-only tool, nothing changed`);
        }
        const source = rules.find((r) => r.id === args.copy_from);
        if (!source) throw new ToolInputError(`no page rule ${args.copy_from} on ${domain} — pick copy_from from arvan_page_rules`);
        const seq = Number(args.seq) || Math.max(0, ...rules.map((r) => Number(r.seq) || 0)) + 1;
        const json = { url, seq };
        for (const key of PAGE_RULE_COPY) if (source[key] != null && source[key] !== "") json[key] = source[key]; // Arvan 422s on a null edge_compute_id
        const { body } = await request(`/domains/${encodeURIComponent(domain)}/page-rules`, { method: "POST", json });
        return { domain, created: pageRuleSummary(dataOf(body) || { ...json }), copiedFrom: pageRuleSummary(source), source: "arvan-api" };
      },
    },

    arvan_security_rules: {
      description:
        "Read the security layer of an ArvanCloud CDN domain (read-only, GET only, all pages): firewall rules (id, name, priority, action, filter expression with the IPs/CIDRs/countries/ASNs/hosts it names, enabled) plus the firewall default action and settings, account-level firewall rules that cover this domain, the IP lists ($name) a rule references, WAF settings/packages/rules, rate-limit settings and rules, DDoS settings and rules. Pass `ip` and/or `host` to keep only the rules that can act on that IP/host — each kept rule says why (matched / no_ip_condition = it filters on country/ASN so it may hit any IP / unknown_list). Use it to explain an Arvan block page (e.g. error 2075 = IP/location block) or a challenge.",
      inputSchema: {
        type: "object",
        properties: {
          domain: { type: "string", pattern: DOMAIN.source },
          host: { type: "string", pattern: DOMAIN.source, description: "e.g. dashboard.example.com — only rules that can apply to this host" },
          ip: { type: "string", maxLength: 64, description: "client IPv4/IPv6 — only rules that can apply to this IP" },
          section: { type: "string", enum: ["all", ...SECURITY_SECTIONS], description: "default all" },
        },
        required: ["domain"],
        additionalProperties: false,
      },
      async execute(args) {
        const domain = requireDomain(args.domain);
        const section = String(args.section || "all");
        if (section !== "all" && !SECURITY_SECTIONS.includes(section)) throw new ToolInputError(`section must be one of all, ${SECURITY_SECTIONS.join(", ")}`);
        let host = null;
        if (args.host) {
          host = String(args.host).trim().toLowerCase();
          if (host !== domain && !host.endsWith(`.${domain}`)) throw new ToolInputError(`host must be on ${domain}`);
        }
        const ip = args.ip ? String(args.ip).trim() : null;
        if (ip && !net.isIP(ip)) throw new ToolInputError("ip must be a plain IPv4 or IPv6 address");
        const want = (s) => section === "all" || section === s;
        const base = `/domains/${encodeURIComponent(domain)}`;
        const errors = {};
        const attempt = async (label, fn) => {
          try {
            return await fn();
          } catch (err) {
            if (err instanceof ToolInputError && /rejected the credential/.test(err.message)) throw err;
            errors[label] = String(err?.message || err).slice(0, 200);
            return null;
          }
        };
        const one = async (path) => dataOf((await request(path)).body);
        const CAP = 300;
        const filtered = (rules, view, relate) => {
          const kept = [];
          for (const r of rules) {
            const why = relate ? relate(r) : null;
            if (why === false) continue;
            kept.push(why ? { ...view(r), applies: why } : view(r));
          }
          return { total: rules.length, shown: Math.min(kept.length, CAP), rules: kept.slice(0, CAP) };
        };
        const result = { domain, host, ip, section, source: "arvan-api" };

        if (want("firewall")) {
          const settings = await attempt("firewall.settings", () => one(`${base}/firewall/settings`));
          const domainRules = (await attempt("firewall.rules", () => allPages(`${base}/firewall/rules`)))?.items || [];
          const accountRules = (await attempt("firewall.account_rules", () => allPages(`/account/firewall-rules`)))?.items || [];
          // Account rules apply to this domain when selection is all, or include lists it, or exclude does not.
          let domainId = null;
          if (accountRules.some((r) => r.domain_selection_type && r.domain_selection_type !== "all")) {
            const d = await attempt("domain", () => one(base));
            domainId = d?.id ?? null;
          }
          const coversDomain = (r) => {
            const type = r.domain_selection_type || "all";
            const ids = (r.domain_ids || []).map(String);
            if (type === "all") return true;
            if (domainId == null) return true;
            return type === "include" ? ids.includes(String(domainId)) : !ids.includes(String(domainId));
          };
          const allRules = [
            ...domainRules.map((r) => ({ ...r, level: "domain" })),
            ...accountRules.filter(coversDomain).map((r) => ({ ...r, level: "account" })),
          ];
          // IP lists referenced as $name: resolve names to contents when an ip filter needs them.
          const lists = new Map();
          const referenced = new Set(allRules.flatMap((r) => [...String(r.filter_expr || "").matchAll(/\$([A-Za-z0-9_.-]+)/g)].map((m) => m[1].toLowerCase())));
          if (referenced.size) {
            const index = (await attempt("firewall.lists", () => allPages(`/dynamic-fields`)))?.items || [];
            for (const entry of index) {
              const name = String(entry.name || entry.key || entry.slug || "").toLowerCase();
              if (!name || !referenced.has(name)) continue;
              let full = entry;
              if (ip && entry.id != null) full = (await attempt(`firewall.list.${name}`, () => one(`/dynamic-fields/${encodeURIComponent(entry.id)}`))) || entry;
              const ips = ipStrings(full.items ?? full.values ?? full.content ?? full.data ?? full);
              lists.set(name, { id: entry.id ?? null, name: entry.name ?? name, type: entry.type ?? null, size: ips.length || entry.count || entry.items_count || null, ips });
            }
          }
          const view = (r) => ({
            id: r.id ?? null,
            level: r.level,
            name: r.name ?? null,
            priority: r.priority ?? r.seq ?? null,
            action: r.action ?? null,
            action_details: r.action_details ?? null,
            enabled: r.is_enabled ?? r.status ?? null,
            filter_expr: r.filter_expr ?? null,
            ips: ipTokens(r.filter_expr).slice(0, 50),
            countries: [...String(r.filter_expr || "").matchAll(/geoip\.country\s*(?:in|eq|==|ne|!=)\s*\{?([^}]*?)\}?(?:\s+(?:and|or)\b|\)|$)/gi)].flatMap((m) => m[1].match(/[A-Z]{2}/g) || []),
            asns: [...String(r.filter_expr || "").matchAll(/(?:asnum|asn)\s*(?:in|eq|==|ne|!=)\s*\{?([^}]*?)\}?(?:\s+(?:and|or)\b|\)|$)/gi)].flatMap((m) => m[1].match(/\d+/g) || []),
            note: r.note ?? null,
          });
          const relate = ip || host
            ? (r) => {
                const why = {};
                if (ip) {
                  const rel = expressionIpRelation(r.filter_expr, ip, lists);
                  if (rel.relation === "other_ips") return false;
                  why.ip = rel;
                }
                if (host) {
                  const rel = expressionHostRelation(r.filter_expr, host);
                  if (rel.relation === "other_hosts") return false;
                  why.host = rel;
                }
                return why;
              }
            : null;
          const sorted = allRules.sort((a, b) => (a.level === b.level ? 0 : a.level === "account" ? -1 : 1) || (Number(a.priority) || 0) - (Number(b.priority) || 0));
          result.firewall = {
            settings: settings ? maskSecrets(settings) : null,
            default_action: settings?.default_action ?? null,
            ...filtered(sorted, view, relate),
            domain_rules: domainRules.length,
            account_rules: accountRules.length,
            lists: [...lists.values()].map((l) => ({ id: l.id, name: l.name, type: l.type, size: l.size, ...(ip ? { contains_ip: l.ips.some((c) => cidrContains(c, ip)) } : {}) })),
          };
        }

        if (want("waf")) {
          const settings = await attempt("waf.settings", () => one(`${base}/waf/settings`));
          const packages = (await attempt("waf.packages", () => allPages(`${base}/waf/packages`)))?.items || [];
          const rules = (await attempt("waf.rules", () => allPages(`${base}/waf/rules`)))?.items || [];
          const view = (r) => ({ id: r.id ?? null, name: r.name ?? r.description ?? null, action: r.action ?? r.mode ?? null, enabled: r.is_enabled ?? r.status ?? null, filter_expr: r.filter_expr ?? r.expression ?? null, url_pattern: r.url_pattern ?? null });
          const relate = ip || host
            ? (r) => {
                const why = {};
                const expr = r.filter_expr ?? r.expression;
                if (expr && ip) {
                  const rel = expressionIpRelation(expr, ip, new Map());
                  if (rel.relation === "other_ips") return false;
                  why.ip = rel;
                }
                if (expr && host) {
                  const rel = expressionHostRelation(expr, host);
                  if (rel.relation === "other_hosts") return false;
                  why.host = rel;
                }
                return why;
              }
            : null;
          result.waf = {
            settings: settings ? maskSecrets(settings) : null,
            packages: packages.map((p) => ({ id: p.id ?? null, name: p.name ?? null, enabled: p.is_enabled ?? null, disabled_rules: (p.disabled_rules || []).length, disabled_rulesets: (p.disabled_rulesets || []).length, params: maskSecrets(p.params ?? null) })),
            ...filtered(rules, view, relate),
          };
        }

        const sourcesRelate = (r, field, label) => {
          const why = {};
          if (host) {
            if (!urlPatternCoversHost(r.url_pattern, host)) return false;
            why.host = r.url_pattern ? "url_pattern covers host" : "no host condition";
          }
          if (ip) {
            const sources = ipStrings(r[field] || []);
            const hit = sources.some((c) => cidrContains(c, ip));
            if (label === "excluded") why.ip = hit ? "ip is in exclude_sources (exempt)" : "applies to this ip";
            else {
              if (sources.length && !hit) return false;
              why.ip = hit ? "ip is in sources" : "no source condition (any ip)";
            }
          }
          return why;
        };

        if (want("ratelimit")) {
          const settings = await attempt("ratelimit.settings", () => one(`${base}/rate-limit/settings`));
          const rules = (await attempt("ratelimit.rules", () => allPages(`${base}/rate-limit/rules`)))?.items || [];
          const view = (r) => ({ id: r.id ?? null, url_pattern: r.url_pattern ?? null, action: r.action ?? null, enabled: r.is_enabled ?? null, rate: r.rate ?? null, burst: r.burst ?? null, time_duration: r.time_duration ?? null, block_duration: r.block_duration ?? null, allowed_methods: r.allowed_methods ?? null, exclude_sources: r.exclude_sources ?? [], description: r.description ?? null });
          result.ratelimit = {
            settings: settings ? maskSecrets(settings) : null,
            ...(ip && settings ? { ip_excluded_globally: ipStrings(settings.exclude_sources || []).some((c) => cidrContains(c, ip)) } : {}),
            ...filtered(rules, view, ip || host ? (r) => sourcesRelate(r, "exclude_sources", "excluded") : null),
          };
        }

        if (want("ddos")) {
          const settings = await attempt("ddos.settings", () => one(`${base}/ddos/settings`));
          const rules = (await attempt("ddos.rules", () => allPages(`${base}/ddos/rules`)))?.items || [];
          const view = (r) => ({ id: r.id ?? null, url_pattern: r.url_pattern ?? null, sources: r.sources ?? [], action: r.action ?? null, enabled: r.is_enabled ?? null, description: r.description ?? null });
          result.ddos = {
            settings: settings ? maskSecrets(settings) : null,
            ...filtered(rules, view, ip || host ? (r) => sourcesRelate(r, "sources", "sources") : null),
          };
        }

        if (ip) result.note = "Country/ASN of the ip is not resolved here: a rule with relation no_ip_condition or matched_by_other_terms (geoip/ASN) may be the one blocking it.";
        if (Object.keys(errors).length) result.errors = errors;
        return result;
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
