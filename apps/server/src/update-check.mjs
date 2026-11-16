// A public install has no host agent writing <data>/update/available.json (that is the private
// fleet's griffin-pull), so the in-app «new version» card never showed. This looks at the project's
// own GitHub repository every few hours instead and writes the same file, marked source:"github".
// It only tells that a newer version exists and what changed: taking it is the install command run
// again (docs/install.sh), which waits for running chats and rolls back if the new one is unhealthy.
// It never touches a file a host agent wrote (no `source` field, or a policy/status file next to it).
import fs from "node:fs";
import path from "node:path";

const SHA = /^[0-9a-f]{40}$/;
export const UPDATE_COMMAND = "curl -fsSL https://griffin.paziresh24.com/install.sh | bash";

const firstLine = (message) => String(message || "").split("\n")[0].trim().slice(0, 300);
const skip = (text) => !text || /^Merge /i.test(text) || /^docs\(handoff\)/i.test(text);

/** Commits newer than `current` as changelog entries, newest first. Unknown current: the newest few. */
export function changesFromCommits(commits, current) {
  const list = (Array.isArray(commits) ? commits : []).filter((c) => SHA.test(String(c?.sha || "")));
  const at = current ? list.findIndex((c) => c.sha.startsWith(current) || current.startsWith(c.sha)) : -1;
  const fresh = at < 0 ? list.slice(0, current ? list.length : 10) : list.slice(0, at);
  return fresh
    .map((c) => ({ commit: c.sha.slice(0, 12), at: c.commit?.committer?.date || c.commit?.author?.date || null, text: firstLine(c.commit?.message) }))
    .filter((c) => !skip(c.text));
}

export function createUpdateCheck({
  dir,
  current = null,
  repo = "paziresh24/Griffin",
  branch = "main",
  fetchImpl = fetch,
  now = () => new Date(),
  intervalMs = 6 * 3_600_000,
  firstDelayMs = 45_000,
  log = console,
  env = process.env,
} = {}) {
  const file = (name) => path.join(dir, name);
  const read = (name) => {
    try {
      return JSON.parse(fs.readFileSync(file(name), "utf8"));
    } catch {
      return null;
    }
  };
  let timer = null;
  let warned = false;

  /** A host agent owns the folder when it left a policy or status file, or an available.json of its own. */
  function hostManaged() {
    if (fs.existsSync(file("policy.json")) || fs.existsSync(file("status.json"))) return true;
    const own = read("available.json");
    return Boolean(own && own.source !== "github");
  }

  const write = (body) => {
    fs.mkdirSync(dir, { recursive: true });
    const tmp = file(`available.json.${process.pid}`);
    fs.writeFileSync(tmp, JSON.stringify(body));
    fs.renameSync(tmp, file("available.json"));
  };

  async function check() {
    if (!current) return { skipped: "unknown current version" };
    if (String(env.GRIFFIN_UPDATE_CHECK || "").toLowerCase() === "off") return { skipped: "off" };
    if (hostManaged()) return { skipped: "host-managed" };
    let commits;
    try {
      const res = await fetchImpl(`https://api.github.com/repos/${repo}/commits?sha=${encodeURIComponent(branch)}&per_page=50`, {
        headers: { accept: "application/vnd.github+json", "user-agent": "griffin-update-check" },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
      commits = await res.json();
    } catch (error) {
      // Quiet after the first line: a server with no route to GitHub would otherwise log every few hours.
      if (!warned) log.warn?.(`[update-check] ${error?.message || error}`);
      warned = true;
      return { error: String(error?.message || error) };
    }
    warned = false;
    const newest = Array.isArray(commits) && SHA.test(String(commits[0]?.sha || "")) ? commits[0].sha.slice(0, 12) : null;
    if (!newest) return { error: "no commits in the answer" };
    if (newest === current) {
      fs.rmSync(file("available.json"), { force: true });
      return { current: true };
    }
    // Everything on main newer than this build; when none of those is a visible change (only merges and
    // notes), there is nothing to show.
    const changes = changesFromCommits(commits, current);
    write({ commit: newest, at: now().toISOString(), changes, source: "github" });
    return { available: newest, changes: changes.length };
  }

  function start() {
    if (timer) return;
    const run = () => check().catch((error) => log.warn?.(`[update-check] ${error?.message || error}`));
    timer = setTimeout(function again() {
      run();
      timer = setTimeout(again, intervalMs);
      timer.unref?.();
    }, firstDelayMs);
    timer.unref?.();
  }
  const stop = () => {
    clearTimeout(timer);
    timer = null;
  };
  return { check, start, stop, hostManaged };
}
