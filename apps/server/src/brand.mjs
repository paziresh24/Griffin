// Per-install look: the repo ships Griffin's orange hub and palette; an owner picks their own logo and
// colours in the setup wizard (or Settings → ظاهر), saved under <data>/brand/:
//   icon.svg   — the rendered logo (served at /icon.svg and /agents/griffin.svg)
//   brand.css  — :root and .dark colour tokens (linked last in index.html)
//   brand.json — what was picked (preset ids or custom) so the picker can show it again
// The web renders presets itself (they depend on the palette and the assistant's name) and sends the
// final SVG and colours; everything is checked here, since the SVG is served from our own origin.
import fs from "node:fs";
import path from "node:path";

export const MAX_SVG_BYTES = 100 * 1024;
export const COLOR_KEYS = { brand: "--brand", primary: "--primary", primaryForeground: "--primary-foreground", accent: "--accent" };

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const NUM = String.raw`\d*\.?\d+%?`;
const OKLCH = new RegExp(String.raw`^oklch\(\s*${NUM}\s+${NUM}\s+${NUM}(?:deg)?\s*(?:\/\s*${NUM}\s*)?\)$`, "i");
export const isColor = (value) => typeof value === "string" && value.length <= 64 && (HEX.test(value) || OKLCH.test(value));

// Drawing only. Anything else (script, style, foreignObject, animate/set, a, iframe…) is dropped with
// everything inside it.
const ELEMENTS = new Set([
  "svg", "g", "path", "circle", "ellipse", "rect", "line", "polyline", "polygon", "text", "tspan", "textPath",
  "defs", "linearGradient", "radialGradient", "stop", "clipPath", "mask", "pattern", "symbol", "use", "image",
  "title", "desc", "filter", "feGaussianBlur", "feOffset", "feMerge", "feMergeNode", "feFlood", "feComposite",
  "feBlend", "feColorMatrix", "feDropShadow",
]);
const SAFE_IMAGE = /^data:image\/(?:png|jpeg|gif|webp);base64,[a-z0-9+/=\s]+$/i;

function safeAttr(name, value) {
  const lower = name.toLowerCase();
  if (!/^[a-z_][\w:.-]*$/i.test(name) || lower.startsWith("on") || lower === "style") return false;
  const flat = value.replace(/[\s\u0000-\u001f]/g, "").toLowerCase();
  if (/javascript:|vbscript:|data:text|@import|expression\(/.test(flat)) return false;
  // Links stay inside the file (#id) or are inline raster images; no fetches from elsewhere.
  if (lower === "href" || lower.endsWith(":href") || lower === "src") return flat.startsWith("#") || SAFE_IMAGE.test(value.trim());
  if (/url\((?!['"]?#)/.test(flat)) return false;
  return true;
}

const escapeAttr = (value) => value.replace(/&(?![a-z]+;|#\d+;|#x[0-9a-f]+;)/gi, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const TOKEN = /<!--[\s\S]*?-->|<\?xml[^>]*\?>|<\/([A-Za-z][\w:.-]*)\s*>|<([A-Za-z][\w:.-]*)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'))?)*)\s*(\/?)>|([^<]+)|(<)/gy;
const ATTR = /([^\s=>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'))?/g;

/** Rebuilds an uploaded SVG from an allowlist; throws on anything that is not a plain <svg> drawing. */
export function sanitizeSvg(input) {
  const source = String(input ?? "");
  if (Buffer.byteLength(source) > MAX_SVG_BYTES) throw new Error("svg is larger than 100KB");
  if (/<!DOCTYPE|<!ENTITY|<!\[CDATA\[/i.test(source)) throw new Error("svg must not carry a DOCTYPE, entities or CDATA");
  let out = "";
  const stack = []; // open element names; `false` entries are dropped elements
  let dropDepth = 0;
  let sawRoot = false;
  let closedRoot = false;
  TOKEN.lastIndex = 0;
  let m;
  while (TOKEN.lastIndex < source.length && (m = TOKEN.exec(source))) {
    const [, close, open, attrs, selfClose, text, stray] = m;
    if (stray) throw new Error("svg is not well-formed");
    if (text !== undefined) {
      if (!sawRoot || closedRoot) {
        if (text.trim()) throw new Error("text outside the <svg> root");
      } else if (!dropDepth) out += text.replace(/>/g, "&gt;");
      continue;
    }
    if (open) {
      if (closedRoot) throw new Error("only one <svg> root");
      if (!sawRoot) {
        if (open !== "svg") throw new Error("root element must be <svg>");
        sawRoot = true;
      }
      const keep = !dropDepth && ELEMENTS.has(open);
      if (!keep) dropDepth += selfClose ? 0 : 1;
      if (keep) {
        let tag = `<${open}`;
        const seen = new Set();
        for (const [, name, dq, sq] of (attrs || "").matchAll(ATTR)) {
          const value = dq ?? sq ?? "";
          if (seen.has(name) || !safeAttr(name, value)) continue;
          seen.add(name);
          tag += ` ${name}="${escapeAttr(value)}"`;
        }
        if (open === "svg" && stack.length === 0 && !seen.has("xmlns")) tag += ` xmlns="http://www.w3.org/2000/svg"`;
        out += tag + (selfClose ? "/>" : ">");
      }
      if (!selfClose) stack.push(keep ? open : false);
      else if (open === "svg" && stack.length === 0) closedRoot = true;
      continue;
    }
    if (close) {
      const top = stack.pop();
      if (top === undefined) throw new Error("svg is not well-formed");
      if (top === false) dropDepth -= 1;
      else if (top !== close) throw new Error("svg is not well-formed");
      else out += `</${close}>`;
      if (!stack.length) closedRoot = true;
    }
  }
  if (!sawRoot || !closedRoot || stack.length) throw new Error("svg is not well-formed");
  return out;
}

function checkColors(set, label) {
  if (!set || typeof set !== "object") throw new Error(`palette.${label} is required`);
  const clean = {};
  for (const key of Object.keys(COLOR_KEYS)) {
    if (!isColor(set[key])) throw new Error(`palette.${label}.${key} must be a hex colour or oklch(…)`);
    clean[key] = set[key].trim();
  }
  return clean;
}

const cssBlock = (selector, set) => `${selector}{${Object.entries(COLOR_KEYS).map(([key, name]) => `${name}:${set[key]}`).join(";")}}`;
// The install's colours win over both looks (Karsara's :root[data-look="karsara"] set its own blue,
// so the palette changed only the logo, owner 2026-10-18), but not over a specialist's page colours
// (html[data-agent], brand.js applyAgentTheme).
export const LIGHT_SELECTOR = ":root,:root[data-look]:not([data-agent])";
export const DARK_SELECTOR = ".dark,:root.dark[data-look]:not([data-agent])";
export const brandCss = (palette) => `/* Written by Griffin's setup (Settings → ظاهر). */\n${cssBlock(LIGHT_SELECTOR, palette.light)}\n${cssBlock(DARK_SELECTOR, palette.dark)}\n`;
/** A brand.css written before the selectors above (or copied by hand): served with them. */
export const upgradeBrandCss = (css) => String(css || "").replace(/^:root\{/m, `${LIGHT_SELECTOR}{`).replace(/^\.dark\{/m, `${DARK_SELECTOR}{`);

const presetId = (value) => (typeof value === "string" && /^[a-z0-9-]{1,40}$/.test(value) ? value : null);

function writeAtomic(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data, { mode: 0o644 });
  fs.renameSync(tmp, file);
}

export function createBrand(dir) {
  const file = (name) => path.join(dir, name);
  const read = () => {
    const icon = fs.existsSync(file("icon.svg"));
    const css = fs.existsSync(file("brand.css"));
    let saved = {};
    try {
      saved = JSON.parse(fs.readFileSync(file("brand.json"), "utf8"));
    } catch {
      // hand-made folder  or nothing saved: no record of the choice
    }
    return { custom: icon || css, icon, css, logo: saved.logo || null, palette: saved.palette || null, color: saved.palette?.light?.brand || null };
  };
  const save = (body = {}) => {
    const logo = body.logo || {};
    const palette = body.palette || {};
    const svg = sanitizeSvg(logo.svg);
    const colors = { light: checkColors(palette.light, "light"), dark: checkColors(palette.dark, "dark") };
    fs.mkdirSync(dir, { recursive: true });
    writeAtomic(file("icon.svg"), svg);
    writeAtomic(file("brand.css"), brandCss(colors));
    const record = { logo: { preset: presetId(logo.preset) }, palette: { preset: presetId(palette.preset), ...colors } };
    writeAtomic(file("brand.json"), JSON.stringify(record, null, 2));
    return read();
  };
  const reset = () => {
    for (const name of ["icon.svg", "brand.css", "brand.json"]) fs.rmSync(file(name), { force: true });
    return read();
  };
  return { read, save, reset };
}

export function brandRoutes(app, { dir }) {
  const brand = createBrand(dir);
  app.get("/api/setup/brand", (c) => c.json(brand.read()));
  app.put("/api/setup/brand", async (c) => {
    const body = await c.req.json().catch(() => null);
    try {
      return c.json(brand.save(body || {}));
    } catch (error) {
      return c.json({ error: error.message }, 400);
    }
  });
  app.delete("/api/setup/brand", (c) => c.json(brand.reset()));
  return brand;
}
