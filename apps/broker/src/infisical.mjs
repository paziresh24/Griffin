import { ToolInputError } from "./kube.mjs";

// Infisical (self-hosted or cloud). The broker logs in with a Universal Auth machine identity whose
// credentials are in the vault as `infisical__universal-auth`:
//   { "host": "https://secrets.example.com", "clientId": "...", "clientSecret": "...", "projectId": "..." }
// The agent can read a project's secrets and upsert one (so a credential lands in Infisical, where the
// owner grants a teammate access, instead of being pasted into chat). Secret values never leave the broker
// except as the explicit result of a read the owner asked for.

const NAME = /^[A-Za-z0-9_.-]{1,255}$/;
const PATH = /^\/[A-Za-z0-9_./-]{0,250}$/;
const ENV = /^[a-z0-9-]{1,32}$/;
// Per-person projects are named like the people: kebab-case, matching the existing convention.
const PROJECT_NAME = /^[a-z0-9][a-z0-9-]{1,63}$/;

export function createInfisicalTools({ vault, fetchImpl = fetch }) {
  let token = null; // { value, expires, host }

  async function config() {
    let raw;
    try {
      raw = await vault.item("infisical__universal-auth");
    } catch {
      throw new ToolInputError("Infisical is not connected: add a Universal Auth machine identity to the vault as infisical__universal-auth");
    }
    let cfg;
    try {
      cfg = JSON.parse(raw);
    } catch {
      throw new Error("infisical__universal-auth is not valid JSON");
    }
    cfg.host = (cfg.host || "https://app.infisical.com").replace(/\/$/, "");
    if (!cfg.clientId || !cfg.clientSecret) throw new Error("infisical__universal-auth needs clientId and clientSecret");
    return cfg;
  }

  async function accessToken(cfg) {
    if (token && token.host === cfg.host && Date.now() < token.expires) return token.value;
    const response = await fetchImpl(`${cfg.host}/api/v1/auth/universal-auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ clientId: cfg.clientId, clientSecret: cfg.clientSecret }),
      signal: AbortSignal.timeout(20_000),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || !body.accessToken) throw new Error(`Infisical login failed http_${response.status}${body.message ? `: ${body.message}` : ""}`);
    token = { value: body.accessToken, host: cfg.host, expires: Date.now() + Math.max(60, (body.expiresIn || 3600) - 60) * 1000 };
    return token.value;
  }

  async function call(cfg, method, path, { query, body } = {}) {
    const url = new URL(`${cfg.host}${path}`);
    for (const [k, v] of Object.entries(query || {})) if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
    const response = await fetchImpl(url, {
      method,
      headers: { Authorization: `Bearer ${await accessToken(cfg)}`, Accept: "application/json", ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
    const text = await response.text();
    const json = text ? JSON.parse(text) : {};
    if (!response.ok) {
      const error = new Error(`Infisical ${method} ${path} http_${response.status}${json.message ? `: ${json.message}` : ""}`);
      error.status = response.status;
      throw error;
    }
    return json;
  }

  // Infisical has shuffled these read endpoints between versions; try the known spellings and
  // report which one answered, so an audit never silently returns "nobody has access".
  async function tryGet(cfg, paths, { query } = {}) {
    let lastError = null;
    for (const path of paths) {
      try {
        return { path, body: await call(cfg, "GET", path, { query }) };
      } catch (error) {
        lastError = error;
        if (error.status && error.status !== 404 && error.status !== 400 && error.status !== 405) break;
      }
    }
    return { path: null, body: null, error: lastError ? lastError.message : "no endpoint answered" };
  }

  const personOf = (m) => {
    const u = m.user || m.membership?.user || m;
    const email = u.email || u.username || null;
    const name = [u.firstName, u.lastName].filter(Boolean).join(" ") || u.name || null;
    const role = m.role || m.roles?.map((r) => r.customRoleSlug || r.role).join(",") || m.membership?.role || null;
    return { email, name, role, id: u.id || u._id || null };
  };

  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  let projectsByName = null;

  // Projects are usually named after a person or a team; their ids are uuids nobody
  // remembers. Accept either: a name is resolved once against the workspace list and cached.
  async function project(cfg, args) {
    const given = String(args.projectId || cfg.projectId || "");
    if (!given) throw new ToolInputError("projectId is required (no default in infisical__universal-auth)");
    if (UUID.test(given)) return given;
    if (!projectsByName) {
      const body = await call(cfg, "GET", "/api/v1/workspace");
      projectsByName = new Map((body.workspaces || []).map((w) => [String(w.name || "").toLowerCase(), w.id || w._id]));
    }
    const id = projectsByName.get(given.toLowerCase());
    if (id) return id;
    // Not a name we know: pass it through (it may still be a valid id) but say what the names are,
    // because "Project with ID '<name>' not found" on its own sends the agent hunting.
    if (!UUID.test(given)) {
      throw new ToolInputError(
        `unknown Infisical project "${given}" — known: ${[...projectsByName.keys()].slice(0, 40).join(", ") || "(none visible)"}`,
      );
    }
    return given;
  }

  function requireEnv(value) {
    const env = String(value || "prod");
    if (!ENV.test(env)) throw new ToolInputError("invalid environment");
    return env;
  }

  function requirePath(value) {
    const path = String(value || "/");
    if (!PATH.test(path)) throw new ToolInputError("invalid secretPath");
    return path;
  }

  const projectArg = { type: "string", description: "Infisical project id (workspace); omit to use the configured default" };
  const envArg = { type: "string", description: "environment slug (default prod)" };
  const pathArg = { type: "string", description: "folder path, e.g. /hami (default /)" };

  return {
    infisical_projects: {
      description: "List the Infisical projects (workspaces) this identity can see, with their ids. Use it to find the projectId for the other Infisical tools.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      async execute() {
        const cfg = await config();
        const body = await call(cfg, "GET", "/api/v1/workspace");
        return {
          projects: (body.workspaces || []).map((w) => ({ id: w.id || w._id, name: w.name, environments: (w.environments || []).map((e) => e.slug) })),
          default: cfg.projectId || null,
          source: `infisical ${new URL(cfg.host).host}`,
        };
      },
    },

    infisical_list: {
      description:
        "List secret names in an Infisical project (names and folder paths only, never values). With recursive:true it walks sub-folders, and search narrows to names/paths containing that text — use it to FIND where a credential lives (e.g. search \"MIKROTIK\" or \"mt-\") instead of listing folders one by one.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: projectArg,
          environment: envArg,
          path: pathArg,
          recursive: { type: "boolean", description: "walk sub-folders under path (depth 5, bounded)" },
          search: { type: "string", description: "only names/paths containing this text (case-insensitive); implies recursive" },
          limit: { type: "integer", minimum: 1, maximum: 500, description: "max matches (default 200)" },
        },
        additionalProperties: false,
      },
      async execute(args) {
        const cfg = await config();
        const workspaceId = await project(cfg, args);
        const environment = requireEnv(args.environment);
        const secretPath = requirePath(args.path);
        const needle = args.search ? String(args.search).trim().toLowerCase().slice(0, 64) : null;
        const recursive = Boolean(args.recursive) || Boolean(needle);
        const limit = Math.min(Math.max(Number(args.limit) || 200, 1), 500);

        const names = async (path) =>
          (await call(cfg, "GET", "/api/v3/secrets/raw", { query: { workspaceId, environment, secretPath: path, viewSecretValue: "false" } }))
            .secrets?.map((s) => s.secretKey) || [];
        const sub = async (path) =>
          (await call(cfg, "GET", "/api/v1/folders", { query: { workspaceId, environment, path } }).catch(() => ({ folders: [] })))
            .folders?.map((f) => f.name) || [];

        if (!recursive) {
          return {
            project: workspaceId,
            environment,
            path: secretPath,
            secrets: await names(secretPath),
            folders: await sub(secretPath),
            source: `infisical ${new URL(cfg.host).host}`,
          };
        }

        // Bounded breadth-first walk: a project has ~100 folders, so this stays one short burst
        // of requests instead of the twenty-plus single-folder calls it replaces.
        const MAX_FOLDERS = 300;
        const MAX_DEPTH = 5;
        const queue = [{ path: secretPath, depth: 0 }];
        const seen = new Set([secretPath]);
        const matches = [];
        const folders = [];
        let visited = 0;
        let truncated = false;
        while (queue.length && visited < MAX_FOLDERS && matches.length < limit) {
          const batch = queue.splice(0, 8);
          const results = await Promise.all(
            batch.map(async ({ path, depth }) => ({ path, depth, keys: await names(path), children: depth < MAX_DEPTH ? await sub(path) : [] })),
          );
          for (const { path, depth, keys, children } of results) {
            visited += 1;
            if (path !== secretPath) folders.push(path);
            for (const key of keys) {
              const hit = !needle || key.toLowerCase().includes(needle) || path.toLowerCase().includes(needle);
              if (!hit) continue;
              if (matches.length >= limit) {
                truncated = true;
                break;
              }
              matches.push({ path, name: key });
            }
            for (const child of children) {
              const next = path === "/" ? `/${child}` : `${path}/${child}`;
              if (seen.has(next)) continue; // a folder listing that repeats itself must not loop
              seen.add(next);
              queue.push({ path: next, depth: depth + 1 });
            }
          }
        }
        if (queue.length || visited >= MAX_FOLDERS) truncated = true;
        return {
          project: workspaceId,
          environment,
          path: secretPath,
          ...(needle ? { search: needle } : {}),
          folders: folders.filter((f) => !needle || f.toLowerCase().includes(needle)).slice(0, limit),
          foldersScanned: visited,
          total: matches.length,
          truncated,
          matches,
          source: `infisical ${new URL(cfg.host).host}`,
        };
      },
    },

    infisical_get: {
      description:
        "Read one secret's value from Infisical. Only for a value the owner asked to retrieve; never for browsing. Returns the value.",
      inputSchema: {
        type: "object",
        properties: { name: { type: "string" }, projectId: projectArg, environment: envArg, path: pathArg },
        required: ["name"],
        additionalProperties: false,
      },
      async execute(args) {
        const cfg = await config();
        const workspaceId = await project(cfg, args);
        const environment = requireEnv(args.environment);
        const secretPath = requirePath(args.path);
        const name = String(args.name || "");
        if (!NAME.test(name)) throw new ToolInputError("invalid secret name");
        const body = await call(cfg, "GET", `/api/v3/secrets/raw/${encodeURIComponent(name)}`, { query: { workspaceId, environment, secretPath } });
        return { name, value: body.secret?.secretValue ?? null, environment, path: secretPath, source: `infisical ${new URL(cfg.host).host}` };
      },
    },

    // Onboarding a colleague needs a project of their own to put their credential in (the owner's
    // rule: secrets travel only through the recipient's own secret manager). Create-only: it never
    // renames or deletes, and an existing project of that name is returned instead of duplicated.
    // Read-only: answers "who can reach this project?" and "what can this person reach?".
    // Reads memberships only — never a secret value.
    infisical_access: {
      description:
        "Audit Infisical access (read-only): organization members with their org role, and per project which users and groups are members with which role. Use it to check that a person can reach their own project and nothing they should not. Never returns secret values.",
      inputSchema: {
        type: "object",
        properties: {
          project: { type: "string", description: "limit to one project by name or id (default: every project)" },
          person: { type: "string", description: "limit the report to memberships whose email or name contains this" },
          roles: { type: "boolean", description: "resolve custom project roles and their permissions (default true)" },
        },
        additionalProperties: false,
      },
      async execute(args) {
        const cfg = await config();
        const want = String(args.project || "").trim().toLowerCase();
        const who = String(args.person || "").trim().toLowerCase();
        const matches = (p) => !who || `${p.email || ""} ${p.name || ""}`.toLowerCase().includes(who);

        const all = await call(cfg, "GET", "/api/v1/workspace");
        const workspaces = all.workspaces || [];
        const orgs = await tryGet(cfg, ["/api/v1/organization"]);
        const org = (orgs.body?.organizations || [])[0] || null;
        // A machine identity often cannot list organizations; every workspace carries its org id.
        const orgId = org?.id || org?._id || workspaces[0]?.orgId || workspaces[0]?.organization || null;

        let orgMembers = [];
        let orgMembersError = null;
        if (orgId) {
          const res = await tryGet(cfg, [`/api/v2/organizations/${orgId}/memberships`, `/api/v1/organization/${orgId}/memberships`]);
          if (res.body) orgMembers = (res.body.memberships || res.body.users || []).map(personOf);
          else orgMembersError = res.error;
        }

        // Groups are how most people actually reach a project, so resolve their members too.
        let orgGroups = [];
        let orgGroupsError = null;
        if (orgId) {
          const res = await tryGet(cfg, [`/api/v1/organization/${orgId}/groups`, `/api/v2/organizations/${orgId}/groups`]);
          if (res.body) {
            for (const g of res.body.groups || res.body || []) {
              const gid = g.id || g._id;
              if (!gid) continue;
              const users = await tryGet(cfg, [`/api/v1/group/${gid}/users`, `/api/v1/groups/${gid}/users`], { query: { limit: 200 } });
              orgGroups.push({
                name: g.name,
                slug: g.slug || null,
                role: g.role || g.customRoleSlug || null,
                members: (users.body?.users || users.body?.members || [])
                  .filter((u) => u.isPartOfGroup !== false)
                  .map(personOf)
                  .filter(matches),
                ...(users.body ? {} : { membersError: users.error }),
              });
            }
          } else orgGroupsError = res.error;
        }

        const projects = workspaces
          .map((w) => ({ id: w.id || w._id, name: w.name }))
          .filter((w) => !want || String(w.name).toLowerCase() === want || String(w.id) === args.project);

        const report = [];
        for (const p of projects) {
          const users = await tryGet(cfg, [`/api/v1/workspace/${p.id}/users`, `/api/v2/workspace/${p.id}/memberships`, `/api/v1/workspace/${p.id}/memberships`]);
          const groups = await tryGet(cfg, [`/api/v1/workspace/${p.id}/groups`, `/api/v2/workspace/${p.id}/groups`]);
          // A group's power is in its role, not its name: resolve custom project roles so "which
          // group is on this project" also answers "and what may it do with the secrets".
          const roles = args.roles === false ? { body: null } : await tryGet(cfg, [`/api/v1/workspace/${p.id}/roles`, `/api/v2/workspace/${p.id}/roles`]);
          const BUILT_IN = new Set(["admin", "member", "viewer", "no-access"]);
          const roleDefs = [];
          for (const r of roles.body?.roles || roles.body?.data || []) {
            const slug = r.slug || r.customRoleSlug || null;
            const def = { slug, name: r.name || null, permissions: r.permissions || null };
            // The list endpoint omits permissions; only the custom roles need a detail fetch.
            if (!def.permissions && slug && !BUILT_IN.has(slug) && (r.id || r._id)) {
              const detail = await tryGet(cfg, [`/api/v1/workspace/${p.id}/roles/${r.id || r._id}`, `/api/v2/workspace/${p.id}/roles/${r.id || r._id}`]);
              def.permissions = detail.body?.role?.permissions || detail.body?.permissions || null;
              if (!def.permissions) def.permissionsError = detail.error || "role detail had no permissions";
            }
            roleDefs.push(def);
          }
          const members = ((users.body?.users || users.body?.memberships || [])).map(personOf).filter(matches);
          report.push({
            project: p.name,
            projectId: p.id,
            members,
            memberCount: members.length,
            groups: (groups.body?.groups || groups.body?.groupMemberships || []).map((g) => ({
              name: g.group?.name || g.name || null,
              role: g.roles?.map((r) => r.customRoleSlug || r.role).join(",") || g.role || null,
            })),
            ...(roleDefs.length ? { roles: roleDefs } : {}),
            ...(users.body ? {} : { membersError: users.error }),
          });
        }

        return {
          org: org ? { id: orgId, name: org.name } : null,
          orgMembers: orgMembers.filter(matches),
          ...(orgMembersError ? { orgMembersError } : {}),
          orgGroups,
          ...(orgGroupsError ? { orgGroupsError } : {}),
          projects: report,
          source: `infisical ${new URL(cfg.host).host}`,
        };
      },
    },

    infisical_create_project: {
      description:
        "Create an Infisical project (workspace) for a person, named like the other per-person projects (kebab-case, e.g. sara-karimi). Returns the projectId to use with infisical_upsert. If a project with that name already exists it is returned unchanged — this never renames or deletes anything.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "project name, kebab-case, e.g. sara-karimi" },
          description: { type: "string", maxLength: 300 },
        },
        required: ["name"],
        additionalProperties: false,
      },
      async execute(args) {
        const cfg = await config();
        const name = String(args.name || "").trim();
        if (!PROJECT_NAME.test(name)) throw new ToolInputError("invalid project name: lowercase letters, digits and dashes, 2-64 chars");

        const existingBody = await call(cfg, "GET", "/api/v1/workspace");
        const existing = (existingBody.workspaces || []).find((w) => String(w.name) === name);
        if (existing) {
          return {
            name,
            action: "exists",
            projectId: existing.id || existing._id,
            environments: (existing.environments || []).map((e) => e.slug),
            consoleUrl: `${cfg.host}/project/${existing.id || existing._id}/secrets/prod`,
            source: `infisical ${new URL(cfg.host).host}`,
          };
        }

        const created = await call(cfg, "POST", "/api/v2/workspace", {
          body: { projectName: name, ...(args.description ? { projectDescription: String(args.description) } : {}) },
        });
        const workspace = created.project || created.workspace || created;
        const projectId = workspace.id || workspace._id;
        if (!projectId) throw new Error("Infisical created the project but returned no id");
        return {
          name,
          action: "created",
          projectId,
          environments: (workspace.environments || []).map((e) => e.slug),
          consoleUrl: `${cfg.host}/project/${projectId}/secrets/prod`,
          note: "عضویت/نقشِ خودِ شخص را در همین پروژه در پنل Infisical بده؛ این ابزار فقط پروژه را می‌سازد.",
          source: `infisical ${new URL(cfg.host).host}`,
        };
      },
    },

    infisical_upsert: {
      description:
        "Create or update a secret in Infisical (create if new, update if it exists). Use this to store a credential where a teammate can access it, instead of sending it in chat. Tell the owner the project/path so they can grant access. Returns the console link, never the value.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "secret name, e.g. HAMI_DB_PASSWORD" },
          value: { type: "string", minLength: 1, maxLength: 8000 },
          projectId: projectArg,
          environment: envArg,
          path: pathArg,
          comment: { type: "string", maxLength: 500 },
        },
        required: ["name", "value"],
        additionalProperties: false,
      },
      async execute(args) {
        const cfg = await config();
        const workspaceId = await project(cfg, args);
        const environment = requireEnv(args.environment);
        const secretPath = requirePath(args.path);
        const name = String(args.name || "");
        if (!NAME.test(name)) throw new ToolInputError("invalid secret name");
        const payload = { workspaceId, environment, secretPath, secretValue: String(args.value), ...(args.comment ? { secretComment: String(args.comment) } : {}) };
        let action = "updated";
        try {
          await call(cfg, "PATCH", `/api/v3/secrets/raw/${encodeURIComponent(name)}`, { body: payload });
        } catch (error) {
          if (error.status !== 404 && error.status !== 400) throw error;
          await call(cfg, "POST", `/api/v3/secrets/raw/${encodeURIComponent(name)}`, { body: payload });
          action = "created";
        }
        return {
          name,
          action,
          project: workspaceId,
          environment,
          path: secretPath,
          consoleUrl: `${cfg.host}/project/${workspaceId}/secrets/${environment}`,
          note: "برای دسترسی همکار، در همین پروژه/مسیر او را در Infisical عضو کن (یا نقش بده).",
          source: `infisical ${new URL(cfg.host).host}`,
        };
      },
    },
  };
}
