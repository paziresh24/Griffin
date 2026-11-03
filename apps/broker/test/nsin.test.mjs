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

test("nsin_request_logs reads a past window and pages it", async () => {
  const { tools, calls } = setup({ responses: { "/analytics/logs": () => Response.json({ data: [], total: 0 }) } });
  const result = await tools.nsin_request_logs.execute({ domain: "example.org", from: "2026-10-29T09:30:00+03:30", to: "2026-10-29T08:00:00Z", node: "IRM", errFault: "origin", offset: 100 });
  const sent = new URL(calls[0].path, "https://x").searchParams;
  assert.equal(sent.get("from"), "2026-10-29T06:00:00Z");
  assert.equal(sent.get("to"), "2026-10-29T08:00:00Z");
  assert.equal(sent.get("period"), null, "a window is not sent with a period");
  assert.equal(sent.get("node"), "IRM");
  assert.equal(sent.get("errFault"), "origin");
  assert.equal(sent.get("offset"), "100");
  assert.equal(result.from, "2026-10-29T06:00:00Z");
});

test("nsin_request_logs without a window stays on the sliding period", async () => {
  const { tools, calls } = setup({ responses: { "/analytics/logs": () => Response.json({ data: [] }) } });
  const result = await tools.nsin_request_logs.execute({ domain: "example.org" });
  assert.equal(new URL(calls[0].path, "https://x").searchParams.get("period"), "24h");
  assert.equal(result.period, "24h");
});

test("nsin_request_logs countBy node gives exact counts per edge, and the rest as other", async () => {
  const totals = { "": 1922, IRM: 1816, IRMA: 40, IR: 50, IRAFRA: 10, NL: 0 };
  const { tools, calls } = setup({
    responses: { "/analytics/logs": (u) => Response.json({ data: [], total: totals[u.searchParams.get("node") || ""] }) },
  });
  const result = await tools.nsin_request_logs.execute({ domain: "example.org", from: "2026-10-30T15:08:00Z", to: "2026-10-30T15:16:00Z", status: 504, countBy: "node" });
  assert.deepEqual(result.byNode, { IR: 50, IRM: 1816, IRMA: 40, IRAFRA: 10, NL: 0 });
  assert.equal(result.total, 1922);
  assert.equal(result.other, 6);
  assert.ok(calls.every((call) => call.path.includes("limit=1") && call.path.includes("status=504")), "no rows fetched, every count under the same filters");
  assert.equal(calls.length, 6);
});

test("nsin_request_logs refuses a window it cannot read", async () => {
  const { tools } = setup();
  const logs = (args) => tools.nsin_request_logs.execute({ domain: "example.org", ...args });
  await assert.rejects(logs({ from: "2026-10-29T06:00:00Z" }), /go together/);
  await assert.rejects(logs({ from: "yesterday", to: "2026-10-29T06:00:00Z" }), /ISO time/);
  await assert.rejects(logs({ from: "2026-10-29T08:00:00Z", to: "2026-10-29T06:00:00Z" }), /before to/);
  await assert.rejects(logs({ period: "3h", from: "2026-10-29T06:00:00Z", to: "2026-10-29T08:00:00Z" }), /not both/);
  await assert.rejects(logs({ countBy: "node", node: "IRM" }), /drop node/);
});

test("nsin_request_logs rows come slim by default, and cookie/auth headers are masked when kept", async () => {
  const row = {
    node: "IRM",
    headers: JSON.stringify({ Cookie: ["griffin_session=abc"], Authorization: ["Bearer x"], Accept: ["*/*"] }),
    origin_req_headers: JSON.stringify({ "X-Api-Key": ["k"], Host: ["h"] }),
    body: "password=1",
    origin_error_body: "e",
  };
  const { tools, calls } = setup({ responses: { "/analytics/logs": () => Response.json({ data: [row] }) } });
  const slim = await tools.nsin_request_logs.execute({ domain: "example.org", errReason: "origin_timeout", cache: "miss" });
  assert.deepEqual(slim.logs.data, [{ node: "IRM" }]);
  const sent = new URL(calls[0].path, "https://x").searchParams;
  assert.equal(sent.get("errReason"), "origin_timeout");
  assert.equal(sent.get("cache"), "miss");
  const full = await tools.nsin_request_logs.execute({ domain: "example.org", slim: false });
  const text = JSON.stringify(full);
  assert.doesNotMatch(text, /griffin_session|Bearer x|\["k"\]/);
  assert.deepEqual(JSON.parse(full.logs.data[0].headers), { Cookie: ["[masked]"], Authorization: ["[masked]"], Accept: ["*/*"] });
  const byRay = await tools.nsin_request_logs.execute({ domain: "example.org", rayId: "c3c3" });
  assert.equal(byRay.logs.data[0].origin_error_body, "e", "one ray id keeps its whole row");
  assert.doesNotMatch(JSON.stringify(byRay), /griffin_session/);
});

test("nsin_request_logs countBy with more keys reads the rows and returns counts only", async () => {
  const pages = [
    { data: [{ node: "IRM", status: 200, err_reason: "" }, { node: "IRM", status: 504, err_reason: "origin_timeout" }], has_more: true, total: 3 },
    { data: [{ node: "IRM", status: 200, err_reason: "" }], has_more: false },
  ];
  const { tools, calls } = setup({ responses: { "/analytics/logs": () => Response.json(pages.shift()) } });
  const result = await tools.nsin_request_logs.execute({ domain: "example.org", from: "2026-10-28T12:40:00Z", to: "2026-10-28T13:00:00Z", countBy: "node,status,err_reason" });
  assert.equal(calls.length, 2);
  const first = new URL(calls[0].path, "https://x").searchParams;
  const second = new URL(calls[1].path, "https://x").searchParams;
  assert.equal(first.get("period"), null);
  assert.equal(first.get("limit"), "500");
  assert.equal(first.get("count"), "exact");
  assert.equal(second.get("offset"), "2");
  assert.equal(second.get("count"), "0");
  assert.deepEqual(result.groups, [
    { node: "IRM", status: 200, err_reason: null, count: 2 },
    { node: "IRM", status: 504, err_reason: "origin_timeout", count: 1 },
  ]);
  assert.equal(result.total, 3);
  assert.equal(result.truncated, false);
});

test("nsin_request_logs countBy minute stops at 20k rows", async () => {
  const row = { timestamp: "2026-10-30T15:10:30Z" };
  const { tools, calls } = setup({ responses: { "/analytics/logs": () => Response.json({ data: Array(500).fill(row), has_more: true }) } });
  const result = await tools.nsin_request_logs.execute({ domain: "example.org", countBy: "minute" });
  assert.equal(calls.length, 40);
  assert.equal(result.truncated, true);
  assert.deepEqual(result.groups, [{ minute: "2026-10-30T15:10Z", count: 20000 }]);
  await assert.rejects(tools.nsin_request_logs.execute({ domain: "example.org", countBy: "country" }), /countBy takes/);
});
