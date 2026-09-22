import test from "node:test";
import assert from "node:assert/strict";
import { renderChartPng } from "../src/chart-image.mjs";

const chart = {
  id: "c1", chat_id: "chat", title: "مصرف",
  spec: {
    $schema: "https://vega.github.io/schema/vega-lite/v6.json",
    data: { name: "d" },
    datasets: { d: [{ s: "الف", v: 3 }, { s: "ب", v: 7 }] },
    mark: "bar",
    encoding: { x: { field: "s", type: "nominal", title: "اپ" }, y: { field: "v", type: "quantitative", title: "GiB" } },
  },
};

test("a stored Vega-Lite chart renders to a real PNG with Persian labels", async () => {
  const png = await renderChartPng(chart, { width: 600 });
  assert.equal(png.slice(0, 8).toString("hex"), "89504e470d0a1a0a", "PNG signature");
  assert.ok(png.length > 3000);
});
