import fs from "node:fs";
import path from "node:path";

// Renders a stored Vega-Lite chart (spec + embedded datasets) to a PNG so it can be sent into a
// messenger. Everything is lazy-loaded: the deps and the font are only touched the first time a chart
// is delivered. Persian text needs a real font, so resvg is pointed at the bundled Vazirmatn TTF.

const FONT = path.resolve(import.meta.dirname, "../assets/Vazirmatn-Regular.ttf");

let deps = null;
async function load() {
  if (!deps) {
    const [vega, vegaLite, resvg] = await Promise.all([import("vega"), import("vega-lite"), import("@resvg/resvg-js")]);
    deps = { vega, compile: vegaLite.compile, Resvg: resvg.Resvg };
  }
  return deps;
}

// A finished, self-contained Vega-Lite spec on a light background at a fixed width for chat.
function forExport(spec, { width = 900 } = {}) {
  const out = structuredClone(spec);
  out.background = "white";
  out.width = width;
  if (out.height === undefined && !out.vconcat && !out.hconcat && !out.concat && !out.facet) out.height = 360;
  out.config = { ...(out.config || {}), font: "Vazirmatn", background: "white", view: { stroke: null }, padding: 12 };
  delete out.datasets?.__proto__;
  return out;
}

export async function renderChartPng(chart, { width = 900 } = {}) {
  const { vega, compile, Resvg } = await load();
  const spec = forExport(chart.spec, { width });
  const datasets = spec.datasets || {};
  const vgSpec = compile(spec).spec;
  const view = new vega.View(vega.parse(vgSpec), { renderer: "none" });
  for (const [name, rows] of Object.entries(datasets)) view.data(name, rows);
  const svg = await view.toSVG();
  view.finalize();
  const resvg = new Resvg(svg, {
    background: "white",
    fitTo: { mode: "width", value: width },
    font: fs.existsSync(FONT) ? { fontFiles: [FONT], defaultFontFamily: "Vazirmatn", loadSystemFonts: false } : { loadSystemFonts: true },
  });
  return resvg.render().asPng();
}

// Render a chart once and keep the PNG in the media store, so re-delivery and the messenger reuse it.
export async function chartMedia(store, chart) {
  const cached = store.getChartMedia?.(chart.id);
  if (cached) return cached;
  const png = await renderChartPng(chart);
  const mediaId = store.saveMedia({ chatId: chart.chat_id, mimeType: "image/png", data: png, meta: { chartId: chart.id, title: chart.title } });
  store.setChartMedia?.(chart.id, mediaId);
  return { id: mediaId, mime_type: "image/png", data: png };
}
