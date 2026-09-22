import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// Runs one remote command with the owner key from the vault. The key lives in a 0600 temp
// file only for the duration of the call.
export function createSsh({ vault, knownHosts, keySlug = "ssh-bastion__owner-key", sshBin = "ssh" }) {
  return async function sshRun(target, remoteCommand, { timeoutMs = 60_000, maxBytes = 4 * 1024 * 1024, binary = false } = {}) {
    const work = await mkdtemp(path.join(tmpdir(), "griffin-ssh-"));
    const keyPath = path.join(work, "key");
    try {
      await writeFile(keyPath, `${(await vault.item(keySlug)).trim()}\n`, { mode: 0o600 });
      const args = [
        "-i", keyPath,
        "-o", "IdentitiesOnly=yes",
        "-o", "BatchMode=yes",
        "-o", "StrictHostKeyChecking=yes",
        "-o", `UserKnownHostsFile=${knownHosts}`,
        "-o", "ConnectTimeout=10",
        "-o", "ServerAliveInterval=10",
        "-p", String(target.port),
        `${target.user}@${target.host}`,
        "--",
        remoteCommand,
      ];
      return await new Promise((resolve, reject) => {
        const child = spawn(sshBin, args, { stdio: ["ignore", "pipe", "pipe"] });
        const chunks = [];
        let stderr = "";
        let size = 0;
        const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
        child.stdout.on("data", (chunk) => {
          size += chunk.length;
          if (size > maxBytes) child.kill("SIGKILL");
          else chunks.push(chunk);
        });
        child.stderr.on("data", (chunk) => {
          if (stderr.length < 16_000) stderr += chunk;
        });
        child.on("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.on("close", (code, signal) => {
          clearTimeout(timer);
          const buffer = Buffer.concat(chunks);
          if (code === 0) resolve({ stdout: binary ? buffer : buffer.toString("utf8"), stderr });
          else {
            const reason = signal ? `killed (${size > maxBytes ? "output too large" : "timeout"})` : `exit ${code}`;
            reject(new Error(`ssh ${target.host}: ${reason}: ${stderr.trim().slice(-400)}`));
          }
        });
      });
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  };
}

// Arguments are validated before they get here; quoting is a second line of defence.
export function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}
