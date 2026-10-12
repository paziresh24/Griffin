import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// Runs one remote command with the owner key from the vault (or the target's own keyFile — the
// sandbox has a dedicated key, never the owner's). The key lives in a 0600 temp file only for the
// duration of the call.
export function createSsh({ vault, knownHosts, keySlug = "ssh-bastion__owner-key", sshBin = "ssh" }) {
  return async function sshRun(target, remoteCommand, { timeoutMs = 60_000, maxBytes = 4 * 1024 * 1024, binary = false } = {}) {
    const work = await mkdtemp(path.join(tmpdir(), "griffin-ssh-"));
    const keyPath = path.join(work, "key");
    try {
      const key = target.keyFile ? await readFile(target.keyFile, "utf8") : await vault.item(target.keySlug || keySlug);
      await writeFile(keyPath, `${key.trim()}\n`, { mode: 0o600 });
      const args = [
        "-i", keyPath,
        "-o", "IdentitiesOnly=yes",
        "-o", "BatchMode=yes",
        // ponytail: the sandbox is our own container on loopback with a host key it regenerates;
        // pin it in known_hosts if it ever leaves 127.0.0.1. `tofu` is for ssh_exec to arbitrary
        // hosts (ssh anywhere with the owner key): trust-on-first-use, pinned in a persistent file
        // so a later host-key change is still caught. The known fixed hosts stay strict.
        ...(target.loopback
          ? ["-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null", "-o", "LogLevel=ERROR"]
          : target.tofu
            ? ["-o", "StrictHostKeyChecking=accept-new", "-o", `UserKnownHostsFile=${process.env.GRIFFIN_SSH_TOFU_KNOWN_HOSTS || "/tmp/griffin_tofu_known_hosts"}`]
            : ["-o", "StrictHostKeyChecking=yes", "-o", `UserKnownHostsFile=${knownHosts}`]),
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
