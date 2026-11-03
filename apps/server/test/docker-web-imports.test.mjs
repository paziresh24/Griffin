import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const MODULES = path.join(ROOT, "modules");

test("the runtime image copies every apps/web/src file a module's server side imports", () => {
  // modules/*/server.mjs import ./web/view.js, which imports from apps/web/src; the image ships only
  // the files the Dockerfile copies (a module that imported mcp.js once failed with «Cannot find module» in the image).
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
  const web = path.join(ROOT, "apps/web/src") + path.sep;
  const needed = [...seen].filter((f) => f.startsWith(web) && !f.endsWith(".json")).map((f) => path.relative(ROOT, f));
  for (const rel of needed) assert.match(docker, new RegExp(`^COPY ${rel.replace(/\./g, "\\.")} `, "m"), `${rel} is not copied into the image`);
});
