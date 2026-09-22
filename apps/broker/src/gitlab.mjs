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

const MR_MERGE_STATES = new Set(["merge", "squash", "rebase_merge", "ff"]);

export function createGitlabTools({ vault, fetchImpl = fetch, canMutate = () => true, host = "" }) {
  const HOST = String(host || "").replace(/\/+$/, "");
  const requireHost = () => {
    if (!HOST) throw new ToolInputError("no GitLab configured — set gitlab.url in the site config");
    return HOST;
  };
  async function api(path, { params, raw = false, method = "GET", json } = {}) {
    const token = (await vault.item("gitlab__token")).trim();
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
      description: "Read or merge a GitLab merge request. Reading is free; merging is a live mutation and is disabled unless the broker caller explicitly allows it.",
      inputSchema: {
        type: "object",
        properties: {
          project: { type: "string" },
          iid: { type: "integer", minimum: 1 },
          action: { type: "string", enum: ["view", "ready", "merge"], description: "ready = remove the Draft: prefix so it can be merged" },
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
        const method = args.mergeMethod || "merge";
        if (!MR_MERGE_STATES.has(method)) throw new ToolInputError("invalid merge method");
        const json = { merge_when_pipeline_succeeds: false, should_remove_source_branch: false, merge_method: method, ...(args.sha ? { sha: String(args.sha) } : {}) };
        const { body } = await api(`${path}/merge`, { method: "PUT", json });
        return { iid, project: args.project, state: body.state, merged: Boolean(body.state === "merged" || body.merged_at), webUrl: body.web_url, source: "gitlab api" };
      },
    },

    gitlab_propose: {
      description:
        "Propose a change as a GitLab merge request: one commit (create/update/delete files) on a new branch `griffin/<name>` from the target branch, then a Draft MR. With update=true, adds a commit to an existing griffin/<name> branch (its MR updates). Never pushes to non-griffin branches and never merges.",
      inputSchema: {
        type: "object",
        properties: {
          project: { type: "string" },
          branch: { type: "string", pattern: "^[a-z0-9][a-z0-9._-]{2,60}$", description: "short name; the branch becomes griffin/<branch>" },
          targetBranch: { type: "string", maxLength: 255, description: "default: the project's default branch" },
          title: { type: "string", minLength: 5, maxLength: 200 },
          update: { type: "boolean", description: "commit to the existing griffin/<branch> instead of creating a new branch + MR" },
          description: { type: "string", maxLength: 20_000 },
          actions: {
            type: "array",
            minItems: 1,
            maxItems: 20,
            items: {
              type: "object",
              properties: {
                action: { type: "string", enum: ["create", "update", "delete"] },
                path: { type: "string", minLength: 1, maxLength: 500 },
                content: { type: "string", maxLength: 500_000 },
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
        const branch = `griffin/${String(args.branch)}`;
        if (!/^griffin\/[a-z0-9][a-z0-9._-]{2,60}$/.test(branch)) throw new ToolInputError("invalid branch name");
        let target = args.targetBranch ? String(args.targetBranch) : null;
        if (target && !REF.test(target)) throw new ToolInputError("invalid target branch");
        if (!target) target = (await api(`/projects/${project}`)).body.default_branch || "main";
        if (target === branch) throw new ToolInputError("target and source branch are the same");
        const actions = args.actions.map((a) => {
          const filePath = String(a.path).replace(/^\/+/, "");
          if (!filePath || filePath.includes("..") || /[\0]/.test(filePath)) throw new ToolInputError(`invalid path ${a.path}`);
          if (a.action !== "delete" && typeof a.content !== "string") throw new ToolInputError(`content is required for ${a.action} ${filePath}`);
          return { action: a.action, file_path: filePath, ...(a.action !== "delete" ? { content: a.content } : {}) };
        });
        const total = actions.reduce((n, a) => n + (a.content?.length || 0), 0);
        if (total > 1_000_000) throw new ToolInputError("change is too large (max 1MB)");
        let exists = true;
        try {
          await api(`/projects/${project}/repository/branches/${encodeURIComponent(branch)}`);
        } catch (error) {
          if (error.status !== 404) throw error;
          exists = false;
        }
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
        const description = `${String(args.description || "").trim()}\n\n---\nپیشنهاد خودکار گریفین؛ بازبینی و merge با انسان.`.trim();
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

    gitlab_pipeline: {
      description: "Read a GitLab pipeline: status and each job (stage, status, failure_reason), with the log tail of failed jobs.",
      inputSchema: {
        type: "object",
        properties: {
          project: { type: "string" },
          id: { type: "integer", minimum: 1 },
          tailLines: { type: "integer", minimum: 5, maximum: 300 },
          retryFailed: { type: "boolean", description: "retry the failed jobs (safe for runner/system failures; do not use to paper over real test failures)" },
          playJob: { type: "string", maxLength: 200, description: "start this manual job by name (e.g. runner:publish-images)" },
        },
        required: ["project", "id"],
        additionalProperties: false,
      },
      async execute(args) {
        const project = projectRef(args.project);
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
      description: "Read one file from a GitLab project at a ref (default the project's default branch). project = id or path like group/name.",
      inputSchema: {
        type: "object",
        properties: { project: { type: "string" }, path: { type: "string", minLength: 1, maxLength: 500 }, ref: { type: "string", maxLength: 255 } },
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
        return { project: args.project, path: filePath, ref: branch, content: text.length > 200_000 ? `${text.slice(0, 200_000)}\n… [truncated]` : text, source: "gitlab repository/files" };
      },
    },
  };
}
