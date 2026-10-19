// Logos and colour palettes an owner can pick for their install (setup wizard → Appearance, Settings →
// Appearance). Griffin's orange hub is the default; every other look is just a preset.
// A palette sets the page tokens (--brand, --primary, --primary-foreground, --accent) for light and
// dark, plus `ink`: the four colours a logo is drawn with, so logo and palette always match. The
// server stores the rendered SVG and the colours (apps/server/src/brand.mjs).

import { t } from "./i18n.js";

const P = (id, label, brand, light, dark, ink) => ({ id, label, light: { brand, ...light }, dark: dark, ink });
const tone = (primary, primaryForeground, accent) => ({ primary, primaryForeground, accent });

export const PALETTES = [
  P("griffin", t("نارنجی گریفین"), "#e8873a",
    tone("oklch(0.7 0.15 55)", "oklch(0.98 0.01 70)", "oklch(0.95 0.04 55)"),
    { brand: "#e8873a", ...tone("oklch(0.78 0.14 55)", "oklch(0.2 0.04 50)", "oklch(0.28 0.05 50)") },
    { bg: "#1a120c", main: "#e8873a", light: "#f0a35a", alt: "#c96a28" }),
  P("violet", t("بنفش"), "#7c5cdb",
    tone("oklch(0.58 0.18 295)", "oklch(0.98 0.01 295)", "oklch(0.95 0.035 295)"),
    { brand: "#a48bf0", ...tone("oklch(0.74 0.14 295)", "oklch(0.2 0.05 295)", "oklch(0.28 0.05 295)") },
    { bg: "#15101f", main: "#7c5cdb", light: "#a48bf0", alt: "#c4b5fd" }),
  P("teal", t("فیروزه‌ای"), "#0d9488",
    tone("oklch(0.6 0.11 185)", "oklch(0.98 0.01 185)", "oklch(0.95 0.03 185)"),
    { brand: "#2dd4bf", ...tone("oklch(0.78 0.12 185)", "oklch(0.2 0.04 185)", "oklch(0.28 0.04 185)") },
    { bg: "#0b1716", main: "#14b8a6", light: "#5eead4", alt: "#0f766e" }),
  P("blue", t("آبی"), "#3b82f6",
    tone("oklch(0.58 0.17 258)", "oklch(0.98 0.01 258)", "oklch(0.95 0.03 258)"),
    { brand: "#60a5fa", ...tone("oklch(0.74 0.13 258)", "oklch(0.2 0.04 258)", "oklch(0.28 0.05 258)") },
    { bg: "#0e1424", main: "#3b82f6", light: "#93c5fd", alt: "#1d4ed8" }),
  P("green", t("سبز"), "#16a34a",
    tone("oklch(0.6 0.15 150)", "oklch(0.98 0.01 150)", "oklch(0.95 0.04 150)"),
    { brand: "#4ade80", ...tone("oklch(0.78 0.15 150)", "oklch(0.2 0.04 150)", "oklch(0.28 0.05 150)") },
    { bg: "#0c1710", main: "#22c55e", light: "#86efac", alt: "#15803d" }),
  P("rose", t("گلی"), "#e11d48",
    tone("oklch(0.6 0.2 15)", "oklch(0.98 0.01 15)", "oklch(0.95 0.03 15)"),
    { brand: "#fb7185", ...tone("oklch(0.75 0.15 15)", "oklch(0.2 0.05 15)", "oklch(0.28 0.05 15)") },
    { bg: "#1f0d12", main: "#f43f5e", light: "#fda4af", alt: "#be123c" }),
  P("amber", t("کهربایی"), "#d97706",
    tone("oklch(0.75 0.15 75)", "oklch(0.22 0.05 60)", "oklch(0.95 0.05 85)"),
    { brand: "#fbbf24", ...tone("oklch(0.82 0.15 85)", "oklch(0.2 0.04 70)", "oklch(0.28 0.05 75)") },
    { bg: "#1c1508", main: "#f59e0b", light: "#fcd34d", alt: "#b45309" }),
  P("slate", t("خاکستری"), "#475569",
    tone("oklch(0.45 0.03 255)", "oklch(0.98 0.005 255)", "oklch(0.95 0.01 255)"),
    { brand: "#94a3b8", ...tone("oklch(0.8 0.02 255)", "oklch(0.2 0.02 255)", "oklch(0.28 0.015 255)") },
    { bg: "#0f1319", main: "#64748b", light: "#cbd5e1", alt: "#334155" }),
];

const svg = (bg, body) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" fill="none"><rect width="64" height="64" rx="14" fill="${bg}"/>${body}</svg>`;
const escapeXml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const PETAL = "M0 -3 C8 -9 8 -19 0 -24 C-8 -19 -8 -9 0 -3Z";

export const LOGOS = [
  { id: "hub", label: t("هاب"), render: (k) => svg(k.bg, `<circle cx="32" cy="32" r="21" stroke="${k.main}" stroke-width="2.25" opacity="0.3"/><path stroke="${k.main}" stroke-width="2.5" stroke-linecap="round" d="M32 24.5 V18 M38.2 35.8 L44.5 39.6 M25.8 35.8 L19.5 39.6"/><circle cx="32" cy="32" r="8" fill="${k.main}"/><circle cx="32" cy="13.5" r="5" fill="${k.light}"/><circle cx="48" cy="42" r="5" fill="${k.main}"/><circle cx="16" cy="42" r="5" fill="${k.alt}"/>`) },
  { id: "flower", label: t("گل"), render: (k) => svg(k.bg, `<g transform="translate(32 34)"><path d="${PETAL}" fill="${k.light}"/><path d="${PETAL}" fill="${k.main}" transform="rotate(120)"/><path d="${PETAL}" fill="${k.alt}" transform="rotate(240)"/><circle r="5" fill="#f5d76e"/></g>`) },
  { id: "leaf", label: t("برگ"), render: (k) => svg(k.bg, `<path d="M16 48 C16 26 30 15 49 15 C49 35 38 48 16 48Z" fill="${k.main}"/><path d="M16 48 L40 24" stroke="${k.light}" stroke-width="2.5" stroke-linecap="round"/><path d="M28 36 L28 28 M34 30 L34 22" stroke="${k.alt}" stroke-width="2" stroke-linecap="round"/>`) },
  { id: "wave", label: t("موج"), render: (k) => svg(k.bg, `<path d="M12 26 Q22 16 32 26 T52 26" stroke="${k.light}" stroke-width="4" stroke-linecap="round"/><path d="M12 36 Q22 26 32 36 T52 36" stroke="${k.main}" stroke-width="4" stroke-linecap="round"/><path d="M12 46 Q22 36 32 46 T52 46" stroke="${k.alt}" stroke-width="4" stroke-linecap="round"/>`) },
  { id: "star", label: t("ستاره"), render: (k) => svg(k.bg, `<path d="M32 11 L38.2 24.6 L53 26.3 L42 36.3 L45 51 L32 43.6 L19 51 L22 36.3 L11 26.3 L25.8 24.6Z" fill="${k.main}"/><circle cx="32" cy="32" r="5" fill="${k.light}"/>`) },
  { id: "shield", label: t("سپر"), render: (k) => svg(k.bg, `<path d="M32 11 L50 18 V31 C50 42 42 50 32 54 C22 50 14 42 14 31 V18Z" fill="${k.main}"/><path d="M32 11 L50 18 V31 C50 42 42 50 32 54Z" fill="${k.alt}"/><path d="M24 32 L30 38 L41 26" stroke="${k.light}" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/>`) },
  { id: "bolt", label: t("جرقه"), render: (k) => svg(k.bg, `<circle cx="32" cy="32" r="21" fill="${k.alt}" opacity="0.35"/><path d="M35 10 L18 36 H30 L27 54 L46 26 H34Z" fill="${k.main}" stroke="${k.light}" stroke-width="1.5" stroke-linejoin="round"/>`) },
  { id: "orbit", label: t("مدار"), render: (k) => svg(k.bg, `<ellipse cx="32" cy="32" rx="22" ry="9" stroke="${k.alt}" stroke-width="2.5" transform="rotate(-30 32 32)"/><ellipse cx="32" cy="32" rx="22" ry="9" stroke="${k.light}" stroke-width="2.5" transform="rotate(30 32 32)"/><circle cx="32" cy="32" r="7" fill="${k.main}"/>`) },
  {
    id: "monogram",
    label: t("حرف اول نام"),
    render: (k, name = "G") =>
      svg(k.bg, `<circle cx="32" cy="32" r="22" fill="${k.main}"/><text x="32" y="33" text-anchor="middle" dominant-baseline="central" font-family="Vazirmatn, sans-serif" font-size="26" font-weight="700" fill="${k.bg}">${escapeXml([...String(name).trim()][0] || "G")}</text>`),
  },
];

export const findPalette = (id) => PALETTES.find((p) => p.id === id) || null;
export const findLogo = (id) => LOGOS.find((l) => l.id === id) || null;
export const renderLogo = (logoId, palette, name) => (findLogo(logoId) || LOGOS[0]).render(palette.ink, name);
export const svgDataUrl = (text) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(text)}`;

// sRGB hex → OKLCH (lightness, chroma, hue in degrees), for a palette built from one picked colour.
export function hexToOklch(hex) {
  const n = /^#?([0-9a-f]{6})$/i.exec(hex)?.[1];
  if (!n) return null;
  const lin = [0, 2, 4].map((i) => {
    const v = parseInt(n.slice(i, i + 2), 16) / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  const [r, g, b] = lin;
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  const H = (Math.atan2(B, A) * 180) / Math.PI;
  return { l: L, c: Math.hypot(A, B), h: H < 0 ? H + 360 : H };
}

const ok = (l, c, h) => `oklch(${+l.toFixed(3)} ${+c.toFixed(3)} ${Math.round(h)})`;

/** A whole palette (page tokens for light and dark + logo ink) from one colour the owner picked. */
export function paletteFromColor(hex) {
  const lch = hexToOklch(hex);
  if (!lch) return null;
  const { h } = lch;
  const c = Math.min(Math.max(lch.c, 0.02), 0.19);
  const brand = `#${/^#?([0-9a-f]{6})$/i.exec(hex)[1].toLowerCase()}`;
  return {
    id: "custom",
    label: t("رنگ دلخواه"),
    light: { brand, primary: ok(0.58, c, h), primaryForeground: ok(0.98, 0.01, h), accent: ok(0.95, Math.min(c, 0.04), h) },
    dark: { brand: ok(0.75, Math.min(c, 0.15), h), primary: ok(0.76, Math.min(c, 0.14), h), primaryForeground: ok(0.2, Math.min(c, 0.05), h), accent: ok(0.28, Math.min(c, 0.05), h) },
    ink: { bg: ok(0.18, Math.min(c, 0.03), h), main: brand, light: ok(0.82, Math.min(c, 0.12), h), alt: ok(0.5, c, h) },
  };
}
