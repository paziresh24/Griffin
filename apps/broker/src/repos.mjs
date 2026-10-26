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

function run(args, { cwd, env, timeout }) {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, env, timeout, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(Object.assign(new Error(String(stderr || error.message).trim().slice(-800)), { code: error.code }));
      else resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

export function createRepoTools({ vault, host = "", root = genv("REPOS_ROOT", "/workspace/repos"), git = run, fetchImpl = fetch }) {
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

  // A pushed chat branch as a Draft MR (one per branch: an open one is returned, not duplicated).
  // Merging stays with a person — this never merges.
  async function openDraft(args) {
    const { stdout: url } = await git(["remote", "get-url", "origin"], { cwd: repoDir(args.repo), env: process.env, timeout: 10_000 });
    if (!HOST) throw new ToolInputError("no GitLab configured (site.gitlab.url)");
    const hostname = new URL(HOST).host.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const project = new RegExp(`${hostname}[:/](.+?)(\\.git)?\\s*$`).exec(url.trim())?.[1];
    if (!project || !PROJECT.test(project)) throw new ToolInputError("origin is not a GitLab project of this instance");
    const token = await gitlabToken(vault, true);
    const api = async (p, init = {}) => {
      const r = await fetchImpl(`${HOST}/api/v4/projects/${encodeURIComponent(project)}${p}`, { ...init, headers: { "PRIVATE-TOKEN": token, "Content-Type": "application/json" }, signal: AbortSignal.timeout(30_000) });
      if (!r.ok) throw new Error(`GitLab ${p} http_${r.status}: ${(await r.text()).slice(0, 200)}`);
      return r.json();
    };
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
        "Push a chat's own branch (<your name>/<id>) of a repo to GitLab — never another branch, never --force. Returns git's output, which carries the link to open a merge request.",
      inputSchema: {
        type: "object",
        properties: {
          repo: { type: "string", maxLength: 100 },
          branch: { type: "string", maxLength: 100 },
          mrTitle: { type: "string", maxLength: 200, description: "also open a Draft merge request to the default branch with this title (or return the open one for this branch)" },
          mrDescription: { type: "string", maxLength: 20_000 },
        },
        required: ["repo", "branch"],
        additionalProperties: false,
      },
      async execute(args) {
        if (!CHAT_BRANCH.test(String(args.branch || ""))) throw new ToolInputError("only a chat branch (<name>/<id8>) can be pushed");
        const { stdout, stderr } = await git(["push", "--porcelain", "origin", `refs/heads/${args.branch}:refs/heads/${args.branch}`], {
          cwd: repoDir(args.repo),
          env: await env(true),
          timeout: 180_000,
        });
        const mr = /https:\/\/\S+merge_requests\/new\S*/.exec(stderr)?.[0] || null;
        const opened = args.mrTitle ? await openDraft(args) : null;
        return { repo: args.repo, branch: args.branch, pushed: true, mergeRequestUrl: opened?.webUrl || mr, ...(opened ? { mergeRequest: opened } : {}), output: `${stdout}${stderr}`.trim().slice(-1500), source: "git push" };
      },
    },
  };
}
