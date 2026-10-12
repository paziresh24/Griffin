// Griffin is the platform; the assistant running on it has its own name per install (every agent
// used to be told «You are Griffin» and they stepped on each other). Defaults keep a fresh install
// named Griffin.
// Env wins; otherwise <data>/persona.json, written by the setup wizard.
// ponytail: read once at load (prompts and regexes are built from it) — a rename needs a restart.
import { readFileSync } from "node:fs";
import path from "node:path";

export const PERSONA_FILE = path.join(process.env.GRIFFIN_DATA || "/data", "persona.json");
const saved = (() => {
  try {
    return JSON.parse(readFileSync(PERSONA_FILE, "utf8"));
  } catch {
    return {};
  }
})();
export const PERSONA = {
  name: process.env.GRIFFIN_ASSISTANT_NAME || saved.name || "گریفین",
  latin: process.env.GRIFFIN_ASSISTANT_LATIN || saved.latin || "Griffin",
};

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Names people call the assistant by: the configured ones plus «گریفین/Griffin», which colleagues
// already use and keep working after a rename.
export const CALL_NAMES = [...new Set([PERSONA.name, PERSONA.latin, "گریفین", "گریف", "Griffin"])];
// Longest first, so «گریف» never eats the start of «گریفین».
export const CALL_RE = [...CALL_NAMES].sort((a, b) => b.length - a.length).map(esc).join("|");

// A call name as a whole word («اوریونی بود» or «griffins» is not a call).
export const CALL_WORD = `(?:${CALL_RE})(?![\\p{L}\\p{N}])`;

// A signature line under a message: the assistant, or an agent that signed with its name.
export const SIGNATURE_RE = `(?:ایجنت\\s*)?(?:${CALL_RE})`;
