import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const MODULES = path.join(ROOT, "modules");

test("the runtime image copies every apps/web/src file the server or a module's server side imports", () => {
  // modules/*/server.mjs import ./web/view.js, which imports from apps/web/src; the image ships only
  // the files the Dockerfile copies (2026-10-29: tickets imported mcp.js → «Cannot find module» on .46).
  const docker = fs.readFileSync(path.join(ROOT, "Dockerfile"), "utf8");
  const seen = new Set();
  const walk = (file) => {
    if (seen.has(file) || !fs.existsSync(file)) return;
    seen.add(file);
    for (const [, spec] of fs.readFileSync(file, "utf8").matchAll(/^\s*import\s[^;]*?from\s+["'](\.[^"']+)["']/gm)) {
      const dep = path.resolve(path.dirname(file), spec);
      if (/\.(m?js|json)$/.test(dep)) walk(dep);
    }
  };
  for (const id of fs.readdirSync(MODULES)) walk(path.join(MODULES, id, "server.mjs"));
  // The server's own imports too (settings-suggest.mjs reads the settings catalogue).
  const SERVER = path.join(ROOT, "apps/server/src");
  for (const file of fs.readdirSync(SERVER)) if (file.endsWith(".mjs")) walk(path.join(SERVER, file));
  const web = path.join(ROOT, "apps/web/src") + path.sep;
  const needed = [...seen].filter((f) => f.startsWith(web) && !f.endsWith(".json")).map((f) => path.relative(ROOT, f));
  assert.ok(needed.includes("apps/web/src/i18n.js"));
  for (const rel of needed) assert.match(docker, new RegExp(`^COPY ${rel.replace(/\./g, "\\.")} `, "m"), `${rel} is not copied into the image`);
});
