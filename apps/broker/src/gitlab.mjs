import { ToolInputError } from "./kube.mjs";

// GitLab (host from the site config) with the token in the vault as `gitlab__token`. Beyond the version,
// the agent can list projects, search code across the instance (or a group/project), and read a file —
// e.g. "which projects pin next 14.1.0" is a blob search for the version in package.json.
//
// Global/group blob|commit|wiki search needs GitLab Advanced Search (Elasticsearch). This instance
// often has it off — then the API returns 400 "scope does not have a valid value". Project search
// still works (PostgreSQL), so we fan out across projects when the global/group call fails that way.

const REF = /^[\w./-]{1,255}$/;
const CODE_SCOPES = new Set(["blobs", "filenames", "wiki_blobs", "commits"]);
const FANOUT_CONCURRENCY = 16;
const FANOUT_MAX_PROJECTS = 300;
// Global blob search fans out over ~300 repos (Advanced Search is off) at ~1–2 min each; agents
// often repeat the same query while exploring. Cache fan-out results briefly so a repeat is instant.
const FANOUT_CACHE_TTL_MS = 10 * 60_000;
const fanoutCache = new Map(); // key -> { at, value }

const MEMBER_LEVELS = { reporter: 20, developer: 30 };
const MR_MERGE_STATES = new Set(["merge", "squash", "rebase_merge", "ff"]);

// Writes (push, MR, merge, pipeline) go out under `gitlab__write-token` when the vault has one —
// e.g. the owner's own identity, so GitLab shows a person rather than the bot user. Reads, and every
// write when it is absent, use `gitlab__token`.
export async function gitlabToken(vault, write = false) {
  if (write) {
    const own = await vault.item("gitlab__write-token").catch(() => "");
    if (String(own || "").trim()) return String(own).trim();
  }
  return String(await vault.item("gitlab__token")).trim();
}

export function createGitlabTools({ vault, fetchImpl = fetch, canMutate = () => true, host = "" }) {
  const HOST = String(host || "").replace(/\/+$/, "");
  const requireHost = () => {
    if (!HOST) throw new ToolInputError("no GitLab configured — set gitlab.url in the site config");
    return HOST;
  };
  async function api(path, { params, raw = false, method = "GET", json } = {}) {
    const token = await gitlabToken(vault, method !== "GET");
    const url = new URL(`${requireHost()}/api/v4${path}`);
    for (const [k, v] of Object.entries(params || {})) if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
    let lastError;
    const maxAttempts = 8;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const body = json !== undefined ? JSON.stringify(json) : undefined;
      const response = await fetchImpl(url, {
        method,
        headers: {
          "PRIVATE-TOKEN": token,
          Accept: raw ? "text/plain" : "application/json",
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        body,
        redirect: "manual",
        signal: AbortSignal.timeout(40_000),
      });
      if (response.status >= 500) {
        // The CDN in front of GitLab returns an HTML "Origin internal error" during outages; retry a bit.
        lastError = new Error(`GitLab ${path} http_${response.status} (origin/CDN error — GitLab may be down)`);
        await new Promise((r) => setTimeout(r, 500 * attempt));
        continue;
      }
      if (response.status === 401 || response.status === 403) throw new ToolInputError(`GitLab rejected the token for ${path} (http_${response.status}) — needs a token with the right scope/admin`);
      if (response.status === 429) {
        lastError = new Error(`GitLab ${path} http_429 (rate limited)`);
        lastError.status = 429;
        const wait = Number(response.headers.get("retry-after")) || 5 * attempt;
        await new Promise((r) => setTimeout(r, Math.min(Math.max(wait, 5), 60) * 1000));
        continue;
      }
      if (!response.ok) {
        const text = (await response.text()).slice(0, 200);
        const err = new Error(`GitLab ${path} http_${response.status}: ${text}`);
        err.status = response.status;
        err.body = text;
        throw err;
      }
      if (raw) return { text: await response.text(), headers: response.headers };
      if (response.status === 204) return { body: null, headers: response.headers };
      return { body: await response.json(), headers: response.headers };
    }
    throw lastError;
  }

  const projectRef = (value) => {
    const p = String(value || "");
    if (!p || p.length > 300 || /[?#\s]/.test(p)) throw new ToolInputError("project must be an id or path like group/name");
    return encodeURIComponent(p);
  };

  const mapBlobHits = (body) =>
    (body || []).map((r) => ({
      project: r.project_id,
      projectPath: r.project_path || undefined,
      path: r.path,
      ref: r.ref,
      startline: r.startline,
      line: (r.data || "").split("\n").slice(0, 4).join("\n").slice(0, 400),
    }));

  const needsFanout = (error) => error?.status === 400 && /scope does not have a valid value/i.test(error.body || error.message || "");

  async function listProjectsForFanout(group) {
    const projects = [];
    for (let page = 1; page <= Math.ceil(FANOUT_MAX_PROJECTS / 100); page += 1) {
      const path = group ? `/groups/${projectRef(group)}/projects` : "/projects";
      const { body, headers } = await api(path, {
        params: { per_page: 100, page, simple: "true", order_by: "last_activity_at", include_subgroups: group ? "true" : undefined },
      });
      for (const p of body || []) projects.push({ id: p.id, path: p.path_with_namespace });
      const totalPages = Number(headers.get?.("x-total-pages") || 1);
      if (!body?.length || body.length < 100 || page >= totalPages || projects.length >= FANOUT_MAX_PROJECTS) break;
    }
    return projects.slice(0, FANOUT_MAX_PROJECTS);
  }

  async function withSearchBudget(fn) {
    // Admin PAT can briefly raise the instance search rate limit so a fan-out finishes in
    // minutes instead of stalling on http_429 (default is often 30/min). Restored afterwards.
    let previous;
    try {
      const { body } = await api("/application/settings");
      previous = body?.search_rate_limit;
      if (typeof previous === "number" && previous < 200) {
        await api("/application/settings", { method: "PUT", json: { search_rate_limit: 200 } });
      } else {
        previous = undefined;
      }
    } catch {
      previous = undefined;
    }
    try {
      return await fn();
    } finally {
      if (typeof previous === "number") {
        try {
          await api("/application/settings", { method: "PUT", json: { search_rate_limit: previous } });
        } catch {
          /* leave raised; better than failing the tool */
        }
      }
    }
  }

  async function fanoutCodeSearch({ apiScope, search, limit, group }) {
    const cacheKey = `${apiScope}\u0000${group || ""}\u0000${search}`;
    const hit = fanoutCache.get(cacheKey);
    // Reuse a cached fan-out unless the caller now wants more than we cached (and more existed).
    if (hit && Date.now() - hit.at < FANOUT_CACHE_TTL_MS && (hit.value.results.length >= limit || hit.value.results.length >= (hit.value.count || 0))) {
      return { ...hit.value, results: hit.value.results.slice(0, limit), cached: true };
    }
    const value = await withSearchBudget(async () => {
      const projects = await listProjectsForFanout(group);
      const results = [];
      let scanned = 0;
      let cursor = 0;

      async function worker() {
        while (results.length < limit && cursor < projects.length) {
          const index = cursor;
          cursor += 1;
          const project = projects[index];
          scanned += 1;
          try {
            const { body } = await api(`/projects/${project.id}/search`, { params: { scope: apiScope, search, per_page: Math.min(limit, 20) } });
            for (const hit of mapBlobHits(body)) {
              results.push({ ...hit, project: project.id, projectPath: project.path });
              if (results.length >= limit) break;
            }
          } catch (error) {
            // Empty/disabled repos and permission gaps are normal while sweeping.
            if (error.status === 404 || error.status === 403 || error.status === 429) continue;
            if (needsFanout(error)) continue;
            throw error;
          }
        }
      }

      await Promise.all(Array.from({ length: Math.min(FANOUT_CONCURRENCY, projects.length || 1) }, () => worker()));
      return {
        scope: apiScope === "blobs" ? "blobs" : apiScope,
        count: results.length,
        results: results.slice(0, limit),
        scannedProjects: scanned,
        totalProjects: projects.length,
        note:
          results.length >= limit
            ? "more matches may exist; narrow with group/project or raise limit"
            : "GitLab Advanced Search is off — searched project-by-project (PostgreSQL). Pass project= for a single repo.",
        source: group ? `gitlab fanout group ${group}` : "gitlab fanout /projects",
      };
    });
    fanoutCache.set(cacheKey, { at: Date.now(), value });
    if (fanoutCache.size > 200) fanoutCache.delete(fanoutCache.keys().next().value);
    return value;
  }

  return {
    gitlab_projects: {
      description:
        "List GitLab projects, optionally filtered by a search term (matches name/path). Returns id, path, default branch, last activity. Use it to find a project id/path for gitlab_file or a scoped gitlab_search.",
      inputSchema: {
        type: "object",
        properties: {
          search: { type: "string", maxLength: 200 },
          membership: { type: "boolean", description: "only projects the token's user belongs to" },
          limit: { type: "integer", minimum: 1, maximum: 100 },
        },
        additionalProperties: false,
      },
      async execute(args) {
        const { body } = await api("/projects", {
          params: { search: args.search, membership: args.membership ? "true" : undefined, order_by: "last_activity_at", per_page: Math.min(Number(args.limit) || 30, 100), simple: "true" },
        });
        return {
          projects: (body || []).map((p) => ({ id: p.id, path: p.path_with_namespace, defaultBranch: p.default_branch, lastActivity: p.last_activity_at, url: p.web_url })),
          source: "gitlab api/v4/projects",
        };
      },
    },

    gitlab_search: {
      description:
        "Search GitLab. scope \"blobs\" searches file contents (e.g. '\"next\": \"14.1.0\"' to find package.json pins), \"projects\" searches project names, \"filenames\" finds files by name. Global by default; Advanced Search is OFF here, so a global blob/commit search fans out over ~300 repos and takes 1–2 minutes — STRONGLY prefer project= (or group=) to scope it, or gitlab_file if you already know the path. Do not repeat the same global query; results are cached ~10 min. Returns file path, project and matching lines.",
      inputSchema: {
        type: "object",
        properties: {
          search: { type: "string", minLength: 1, maxLength: 500 },
          scope: { type: "string", enum: ["blobs", "projects", "filenames", "wiki_blobs", "commits"] },
          group: { type: "string", description: "group id or path to scope the search" },
          project: { type: "string", description: "project id or path to scope the search" },
          limit: { type: "integer", minimum: 1, maximum: 100 },
        },
        required: ["search"],
        additionalProperties: false,
      },
      async execute(args) {
        const scope = args.scope || "blobs";
        const limit = Math.min(Number(args.limit) || 30, 100);
        const apiScope = scope === "filenames" ? "blobs" : scope;
        const search = scope === "filenames" ? `${args.search} filename:*` : args.search;
        const params = { scope: apiScope, search, per_page: limit };

        if (args.project) {
          const path = `/projects/${projectRef(args.project)}/search`;
          const { body } = await api(path, { params });
          if (scope === "projects") return { scope, results: (body || []).map((p) => ({ id: p.id, path: p.path_with_namespace, url: p.web_url })), source: `gitlab search ${path}` };
          return {
            scope,
            count: (body || []).length,
            results: mapBlobHits(body),
            note: (body || []).length >= limit ? "more matches exist; narrow the search or raise limit" : undefined,
            source: `gitlab search ${path}`,
          };
        }

        const path = args.group ? `/groups/${projectRef(args.group)}/search` : "/search";
        try {
          const { body } = await api(path, { params });
          if (scope === "projects") return { scope, results: (body || []).map((p) => ({ id: p.id, path: p.path_with_namespace, url: p.web_url })), source: `gitlab search ${path}` };
          return {
            scope,
            count: (body || []).length,
            results: mapBlobHits(body),
            note: (body || []).length >= limit ? "more matches exist; narrow the search or raise limit" : undefined,
            source: `gitlab search ${path}`,
          };
        } catch (error) {
          if (CODE_SCOPES.has(scope) && needsFanout(error)) {
            return fanoutCodeSearch({ apiScope, search, limit, group: args.group });
          }
          throw error;
        }
      },
    },

    gitlab_mr: {
      description: "Read, close/reopen or merge a GitLab merge request. Reading is free; the rest are live changes and disabled unless the broker caller explicitly allows it. close keeps the branch and can be undone with reopen.",
      inputSchema: {
        type: "object",
        properties: {
          project: { type: "string" },
          iid: { type: "integer", minimum: 1 },
          action: { type: "string", enum: ["view", "ready", "close", "reopen", "merge"], description: "ready = remove the Draft: prefix so it can be merged; close/reopen = the MR only, the branch stays" },
          mergeMethod: { type: "string", enum: ["merge", "squash", "rebase_merge", "ff"] },
          sha: { type: "string", maxLength: 64 },
        },
        required: ["project", "iid"],
        additionalProperties: false,
      },
      async execute(args) {
        const project = projectRef(args.project);
        const iid = Number(args.iid);
        if (!Number.isInteger(iid) || iid < 1) throw new ToolInputError("invalid merge request iid");
        const action = args.action || "view";
        const path = `/projects/${project}/merge_requests/${iid}`;
        if (action === "view") {
          const { body } = await api(path);
          return { iid, project: args.project, title: body.title, state: body.state, draft: Boolean(body.draft), sourceBranch: body.source_branch, targetBranch: body.target_branch, description: String(body.description || "").slice(0, 4000), webUrl: body.web_url, mergeStatus: body.merge_status, detailedMergeStatus: body.detailed_merge_status, pipeline: body.head_pipeline ? { status: body.head_pipeline.status, id: body.head_pipeline.id } : null, sha: body.sha, source: "gitlab api" };
        }
        if (!canMutate()) throw new ToolInputError("GitLab merge is not enabled for this caller; ask the owner to merge it");
        if (action === "ready") {
          const { body: current } = await api(path);
          const title = String(current.title || "").replace(/^(Draft:|\[Draft\]|\(Draft\))\s*/i, "");
          const { body } = await api(path, { method: "PUT", json: { title } });
          return { iid, project: args.project, title: body.title, draft: Boolean(body.draft), webUrl: body.web_url, source: "gitlab api" };
        }
        if (action === "close" || action === "reopen") {
          const { body } = await api(path, { method: "PUT", json: { state_event: action } });
          return { iid, project: args.project, state: body.state, webUrl: body.web_url, source: "gitlab api" };
        }
        const method = args.mergeMethod || "merge";
        if (!MR_MERGE_STATES.has(method)) throw new ToolInputError("invalid merge method");
        const json = { merge_when_pipeline_succeeds: false, should_remove_source_branch: false, merge_method: method, ...(args.sha ? { sha: String(args.sha) } : {}) };
        const { body } = await api(`${path}/merge`, { method: "PUT", json });
        return { iid, project: args.project, state: body.state, merged: Boolean(body.state === "merged" || body.merged_at), webUrl: body.web_url, source: "gitlab api" };
      },
    },

    gitlab_propose: {
      description:
        "Propose a change as a GitLab merge request: one commit (create/update/edit/delete files) on a new branch `<your name>/<name>` from the target branch, then a Draft MR. With update=true, adds a commit to that existing branch (its MR updates). Never pushes to other branches and never merges. For a small change to an existing file use action \"edit\" with edits [{find, replace}]: the broker reads the file itself and swaps only that exact text (find must match exactly once, or set all=true), so the rest of the file stays byte-for-byte untouched. Never rewrite a whole file with \"update\" for a one-line change (a copy read through a tool may have secrets masked as ***).",
      inputSchema: {
        type: "object",
        properties: {
          project: { type: "string" },
          branch: { type: "string", pattern: "^[a-z0-9][a-z0-9._-]{2,60}$", description: "short name; the branch becomes <your name>/<branch>" },
          prefix: { type: "string", pattern: "^[a-z0-9][a-z0-9-]{0,31}$", description: "set by the app (the assistant's name); not for the model" },
          targetBranch: { type: "string", maxLength: 255, description: "default: the project's default branch" },
          title: { type: "string", minLength: 5, maxLength: 200 },
          update: { type: "boolean", description: "commit to the existing <your name>/<branch> instead of creating a new branch + MR" },
          description: { type: "string", maxLength: 20_000 },
          actions: {
            type: "array",
            minItems: 1,
            maxItems: 20,
            items: {
              type: "object",
              properties: {
                action: { type: "string", enum: ["create", "update", "edit", "delete"] },
                path: { type: "string", minLength: 1, maxLength: 500 },
                content: { type: "string", maxLength: 500_000, description: "whole new file (create/update)" },
                edits: {
                  type: "array",
                  minItems: 1,
                  maxItems: 50,
                  description: "for action edit: exact text swaps applied in order",
                  items: {
                    type: "object",
                    properties: {
                      find: { type: "string", minLength: 1, maxLength: 20_000, description: "exact text to replace (include enough neighbouring lines to be unique)" },
                      replace: { type: "string", maxLength: 20_000 },
                      all: { type: "boolean", description: "replace every occurrence instead of requiring exactly one" },
                    },
                    required: ["find", "replace"],
                    additionalProperties: false,
                  },
                },
              },
              required: ["action", "path"],
              additionalProperties: false,
            },
          },
        },
        required: ["project", "branch", "title", "actions"],
        additionalProperties: false,
      },
      async execute(args) {
        if (!canMutate()) throw new ToolInputError("GitLab changes are not enabled for this caller");
        const project = projectRef(args.project);
        // The branch carries the assistant's name (the app passes it); older proposals used griffin/<name>.
        const prefix = /^[a-z0-9][a-z0-9-]{0,31}$/.test(String(args.prefix || "")) ? String(args.prefix) : "agent";
        let branch = `${prefix}/${String(args.branch)}`;
        if (!/^[a-z0-9][a-z0-9-]{0,31}\/[a-z0-9][a-z0-9._-]{2,60}$/.test(branch)) throw new ToolInputError("invalid branch name");
        let target = args.targetBranch ? String(args.targetBranch) : null;
        if (target && !REF.test(target)) throw new ToolInputError("invalid target branch");
        if (!target) target = (await api(`/projects/${project}`)).body.default_branch || "main";
        if (target === branch) throw new ToolInputError("target and source branch are the same");
        const seen = new Set();
        const cleaned = args.actions.map((a) => {
          const filePath = String(a.path).replace(/^\/+/, "");
          if (!filePath || filePath.includes("..") || /[\0]/.test(filePath)) throw new ToolInputError(`invalid path ${a.path}`);
          if (seen.has(filePath)) throw new ToolInputError(`${filePath} appears twice — one action per file (put all edits in one edit action)`);
          seen.add(filePath);
          if (a.action === "edit") {
            if (!Array.isArray(a.edits) || !a.edits.length) throw new ToolInputError(`edits are required for edit ${filePath}`);
          } else if (a.action !== "delete" && typeof a.content !== "string") {
            throw new ToolInputError(`content is required for ${a.action} ${filePath}`);
          }
          return { ...a, filePath };
        });
        let exists = true;
        try {
          await api(`/projects/${project}/repository/branches/${encodeURIComponent(branch)}`);
        } catch (error) {
          if (error.status !== 404) throw error;
          exists = false;
        }
        if (args.update && !exists) {
          // A proposal opened before branches carried the assistant's name.
          const older = `griffin/${String(args.branch)}`;
          try {
            await api(`/projects/${project}/repository/branches/${encodeURIComponent(older)}`);
            branch = older;
            exists = true;
          } catch (error) {
            if (error.status !== 404) throw error;
          }
        }
        // Edits read the file where the change will land: the proposal's own branch when updating, else the target.
        const readRef = args.update && exists ? branch : target;
        const readRaw = async (filePath) => {
          try {
            return (await api(`/projects/${project}/repository/files/${encodeURIComponent(filePath)}/raw`, { params: { ref: readRef }, raw: true })).text;
          } catch (error) {
            if (error.status === 404) return null;
            throw error;
          }
        };
        const maskCount = (t) => (String(t).match(/\*\*\*/g) || []).length;
        const actions = [];
        for (const a of cleaned) {
          if (a.action === "delete") {
            actions.push({ action: "delete", file_path: a.filePath });
          } else if (a.action === "edit") {
            let text = await readRaw(a.filePath);
            if (text === null) throw new ToolInputError(`${a.filePath} does not exist on ${readRef} — use create`);
            a.edits.forEach((e, i) => {
              const find = String(e.find);
              const count = text.split(find).length - 1;
              if (count === 0) throw new ToolInputError(`edit ${i + 1} of ${a.filePath}: the text to find is not in the file (exact match, whitespace included)`);
              if (count > 1 && !e.all) throw new ToolInputError(`edit ${i + 1} of ${a.filePath}: the text to find occurs ${count} times — add neighbouring lines to make it unique, or set all=true`);
              text = text.split(find).join(String(e.replace));
            });
            actions.push({ action: "update", file_path: a.filePath, content: text });
          } else {
            if (a.action === "update") {
              // A whole-file rewrite that brings in masked values is a copy read through a redacting tool: refuse it.
              const original = await readRaw(a.filePath);
              if (original !== null && maskCount(a.content) > maskCount(original)) {
                throw new ToolInputError(`${a.filePath}: the new content has *** that the file on ${readRef} does not — a masked copy would overwrite real values. Use action edit with find/replace instead of rewriting the file.`);
              }
            }
            actions.push({ action: a.action, file_path: a.filePath, content: a.content });
          }
        }
        const total = actions.reduce((n, a) => n + (a.content?.length || 0), 0);
        if (total > 1_000_000) throw new ToolInputError("change is too large (max 1MB)");
        if (args.update) {
          if (!exists) throw new ToolInputError(`branch ${branch} does not exist — nothing to update`);
          const { body: commit } = await api(`/projects/${project}/repository/commits`, { method: "POST", json: { branch, commit_message: String(args.title), actions } });
          return { project: args.project, branch, commit: commit.short_id || commit.id, updated: true, source: "gitlab api" };
        }
        if (exists) throw new ToolInputError(`branch ${branch} already exists — pick another name or pass update=true`);
        const title = String(args.title).startsWith("Draft:") ? String(args.title) : `Draft: ${args.title}`;
        const { body: commit } = await api(`/projects/${project}/repository/commits`, {
          method: "POST",
          json: { branch, start_branch: target, commit_message: String(args.title), actions },
        });
        const description = `${String(args.description || "").trim()}\n\n---\nپیشنهاد خودکار ایجنت؛ بازبینی و merge با انسان.`.trim();
        const { body: mr } = await api(`/projects/${project}/merge_requests`, {
          method: "POST",
          json: { source_branch: branch, target_branch: target, title, description, remove_source_branch: true },
        });
        return { project: args.project, branch, targetBranch: target, commit: commit.short_id || commit.id, iid: mr.iid, webUrl: mr.web_url, state: mr.state, source: "gitlab api" };
      },
    },

    gitlab_commits: {
      description: "Recent commits of a GitLab project, optionally only those touching a path (e.g. the GitOps folder of one app) — use it to learn whether a state was changed on purpose, by whom and why.",
      inputSchema: {
        type: "object",
        properties: {
          project: { type: "string" },
          path: { type: "string", maxLength: 500 },
          ref: { type: "string", maxLength: 255 },
          since: { type: "string", maxLength: 40, description: "ISO date" },
          limit: { type: "integer", minimum: 1, maximum: 100 },
        },
        required: ["project"],
        additionalProperties: false,
      },
      async execute(args) {
        const project = projectRef(args.project);
        if (args.ref && !REF.test(String(args.ref))) throw new ToolInputError("invalid ref");
        const { body } = await api(`/projects/${project}/repository/commits`, {
          params: { path: args.path ? String(args.path).replace(/^\/+/, "") : undefined, ref_name: args.ref, since: args.since, per_page: Math.min(Number(args.limit) || 20, 100) },
        });
        const commits = (body || []).map((c) => ({ id: c.short_id, at: c.committed_date, author: c.author_name, title: c.title, message: String(c.message || "").slice(0, 600) }));
        return { project: args.project, path: args.path || null, commits, source: "gitlab api" };
      },
    },

    gitlab_mrs: {
      description:
        "List merge requests of one GitLab project (newest update first), or across the whole instance when project is omitted: iid, title, author, state, draft, branches, pipeline status, updated time, link. Read-only. Use it to find the MR a colleague means, then gitlab_mr / gitlab_mr_changes for its detail.",
      inputSchema: {
        type: "object",
        properties: {
          project: { type: "string", description: "id or path like group/name; omit for every project the token can see" },
          state: { type: "string", enum: ["opened", "merged", "closed", "all"], description: "default opened" },
          author: { type: "string", maxLength: 100, description: "GitLab username" },
          search: { type: "string", maxLength: 200, description: "words in the title or description" },
          limit: { type: "integer", minimum: 1, maximum: 100 },
        },
        additionalProperties: false,
      },
      async execute(args) {
        const state = args.state || "opened";
        if (!["opened", "merged", "closed", "all"].includes(state)) throw new ToolInputError("invalid state");
        const path = args.project ? `/projects/${projectRef(args.project)}/merge_requests` : "/merge_requests";
        const { body } = await api(path, {
          params: { state, scope: args.project ? undefined : "all", author_username: args.author || undefined, search: args.search || undefined, order_by: "updated_at", sort: "desc", per_page: Math.min(Number(args.limit) || 30, 100) },
        });
        return {
          project: args.project || null,
          state,
          mergeRequests: (body || []).map((m) => ({
            iid: m.iid,
            project: m.references?.full ? String(m.references.full).replace(/!\d+$/, "") : args.project || null,
            title: m.title,
            author: m.author?.username || null,
            state: m.state,
            draft: Boolean(m.draft),
            sourceBranch: m.source_branch,
            targetBranch: m.target_branch,
            pipeline: m.head_pipeline?.status || null,
            detailedMergeStatus: m.detailed_merge_status || null,
            hasConflicts: Boolean(m.has_conflicts),
            labels: Array.isArray(m.labels) ? m.labels : [],
            reviewers: (m.reviewers || []).map((r) => r.username),
            changesCount: m.changes_count == null ? null : String(m.changes_count),
            comments: Number(m.user_notes_count) || 0,
            createdAt: m.created_at || null,
            updatedAt: m.updated_at,
            webUrl: m.web_url,
          })),
          source: "gitlab api merge_requests",
        };
      },
    },

    gitlab_project_member: {
      description:
        "Give a GitLab user a role on one project (reporter or developer only; never lowers an existing higher role). Needs the owner's approval, which the app asks for itself. Use it when a colleague must push to a repo (e.g. Developer on group/project).",
      inputSchema: {
        type: "object",
        properties: {
          project: { type: "string" },
          username: { type: "string", minLength: 1, maxLength: 100, pattern: "^[A-Za-z0-9_.-]+$" },
          role: { type: "string", enum: ["reporter", "developer"] },
        },
        required: ["project", "username", "role"],
        additionalProperties: false,
      },
      async execute(args) {
        if (!canMutate()) throw new ToolInputError("GitLab changes are not enabled for this caller");
        const project = projectRef(args.project);
        const level = MEMBER_LEVELS[args.role];
        if (!level) throw new ToolInputError("role must be reporter or developer");
        const { body: users } = await api("/users", { params: { username: args.username } });
        const user = (users || []).find((u) => u.username === args.username);
        if (!user) throw new ToolInputError(`no GitLab user "${args.username}"`);
        if (user.state !== "active") throw new ToolInputError(`GitLab user "${args.username}" is ${user.state}, not active`);
        let current = null;
        try {
          current = (await api(`/projects/${project}/members/all/${user.id}`)).body;
        } catch (error) {
          if (error.status !== 404) throw error;
        }
        if (current && current.access_level >= level) {
          return { project: args.project, username: args.username, accessLevel: current.access_level, changed: false, source: "gitlab api" };
        }
        const { body } = await api(`/projects/${project}/members${current ? `/${user.id}` : ""}`, {
          method: current ? "PUT" : "POST",
          json: current ? { access_level: level } : { user_id: user.id, access_level: level },
        });
        return { project: args.project, username: args.username, accessLevel: body.access_level, changed: true, source: "gitlab api" };
      },
    },

    gitlab_pipeline: {
      description: "Read a GitLab pipeline: status and each job (stage, status, failure_reason), with the log tail of failed jobs. Without id: the project's recent pipelines (id, ref, status, time) — use that to find the one to read.",
      inputSchema: {
        type: "object",
        properties: {
          project: { type: "string" },
          id: { type: "integer", minimum: 1 },
          tailLines: { type: "integer", minimum: 5, maximum: 300 },
          retryFailed: { type: "boolean", description: "retry the failed jobs (safe for runner/system failures; do not use to paper over real test failures)" },
          playJob: { type: "string", maxLength: 200, description: "start this manual job by name (e.g. runner:publish-images)" },
        },
        required: ["project"],
        additionalProperties: false,
      },
      async execute(args) {
        const project = projectRef(args.project);
        // No id used to become /pipelines/NaN, and the agent fell back to curl with someone
        // else's token from the secret store just to list pipelines.
        if (args.id == null) {
          if (args.playJob || args.retryFailed) throw new ToolInputError("id is required to play or retry");
          const { body: list } = await api(`/projects/${project}/pipelines`, { params: { per_page: 20, order_by: "id", sort: "desc" } });
          return {
            project: args.project,
            pipelines: (list || []).map((p) => ({ id: p.id, ref: p.ref, status: p.status, sha: String(p.sha || "").slice(0, 8), createdAt: p.created_at, updatedAt: p.updated_at })),
            source: "gitlab api",
          };
        }
        const id = Number(args.id);
        if (args.playJob) {
          if (!canMutate()) throw new ToolInputError("GitLab changes are not enabled for this caller");
          const { body: all } = await api(`/projects/${project}/pipelines/${id}/jobs`, { params: { per_page: 100, "scope[]": "manual" } });
          const job = (all || []).find((j) => j.name === String(args.playJob));
          if (!job) throw new ToolInputError(`no manual job "${args.playJob}" in pipeline ${id}`);
          const { body: played } = await api(`/projects/${project}/jobs/${job.id}/play`, { method: "POST", json: {} });
          return { project: args.project, id, played: { id: played.id, name: played.name, status: played.status, webUrl: played.web_url }, source: "gitlab api" };
        }
        if (args.retryFailed) {
          if (!canMutate()) throw new ToolInputError("GitLab changes are not enabled for this caller");
          const { body: all } = await api(`/projects/${project}/pipelines/${id}/jobs`, { params: { per_page: 100, "scope[]": "failed" } });
          const retried = [];
          for (const job of all || []) {
            await api(`/projects/${project}/jobs/${job.id}/retry`, { method: "POST", json: {} });
            retried.push(job.name);
          }
          return { project: args.project, id, retried, source: "gitlab api" };
        }
        const { body: pipeline } = await api(`/projects/${project}/pipelines/${id}`);
        const { body: jobs } = await api(`/projects/${project}/pipelines/${id}/jobs`, { params: { per_page: 100 } });
        const tail = Math.min(Number(args.tailLines) || 60, 300);
        const out = [];
        for (const job of jobs || []) {
          const row = { id: job.id, name: job.name, stage: job.stage, status: job.status, failureReason: job.failure_reason || null, duration: job.duration };
          if (job.status === "failed") {
            try {
              const { text } = await api(`/projects/${project}/jobs/${job.id}/trace`, { raw: true });
              row.logTail = text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").split("\n").slice(-tail).join("\n");
            } catch (error) {
              row.logTail = `(trace unavailable: ${error.message})`;
            }
          }
          out.push(row);
        }
        return { project: args.project, id, status: pipeline.status, ref: pipeline.ref, sha: pipeline.sha, webUrl: pipeline.web_url, jobs: out, source: "gitlab api" };
      },
    },

    gitlab_file: {
      description:
        "Read one file from a GitLab project at a ref (default the project's default branch). project = id or path like group/name. A big file comes back in line ranges: give startLine/endLine (1-based, inclusive); without them a file over ~1500 lines or 60k characters returns its first part with totalLines and nextStartLine — read on from there instead of guessing. To review a change, prefer gitlab_mr_changes (the diff) over reading two whole versions.",
      inputSchema: {
        type: "object",
        properties: {
          project: { type: "string" },
          path: { type: "string", minLength: 1, maxLength: 500 },
          ref: { type: "string", maxLength: 255 },
          startLine: { type: "integer", minimum: 1, description: "first line to return (1-based)" },
          endLine: { type: "integer", minimum: 1, description: "last line to return (inclusive)" },
        },
        required: ["project", "path"],
        additionalProperties: false,
      },
      async execute(args) {
        const project = projectRef(args.project);
        const ref = args.ref ? String(args.ref) : null;
        if (ref && !REF.test(ref)) throw new ToolInputError("invalid ref");
        const filePath = String(args.path).replace(/^\/+/, "");
        if (!filePath || /[\0]/.test(filePath)) throw new ToolInputError("invalid path");
        let branch = ref;
        if (!branch) {
          const { body } = await api(`/projects/${project}`);
          branch = body.default_branch || "main";
        }
        const { text } = await api(`/projects/${project}/repository/files/${encodeURIComponent(filePath)}/raw`, { params: { ref: branch }, raw: true });
        return { project: args.project, path: filePath, ref: branch, ...sliceLines(text, args), source: "gitlab repository/files" };
      },
    },

    gitlab_mr_changes: {
      description:
        "The diff of a merge request (iid), or of two refs (from → to, e.g. main → a branch): every changed file with added/removed line counts, and the unified diff of as many files as fit (~60k characters). Files left out are listed with diffOmitted; ask for one of them with path (a long one-file diff pages with startLine). Use this to review a change instead of reading whole files.",
      inputSchema: {
        type: "object",
        properties: {
          project: { type: "string" },
          iid: { type: "integer", minimum: 1, description: "merge request iid" },
          from: { type: "string", maxLength: 255, description: "base ref (with to; instead of iid)" },
          to: { type: "string", maxLength: 255, description: "head ref" },
          path: { type: "string", maxLength: 500, description: "only this file's diff" },
          startLine: { type: "integer", minimum: 1, description: "with path: first diff line to return" },
        },
        required: ["project"],
        additionalProperties: false,
      },
      async execute(args) {
        const project = projectRef(args.project);
        let diffs;
        let head = null;
        if (args.iid != null) {
          const iid = Number(args.iid);
          if (!Number.isInteger(iid) || iid < 1) throw new ToolInputError("invalid merge request iid");
          const { body: mr } = await api(`/projects/${project}/merge_requests/${iid}`);
          head = { iid, title: mr.title, state: mr.state, sourceBranch: mr.source_branch, targetBranch: mr.target_branch, sha: mr.sha, webUrl: mr.web_url };
          diffs = [];
          for (let page = 1; page <= 25; page += 1) {
            const { body, headers } = await api(`/projects/${project}/merge_requests/${iid}/diffs`, { params: { page, per_page: 20 } });
            diffs.push(...(body || []));
            const total = Number(headers.get?.("x-total-pages")) || 0;
            if (!body?.length || body.length < 20 || (total && page >= total)) break;
          }
        } else {
          const from = String(args.from || "");
          const to = String(args.to || "");
          if (!REF.test(from) || !REF.test(to)) throw new ToolInputError("give iid, or both from and to");
          const { body } = await api(`/projects/${project}/repository/compare`, { params: { from, to, straight: false } });
          head = { from, to, commits: (body?.commits || []).map((c) => ({ id: c.short_id, title: c.title })).slice(0, 50) };
          diffs = body?.diffs || [];
        }
        return { project: args.project, ...head, ...packDiffs(diffs, args), source: "gitlab api" };
      },
    },
  };
}

const FILE_MAX_CHARS = 60_000;
const FILE_MAX_LINES = 1_500;

// A whole big file can blow past the agent's tool-output limit, where the agent cannot read it —
// so files come in line windows.
export function sliceLines(text, { startLine, endLine } = {}) {
  const lines = String(text).split("\n");
  const totalLines = lines.length;
  const start = Math.max(1, Number(startLine) || 1);
  if (start > totalLines) throw new ToolInputError(`startLine ${start} is past the end (${totalLines} lines)`);
  const wanted = Math.min(totalLines, Number(endLine) || totalLines);
  let end = wanted;
  if (end < start) throw new ToolInputError("endLine is before startLine");
  if (end - start + 1 > FILE_MAX_LINES) end = start + FILE_MAX_LINES - 1;
  let out = lines.slice(start - 1, end);
  let size = 0;
  let kept = 0;
  for (const line of out) {
    if (kept && size + line.length + 1 > FILE_MAX_CHARS) break;
    size += line.length + 1;
    kept += 1;
  }
  out = out.slice(0, kept);
  end = start + kept - 1;
  const whole = start === 1 && end === totalLines;
  return {
    content: out.join("\n"),
    ...(whole ? {} : { startLine: start, endLine: end, totalLines }),
    ...(end < wanted ? { truncated: true, nextStartLine: end + 1 } : {}),
  };
}

const DIFF_BUDGET = 60_000;

function countLines(diff) {
  let added = 0;
  let removed = 0;
  for (const line of String(diff || "").split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) added += 1;
    else if (line.startsWith("-") && !line.startsWith("---")) removed += 1;
  }
  return { added, removed };
}

export function packDiffs(diffs, { path, startLine } = {}) {
  const files = (diffs || []).map((d) => ({
    path: d.new_path || d.old_path,
    ...(d.old_path && d.old_path !== d.new_path ? { oldPath: d.old_path } : {}),
    ...(d.new_file ? { newFile: true } : {}),
    ...(d.deleted_file ? { deleted: true } : {}),
    ...(d.renamed_file ? { renamed: true } : {}),
    ...countLines(d.diff),
    ...(d.too_large || d.collapsed ? { tooLargeForGitlab: true } : {}),
    diff: String(d.diff || ""),
  }));
  if (path) {
    const want = String(path).replace(/^\/+/, "");
    const file = files.find((f) => f.path === want || f.oldPath === want);
    if (!file) throw new ToolInputError(`${want} is not among the changed files (${files.map((f) => f.path).slice(0, 40).join(", ")})`);
    const { content, ...window } = sliceLines(file.diff, { startLine });
    return { files: [{ ...file, diff: content, ...window }] };
  }
  let used = 0;
  const out = files.map((f) => {
    if (used + f.diff.length > DIFF_BUDGET) {
      const { diff, ...rest } = f;
      return { ...rest, diffOmitted: true };
    }
    used += f.diff.length;
    return f;
  });
  const omitted = out.filter((f) => f.diffOmitted).length;
  return { fileCount: files.length, files: out, ...(omitted ? { note: `${omitted} file diff(s) left out to fit; ask again with path=<file> for each` } : {}) };
}

