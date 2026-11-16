// «Add a repo» from the composer's picker on an install with no GitLab configured (most public ones):
// a git URL (https://… or git@host:path) is cloned straight under REPOS_ROOT by the app itself. Only
// network transports; git never prompts (a private repo fails at once with git's own message), and
// local/ext transports are refused so a URL can never read this machine's files or run a command.
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";

const HTTPS = /^https:\/\/[a-z0-9.-]+(?::\d+)?\/[\w.~%-]+(?:\/[\w.~%-]+)+?(?:\.git)?\/?$/i;
const SSH = /^(?:ssh:\/\/)?[\w.-]+@[a-z0-9.-]+[:/][\w.~-]+(?:\/[\w.~-]+)*?(?:\.git)?$/i;

/** Whether `text` is a clonable git URL (not a GitLab group/name, not a local path). */
export const isGitUrl = (text) => {
  const value = String(text || "").trim();
  return !/\s/.test(value) && (HTTPS.test(value) || SSH.test(value));
};

/** The folder name a URL clones into: its last path segment without .git. */
export function repoNameFromUrl(url) {
  const last = String(url).trim().replace(/\/+$/, "").replace(/\.git$/i, "").split(/[/:]/).pop() || "";
  const name = last.replace(/[^\w.-]/g, "-").replace(/^[.-]+/, "");
  return name && name !== "_wt" ? name.slice(0, 100) : null;
}

const run = (args, opts) =>
  new Promise((resolve, reject) => {
    execFile("git", args, { maxBuffer: 1024 * 1024, ...opts }, (error, stdout, stderr) =>
      error ? reject(new Error(String(stderr || error.message).trim().split("\n").slice(-3).join(" ").slice(0, 400))) : resolve(stdout),
    );
  });

export async function cloneUrl({ url, root, name = null, exec = run, timeout = 10 * 60_000 }) {
  const value = String(url || "").trim();
  if (!isGitUrl(value)) throw new Error("آدرس git معتبر نیست؛ مثلاً https://github.com/owner/repo.git");
  const folder = name ? String(name).trim() : repoNameFromUrl(value);
  if (!folder || !/^[\w.-]+$/.test(folder) || folder.startsWith(".") || folder === "_wt") throw new Error("نام پوشهٔ ریپو معتبر نیست");
  const dir = path.join(root, folder);
  if (fs.existsSync(dir)) throw new Error(`«${folder}» از قبل هست`);
  fs.mkdirSync(root, { recursive: true });
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "/bin/false", SSH_ASKPASS: "/bin/false", GIT_SSH_COMMAND: "ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new" };
  try {
    await exec(["-c", "protocol.file.allow=never", "-c", "protocol.ext.allow=never", "clone", "-q", "--", value, dir], { cwd: root, env, timeout });
  } catch (error) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw new Error(`کلون نشد: ${error.message}`);
  }
  return { repo: folder, url: value };
}
