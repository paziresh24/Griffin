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
  const out = await tools.arvan_dns_create.execute({ domain: "example.com", name: "baft", type: "A", value: "203.0.113.1", cloud: true });
  assert.equal(out.created.name, "baft");
  const post = calls.find((c) => c.method === "POST");
  assert.deepEqual(JSON.parse(post.body).value, [{ ip: "203.0.113.1", port: null, weight: 100, country: "" }]);
  await assert.rejects(tools.arvan_dns_create.execute({ domain: "example.com", name: "mohr", type: "A", value: "1.2.3.4" }), /already has/);
  await assert.rejects(tools.arvan_dns_create.execute({ domain: "example.com", name: "x", type: "A", value: "not-ip" }), /IPv4/);
  assert.equal(calls.filter((c) => c.method !== "GET").length, 1, "no write on refusal");
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
