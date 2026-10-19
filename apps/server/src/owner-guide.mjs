// The owner's own voice-and-decision guide (GRIFFIN_OWNER_GUIDE, persona.mjs), read in place of
// the built-in one. Meant for the owner's CLAUDE.md, so it follows Claude Code's memory imports:
// a line that is only `@path` pulls that file in (`~/` is the home folder, a relative path is relative
// to the file that names it), up to five levels deep, and a fenced code block is left alone. That is
// how Karsara gets the brain's core.md into every session: ~/.claude/CLAUDE.md says
// `@/…/brain/core.md`. Read on every rules build, so an edit to the brain reaches the next run.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const MAX_DEPTH = 5;
const IMPORT_LINE = /^@(\S+)$/;
const UNRESOLVED = "\u0000"; // marks an import line that could not be read, removed before return

function resolveImport(target, fromFile) {
  if (target === "~" || target.startsWith("~/")) return path.join(os.homedir(), target.slice(1));
  return path.isAbsolute(target) ? target : path.resolve(path.dirname(fromFile), target);
}

function expand(file, depth, seen, missing) {
  const real = path.resolve(file);
  if (seen.has(real)) return "";
  seen.add(real);
  const text = fs.readFileSync(real, "utf8");
  let fenced = false;
  const out = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (/^(```|~~~)/.test(trimmed)) fenced = !fenced;
    const m = !fenced && depth < MAX_DEPTH ? IMPORT_LINE.exec(trimmed) : null;
    if (!m) {
      out.push(line);
      continue;
    }
    const target = resolveImport(m[1], real);
    try {
      out.push(expand(target, depth + 1, seen, missing));
    } catch {
      missing.push(target);
      out.push(UNRESOLVED + line);
    }
  }
  return out.join("\n");
}

// { text, missing } — text is the guide with its imports read in; missing lists imports that could not
// be read (left as their `@path` line). Unreadable, or nothing but unreadable imports (a CLAUDE.md whose
// brain is not on this host) → text null: the caller then says the guide is missing.
export function readOwnerGuide(file) {
  const missing = [];
  let text;
  try {
    text = expand(file, 0, new Set(), missing);
  } catch {
    return { text: null, missing: [file] };
  }
  const lines = text.split("\n");
  if (!lines.some((l) => l.trim() && !l.startsWith(UNRESOLVED))) return { text: null, missing };
  return { text: lines.map((l) => (l.startsWith(UNRESOLVED) ? l.slice(1) : l)).join("\n").trim(), missing };
}
