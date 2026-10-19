// Every t("…") key has an English entry, and no Persian text is left outside t() in UI code.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const src = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");
const PERSIAN = /[؀-ۿ]/;

function files(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(path.join(dir, e.name)) : /\.(jsx?|mjs)$/.test(e.name) ? [path.join(dir, e.name)] : []);
}

const en = Object.assign({}, ...fs.readdirSync(path.join(src, "i18n", "en")).map((f) =>
  JSON.parse(fs.readFileSync(path.join(src, "i18n", "en", f), "utf8"))));

// String literals passed as the first argument of t(…): "…", '…' or `…` without ${}.
const T_CALL = /\bt\(\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`[^`$]*`)/g;
const unquote = (lit) => (lit[0] === "`" ? lit.slice(1, -1) : JSON.parse(lit[0] === "'" ? `"${lit.slice(1, -1).replace(/"/g, '\\"')}"` : lit));

test("every translated key has English text", () => {
  const missing = [];
  for (const file of files(src)) {
    for (const [, lit] of fs.readFileSync(file, "utf8").matchAll(T_CALL)) {
      const key = unquote(lit);
      if (PERSIAN.test(key) && !en[key]) missing.push(`${path.relative(src, file)}: ${key}`);
    }
  }
  assert.deepEqual(missing, []);
});

// Files with UI text still waiting for English (mixed JSX text and template strings). Remove a file
// from the list once it is translated; a new file is never added here.
const PENDING = new Set(JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "i18n-pending.json"), "utf8")));

test("no Persian UI text outside t()", () => {
  const strays = [];
  for (const file of files(src)) {
    if (file.endsWith(path.join("src", "i18n.js"))) continue;
    if (PENDING.has(path.relative(src, file).split(path.sep).join("/"))) continue;
    fs.readFileSync(file, "utf8").split("\n").forEach((line, i) => {
      const code = line.replace(/\/\/.*$/, "").replace(T_CALL, "t()");
      if (PERSIAN.test(code) && !/i18n-ignore/.test(line)) strays.push(`${path.relative(src, file)}:${i + 1}: ${line.trim().slice(0, 90)}`);
    });
  }
  assert.deepEqual(strays, []);
});
