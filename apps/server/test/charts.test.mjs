import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp } from "../src/app.mjs";
import { applyAxes, bindSingleDataset, checkDatasetNames, createVisualizer, sanitizeSpec } from "../src/charts.mjs";
import { openStore } from "../src/db.mjs";

const GiB = 1 / 2 ** 30;

function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "platform-charts-"));
  const store = openStore(path.join(dir, "db.sqlite"));
  return { store, cleanup: () => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

test("spec sanitizing: no urls or pasted values, datasets are ours", () => {
  assert.throws(() => sanitizeSpec({ data: { url: "https://evil" }, mark: "line" }), /urls and inline values/);
  assert.throws(() => sanitizeSpec({ layer: [{ data: { values: [{ a: 1 }] }, mark: "bar" }] }), /urls and inline values/);
  assert.throws(() => sanitizeSpec([]), /Vega-Lite object/);
  const spec = sanitizeSpec({ data: { name: "mem" }, mark: "line", datasets: { mem: [{ x: 1 }] }, usermeta: { a: 1 } });
  assert.equal(spec.datasets, undefined);
  assert.equal(spec.usermeta, undefined);
  assert.match(spec.$schema, /vega-lite\/v6/);
});

test("axes: auto for lines, zero baseline for bars, agent domains and other fields untouched", () => {
  const datasets = [{ name: "mem", domain: [2, 14] }, { name: "pods", domain: [0, 3] }];
  const spec = {
    data: { name: "mem" },
    vconcat: [
      { layer: [{ mark: "line", encoding: { x: { field: "time", type: "temporal" }, y: { field: "value", type: "quantitative" } } }] },
      { mark: "bar", encoding: { y: { field: "value", type: "quantitative" } } },
      { data: { name: "pods" }, mark: "line", encoding: { y: { field: "value", type: "quantitative", scale: { domain: [0, 10] } } } },
      { mark: "line", encoding: { y: { field: "other", type: "quantitative" } } },
    ],
  };
  const applied = applyAxes(spec, datasets);
  assert.deepEqual(spec.vconcat[0].layer[0].encoding.y.scale, { domain: [2, 14], nice: false, zero: false });
  assert.deepEqual(spec.vconcat[1].encoding.y.scale, { domain: [0, 14], nice: false, zero: true });
  assert.deepEqual(spec.vconcat[2].encoding.y.scale, { domain: [0, 10] });
  assert.equal(spec.vconcat[3].encoding.y.scale, undefined);
  assert.deepEqual(applied.map((a) => [a.dataset, a.by]), [["mem", "auto"], ["mem", "auto"], ["pods", "agent"]]);
});

test("visualize stores a self-contained chart and returns only a summary", async () => {
  const { store, cleanup } = tempStore();
  const requests = [];
  const visualizer = createVisualizer({
    store,
    fetchMetrics: async (args) => {
      requests.push(args);
      return {
        step: 300,
        series: [{ labels: {}, points: [[1000, 2.1], [1300, 12.3], [1600, Number.NaN]] }],
        overall: { min: 2.1, max: 12.3 },
        domain: [0, 14],
        source: "public-api https://k8s.example.com",
        attempts: [{ path: "public-api", ok: true }],
      };
    },
  });
  try {
    const chat = store.createChat({ title: "mem" });
    const tool = visualizer.tool(chat.id);
    const out = await tool.execute({
      title: "مصرف مموری p24core",
      description: "پروداکشن، ۲۴ ساعت، GiB",
      datasets: [{ name: "mem", prometheus: { cluster: "prod", promql: "sum(x)", range: "24h", scale: GiB, unit: "GiB" } }],
      spec: { data: { name: "mem" }, mark: "line", encoding: { x: { field: "time", type: "temporal" }, y: { field: "value", type: "quantitative" } } },
    });
    const summary = JSON.parse(out.content[0].text);
    assert.equal(out.isError, undefined);
    assert.deepEqual(requests, [{ cluster: "prod", promql: "sum(x)", range: "24h", step: undefined, instant: undefined, scale: GiB }]);
    assert.equal(summary.datasets[0].rows, 2, "NaN dropped");
    assert.deepEqual(summary.axes, [{ dataset: "mem", channel: "y", domain: [0, 14], by: "auto" }]);
    assert.equal(JSON.stringify(summary).includes("1970-01-01T"), false, "no points in the agent summary");

    const chart = store.getChart(summary.chartId);
    assert.deepEqual(chart.spec.datasets.mem.map((r) => [r.time, r.value, r.series]), [["1970-01-01T00:16:40.000Z", 2.1, "total"], ["1970-01-01T00:21:40.000Z", 12.3, "total"]]);

    const app = createApp({ store, runner: { activeCount: () => 0 } });
    const fetched = await (await app.request(`/api/charts/${summary.chartId}`)).json();
    assert.equal(fetched.chart.title, "مصرف مموری p24core");
    assert.equal((await (await app.request(`/api/chats/${chat.id}/charts`)).json()).charts.length, 1);

    const tooMany = createVisualizer({ store, fetchMetrics: async () => ({ series: Array.from({ length: 81 }, () => ({ labels: {}, points: [] })) }) });
    const refused = await tooMany.tool(chat.id).execute({ title: "x", datasets: [{ name: "a", prometheus: { cluster: "prod", promql: "x" } }], spec: { mark: "line" } });
    assert.equal(refused.isError, true);
    assert.match(refused.content[0].text, /too many to draw; aggregate/);
  } finally {
    cleanup();
  }
});

test("a spec without named data is bound to the only dataset and gets the axis", () => {
  // The exact spec the agent sent on 2026-09-14 for p24core memory (no "data").
  const spec = { mark: { type: "area", line: true }, encoding: { x: { field: "time", type: "temporal" }, y: { field: "value", type: "quantitative", title: "GiB" } } };
  const datasets = [{ name: "mem", domain: [0, 12.5], rows: [] }];
  assert.equal(bindSingleDataset(spec, datasets), true);
  assert.deepEqual(spec.data, { name: "mem" });
  assert.deepEqual(applyAxes(spec, datasets), [{ dataset: "mem", channel: "y", domain: [0, 12.5], by: "auto" }]);

  const layered = { layer: [{ data: { name: "a" }, mark: "line" }] };
  assert.equal(bindSingleDataset(layered, [{ name: "a" }]), false, "named data is left alone");
  assert.equal(bindSingleDataset({ mark: "line" }, [{ name: "a" }, { name: "b" }]), false, "ambiguous with two datasets");
});

// A scheduled job drew "Unrecognized data set: cpu" on 2026-09-16: the second view of a vconcat
// pointed at a dataset name that was never provided, so that half of the chart came out empty.
test("a view bound to a dataset that does not exist is refused", () => {
  const datasets = [{ name: "mem", rows: [] }, { name: "cpu_usage", rows: [] }];
  assert.throws(
    () => checkDatasetNames({ vconcat: [{ data: { name: "mem" }, mark: "line" }, { data: { name: "cpu" }, mark: "line" }] }, datasets),
    /dataset\(s\) cpu that were not provided; available: mem, cpu_usage/,
  );
  assert.throws(() => checkDatasetNames({ mark: "line" }, datasets), /no view is bound to a dataset/);
  assert.deepEqual(
    checkDatasetNames({ vconcat: [{ data: { name: "mem" }, mark: "line" }, { data: { name: "cpu_usage" }, mark: "line" }] }, datasets),
    { used: ["mem", "cpu_usage"], unused: [] },
  );
});
