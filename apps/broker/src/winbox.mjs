import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

// A RouterOS console over the Winbox protocol (TCP 8291) — the same door the Winbox app uses.
//
// Why not the RouterOS API: the owner does not want the API service enabled on the office router,
// and there is nothing to enable here — Winbox is already listening for people. The protocol
// itself (EC-SRP5 + AES) is implemented by the vendored MIT client in ../vendor/winbox; this
// module only runs it: one command per call, credentials handed over on stdin (never argv, so
// they stay out of /proc), one JSON line back.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUNNER = path.join(HERE, "..", "vendor", "winbox", "run.py");

export class WinboxError extends Error {}

export function winboxExec({ host, port = 8291, user, password, command, timeoutMs = 30_000, python = "python3" } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(python, [RUNNER], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new WinboxError(`winbox timed out after ${timeoutMs}ms`));
    }, timeoutMs + 5_000);

    child.stdout.on("data", (chunk) => {
      out += chunk;
    });
    child.stderr.on("data", (chunk) => {
      err += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new WinboxError(`winbox runner failed to start: ${error.message}`));
    });
    child.on("close", () => {
      clearTimeout(timer);
      const line = out.trim().split("\n").filter(Boolean).at(-1) || "";
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        reject(new WinboxError(`winbox runner gave no result${err ? `: ${err.trim().slice(0, 300)}` : ""}`));
        return;
      }
      if (!parsed.ok) {
        reject(new WinboxError(String(parsed.error || "winbox failed")));
        return;
      }
      resolve(String(parsed.output ?? ""));
    });

    child.stdin.end(JSON.stringify({ host, port, user, password, command, timeoutMs }));
  });
}
