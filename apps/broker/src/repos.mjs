import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { genv } from "./env.mjs";
import { gitlabToken } from "./gitlab.mjs";
import { ToolInputError } from "./kube.mjs";

// The owner's git clones under GRIFFIN_REPOS_ROOT (the same path in the app, the broker and the
// sandbox). Chats work in their own worktree of one (apps/server/src/worktrees.mjs); the app has
// no git credentials, so the network side — clone, fetch, push — runs here with the GitLab token
// from the vault (`gitlab__token`, same as the gitlab pack; host = site.gitlab.url). The token goes
// to git through GIT_CONFIG_* env (never argv, never the remote URL).

const PROJECT = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)+$/;
const NAME = /^[A-Za-z0-9._-]{1,100}$/;
// Only a chat's own branch is ever pushed (worktrees.mjs branchName: <assistant name>/<id8>[-2];
// older chats: griffin/<id8>).
const CHAT_BRANCH = /^[a-z0-9][a-z0-9-]{0,31}\/[A-Za-z0-9]{8}(-2)?$/;
// Projects whose owner wants a chat's commits pushed straight onto the default branch, no MR
// (GRIFFIN_PUSH_TO_DEFAULT, comma-separated group/name; set per install by its owner). Still never
// --force: a non-fast-forward is refused by git itself. 2026-10-28: a colleague asked for
// mahdibagheri/mohr — branch + MR + merge ran three pipelines per change on the shared runner.
const pushToDefault = (env = process.env) =>
  new Set(String(env.GRIFFIN_PUSH_TO_DEFAULT || "").split(",").map((p) => p.trim().replace(/\.git$/, "")).filter((p) => PROJECT.test(p)));

// A repo's own config can make git run a program (core.fsmonitor on `git status`, a filter or diff
// driver, gpg.program, sshCommand, credential helpers) or pull in another file. A checkout anyone
// else can write (a chat's worktree, the sandbox's mount) could plant one, so git refuses to work in
// a repo whose local or worktree config sets any of these (security audit 2026-10-29). Our own
// core.hooksPath override (command scope) wins over a local one, so that one is left alone.
const PLANTED = /^(core\.(fsmonitor|sshcommand|pager|editor|askpass|alternaterefscommand|gitproxy)|sequence\.editor|diff\.external|(diff|merge|filter)\..+\.(textconv|command|driver|clean|smudge|process)|credential(\..+)?\.helper|gpg\.(.+\.)?program|include\.path|includeif\..+\.path|uploadpack\..+|receivepack\..+|remote\..+\.(uploadpack|receivepack|proxy)|protocol\.(.+\.)?allow|url\..+\.(insteadof|pushinsteadof)|http\.(.+\.)?proxy)$/i;
export function plantedGitConfig(listing) {
  const bad = [];
  for (const line of String(listing).split("\n")) {
    const [scope, name] = line.trim().split(/\s+/);
    if ((scope === "local" || scope === "worktree") && name && PLANTED.test(name)) bad.push(name);
  }
  return bad;
}

function rawRun(args, { cwd, env, timeout, input }) {
  return new Promise((resolve, reject) => {
    const child = execFile("git", args, { cwd, env, timeout, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(Object.assign(new Error(String(stderr || error.message).trim().slice(-800)), { code: error.code }));
      else resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
    if (input != null) child.stdin.end(input);
  });
}

export async function run(args, opts) {
  if (args[0] !== "clone") {
    const { stdout } = await rawRun(["config", "--list", "--name-only", "--show-scope", "--includes"], { cwd: opts.cwd, env: process.env, timeout: 20_000 });
    const bad = plantedGitConfig(stdout);
    if (bad.length) throw new Error(`this repo's git config sets ${bad.join(", ")}, which would run a program here; remove it from .git/config first`);
  }
  return rawRun(args, opts);
}

// Pushes carry the token's own name (owner 2026-10-29): an author watch flagged a dozen pushes
// where the token was a person's and the commits said «Nova», «Kian», «Atlas» or mnajafi@localhost.
// Before a push, the branch's commits that origin does not have yet are re-made with the token's user
// as author and committer — same tree, message and dates, so the chat's worktree stays clean. Commits
// already on origin (a colleague's branch merged in) keep their author. GRIFFIN_PUSH_AUTHOR_FIX=off
// turns it off.
const authorFixOn = (env = process.env) => String(env.GRIFFIN_PUSH_AUTHOR_FIX || "on").toLowerCase() !== "off";
const SEP = "\x1f";

/** The commits `ref` would push that origin has not got, oldest first, with who made them. */
export async function unpushedCommits(git, opts, ref) {
  const format = ["%H", "%P", "%an", "%ae", "%cn", "%ce", "%ad", "%cd"].join("%x1f");
  const { stdout } = await git(["log", "--topo-order", "--reverse", `--format=${format}`, "--date=raw", ref, "--not", "--remotes=origin"], opts);
  return stdout
    .split("\n")
    .filter((line) => line.includes(SEP))
    .map((line) => {
      const [sha, parents, an, ae, cn, ce, ad, cd] = line.split(SEP);
      return { sha, parents: parents ? parents.split(" ") : [], an, ae, cn, ce, ad, cd };
    });
}

/**
 * Re-makes `ref`'s unpushed commits as `who` ({name, email}) where any of them names someone else,
 * and moves `ref` to the new tip. Returns [{from, to}] for the commits re-made (empty: all were right).
 */
export async function fixAuthors(git, opts, ref, who) {
  const commits = await unpushedCommits(git, opts, ref);
  const same = (c) => c.an === who.name && c.ae === who.email && c.cn === who.name && c.ce === who.email;
  if (!commits.length || commits.every(same)) return [];
  const made = new Map();
  for (const c of commits) {
    const parents = c.parents.map((p) => made.get(p) || p);
    if (same(c) && parents.every((p, i) => p === c.parents[i])) continue;
    const raw = (await git(["cat-file", "commit", c.sha], opts)).stdout;
    const cut = raw.indexOf("\n\n");
    const message = cut >= 0 ? raw.slice(cut + 2) : "";
    const env = { ...opts.env, GIT_AUTHOR_NAME: who.name, GIT_AUTHOR_EMAIL: who.email, GIT_AUTHOR_DATE: c.ad, GIT_COMMITTER_NAME: who.name, GIT_COMMITTER_EMAIL: who.email, GIT_COMMITTER_DATE: c.cd };
    const { stdout } = await git(["commit-tree", `${c.sha}^{tree}`, ...parents.flatMap((p) => ["-p", p])], { ...opts, env, input: message });
    made.set(c.sha, stdout.trim());
  }
  const tip = commits.at(-1).sha;
  const next = made.get(tip);
  if (!next) return [];
  // Compare-and-swap: a commit the chat made meanwhile fails this instead of being lost.
  await git(["update-ref", "-m", "push: commits carry the pusher's identity", ref, next, tip], opts);
  return [...made].map(([from, to]) => ({ from: from.slice(0, 12), to: to.slice(0, 12) }));
}

export function createRepoTools({ vault, host = "", root = genv("REPOS_ROOT", "/workspace/repos"), git = run, fetchImpl = fetch, defaultPush = pushToDefault(), authorFix = authorFixOn() }) {
  const HOST = String(host || "").replace(/\/+$/, "");
  async function env(write = false) {
    if (!HOST) throw new ToolInputError("no GitLab configured (site.gitlab.url)");
    const token = await gitlabToken(vault, write);
    return {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_COUNT: "3",
      GIT_CONFIG_KEY_0: `http.${HOST}/.extraHeader`,
      GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`oauth2:${token}`).toString("base64")}`,
      GIT_CONFIG_KEY_1: "safe.directory",
      GIT_CONFIG_VALUE_1: "*",
      // A repo's hooks never run here, beside the vault.
      GIT_CONFIG_KEY_2: "core.hooksPath",
      GIT_CONFIG_VALUE_2: "/dev/null",
    };
  }
  const repoDir = (repo) => {
    if (!NAME.test(String(repo || "")) || repo === "_wt") throw new ToolInputError("invalid repo name");
    const dir = path.join(root, repo);
    if (!fs.existsSync(path.join(dir, ".git"))) throw new ToolInputError(`no repo ${repo} under ${root}`);
    return dir;
  };

  async function originProject(repo) {
    const { stdout: url } = await git(["remote", "get-url", "origin"], { cwd: repoDir(repo), env: process.env, timeout: 10_000 });
    if (!HOST) throw new ToolInputError("no GitLab configured (site.gitlab.url)");
    const hostname = new URL(HOST).host.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const project = new RegExp(`${hostname}[:/](.+?)(\\.git)?\\s*$`).exec(url.trim())?.[1];
    if (!project || !PROJECT.test(project)) throw new ToolInputError("origin is not a GitLab project of this instance");
    return project;
  }
  async function projectApi(project) {
    const token = await gitlabToken(vault, true);
    return async (p, init = {}) => {
      const r = await fetchImpl(`${HOST}/api/v4/projects/${encodeURIComponent(project)}${p}`, { ...init, headers: { "PRIVATE-TOKEN": token, "Content-Type": "application/json" }, signal: AbortSignal.timeout(30_000) });
      if (!r.ok) throw new Error(`GitLab ${p} http_${r.status}: ${(await r.text()).slice(0, 200)}`);
      return r.json();
    };
  }
  // Who the write token is, as git should name them: /user; a token without read_user still knows
  // its own user id (/personal_access_tokens/self), and the public profile gives the name — the email
  // is then GitLab's private commit address for that user. Cached an hour, a miss five minutes.
  let pusherCache = { at: 0, value: null };
  async function pusher() {
    if (Date.now() - pusherCache.at < (pusherCache.value ? 3_600_000 : 300_000)) return pusherCache.value;
    let value = null;
    try {
      const token = await gitlabToken(vault, true);
      const get = async (p) => {
        const r = await fetchImpl(`${HOST}/api/v4${p}`, { headers: { "PRIVATE-TOKEN": token }, signal: AbortSignal.timeout(20_000) });
        return r.ok ? r.json() : null;
      };
      const me = await get("/user");
      if (me?.name && (me.commit_email || me.email)) value = { name: me.name, email: me.commit_email || me.email };
      else {
        const self = await get("/personal_access_tokens/self");
        const user = self?.user_id ? await get(`/users/${self.user_id}`) : null;
        if (user?.name && user.username) value = { name: user.name, email: user.public_email || `${user.id}-${user.username}@users.noreply.${new URL(HOST).host}` };
      }
    } catch {
      /* unknown: asked again in five minutes */
    }
    pusherCache = { at: Date.now(), value };
    return value;
  }

  // The branch's own commits as the token's user, before git sends them (fixAuthors).
  async function asPusher(cwd, branch, env) {
    if (!authorFix) return {};
    const who = await pusher();
    if (!who) return { authorCheck: "skipped: the token's GitLab user could not be read" };
    const rewritten = await fixAuthors(git, { cwd, env, timeout: 60_000 }, `refs/heads/${branch}`, who);
    return rewritten.length ? { author: `${who.name} <${who.email}>`, rewritten } : {};
  }

  // A pushed chat branch as a Draft MR (one per branch: an open one is returned, not duplicated).
  // Merging stays with a person — this never merges.
  async function openDraft(args) {
    const project = await originProject(args.repo);
    const api = await projectApi(project);
    const open = await api(`/merge_requests?state=opened&source_branch=${encodeURIComponent(args.branch)}`);
    if (open?.[0]) return { iid: open[0].iid, webUrl: open[0].web_url, project, existing: true };
    const info = await api("");
    const title = /^draft:/i.test(args.mrTitle) ? String(args.mrTitle) : `Draft: ${args.mrTitle}`;
    const created = await api("/merge_requests", { method: "POST", body: JSON.stringify({ source_branch: args.branch, target_branch: info.default_branch || "main", title, description: String(args.mrDescription || ""), remove_source_branch: true }) });
    return { iid: created.iid, webUrl: created.web_url, project, existing: false };
  }

  return {
    git_clone: {
      description:
        "Clone a GitLab project (group/name) into the repos folder so chats can work on it (each chat gets its own worktree and branch). name defaults to the project's last path part. Never overwrites an existing folder.",
      inputSchema: {
        type: "object",
        properties: { project: { type: "string", maxLength: 255 }, name: { type: "string", maxLength: 100 } },
        required: ["project"],
        additionalProperties: false,
      },
      async execute(args) {
        const project = String(args.project || "").replace(/\.git$/, "").replace(/^\/+|\/+$/g, "");
        if (!PROJECT.test(project) || project.includes("..")) throw new ToolInputError("project must look like group/name");
        const name = args.name || project.split("/").at(-1);
        if (!NAME.test(name) || name === "_wt") throw new ToolInputError("invalid name");
        const dir = path.join(root, name);
        if (fs.existsSync(dir)) throw new ToolInputError(`${name} already exists under ${root}`);
        fs.mkdirSync(root, { recursive: true });
        await git(["clone", "-q", `${HOST}/${project}.git`, dir], { cwd: root, env: await env(), timeout: 10 * 60_000 });
        const { stdout } = await git(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: dir, env: await env(), timeout: 20_000 });
        return { repo: name, project, defaultBranch: stdout.trim(), path: dir, source: "git clone" };
      },
    },

    git_fetch: {
      description:
        "Fetch origin for one of the repos (refreshes the branches new chat worktrees start from). update:true also fast-forwards the clone's own checkout when it is clean (never a merge, never a reset).",
      inputSchema: {
        type: "object",
        properties: { repo: { type: "string", maxLength: 100 }, update: { type: "boolean" } },
        required: ["repo"],
        additionalProperties: false,
      },
      async execute(args) {
        const cwd = repoDir(args.repo);
        const opts = { cwd, env: await env(), timeout: 120_000 };
        await git(["fetch", "-q", "--prune", "origin"], opts);
        if (!args.update) return { repo: args.repo, fetched: true, source: "git fetch" };
        const dirty = (await git(["status", "--porcelain", "--untracked-files=no"], opts)).stdout.trim();
        if (dirty) return { repo: args.repo, fetched: true, updated: false, reason: "local changes in the clone", source: "git fetch" };
        // A checkout an agent left on its own branch (detached, no upstream, or with commits of its own)
        // is its work: fetched, not moved. It was logged as an error every 10 minutes on six installs (2026-10-21).
        const skip = (reason) => ({ repo: args.repo, fetched: true, updated: false, reason, source: "git fetch" });
        const upstream = await git(["rev-parse", "--abbrev-ref", "@{upstream}"], opts).catch(() => null);
        if (!upstream) return skip("the checkout is not on a branch that tracks origin");
        if (await git(["merge-base", "--is-ancestor", "HEAD", "@{upstream}"], opts).then(() => false, () => true)) return skip("the checkout has commits of its own");
        await git(["merge", "-q", "--ff-only", "@{upstream}"], opts);
        const head = (await git(["rev-parse", "--short", "HEAD"], opts)).stdout.trim();
        return { repo: args.repo, fetched: true, updated: true, head, source: "git fetch + ff" };
      },
    },

    git_push: {
      description:
        "Push a chat's own branch (<your name>/<id>) of a repo to GitLab — never another branch, never --force. Commits origin does not have yet go out under the token's own GitLab name (re-made before the push when they say someone else; the answer lists them). Returns git's output, which carries the link to open a merge request.",
      inputSchema: {
        type: "object",
        properties: {
          repo: { type: "string", maxLength: 100 },
          branch: { type: "string", maxLength: 100 },
          mrTitle: { type: "string", maxLength: 200, description: "also open a Draft merge request to the default branch with this title (or return the open one for this branch)" },
          mrDescription: { type: "string", maxLength: 20_000 },
          toDefault: { type: "boolean", description: "push the branch's commits straight onto the project's default branch instead (fast-forward only, never force); only for projects this install allows, refused otherwise" },
        },
        required: ["repo", "branch"],
        additionalProperties: false,
      },
      async execute(args) {
        if (!CHAT_BRANCH.test(String(args.branch || ""))) throw new ToolInputError("only a chat branch (<name>/<id8>) can be pushed");
        if (args.toDefault) {
          const project = await originProject(args.repo);
          if (!defaultPush.has(project)) throw new ToolInputError(`${project} is not allowed to take pushes onto its default branch on this install (GRIFFIN_PUSH_TO_DEFAULT); push the chat branch and open an MR`);
          const target = (await (await projectApi(project))("")).default_branch;
          if (!target || !/^[A-Za-z0-9._\/-]{1,100}$/.test(target)) throw new Error(`${project} has no usable default branch`);
          const fixed = await asPusher(repoDir(args.repo), args.branch, await env(true));
          const { stdout, stderr } = await git(["push", "--porcelain", "origin", `refs/heads/${args.branch}:refs/heads/${target}`], { cwd: repoDir(args.repo), env: await env(true), timeout: 180_000 });
          return { repo: args.repo, branch: args.branch, pushed: true, target, project, ...fixed, output: `${stdout}${stderr}`.trim().slice(-1500), source: "git push" };
        }
        const fixed = await asPusher(repoDir(args.repo), args.branch, await env(true));
        const { stdout, stderr } = await git(["push", "--porcelain", "origin", `refs/heads/${args.branch}:refs/heads/${args.branch}`], {
          cwd: repoDir(args.repo),
          env: await env(true),
          timeout: 180_000,
        });
        const mr = /https:\/\/\S+merge_requests\/new\S*/.exec(stderr)?.[0] || null;
        const opened = args.mrTitle ? await openDraft(args) : null;
        return { repo: args.repo, branch: args.branch, pushed: true, mergeRequestUrl: opened?.webUrl || mr, ...(opened ? { mergeRequest: opened } : {}), ...fixed, output: `${stdout}${stderr}`.trim().slice(-1500), source: "git push" };
      },
    },
  };
}
