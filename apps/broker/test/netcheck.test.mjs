import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createNetTools } from "../src/netcheck.mjs";
import { createNsinTools } from "../src/nsin.mjs";
import { ToolInputError } from "../src/kube.mjs";

test("dns_lookup returns records and uses a custom resolver", async () => {
  const calls = [];
  const fakeResolver = {
    setServers(list) {
      calls.push(["setServers", list]);
    },
    async resolve4(name) {
      calls.push(["resolve4", name]);
      return ["1.2.3.4"];
    },
  };
  const tools = createNetTools({ dnsResolver: () => fakeResolver });
  const result = await tools.dns_lookup.execute({ name: "example.com", type: "A", resolver: "8.8.8.8" });
  assert.deepEqual(result.records, ["1.2.3.4"]);
  assert.equal(result.resolver, "8.8.8.8");
  assert.deepEqual(calls[0], ["setServers", ["8.8.8.8"]]);
});

test("dns_lookup NXDOMAIN is a result not a throw", async () => {
  const fakeResolver = {
    setServers() {},
    async resolve4() {
      const err = new Error("ENOTFOUND");
      err.code = "ENOTFOUND";
      throw err;
    },
  };
  const tools = createNetTools({ dnsResolver: () => fakeResolver });
  const result = await tools.dns_lookup.execute({ name: "missing.example" });
  assert.equal(result.error, "NXDOMAIN");
  assert.deepEqual(result.records, []);
});

test("http_check Host/SNI override, status, headers; non-http scheme throws", async () => {
  const seen = {};
  const server = http.createServer((req, res) => {
    seen.host = req.headers.host;
    seen.method = req.method;
    res.writeHead(200, { "x-cache": "HIT", age: "12", "content-type": "text/plain", "x-secret": "nope" });
    res.end("ok");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  try {
    const tools = createNetTools({});
    const result = await tools.http_check.execute({
      url: `http://127.0.0.1:${port}/path`,
      hostHeader: "app.example.com",
      method: "GET",
      bodySnippet: true,
    });
    assert.equal(seen.host, "app.example.com");
    assert.equal(result.status, 200);
    assert.equal(result.headers["x-cache"], "HIT");
    assert.equal(result.headers.age, "12");
    assert.equal(result.headers["x-secret"], undefined);
    assert.equal(result.bodySnippet, "ok");
    await assert.rejects(tools.http_check.execute({ url: "ftp://x" }), (err) => err instanceof ToolInputError);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test("http_check redirect chain is capped at 5", async () => {
  let hits = 0;
  const server = http.createServer((req, res) => {
    hits += 1;
    res.writeHead(302, { location: `/hop-${hits}` });
    res.end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  try {
    const tools = createNetTools({});
    const result = await tools.http_check.execute({ url: `http://127.0.0.1:${port}/start`, followRedirects: true });
    assert.equal(result.error, "too many redirects");
    assert.equal(result.redirects.length, 5);
    assert.ok(hits <= 6);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test("http_check connection failure is a result not a throw", async () => {
  const tools = createNetTools({});
  const result = await tools.http_check.execute({ url: "http://127.0.0.1:1/" });
  assert.ok(result.error);
  assert.equal(result.status, null);
});

test("nsin_edge_ranges parses CIDRs and rejects invalid lines", async () => {
  const tools = createNsinTools({
    fetchImpl: async () => new Response("# comment\n203.0.113.0/24\n\n1.2.3.0/24\n", { status: 200 }),
  });
  const result = await tools.nsin_edge_ranges.execute({});
  assert.deepEqual(result.ranges, ["203.0.113.0/24", "1.2.3.0/24"]);
  assert.equal(result.count, 2);
  assert.equal(result.source, "nsin.ir/ips.txt");

  const bad = createNsinTools({
    fetchImpl: async () => new Response("not-a-cidr\n", { status: 200 }),
  });
  await assert.rejects(bad.nsin_edge_ranges.execute({}), /invalid CIDR/);
});
