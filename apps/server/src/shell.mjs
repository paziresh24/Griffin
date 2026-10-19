// The page shell (index.html) with the install's look files versioned. brand.css (colours) and
// icon.svg (logo) are not content-hashed like /assets/*, and a CDN in front (NSIN) keeps them for
// minutes whatever Cache-Control says — so after a palette or logo change a reload still showed the
// old one until someone cleared the cache (owner 2026-10-19). Putting the file's mtime on the URL
// makes every change a new URL; the shell itself is always revalidated, so it carries the new ones.

import fs from "node:fs";
import path from "node:path";

/** mtime in ms of a file as a short string; "0" when it does not exist (yet). */
export function fileVersion(file) {
  try {
    return String(Math.floor(fs.statSync(file).mtimeMs));
  } catch {
    return "0";
  }
}

/** `/brand.css` and `/icon.svg` in the shell get `?v=`; other links stay as they are. */
export function versionShell(html, { css = "0", icon = "0" } = {}) {
  return String(html)
    .replace(/(href=")\/brand\.css(?:\?[^"]*)?(")/g, `$1/brand.css?v=${css}$2`)
    .replace(/(href=")\/icon\.svg(?:\?[^"]*)?(")/g, `$1/icon.svg?v=${icon}$2`);
}

/** Hono handler: the shell with versioned look links, never cached by the browser or the CDN. */
export function shellHandler({ webDist, brandDir }) {
  const index = path.join(webDist, "index.html");
  return async (c) => {
    let html;
    try {
      html = await fs.promises.readFile(index, "utf8");
    } catch {
      return c.text("not found", 404, { "cache-control": "no-store" });
    }
    const body = versionShell(html, {
      css: fileVersion(path.join(brandDir, "brand.css")),
      icon: fileVersion(path.join(brandDir, "icon.svg")),
    });
    return c.body(body, 200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache, no-store, must-revalidate", "cdn-cache-control": "no-store" });
  };
}
