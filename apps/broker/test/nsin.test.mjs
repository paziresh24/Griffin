import test from "node:test";
import assert from "node:assert/strict";
import { createNsinTools } from "../src/nsin.mjs";
import { ToolInputError } from "../src/kube.mjs";

function setup({ items = { "nsin__api-key": "nsin_test_key" }, responses } = {}) {
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
    if (u.hostname === "nsin.ir" && u.pathname === "/ips.txt") {
      return new Response("# c\n203.0.113.0/24\n", { status: 200 });
    }
    const key = `${init.method || "GET"} ${u.pathname}`;
    const handler = responses?.[key] || responses?.[u.pathname];
    if (typeof handler === "function") return handler(u, init);
    if (handler) return handler;
    return Response.json([]);
  };
  return { tools: createNsinTools({ vault, fetchImpl }), calls };
}

test("X-Api-Key is sent from nsin__api-key (Bearer prefix stripped)", async () => {
  const { tools, calls } = setup({
    items: { "nsin__api-key": "Bearer nsin_abc" },
    responses: {
      "/domains/": Response.json([{ id: 1, name: "example.com", status: "active" }]),
    },
  });
  const result = await tools.nsin_domains.execute({});
  assert.equal(calls[0].headers["X-Api-Key"], "nsin_abc");
  assert.equal(result.domains[0].name, "example.com");
  assert.equal(result.source, "nsin-api");
});

test("missing nsin__api-key is a ToolInputError", async () => {
  const { tools } = setup({ items: {} });
  await assert.rejects(tools.nsin_domains.execute({}), (err) => {
    assert.ok(err instanceof ToolInputError);
    assert.match(err.message, /nsin__api-key/);
    return true;
  });
});

test("nsin_edge_ranges works without vault", async () => {
  const tools = createNsinTools({
    fetchImpl: async () => new Response("1.2.3.0/24\n", { status: 200 }),
  });
  const result = await tools.nsin_edge_ranges.execute({});
  assert.deepEqual(result.ranges, ["1.2.3.0/24"]);
});

test("nsin_cache_purge refuses domains not in the account", async () => {
  const { tools, calls } = setup({
    responses: {
      "/domains/": Response.json([{ name: "example.com" }]),
      "DELETE /domains/evil.com/cache/": () => Response.json({ deleted: 1 }),
    },
  });
  await assert.rejects(tools.nsin_cache_purge.execute({ domain: "evil.com" }), /not in this NSIN account/);
  assert.ok(!calls.some((c) => c.method === "DELETE"));
});

test("nsin_cache_purge_path posts filter path", async () => {
  const { tools, calls } = setup({
    responses: {
      "/domains/": Response.json([{ name: "example.com" }]),
      "POST /domains/example.com/cache/keys/purge": () => Response.json({ deleted: 3, truncated: false }),
    },
  });
  const result = await tools.nsin_cache_purge_path.execute({ domain: "example.com", path: "/assets/*" });
  assert.equal(result.result.deleted, 3);
  const purge = calls.find((c) => c.method === "POST");
  assert.equal(JSON.parse(purge.body).filter.path, "/assets/*");
});

test("nsin_analytics_query rejects non-SELECT", async () => {
  const { tools } = setup();
  await assert.rejects(tools.nsin_analytics_query.execute({ sql: "DROP TABLE requests" }), /SELECT/);
});
