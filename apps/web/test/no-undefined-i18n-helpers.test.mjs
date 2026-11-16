import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

// A helper used but never imported is a ReferenceError only when that line renders: the sidebar's
// badge (num) turned the whole page black the first time something waited for the owner.
const SRC = path.resolve(import.meta.dirname, "../src");
const HELPERS = ["num", "locale", "isRtl"];

function files(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? files(p) : /\.(jsx?|mjs)$/.test(e.name) ? [p] : [];
  });
}

// Code with comments and string/template text blanked, so a word inside a message is not a use.
const bare = (code) =>
  code
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "")
    .replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, (m) => [...m.matchAll(/\$\{([^}]*)\}/g)].map((x) => ` ${x[1]} `).join(""));

test("every i18n helper a source file uses is imported or defined there", () => {
  const missing = [];
  for (const file of files(SRC)) {
    if (path.basename(file) === "i18n.js") continue;
    const raw = fs.readFileSync(file, "utf8");
    const code = bare(raw);
    for (const name of HELPERS) {
      const used = new RegExp(`(?<![\\w.$])${name}(?![\\w$])(?!\\s*:)`).test(code.replace(/import\s*\{[^}]*\}\s*from\s*""/g, ""));
      if (!used) continue;
      const imported = new RegExp(`import\\s*\\{[^}]*\\b${name}\\b[^}]*\\}\\s*from`).test(raw);
      const defined = new RegExp(`(?:const|let|var|function)\\s+${name}\\b|[({,]\\s*${name}\\s*(?:=[^=>]|[,)}])`).test(code);
      if (!imported && !defined) missing.push(`${path.relative(SRC, file)}: ${name}`);
    }
  }
  assert.deepEqual(missing, []);
});
