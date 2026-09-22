// visualize: the agent describes a chart as a Vega-Lite spec over named datasets; this side fills
// the datasets (Prometheus via the broker, or small inline tables), picks axis bounds for metric
// values when the agent did not, stores the finished spec, and returns only a summary. Series
// never pass through the model.

export const VISUALIZE_TOOL = "visualize";

const NAME = /^[a-z][a-z0-9_]{0,30}$/;
const DURATION = "^\\d{1,5}(s|m|h|d)$";
const MAX_ROWS = 60_000;
const MAX_SERIES = 80;
const MAX_INLINE_ROWS = 5_000;
const MAX_SPEC_BYTES = 64_000;

const inputSchema = {
  type: "object",
  properties: {
    title: { type: "string", description: "Persian chart title" },
    description: { type: "string", description: "one line under the title: scope, range, unit" },
    datasets: {
      type: "array",
      minItems: 1,
      maxItems: 6,
      items: {
        type: "object",
        properties: {
          name: { type: "string", pattern: NAME.source, description: "referenced from the spec as {\"data\": {\"name\": ...}}" },
          prometheus: {
            type: "object",
            description: "rows: {time (ISO), t (epoch ms), value, series, ...labels}",
            properties: {
              cluster: { type: "string", description: "cluster name from the site config" },
              promql: { type: "string", minLength: 1, maxLength: 4000 },
              range: { type: "string", pattern: DURATION, description: "e.g. 24h (default 1h)" },
              step: { type: "string", pattern: DURATION },
              instant: { type: "boolean" },
              scale: { type: "number", description: "multiply values for display, e.g. 9.313225746154785e-10 for bytes->GiB" },
              unit: { type: "string", description: "display unit after scale, e.g. GiB, cores, %" },
            },
            required: ["cluster", "promql"],
            additionalProperties: false,
          },
          values: { type: "array", maxItems: MAX_INLINE_ROWS, items: { type: "object" }, description: "inline rows (from other tools)" },
        },
        required: ["name"],
        additionalProperties: false,
      },
    },
    spec: {
      type: "object",
      description:
        "Vega-Lite spec WITHOUT data values or urls; bind views with {\"data\": {\"name\": \"<dataset>\"}}. Any mark/layer/concat/facet/transform is allowed. For Prometheus rows use x {field:\"time\", type:\"temporal\"}, y {field:\"value\", type:\"quantitative\"}, color {field:\"series\"}. Leave y.scale.domain out to get a computed axis, or set it yourself.",
    },
  },
  required: ["title", "datasets", "spec"],
  additionalProperties: false,
};

export function createVisualizer({ store, fetchMetrics }) {
  async function buildDataset(input) {
    if (!NAME.test(String(input?.name || ""))) throw new ChartError("dataset name must match ^[a-z][a-z0-9_]{0,30}$");
    if (Array.isArray(input.values)) {
      if (input.values.length > MAX_INLINE_ROWS) throw new ChartError(`inline dataset ${input.name} is limited to ${MAX_INLINE_ROWS} rows`);
      return { name: input.name, rows: input.values, meta: { name: input.name, kind: "inline", rows: input.values.length } };
    }
    const p = input.prometheus;
    if (!p) throw new ChartError(`dataset ${input.name} needs prometheus or values`);
    const data = await fetchMetrics({ cluster: p.cluster, promql: p.promql, range: p.range, step: p.step, instant: p.instant, scale: p.scale });
    if (data.series.length > MAX_SERIES) {
      throw new ChartError(`${data.series.length} series is too many to draw; aggregate (sum by, topk) to ≤ ${MAX_SERIES}`);
    }
    const rows = [];
    for (const series of data.series) {
      const name = seriesName(series.labels);
      for (const [t, value] of series.points) {
        if (!Number.isFinite(value)) continue;
        rows.push({ ...series.labels, time: new Date(t * 1000).toISOString(), t: t * 1000, value, series: name });
      }
    }
    if (rows.length > MAX_ROWS) throw new ChartError(`${rows.length} points is too many; use a larger step or fewer series`);
    return {
      name: input.name,
      rows,
      domain: data.domain,
      meta: {
        name: input.name,
        kind: "prometheus",
        cluster: p.cluster,
        promql: p.promql,
        range: p.instant ? null : p.range || "1h",
        step: data.step,
        unit: p.unit || null,
        rows: rows.length,
        series: data.series.length,
        min: data.overall?.min ?? null,
        max: data.overall?.max ?? null,
        domain: data.domain,
        source: data.source,
        attempts: data.attempts,
      },
    };
  }

  return {
    tool(chatId) {
      return {
        description:
          "Draw a chart for the owner (line/area/bar/heatmap/scatter/pie/table-like views; anything Vega-Lite can express) from Prometheus queries or inline rows. The chart is stored and rendered in the chat; you get back a summary (series count, min/max, axis used, source). Aggregate first (sum by / topk) so the chart answers the question.",
        inputSchema,
        async execute(args) {
          try {
            const spec = sanitizeSpec(args?.spec);
            const title = String(args?.title || "").trim().slice(0, 200);
            if (!title) throw new ChartError("title is required");
            const inputs = Array.isArray(args?.datasets) ? args.datasets : [];
            if (!inputs.length || inputs.length > 6) throw new ChartError("1-6 datasets are required");
            const datasets = await Promise.all(inputs.map(buildDataset));
            bindSingleDataset(spec, datasets);
            checkDatasetNames(spec, datasets);
            const axes = applyAxes(spec, datasets);
            spec.datasets = Object.fromEntries(datasets.map((d) => [d.name, d.rows]));
            const description = String(args?.description || "").slice(0, 300);
            const meta = { description, datasets: datasets.map((d) => d.meta), axes };
            const chartId = store.saveChart({ chatId, title, spec, meta });
            return result({ chartId, title, ...meta });
          } catch (error) {
            return result({ error: error.message, ...(error.attempts ? { attempts: error.attempts } : {}) }, true);
          }
        },
      };
    },
  };
}

class ChartError extends Error {}

function result(value, isError = false) {
  return { ...(isError ? { isError: true } : {}), content: [{ type: "text", text: JSON.stringify(value) }] };
}

export function seriesName(labels) {
  const entries = Object.entries(labels || {}).filter(([key]) => key !== "__name__");
  if (!entries.length) return labels?.__name__ || "total";
  if (entries.length === 1) return String(entries[0][1]);
  return entries.map(([key, value]) => `${key}=${value}`).join(",");
}

// Strips anything that would make the renderer fetch or execute: data urls, inline data values
// the agent pasted (datasets are filled here), and oversized specs.
export function sanitizeSpec(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new ChartError("spec must be a Vega-Lite object");
  if (JSON.stringify(input).length > MAX_SPEC_BYTES) throw new ChartError("spec is too large");
  const spec = structuredClone(input);
  const walk = (node) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) return node.forEach(walk);
    if (node.data && typeof node.data === "object") {
      if (node.data.url || node.data.values) throw new ChartError("spec data must be {\"name\": \"<dataset>\"}; urls and inline values are not allowed");
    }
    for (const key of ["usermeta", "$schema"]) delete node[key];
    Object.values(node).forEach(walk);
  };
  walk(spec);
  delete spec.datasets;
  spec.$schema = "https://vega.github.io/schema/vega-lite/v6.json";
  return spec;
}

// Agents often omit {"data": {"name"}} when there is one dataset; without it Vega draws an empty
// chart and no axis is computed. With exactly one dataset and no named data anywhere, bind it.
export function bindSingleDataset(spec, datasets) {
  if (datasets.length !== 1) return false;
  let named = false;
  const walk = (node) => {
    if (!node || typeof node !== "object" || named) return;
    if (Array.isArray(node)) return node.forEach(walk);
    if (typeof node.data?.name === "string") named = true;
    Object.values(node).forEach(walk);
  };
  walk(spec);
  if (named) return false;
  spec.data = { name: datasets[0].name };
  return true;
}

// A view bound to a dataset that was never defined renders an empty chart with no axis, which the
// agent only notices by looking at it. Fail the call instead, naming the datasets it can use.
export function checkDatasetNames(spec, datasets) {
  const known = new Set(datasets.map((d) => d.name));
  const used = new Set();
  const walk = (node) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) return node.forEach(walk);
    if (typeof node.data?.name === "string") used.add(node.data.name);
    Object.values(node).forEach(walk);
  };
  walk(spec);
  const missing = [...used].filter((name) => !known.has(name));
  if (missing.length) {
    throw new ChartError(`spec refers to dataset(s) ${missing.join(", ")} that were not provided; available: ${[...known].join(", ")}`);
  }
  const unused = [...known].filter((name) => !used.has(name));
  if (unused.length === known.size) throw new ChartError(`no view is bound to a dataset; add {"data": {"name": "${[...known][0]}"}}`);
  return { used: [...used], unused };
}

// For views that plot a Prometheus dataset's "value" on a quantitative axis without a domain,
// use the broker's domain (chosen in display units). Bars and areas keep a zero baseline.
export function applyAxes(spec, datasets) {
  const byName = new Map(datasets.map((d) => [d.name, d]));
  const applied = [];
  const visit = (view, inheritedData) => {
    if (!view || typeof view !== "object") return;
    const dataName = view.data?.name || inheritedData;
    for (const key of ["layer", "concat", "hconcat", "vconcat"]) {
      if (Array.isArray(view[key])) view[key].forEach((child) => visit(child, dataName));
    }
    if (view.spec) visit(view.spec, dataName);
    const dataset = byName.get(dataName);
    const mark = typeof view.mark === "string" ? view.mark : view.mark?.type;
    if (!dataset?.domain || !view.encoding) return;
    for (const channel of ["y", "x"]) {
      const enc = view.encoding[channel];
      if (!enc || enc.field !== "value" || enc.type !== "quantitative" || enc.aggregate || enc.stack) continue;
      if (enc.scale?.domain) {
        applied.push({ dataset: dataName, channel, domain: enc.scale.domain, by: "agent" });
        continue;
      }
      const zeroBaseline = ["bar", "area", "rect"].includes(mark);
      const domain = zeroBaseline ? [Math.min(0, dataset.domain[0]), dataset.domain[1]] : dataset.domain;
      enc.scale = { ...(enc.scale || {}), domain, nice: false, zero: zeroBaseline };
      applied.push({ dataset: dataName, channel, domain, by: "auto" });
    }
  };
  visit(spec, spec.data?.name);
  return applied;
}
