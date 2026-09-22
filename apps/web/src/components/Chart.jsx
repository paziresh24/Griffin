import { useEffect, useRef, useState } from "react";
import { AreaChart, Download, Loader2, Maximize2, Table2, X } from "lucide-react";
import { api } from "../api.js";
import { useApiBase } from "../base.js";
import { isRtlText, textDir } from "../dir.js";
import { SourceBadge } from "./Tool.jsx";

// Categorical slots from the dataviz reference palette, validated against this app's card
// surfaces (#ffffff light, #12161c dark): fixed order, never cycled.
const CATEGORY = {
  light: ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#4a3aa7", "#e34948"],
  dark: ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"],
};

function isDark() {
  return document.documentElement.classList.contains("dark");
}

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function vegaConfig() {
  const text = cssVar("--foreground");
  const muted = cssVar("--muted-foreground");
  const grid = cssVar("--border");
  const font = "Vazirmatn Variable, system-ui, sans-serif";
  return {
    background: "transparent",
    font,
    range: { category: CATEGORY[isDark() ? "dark" : "light"] },
    view: { stroke: null },
    axis: {
      labelColor: muted, titleColor: muted, domainColor: grid, tickColor: grid, gridColor: grid,
      gridOpacity: 0.6, labelFont: font, titleFont: font, labelFontSize: 11, titleFontWeight: 500,
    },
    // Narrow (phone) widths: drop colliding time labels instead of overprinting them.
    axisTemporal: { labelOverlap: "greedy", labelSeparation: 10, labelFlush: true },
    axisBand: { labelOverlap: "greedy", labelLimit: 120 },
    legend: { labelColor: text, titleColor: muted, labelFont: font, titleFont: font, orient: "bottom", symbolType: "stroke", direction: "horizontal" },
    // Title anchor/align are set per-chart in prepare(); leaving defaults here fights RTL titles.
    title: { color: text, font, subtitleColor: muted },
    line: { strokeWidth: 2, strokeCap: "round", tooltip: true },
    area: { line: { strokeWidth: 2 }, opacity: 0.25, tooltip: true },
    bar: { cornerRadiusEnd: 4, tooltip: true },
    point: { size: 64, filled: true, tooltip: true },
    rect: { tooltip: true },
    arc: { tooltip: true },
    mark: { tooltip: true },
  };
}

// Drop fixed pixel widths so the chart can fill its container (especially in the fullscreen canvas).
function forceContainerWidth(node) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) return node.forEach(forceContainerWidth);
  if (typeof node.width === "number") node.width = "container";
  else if (node.width === undefined && (node.mark || node.layer || node.encoding)) node.width = "container";
  for (const key of ["layer", "hconcat", "vconcat", "concat"]) {
    if (Array.isArray(node[key])) node[key].forEach(forceContainerWidth);
  }
  if (node.spec) forceContainerWidth(node.spec);
}

// Align every panel title with the chart's dominant script (a Persian chart with one English
// panel title like "CPU (core)" still gets all titles on the right).
function applyTitleDirection(node, rtl) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) return node.forEach((child) => applyTitleDirection(child, rtl));
  const anchor = rtl ? "end" : "start";
  const align = rtl ? "right" : "left";
  if (typeof node.title === "string") {
    node.title = { text: node.title, anchor, align };
  } else if (node.title && typeof node.title === "object") {
    node.title.anchor = anchor;
    node.title.align = align;
  }
  for (const key of ["layer", "hconcat", "vconcat", "concat"]) {
    if (Array.isArray(node[key])) node[key].forEach((child) => applyTitleDirection(child, rtl));
  }
  if (node.spec) applyTitleDirection(node.spec, rtl);
}

function collectTitles(node, out = []) {
  if (!node || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    node.forEach((child) => collectTitles(child, out));
    return out;
  }
  if (typeof node.title === "string") out.push(node.title);
  else if (node.title?.text) out.push(node.title.text);
  for (const key of ["layer", "hconcat", "vconcat", "concat"]) {
    if (Array.isArray(node[key])) node[key].forEach((child) => collectTitles(child, out));
  }
  if (node.spec) collectTitles(node.spec, out);
  return out;
}

// Fills the container width. In fullscreen, stretch height too — a bare root height does nothing for
// vconcat/hconcat (each child keeps its own short height), which is why maximize looked like a no-op.
// Inline composites also need container width: agents often leave a fixed pixel width, so the chart
// sat in one corner of the card instead of spanning it.
function prepare(spec, { height, maximized = false } = {}) {
  const copy = structuredClone(spec);
  forceContainerWidth(copy);
  applyTitleDirection(copy, isRtlText(collectTitles(copy).join(" ")));

  if (maximized) {
    if (Array.isArray(copy.vconcat) && height) {
      const n = copy.vconcat.length;
      const each = Math.max(180, Math.floor((height - 40) / n));
      for (const child of copy.vconcat) {
        child.height = each;
        child.width = "container";
      }
      delete copy.height;
      copy.width = "container";
    } else if (Array.isArray(copy.hconcat) && height) {
      for (const child of copy.hconcat) {
        child.height = height;
        if (typeof child.width === "number") delete child.width;
      }
      copy.height = height;
    } else if (height) {
      copy.height = height;
      copy.width = "container";
    }
  } else if (Array.isArray(copy.vconcat)) {
    for (const child of copy.vconcat) {
      if (child.height === undefined || (typeof child.height === "number" && child.height < 120)) child.height = 200;
      child.width = "container";
    }
    copy.width = "container";
    delete copy.height;
  } else if (Array.isArray(copy.hconcat)) {
    copy.width = "container";
  } else {
    if (copy.width === undefined) copy.width = "container";
    if (copy.height === undefined) copy.height = 260;
    if (height) copy.height = height;
  }
  copy.autosize = { type: "fit-x", contains: "padding" };
  return copy;
}

function VegaView({ spec, height, maximized = false, onView }) {
  const ref = useRef(null);
  const [error, setError] = useState(null);
  const [theme, setTheme] = useState(isDark());

  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(isDark()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let view;
    let cancelled = false;
    let resizeObserver;
    (async () => {
      try {
        const { default: embed } = await import("vega-embed");
        if (cancelled || !ref.current) return;
        const prepared = prepare(spec, { height, maximized });
        const result = await embed(ref.current, prepared, { actions: false, renderer: "svg", config: vegaConfig() });
        view = result.view;
        onView?.(view);
        setError(null);
        // Container width can settle after the dialog opens; reflow so fit-x actually fills it.
        resizeObserver = new ResizeObserver(() => {
          try {
            view.resize().runAsync();
          } catch {
            /* view already finalized */
          }
        });
        resizeObserver.observe(ref.current);
        requestAnimationFrame(() => view.resize().runAsync().catch(() => {}));
      } catch (caught) {
        if (!cancelled) setError(caught.message);
      }
    })();
    return () => {
      cancelled = true;
      resizeObserver?.disconnect();
      view?.finalize();
    };
  }, [spec, height, maximized, theme, onView]);

  if (error) return <p className="ltr text-xs text-bad">{error}</p>;
  return <div ref={ref} className="ltr w-full min-w-0" />;
}

function DataTable({ datasets }) {
  const [active, setActive] = useState(Object.keys(datasets)[0]);
  const rows = datasets[active] || [];
  const columns = [...new Set(rows.slice(0, 50).flatMap((row) => Object.keys(row)))].filter((c) => c !== "t");
  return (
    <div className="space-y-2">
      {Object.keys(datasets).length > 1 ? (
        <div className="flex gap-1">
          {Object.keys(datasets).map((name) => (
            <button key={name} type="button" onClick={() => setActive(name)} className={`rounded px-2 py-0.5 font-mono text-xs ${name === active ? "bg-muted" : "text-muted-foreground"}`}>
              {name}
            </button>
          ))}
        </div>
      ) : null}
      <div className="ltr max-h-72 overflow-auto rounded border">
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-card">
            <tr>{columns.map((c) => <th key={c} className="px-2 py-1 text-start font-medium text-muted-foreground">{c}</th>)}</tr>
          </thead>
          <tbody>
            {rows.slice(0, 1000).map((row, i) => (
              <tr key={i} className="border-t">
                {columns.map((c) => <td key={c} className="whitespace-nowrap px-2 py-1 font-mono">{formatCell(row[c])}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length > 1000 ? <p className="text-xs text-muted-foreground">۱۰۰۰ ردیف اول از {rows.length.toLocaleString("fa")}</p> : null}
    </div>
  );
}

function formatCell(value) {
  if (typeof value === "number") return Number.isInteger(value) ? value : value.toFixed(3);
  return String(value ?? "");
}

async function downloadPng(view, title) {
  const url = await view.toImageURL("png", 2);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${title || "chart"}.png`;
  link.click();
}

// Card for the agent's visualize tool: the chart inline, with a full-screen canvas and a table.
export function ChartCard({ args = {}, result, isError, status }) {
  const base = useApiBase();
  const running = status?.type === "running" || result === undefined;
  const chartId = result?.chartId;
  const [chart, setChart] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [table, setTable] = useState(false);
  const [canvas, setCanvas] = useState(false);
  const [view, setView] = useState(null);
  const [canvasHeight, setCanvasHeight] = useState(480);
  const canvasArea = useRef(null);

  useEffect(() => {
    if (!chartId) return;
    api(`${base}/charts/${chartId}`).then((r) => setChart(r.chart), (e) => setLoadError(e.message));
  }, [chartId, base]);

  useEffect(() => {
    if (!canvas) return;
    const close = (event) => event.key === "Escape" && setCanvas(false);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", close);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", close);
    };
  }, [canvas]);

  useEffect(() => {
    if (!canvas || !canvasArea.current) return undefined;
    const measure = () => setCanvasHeight(Math.max(320, canvasArea.current.clientHeight - 16));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(canvasArea.current);
    return () => observer.disconnect();
  }, [canvas, table]);

  const title = chart?.title || args.title || "نمودار";
  const description = chart?.meta?.description || args.description;
  const sources = [...new Set((chart?.meta?.datasets || []).map((d) => d.source).filter(Boolean))];

  if (isError || result?.error) {
    return (
      <div className="my-2 rounded-lg border border-bad/50 bg-card px-3 py-2 text-sm">
        <p className="flex items-center gap-2 font-medium"><AreaChart className="size-4 text-bad" />{title}</p>
        <p className="ltr mt-1 text-xs text-bad">{result?.error || "ساخت نمودار ناموفق بود"}</p>
      </div>
    );
  }

  const header = (
    <div className="flex items-start gap-2 px-3 pt-2.5">
      <AreaChart className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1" dir={textDir(`${title}\n${description || ""}`)}>
        <p className={`text-sm font-medium ${running ? "shimmer" : ""}`}>{title}</p>
        {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {sources.map((source) => <SourceBadge key={source} source={source} />)}
        {chart ? (
          <>
            <IconButton label="جدول داده" active={table} onClick={() => setTable(!table)}><Table2 className="size-4" /></IconButton>
            <IconButton label="دانلود PNG" onClick={() => view && downloadPng(view, title)}><Download className="size-4" /></IconButton>
            {canvas ? null : <IconButton label="بوم تمام‌صفحه" onClick={() => setCanvas(true)}><Maximize2 className="size-4" /></IconButton>}
          </>
        ) : null}
      </div>
    </div>
  );

  const body = running ? (
    <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
      <Loader2 className="me-2 size-4 animate-spin" /> در حال خواندن داده و ساخت نمودار…
    </div>
  ) : loadError ? (
    <p className="ltr px-3 py-2 text-xs text-bad">{loadError}</p>
  ) : !chart ? (
    <div className="h-40" />
  ) : table ? (
    <DataTable datasets={chart.spec.datasets || {}} />
  ) : (
    <VegaView
      key={canvas ? `full-${canvasHeight}` : "inline"}
      spec={chart.spec}
      height={canvas ? canvasHeight : undefined}
      maximized={canvas}
      onView={setView}
    />
  );

  const queries = chart?.meta?.datasets?.filter((d) => d.promql) || [];
  const footer = queries.length ? (
    <details className="px-3 pb-2 text-xs text-muted-foreground">
      <summary className="cursor-pointer select-none">
        {queries.map((d) => `${d.cluster} · ${d.range || "instant"} · ${d.series} سری`).join(" | ")}
        {chart.meta.axes?.some((a) => a.by === "auto") ? " · محور خودکار" : ""}
      </summary>
      {queries.map((d) => (
        <pre key={d.name} className="ltr mt-1 overflow-x-auto whitespace-pre-wrap rounded bg-muted/60 p-2 font-mono">{d.promql}</pre>
      ))}
    </details>
  ) : null;

  if (canvas) {
    return (
      <>
        <div className="my-2 rounded-lg border bg-card px-3 py-2 text-sm text-muted-foreground">{title} — در بوم باز است</div>
        <div className="fixed inset-0 z-50 flex flex-col bg-background/95 p-2 backdrop-blur sm:p-4" role="dialog" aria-modal="true" aria-label={title}>
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border bg-card shadow-2xl">
            <div className="flex shrink-0 items-start border-b">
              <div className="min-w-0 flex-1">{header}</div>
              <IconButton label="بستن" onClick={() => setCanvas(false)} className="m-2"><X className="size-5" /></IconButton>
            </div>
            <div ref={canvasArea} className="min-h-0 flex-1 overflow-auto px-3 py-3 sm:px-5">{body}</div>
            {footer ? <div className="shrink-0 border-t">{footer}</div> : null}
          </div>
        </div>
      </>
    );
  }

  return (
    <div className="my-2 overflow-hidden rounded-lg border bg-card">
      {header}
      <div className="px-3 py-3">{body}</div>
      {footer}
    </div>
  );
}

function IconButton({ label, active, onClick, children, className = "" }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className={`rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground ${active ? "bg-muted text-foreground" : ""} ${className}`}
    >
      {children}
    </button>
  );
}
