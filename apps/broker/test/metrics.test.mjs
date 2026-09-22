import test from "node:test";
import assert from "node:assert/strict";
import { autoStep, createMetrics, niceDomain, parseDuration, PROMETHEUS_PATH, seriesName, summarizeQuery } from "../src/metrics.mjs";
import { createTools } from "../src/tools.mjs";
import { TEST_SITE } from "./fixture-site.mjs";

const GiB = 2 ** 30;

test("durations and automatic steps", () => {
  assert.equal(parseDuration("24h"), 86400);
  assert.equal(parseDuration("7d"), 604800);
  assert.throws(() => parseDuration("1 day", "range"), /30m, 24h or 7d/);
  assert.equal(autoStep(86400), 300, "24h -> 5m (~288 points)");
  assert.equal(autoStep(3600), 15);
  assert.equal(autoStep(30 * 86400), 10800);
});

test("axis domains: near zero keeps 0, far offsets zoom in, flat lines get room", () => {
  // p24core memory on prod, 24h (2026-09-14): ~2 .. 12.3 GiB. Domains are computed in display units.
  assert.deepEqual(niceDomain(2, 12.3), [0, 14]);
  // a gauge hovering 900..1000 must not be flattened against a 0 baseline
  assert.deepEqual(niceDomain(900, 1000), [880, 1020]);
  assert.deepEqual(niceDomain(0.42, 0.42), [0, 0.6]);
  assert.deepEqual(niceDomain(-5, 5), [-6, 6]);
  assert.equal(niceDomain(null, null), null);
});

test("series names use the labels that matter", () => {
  assert.equal(seriesName({}), "total");
  assert.equal(seriesName({ pod: "p24core-a" }), "p24core-a");
  assert.equal(seriesName({ __name__: "up", job: "x", instance: "y" }), "job=x,instance=y");
});

test("range query goes through the kube API proxy and falls back to kubectl get --raw", async () => {
  const calls = [];
  const body = { status: "success", data: { resultType: "matrix", result: [
    { metric: { pod: "p24core-a" }, values: [[1000, "1073741824"], [1300, "2147483648"]] },
    { metric: { pod: "p24core-b" }, values: [[1000, "536870912"], [1300, "NaN"]] },
  ] } };
  const kube = {
    publicRequest: async (cluster, path) => { calls.push(["api", cluster, path]); throw new Error("gateway auth rejected http_302"); },
    emergency: async (cluster, args) => { calls.push(["ssh", cluster, args]); return JSON.stringify(body); },
    withFallback: async (cluster, { viaApi, viaSsh }) => {
      try { return { value: await viaApi(), source: "public-api", attempts: [] }; }
      catch { return { value: await viaSsh(), source: "emergency-ssh x:1", attempts: [{ path: "public-api", ok: false }] }; }
    },
  };
  const metrics = createMetrics({ kube, now: () => 86_400_000 });
  const result = await metrics.query({ cluster: "prod", promql: 'sum by (pod) (x{pod=~"p24core-.*"})', range: "24h" });
  const [, , apiPath] = calls[0];
  assert.ok(apiPath.startsWith(`${PROMETHEUS_PATH}/query_range?`));
  const params = new URL(`http://x${apiPath}`).searchParams;
  assert.deepEqual([params.get("start"), params.get("end"), params.get("step")], ["0", "86400", "300"]);
  assert.deepEqual(calls[1][2], ["get", "--raw", apiPath]);
  assert.equal(result.source, "emergency-ssh x:1");

  const summary = summarizeQuery(result, { maxSeries: 1 });
  assert.equal(summary.seriesTotal, 2);
  assert.equal(summary.truncatedSeries, true);
  assert.equal(summary.series[0].name, "p24core-a");
  assert.equal(summary.overall.max, 2 * GiB);
  assert.equal(summary.points, 3, "NaN is not counted");
  assert.deepEqual(summary.suggestedDomain, [0, 2.5e9], "raw units in the agent summary");
});

test("metrics_query validates input and keeps full points out of the agent's answer", async () => {
  const series = [{ labels: {}, points: Array.from({ length: 288 }, (_, i) => [i * 300, i]) }];
  const metrics = { query: async () => ({ instant: false, step: 300, start: 0, end: 86400, series, source: "public-api", attempts: [] }) };
  const tools = createTools({ site: TEST_SITE, kube: {}, vault: {}, sshRun: async () => {}, metrics });
  const out = await tools.metrics_query.execute({ cluster: "prod", promql: "up", range: "24h" });
  assert.equal(out.points, 288);
  assert.equal(JSON.stringify(out).includes("[0,0]"), false);
  const data = await tools.metricsData({ cluster: "prod", promql: "up", scale: 0.5 });
  assert.equal(data.series[0].points.length, 288);
  assert.deepEqual(data.series[0].points.at(-1), [287 * 300, 143.5], "values arrive in display units");
  assert.deepEqual(data.domain, [0, 160], "axis chosen after scaling");
  await assert.rejects(tools.metrics_query.execute({ cluster: "nowhere", promql: "up" }), /cluster must be/);
  assert.equal(Object.keys(tools).includes("metricsData"), false, "raw data is not an agent tool");
});
