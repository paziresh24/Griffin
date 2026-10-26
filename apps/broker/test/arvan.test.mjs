import test from "node:test";
import assert from "node:assert/strict";
import { createArvanTools } from "../src/arvan.mjs";
import { ToolInputError } from "../src/kube.mjs";

function setup({ items = { "arvan__api-key": "Apikey test-key" }, responses } = {}) {
  const calls = [];
  const vault = {
    item: async (slug) => {
      if (!(slug in items)) throw new Error(`emergency vault http_404`);
      return items[slug];
    },
  };
  const fetchImpl = async (url, init = {}) => {
    const u = typeof url === "string" ? new URL(url) : url;
    calls.push({ method: init.method || "GET", path: u.pathname + u.search, headers: init.headers, body: init.body });
    const key = `${init.method || "GET"} ${u.pathname}`;
    const handler = responses?.[key] || responses?.[u.pathname];
    if (typeof handler === "function") return handler(u, init);
    if (handler) return handler;
    return Response.json({ data: [] });
  };
  return { tools: createArvanTools({ vault, fetchImpl }), calls, vault };
}

const accountDomains = {
  "/cdn/4.0/domains": () => Response.json({
    data: [{ domain: "example.com", status: "active" }, { domain: "cdn.example.com", status: "active" }],
  }),
};

test("Authorization header is passed verbatim from arvan__api-key", async () => {
  const { tools, calls } = setup({
    responses: {
      "/cdn/4.0/domains": Response.json({
        data: [{ domain: "example.com", status: "active", plan: "growth", dns_cloud: true }],
      }),
    },
  });
  const result = await tools.arvan_domains.execute({});
  assert.equal(calls[0].headers.Authorization, "Apikey test-key");
  assert.equal(result.source, "arvan-api");
  assert.equal(result.domains[0].domain, "example.com");
});

test("missing arvan__api-key is a ToolInputError naming the item", async () => {
  const { tools } = setup({ items: {} });
  await assert.rejects(tools.arvan_domains.execute({}), (err) => {
    assert.ok(err instanceof ToolInputError);
    assert.match(err.message, /arvan__api-key/);
    return true;
  });
});

test("401 from Arvan becomes ToolInputError", async () => {
  const { tools } = setup({
    responses: {
      "/cdn/4.0/domains": new Response(JSON.stringify({ message: "Unauthenticated." }), { status: 401 }),
    },
  });
  await assert.rejects(tools.arvan_domains.execute({}), (err) => {
    assert.ok(err instanceof ToolInputError);
    assert.match(err.message, /rejected the credential/);
    return true;
  });
});

test("arvan_dns_records filters by type and name client-side", async () => {
  const { tools } = setup({
    responses: {
      "/cdn/4.0/domains/example.com/dns-records": Response.json({
        data: [
          { id: "1", type: "A", name: "www", value: { ip: "1.2.3.4" }, ttl: 120, cloud: true },
          { id: "2", type: "CNAME", name: "api", value: { host: "origin.example.com" }, ttl: 300, cloud: false },
          { id: "3", type: "A", name: "mail", value: { ip: "9.9.9.9" }, ttl: 60, cloud: false },
        ],
      }),
    },
  });
  const result = await tools.arvan_dns_records.execute({ domain: "Example.COM", type: "A", name: "www" });
  assert.equal(result.domain, "example.com");
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].value, "1.2.3.4");
});

test("arvan_cache_purge refuses a domain not in the live Arvan account", async () => {
  const { tools, calls } = setup({
    responses: {
      ...accountDomains,
      "POST /cdn/4.0/domains/evil.com/caching/purge": () => Response.json({ message: "purged" }),
    },
  });
  await assert.rejects(tools.arvan_cache_purge.execute({ domain: "evil.com", scope: "all" }), (err) => {
    assert.ok(err instanceof ToolInputError);
    assert.match(err.message, /not in this Arvan account/);
    return true;
  });
  assert.ok(calls.some((c) => c.path === "/cdn/4.0/domains"));
  assert.ok(!calls.some((c) => c.method === "POST"), "must not purge when domain is not in the account");
});

test("arvan_cache_purge sends documented body for scope=all and scope=urls after live domain check", async () => {
  const { tools, calls } = setup({
    responses: {
      ...accountDomains,
      "POST /cdn/4.0/domains/example.com/caching/purge": () => Response.json({ message: "Cache purged successfully" }),
    },
  });
  await tools.arvan_cache_purge.execute({ domain: "example.com", scope: "all" });
  await tools.arvan_cache_purge.execute({
    domain: "example.com",
    scope: "urls",
    urls: ["https://example.com/a", "https://example.com/b"],
  });
  const purgeCalls = calls.filter((c) => c.method === "POST");
  assert.equal(purgeCalls.length, 2);
  assert.deepEqual(JSON.parse(purgeCalls[0].body), { purge: "all" });
  assert.deepEqual(JSON.parse(purgeCalls[1].body), {
    purge: "individual",
    purge_urls: ["https://example.com/a", "https://example.com/b"],
  });
});

test("arvan_cache_purge requires urls when scope is urls", async () => {
  const { tools } = setup({ responses: accountDomains });
  await assert.rejects(tools.arvan_cache_purge.execute({ domain: "example.com", scope: "urls" }), /urls required/);
});

test("arvan_dns_export returns clipped BIND text", async () => {
  const { tools } = setup({
    responses: {
      "/cdn/4.0/domains/example.com/dns-records/export": new Response("example.com. IN A 1.2.3.4\n", {
        status: 200,
        headers: { "content-type": "text/plain" },
      }),
    },
  });
  const result = await tools.arvan_dns_export.execute({ domain: "example.com" });
  assert.match(result.bind, /IN A/);
  assert.equal(result.source, "arvan-api");
});

test("arvan_dns_create: creates a new record, refuses to touch an existing name", async () => {
  const records = [{ id: "1", type: "a", name: "mohr", value: [{ ip: "203.0.113.1" }], ttl: 120, cloud: true }];
  const { tools, calls } = setup({
    responses: {
      "GET /cdn/4.0/domains/example.com/dns-records": () => Response.json({ data: records }),
      "POST /cdn/4.0/domains/example.com/dns-records": (u, init) => Response.json({ data: { id: "2", ...JSON.parse(init.body) } }),
    },
  });
  const out = await tools.arvan_dns_create.execute({ domain: "example.com", name: "shop", type: "A", value: "203.0.113.1", cloud: true });
  assert.equal(out.created.name, "shop");
  const post = calls.find((c) => c.method === "POST");
  assert.deepEqual(JSON.parse(post.body).value, [{ ip: "203.0.113.1", port: null, weight: 100, country: "" }]);
  await assert.rejects(tools.arvan_dns_create.execute({ domain: "example.com", name: "mohr", type: "A", value: "1.2.3.4" }), /already has/);
  await assert.rejects(tools.arvan_dns_create.execute({ domain: "example.com", name: "x", type: "A", value: "not-ip" }), /IPv4/);
  assert.equal(calls.filter((c) => c.method !== "GET").length, 1, "no write on refusal");
});

test("arvan_dns_create: host_header rides along on CNAME (default source), A ignores it", async () => {
  const { tools, calls } = setup({
    responses: {
      "GET /cdn/4.0/domains/example.net/dns-records": () => Response.json({ data: [] }),
      "POST /cdn/4.0/domains/example.net/dns-records": (u, init) => Response.json({ data: { id: "9", ...JSON.parse(init.body) } }),
    },
  });
  const out = await tools.arvan_dns_create.execute({ domain: "example.net", name: "temp1", type: "CNAME", value: "gateway.example.net", cloud: true, host_header: "app.example.net" });
  assert.equal(out.created.host_header, "app.example.net");
  const post = calls.find((c) => c.method === "POST");
  assert.deepEqual(JSON.parse(post.body).value, { host: "gateway.example.net", host_header: "app.example.net" });

  const plain = await tools.arvan_dns_create.execute({ domain: "example.net", name: "temp2", type: "CNAME", value: "gateway.example.net", cloud: true });
  const post2 = calls.filter((c) => c.method === "POST").at(-1);
  assert.deepEqual(JSON.parse(post2.body).value, { host: "gateway.example.net", host_header: "source" });
  assert.equal(plain.created.host_header, undefined, "source is the silent default");
});

test("arvan_dns_delete: deletes by exact name, refuses ambiguous and NS", async () => {
  const records = [
    { id: "r1", type: "a", name: "staging", value: [{ ip: "203.0.113.1" }], ttl: 120, cloud: false },
    { id: "r2", type: "cname", name: "dual", value: { host: "a.example.com" }, ttl: 120, cloud: false },
    { id: "r3", type: "a", name: "dual", value: [{ ip: "203.0.113.2" }], ttl: 120, cloud: false },
    { id: "r4", type: "NS", name: "example.com", value: { host: "ns1.arvancloud.ir" } },
  ];
  const { tools, calls } = setup({
    responses: {
      "GET /cdn/4.0/domains/example.com/dns-records": () => Response.json({ data: records }),
      "DELETE /cdn/4.0/domains/example.com/dns-records/r1": () => Response.json({ data: { id: "r1" } }),
      "DELETE /cdn/4.0/domains/example.com/dns-records/r3": () => Response.json({ data: { id: "r3" } }),
    },
  });

  const out = await tools.arvan_dns_delete.execute({ domain: "example.com", name: "staging" });
  assert.equal(out.deleted.id, "r1");
  assert.equal(out.deleted.type, "a");
  assert.match(out.deleted.value, /203\.0\.113\.1/);
  assert.equal(calls.filter((c) => c.method === "DELETE").length, 1);

  // ambiguous without type → refuse; with type → the right one
  await assert.rejects(tools.arvan_dns_delete.execute({ domain: "example.com", name: "dual" }), /pass type/);
  const picked = await tools.arvan_dns_delete.execute({ domain: "example.com", name: "dual", type: "A" });
  assert.equal(picked.deleted.id, "r3");
  assert.ok(calls.some((c) => c.method === "DELETE" && c.path.endsWith("/dns-records/r3")));

  // zone infrastructure and missing names are never touched
  await assert.rejects(tools.arvan_dns_delete.execute({ domain: "example.com", name: "example.com", type: "NS" }), /NS/);
  await assert.rejects(tools.arvan_dns_delete.execute({ domain: "example.com", name: "ghost" }), /no record named/);
  assert.equal(calls.filter((c) => c.method === "DELETE").length, 2, "refusals made no extra deletes");
});

// A cutover once stalled — no tool could add a page rule and Griffin asked for the
// raw Arvan key. arvan_page_rule_create clones a sibling rule's settings and changes only the url.
test("arvan_page_rule_create: copies a sibling's settings, pages through rules, refuses duplicates and foreign hosts", async () => {
  const sibling = { id: "0ac3a8e2-591b-487f-92c2-3057ebfa1f39", seq: 3025, url_type: "regex", url: "https://api.example.com/orders/v2/transactions/balance/main*", load_balancer: "orders-lb", edge_compute_id: null, cache_level: "off", waf_status: true, fw_status: true, acceleration: { status: "inherit", extensions: [] }, slink_status: false, status: true, created_at: "x" };
  const pages = { 1: [{ id: "11111111-1111-1111-1111-111111111111", seq: 10, url: "https://www.example.com/*" }], 2: [sibling] };
  const { tools, calls } = setup({
    responses: {
      "GET /cdn/4.0/domains/example.com/page-rules": (u) => Response.json({ data: pages[u.searchParams.get("page")] || [], meta: { last_page: 2 } }),
      "POST /cdn/4.0/domains/example.com/page-rules": (u, init) => Response.json({ data: { id: "new", ...JSON.parse(init.body) } }),
    },
  });
  const listed = await tools.arvan_page_rules.execute({ domain: "example.com", search: "orders" });
  assert.equal(listed.total, 2);
  assert.deepEqual(listed.rules[0].load_balancer, { id: "orders-lb", name: null });

  const out = await tools.arvan_page_rule_create.execute({ domain: "example.com", url: "https://api.example.com/orders/v1/factors/search*", copy_from: sibling.id });
  const body = JSON.parse(calls.find((c) => c.method === "POST").body);
  assert.equal(body.url, "https://api.example.com/orders/v1/factors/search*");
  assert.equal(body.seq, 3026, "after the highest existing seq");
  assert.equal(body.load_balancer, "orders-lb");
  assert.equal(body.cache_level, "off");
  assert.deepEqual(body.acceleration, sibling.acceleration);
  assert.equal(body.id, undefined, "never copies identity");
  assert.equal("edge_compute_id" in body, false, "Arvan rejects a null edge_compute_id");
  assert.equal(out.created.id, "new");

  await assert.rejects(tools.arvan_page_rule_create.execute({ domain: "example.com", url: sibling.url, copy_from: sibling.id }), /already exists/);
  await assert.rejects(tools.arvan_page_rule_create.execute({ domain: "example.com", url: "https://evil.example.org/x*", copy_from: sibling.id }), /must be on example.com/);
  await assert.rejects(tools.arvan_page_rule_create.execute({ domain: "example.com", url: "https://api.example.com/y*", copy_from: "22222222-2222-2222-2222-222222222222" }), /no page rule/);
  assert.equal(calls.filter((c) => c.method === "POST").length, 1, "no write on refusal");
});

// 2026-10-22: «which rule and which LB does apigw-x…/orders/v1/* hit?» needed host/path matching,
// the full body of one rule, and host_header / cache_ignore_cc in the list.
test("arvan_page_rules: matches host+path, resolves LB names, reads one rule in full, GET only", async () => {
  const rules = [
    { id: "a", seq: 5, url: "https://api.example.com/*", url_type: "wildcard", load_balancer: "lb-gw", cache_level: "off", status: true },
    { id: "b", seq: 2, url: "https://api.example.com/orders/v1/*", url_type: "regex", load_balancer: { id: "lb-k", name: "orders-platform" }, host_header: "orders.internal", cache_ignore_cc: false, cache_level: "query_string", status: true, updated_at: "2026-10-01" },
    { id: "c", seq: 1, url: "https://www.example.com/*", load_balancer: "lb-www" },
    { id: "d", seq: 3, url: "https://api.example.com/orders/v2/*", load_balancer: "lb-k" },
  ];
  const { tools, calls } = setup({
    responses: {
      "/cdn/4.0/domains/example.com/page-rules": () => Response.json({ data: rules, meta: { last_page: 1 } }),
      "/cdn/4.0/domains/example.com/load-balancers": () => Response.json({ data: [{ id: "lb-gw", name: "apisix-gw" }, { id: "lb-k", name: "orders-platform" }] }),
      "/cdn/4.0/domains/example.com/page-rules/b": () => Response.json({ data: { ...rules[1], api_token: "s3cret", acceleration: { status: "inherit" } } }),
    },
  });
  const hit = await tools.arvan_page_rules.execute({ domain: "example.com", host: "api.example.com", path: "/orders/v1/factors/search" });
  assert.deepEqual(hit.rules.map((r) => r.id), ["b", "a"], "covering rules only, by seq");
  assert.deepEqual(hit.rules[0].load_balancer, { id: "lb-k", name: "orders-platform" });
  assert.equal(hit.rules[0].host_header, "orders.internal");
  assert.equal(hit.rules[0].cache_ignore_cc, false);
  assert.deepEqual(hit.rules[1].load_balancer, { id: "lb-gw", name: "apisix-gw" });

  const one = await tools.arvan_page_rules.execute({ domain: "example.com", id: "b" });
  assert.equal(one.rule.full.api_token, "***");
  assert.equal(one.rule.full.acceleration.status, "inherit");
  assert.equal(one.rule.updated_at, "2026-10-01");

  const searched = await tools.arvan_page_rules.execute({ domain: "example.com", search: "orders-platform" });
  assert.deepEqual(searched.rules.map((r) => r.id), ["b"]);
  await assert.rejects(tools.arvan_page_rules.execute({ domain: "example.com", host: "evil.example.net" }), /must be on/);
  assert.ok(calls.every((c) => c.method === "GET"));
});

test("arvan_load_balancer_get finds a balancer by name and masks secrets", async () => {
  const lb = { id: "lb1", name: "hamravesh-doctors", origins: [{ ip: "1.2.3.4", port: 443, weight: 1, token: "abc" }] };
  const { tools, calls } = setup({
    responses: {
      "/cdn/4.0/domains/example.com/load-balancers": () => Response.json({ data: [lb, { id: "lb2", name: "other" }] }),
      "/cdn/4.0/domains/example.com/load-balancers/lb1": () => Response.json({ data: { ...lb, health_check: { path: "/health", timeout: 3 } } }),
    },
  });
  const result = await tools.arvan_load_balancer_get.execute({ domain: "example.com", name: "Hamravesh-Doctors" });
  assert.equal(result.loadBalancer.health_check.path, "/health");
  assert.equal(result.loadBalancer.origins[0].token, "***");
  assert.equal(result.loadBalancer.origins[0].ip, "1.2.3.4");
  assert.ok(calls.every((c) => c.method === "GET"));
  await assert.rejects(tools.arvan_load_balancer_get.execute({ domain: "example.com", name: "nope" }), ToolInputError);
  const all = await tools.arvan_load_balancer_get.execute({ domain: "example.com" });
  assert.equal(all.total, 2);
});

function reportResponses(seen) {
  const record = (u) => seen.push(u.pathname.replace("/cdn/4.0/domains/example.com/reports", "") + "?" + u.searchParams.toString());
  const hours = ["2026-10-21T16:00:00Z", "2026-10-21T17:00:00Z", "2026-10-21T18:00:00Z"];
  return {
    "/cdn/4.0/domains/example.com/reports/status": (u) => (record(u), Response.json({
      data: {
        statistics: { status_codes: { "2xx_sum": 300, "3xx_sum": 30, "4xx_sum": 3, "5xx_sum": 9 } },
        charts: { status_code: { name: "status_code", categories: hours, series: [
          { name: "report.status_code.2xx", data: [100, 100, 100] },
          { name: "report.status_code.5xx", data: [1, 6, 2] },
        ] } },
      },
    })),
    "/cdn/4.0/domains/example.com/reports/status/summary": (u) => (record(u), Response.json({
      data: { statistics: [], charts: { status_code: [{ name: "200", y: 300 }, { name: "502", y: 2 }, { name: "503", y: 7 }, { name: "404", y: 3 }] } },
    })),
    "/cdn/4.0/domains/example.com/reports/error-logs/chart": (u) => (record(u), Response.json({
      data: { charts: { status_code: {
        categories: ["2026-10-21T15:00:00Z", "2026-10-21T16:00:00Z", "2026-10-21T17:00:00Z", "2026-10-21T18:00:00Z", "2026-10-21T22:00:00Z"],
        series: [
          { name: "upstream timed out (110: Connection timed out) while connecting to upstream", data: [50, 4, 5, 0, 70] },
          { name: "connect() failed (111: Connection refused)", data: [9, 0, 0, 0, 9] },
        ],
      } } },
    })),
    "/cdn/4.0/domains/example.com/reports/error-logs": (u) => (record(u), Response.json({
      data: [
        { name: "upstream timed out", count: 129, upstreams: [
          { address: "https://198.51.100.23/webhook/abc?token=s3cr3t", count: 9 },
          { address: "https://198.51.100.23/api/x", count: 120 },
        ] },
        { name: "connect() failed", count: 18, upstreams: [{ address: "https://198.51.100.53/other", count: 18 }] },
      ],
    })),
  };
}

test("arvan_reports: status series by class, exact codes, clipped origin errors", async () => {
  const seen = [];
  const { tools } = setup({ responses: reportResponses(seen) });
  const realNow = Date.now;
  Date.now = () => Date.parse("2026-10-22T09:50:00Z");
  try {
    const out = await tools.arvan_reports.execute({
      domain: "example.com", from: "2026-10-21T16:30:00Z", to: "2026-10-21T21:30:00Z", status: "503", host: "users.example.com", path: "/webhook",
    });
    assert.ok(seen.includes("/status?since=2026-10-21T16%3A30%3A00Z&until=2026-10-21T21%3A30%3A00Z"));
    // 17h20m before now → smallest covering period is 24h; error logs ignore since/until.
    assert.ok(seen.includes("/error-logs?period=24h"));
    assert.equal(out.bucketSeconds, 3600);
    assert.deepEqual(out.series[1], { t: "2026-10-21T17:00:00Z", "5xx": 6 });
    assert.deepEqual(out.totals, { "5xx": 9 });
    assert.deepEqual(out.codes, { 503: 7 });
    assert.equal(out.originErrors.period, "24h");
    assert.equal(out.originErrors.bucketSeconds, 3600);
    // 15:00 is before the window; 22:00 is after it.
    assert.deepEqual(out.originErrors.categories, ["2026-10-21T16:00:00Z", "2026-10-21T17:00:00Z", "2026-10-21T18:00:00Z"]);
    assert.deepEqual(out.originErrors.chart, [{ error: "upstream timed out (110: Connection timed out) while connecting to upstream", total: 9, data: [4, 5, 0] }]);
    assert.equal(out.originErrors.list.length, 1);
    assert.deepEqual(out.originErrors.list[0].upstreams, [{ address: "https://198.51.100.23/webhook/abc", count: 9 }]);
    assert.ok(!JSON.stringify(out).includes("s3cr3t"));
    assert.ok(out.notes.some((n) => /per domain/.test(n)));
    assert.ok(out.notes.some((n) => /5xx class/.test(n)));
  } finally {
    Date.now = realNow;
  }
});

test("arvan_reports: class filter keeps the class; GET only", async () => {
  const seen = [];
  const { tools, calls } = setup({ responses: reportResponses(seen) });
  const out = await tools.arvan_reports.execute({ domain: "example.com", from: new Date(Date.now() - 2 * 3_600_000).toISOString(), status: "5xx" });
  assert.deepEqual(out.codes, { 503: 7, 502: 2 });
  assert.deepEqual(Object.keys(out.series[0]), ["t", "5xx"]);
  assert.equal(out.originErrors.period, "3h");
  assert.ok(calls.every((c) => c.method === "GET"));
});

test("arvan_reports: bad windows are ToolInputError", async () => {
  const { tools } = setup();
  for (const args of [
    { domain: "example.com", from: "yesterday" },
    { domain: "example.com", from: "2026-10-01T00:00:00Z", to: "2026-10-09T00:00:00Z" },
    { domain: "example.com", from: "2026-10-02T00:00:00Z", to: "2026-10-01T00:00:00Z" },
    { domain: "example.com", from: "2026-10-01T00:00:00Z", status: "abc" },
  ]) {
    await assert.rejects(tools.arvan_reports.execute(args), ToolInputError);
  }
});

test("arvan_load_balancer_get reads every page of the list", async () => {
  const all = Array.from({ length: 120 }, (_, i) => ({ id: `d${String(i).padStart(3, "0")}`, name: i === 117 ? "Orders-LoadBalancer-Api" : `lb-${i}` }));
  const pageOf = (u) => {
    const page = Number(u.searchParams.get("page") || 1);
    return { page, data: all.slice((page - 1) * 50, page * 50) };
  };
  for (const shape of ["meta", "links", "bare"]) {
    const { tools, calls } = setup({
      responses: {
        "/cdn/4.0/domains/example.com/load-balancers": (u) => {
          const { page, data } = pageOf(u);
          if (shape === "meta") return Response.json({ data, meta: { current_page: page, last_page: 3, per_page: 50, total: 120 } });
          if (shape === "links") return Response.json({ data, links: { next: page < 3 ? `https://x/?page=${page + 1}` : null } });
          return Response.json({ data });
        },
      },
    });
    const listed = await tools.arvan_load_balancer_get.execute({ domain: "example.com" });
    assert.equal(listed.loadBalancers.length, 120, shape);
    assert.equal(listed.total, 120, shape);
    assert.equal(listed.pages, 3, shape);
    const one = await tools.arvan_load_balancer_get.execute({ domain: "example.com", name: "orders-loadbalancer-api" });
    assert.equal(one.loadBalancer.id, "d117", shape);
    await assert.rejects(tools.arvan_load_balancer_get.execute({ domain: "example.com", name: "orders" }), /similar: Orders-LoadBalancer-Api/);
    assert.ok(calls.every((c) => c.method === "GET"), shape);
  }
});

test("arvan_dns_records pages through the whole zone, reports API total, summary and offset/limit", async () => {
  const make = (i) => ({ id: String(i), type: i % 10 === 0 ? "TXT" : i % 7 === 0 ? "MX" : "A", name: i === 345 ? "jahannama" : `h${i}`, value: { ip: "1.1.1.1" } });
  const pages = [Array.from({ length: 300 }, (_, i) => make(i + 1)), Array.from({ length: 220 }, (_, i) => make(i + 301))];
  const { tools, calls } = setup({
    responses: {
      "/cdn/4.0/domains/example.com/dns-records": (u) => {
        const page = Number(u.searchParams.get("page") || 1);
        return Response.json({ data: pages[page - 1] || [], meta: { total: 520, last_page: 2, current_page: page } });
      },
    },
  });
  const one = await tools.arvan_dns_records.execute({ domain: "example.com", name: "jahannama" });
  assert.equal(one.total, 520);
  assert.equal(one.records.length, 1);
  assert.equal(one.records[0].name, "jahannama");
  assert.equal(calls.length, 2);
  const sum = await tools.arvan_dns_records.execute({ domain: "example.com", summary: true });
  assert.equal(sum.fetched, 520);
  assert.equal(sum.byType.TXT, 52);
  assert.ok(sum.byType.MX > 0);
  assert.equal(sum.records, undefined);
  const page = await tools.arvan_dns_records.execute({ domain: "example.com", offset: 500, limit: 50 });
  assert.equal(page.records.length, 20);
  assert.equal(page.nextOffset, null);
  const first = await tools.arvan_dns_records.execute({ domain: "example.com" });
  assert.equal(first.records.length, 300);
  assert.equal(first.nextOffset, 300);
});

test("arvan_dns_records stops when a page repeats (API ignores page param)", async () => {
  const { tools, calls } = setup({
    responses: { "/cdn/4.0/domains/example.com/dns-records": () => Response.json({ data: [{ id: "1", type: "A", name: "www", value: { ip: "1.2.3.4" } }] }) },
  });
  const out = await tools.arvan_dns_records.execute({ domain: "example.com" });
  assert.equal(out.total, 1);
  assert.ok(calls.length <= 2);
});

test("arvan_dns_delete finds a record on a later page", async () => {
  const pages = [[{ id: "1", type: "A", name: "www", value: { ip: "1.2.3.4" } }], [{ id: "2", type: "A", name: "late", value: { ip: "5.6.7.8" } }]];
  const { tools, calls } = setup({
    responses: {
      "GET /cdn/4.0/domains/example.com/dns-records": (u) => {
        const page = Number(u.searchParams.get("page") || 1);
        return Response.json({ data: pages[page - 1] || [], meta: { total: 2, last_page: 2 } });
      },
      "DELETE /cdn/4.0/domains/example.com/dns-records/2": () => new Response(null, { status: 204 }),
    },
  });
  const out = await tools.arvan_dns_delete.execute({ domain: "example.com", name: "late" });
  assert.equal(out.deleted.id, "2");
  assert.ok(calls.some((c) => c.method === "DELETE"));
});

test("arvan_dns_export grep and line paging", async () => {
  const bind = ["$ORIGIN example.com.", "www 120 IN A 1.2.3.4", "@ 300 IN MX 10 mail.example.com.", "jahannama 120 IN CNAME x.example.com.", "@ 300 IN TXT \"v=spf1\""].join("\n") + "\n";
  const { tools } = setup({
    responses: { "/cdn/4.0/domains/example.com/dns-records/export": () => new Response(bind, { status: 200 }) },
  });
  const g = await tools.arvan_dns_export.execute({ domain: "example.com", grep: "JAHANNAMA" });
  assert.equal(g.matchedLines, 1);
  assert.match(g.bind, /jahannama/);
  assert.equal(g.totalLines, 5);
  const p = await tools.arvan_dns_export.execute({ domain: "example.com", offset: 1, limit: 2 });
  assert.equal(p.bind.split("\n").length, 2);
  assert.equal(p.nextOffset, 3);
});

// 2026-10-24: a 23-record cleanup asked the owner once per record. One call takes the whole list.
test("arvan_dns_delete records: one call for many, resolves all before deleting, reports already-gone", async () => {
  const records = [
    { id: "a1", type: "cname", name: "old1", value: { host: "c14.hamravesh.example" } },
    { id: "a2", type: "cname", name: "old2", value: { host: "to.liara.zone" } },
    { id: "d1", type: "a", name: "dual", value: [{ ip: "1.1.1.1" }] },
    { id: "d2", type: "cname", name: "dual", value: { host: "x.example.com" } },
    { id: "n1", type: "NS", name: "sub", value: { host: "ns1.example.com" } },
  ];
  const { tools, calls } = setup({
    responses: {
      "GET /cdn/4.0/domains/example.com/dns-records": () => Response.json({ data: records }),
      "DELETE /cdn/4.0/domains/example.com/dns-records/a1": () => new Response(null, { status: 204 }),
      "DELETE /cdn/4.0/domains/example.com/dns-records/a2": () => new Response(null, { status: 204 }),
    },
  });
  const deletes = () => calls.filter((c) => c.method === "DELETE").length;
  const out = await tools.arvan_dns_delete.execute({ domain: "example.com", records: [{ name: "old1" }, { name: "old2", type: "CNAME" }, { name: "gone" }] });
  assert.deepEqual(out.deleted.map((r) => r.id), ["a1", "a2"]);
  assert.deepEqual(out.notFound, [{ name: "gone" }]);
  assert.equal(deletes(), 2);
  // one bad entry refuses the whole list before any delete
  await assert.rejects(tools.arvan_dns_delete.execute({ domain: "example.com", records: [{ name: "old1" }, { name: "dual" }] }), /nothing deleted/);
  await assert.rejects(tools.arvan_dns_delete.execute({ domain: "example.com", records: [{ name: "old1" }, { name: "sub" }] }), /NS/);
  await assert.rejects(tools.arvan_dns_delete.execute({ domain: "example.com", name: "old1", records: [{ name: "old2" }] }), /not both/);
  assert.equal(deletes(), 2, "refusals deleted nothing");
});
