import test from "node:test";
import assert from "node:assert/strict";
import { createGrafanaTools, substitute, summarizeResults } from "../src/grafana.mjs";
import { TEST_SITE } from "./fixture-site.mjs";

const dashboard = {
  dashboard: {
    uid: "errt884", title: "VisitOnline Sale", time: { from: "now-90d", to: "now" },
    templating: { list: [{ name: "center", type: "custom", current: { value: "5532" } }] },
    panels: [
      { id: 12, type: "stat", title: "مجموع مقدار فروش", datasource: { uid: "pg1", type: "grafana-postgresql-datasource" },
        targets: [{ refId: "A", rawSql: "SELECT SUM(x) FROM t WHERE center = '$center' AND $__timeFilter(created_at)", format: "table" }] },
      { id: 20, type: "row", panels: [{ id: 21, type: "timeseries", title: "nested", targets: [] }] },
    ],
  },
  meta: { folderTitle: "Sales", url: "/d/errt884/visitonline-sale" },
};

function setup({ publicUp = true } = {}) {
  const calls = [];
  const kube = {
    withFallback: async (_c, { viaApi }) => ({ value: await viaApi(), source: "public-api" }),
    publicRequest: async () => ({ body: { data: { token: Buffer.from("glsa_TEST").toString("base64") } } }),
    emergency: async (_c, args) => {
      calls.push({ ssh: args });
      if (args[0] === "get") return JSON.stringify({ items: [{ metadata: { name: "grafana-0" }, status: { phase: "Running" } }] });
      return JSON.stringify([{ uid: "errt884", title: "VisitOnline Sale", folderTitle: "Sales", url: "/d/errt884" }]);
    },
  };
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), method: init.method, auth: init.headers.Authorization, body: init.body ? JSON.parse(init.body) : null });
    if (!publicUp) throw Object.assign(new Error("fetch failed"), { cause: { code: "ETIMEDOUT" } });
    const path = new URL(url).pathname;
    if (path === "/api/dashboards/uid/errt884") return Response.json(dashboard);
    if (path === "/api/dashboards/uid/nope") return Response.json({ message: "Dashboard not found" }, { status: 404 });
    if (path === "/api/ds/query") {
      return Response.json({ results: { A: { frames: [{ schema: { fields: [{ name: "time", type: "time" }, { name: "value", type: "number" }] }, data: { values: [[1789400000000, 1789403600000], [10, 42]] } }] } } });
    }
    return Response.json([]);
  };
  return { tools: createGrafanaTools({ kube, grafanas: { prod: { url: "https://grafana.example.com" }, edge: { url: "https://grafana-edge.example.com" } }, fetchImpl }), calls };
}

test("panel query sends the panel's SQL with variables filled and Grafana macros kept", async () => {
  const { tools, calls } = setup();
  const result = await tools.grafana_panel_query.execute({ uid: "errt884", panelId: 12, from: "now/d" });
  const query = calls.find((c) => c.url?.endsWith("/api/ds/query"));
  assert.equal(query.auth, "Bearer glsa_TEST");
  assert.equal(query.body.from, "now/d");
  assert.equal(query.body.to, "now");
  assert.equal(query.body.queries[0].rawSql, "SELECT SUM(x) FROM t WHERE center = '5532' AND $__timeFilter(created_at)");
  assert.deepEqual(query.body.queries[0].datasource, { uid: "pg1", type: "grafana-postgresql-datasource" });
  assert.equal(result.results[0].rowCount, 2);
  assert.deepEqual(result.results[0].lastRow, { time: "2026-09-14T20:03:20+03:30", value: 42 });
  assert.equal(result.source, "grafana grafana.example.com");
  assert.ok(!JSON.stringify(result).includes("glsa_TEST"), "token never in results");
});

test("dashboard lists nested panels with full queries; Grafana errors are final", async () => {
  const { tools, calls } = setup();
  const d = await tools.grafana_dashboard.execute({ uid: "errt884" });
  assert.deepEqual(d.panels.map((p) => p.id), [12, 20, 21]);
  assert.match(d.panels[0].targets[0].query, /\$__timeFilter/);
  await assert.rejects(tools.grafana_dashboard.execute({ uid: "nope" }), /http_404/);
  assert.equal(calls.filter((c) => c.ssh).length, 0, "a real Grafana answer is not retried over SSH");
  await assert.rejects(tools.grafana_panel_query.execute({ uid: "errt884", panelId: 99 }), /panel 99 not found/);
  await assert.rejects(tools.grafana_panel_query.execute({ uid: "errt884", panelId: 12, from: "now; rm" }), /invalid time/);
});

test("public Grafana down: the call runs inside the Grafana pod over emergency SSH", async () => {
  const { tools, calls } = setup({ publicUp: false });
  const result = await tools.grafana_search.execute({ query: "visit" });
  assert.equal(result.dashboards[0].uid, "errt884");
  assert.equal(result.source, "emergency-ssh grafana pod grafana-0");
  assert.deepEqual(result.attempts.map((a) => a.path), ["public", "emergency-ssh"]);
  const exec = calls.find((c) => c.ssh?.[0] === "exec").ssh;
  assert.deepEqual(exec.slice(0, 7), ["exec", "-n", "monitoring", "grafana-0", "-c", "grafana", "--"]);
});

test("helpers", () => {
  assert.deepEqual(substitute({ rawSql: "${center} [[center]] $center $__timeFrom() $missing", refId: "A" }, { center: "1" }), { rawSql: "1 1 1 $__timeFrom() $missing", refId: "A" });
  assert.deepEqual(summarizeResults({ results: { A: { error: "db down" } } }), [{ refId: "A", error: "db down" }]);
});
