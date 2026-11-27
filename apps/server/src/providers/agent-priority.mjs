// A chat's Claude Code process — and every build, test and dev server it starts — runs below the app
// (Mr. a colleague and Mr. Mohammadi, 2026-11-24: `next build`, `tsc` and Gradle started by chats filled a
// 4-core capsule's CPU and a 16 GB container's memory; the app's own page stalled for up to two minutes
// and the kernel's OOM killer took the app itself). The bundled binary is started through a tiny
// wrapper that lowers its CPU priority (nice) and makes it the OOM killer's first choice
// (oom_score_adj); children inherit both, the app server keeps its own. Nothing is lost when the
// machine is idle: nice only matters while something else wants the CPU.
//
// GRIFFIN_AGENT_NICE: the nice value (default 10); 0 or "off" starts Claude Code directly as before.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { genv } from "../env.mjs";

export const AGENT_OOM_SCORE_ADJ = 500;

export function agentNice(env = process.env) {
  const raw = String(genv("AGENT_NICE", "10", env)).trim().toLowerCase();
  if (raw === "off" || raw === "") return 0;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? Math.max(0, Math.min(19, n)) : 10;
}

const shellQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/** The wrapper script's text for one real binary. */
export function wrapperScript(real, nice) {
  return [
    "#!/bin/sh",
    "# Griffin: Claude Code below the app (providers/agent-priority.mjs).",
    `echo ${AGENT_OOM_SCORE_ADJ} > /proc/self/oom_score_adj 2>/dev/null`,
    `command -v nice >/dev/null 2>&1 && exec nice -n ${nice} ${shellQuote(real)} "$@"`,
    `exec ${shellQuote(real)} "$@"`,
    "",
  ].join("\n");
}

/** Path of a wrapper that starts `real` at low priority, written once per binary; null = run `real` directly. */
export function lowPriorityExecutable(real, { env = process.env, dir = path.join(os.tmpdir(), "griffin-agent-priority"), platform = process.platform } = {}) {
  const nice = agentNice(env);
  if (!real || !nice || platform !== "linux") return null;
  try {
    const text = wrapperScript(real, nice);
    const file = path.join(dir, `claude-${crypto.createHash("sha256").update(text).digest("hex").slice(0, 12)}.sh`);
    if (!fs.existsSync(file) || fs.readFileSync(file, "utf8") !== text) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, text, { mode: 0o755 });
      fs.renameSync(tmp, file);
    }
    return file;
  } catch {
    return null;
  }
}
