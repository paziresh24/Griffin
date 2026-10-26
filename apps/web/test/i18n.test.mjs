// Every t("…") key has an English entry, and no Persian text is left outside t() in UI code.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const src = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");
// A module's own screens (modules/<id>/web/) are part of the same UI.
const modulesDir = path.join(src, "..", "..", "..", "modules");
const PERSIAN = /[؀-ۿ]/;

function files(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(path.join(dir, e.name)) : /\.(jsx?|mjs)$/.test(e.name) ? [path.join(dir, e.name)] : []);
}
const uiFiles = () => [
  ...files(src),
  ...(fs.existsSync(modulesDir) ? fs.readdirSync(modulesDir).flatMap((m) => (fs.existsSync(path.join(modulesDir, m, "web")) ? files(path.join(modulesDir, m, "web")) : [])) : []),
];
const rel = (file) => (file.startsWith(src) ? path.relative(src, file) : path.relative(path.join(modulesDir, ".."), file)).split(path.sep).join("/");
// Comments are notes for developers, not UI: /* … */ (and JSX {/* … */}) are blanked, keeping the line count.
const withoutComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, " "));

const en = Object.assign({}, ...fs.readdirSync(path.join(src, "i18n", "en")).map((f) =>
  JSON.parse(fs.readFileSync(path.join(src, "i18n", "en", f), "utf8"))));

// String literals passed as the first argument of t(…): "…", '…' or `…` without ${}.
const T_CALL = /\bt\(\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`[^`$]*`)/g;
const unquote = (lit) => (lit[0] === "`" ? lit.slice(1, -1) : JSON.parse(lit[0] === "'" ? `"${lit.slice(1, -1).replace(/"/g, '\\"')}"` : lit));

test("every translated key has English text", () => {
  const missing = [];
  for (const file of uiFiles()) {
    for (const [, lit] of fs.readFileSync(file, "utf8").matchAll(T_CALL)) {
      const key = unquote(lit);
      if (PERSIAN.test(key) && !en[key]) missing.push(`${rel(file)}: ${key}`);
    }
  }
  assert.deepEqual(missing, []);
});

// Persian that is not UI text (a regular expression matching the server's words, a digit table) carries
// an «i18n-ignore» comment on its line.
test("no Persian UI text outside t()", () => {
  const strays = [];
  for (const file of uiFiles()) {
    if (file.endsWith(path.join("src", "i18n.js"))) continue;
    const raw = fs.readFileSync(file, "utf8").split("\n");
    withoutComments(raw.join("\n")).split("\n").forEach((line, i) => {
      const code = line.replace(T_CALL, "t()").replace(/(^|[^:"'`\\])\/\/.*$/, "$1");
      if (PERSIAN.test(code) && !/i18n-ignore/.test(raw[i])) strays.push(`${rel(file)}:${i + 1}: ${raw[i].trim().slice(0, 90)}`);
    });
  }
  assert.deepEqual(strays, []);
});
