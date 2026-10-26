import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { customCallers } from "../agents/create.mjs";
import { parseManifest, toolPrefix } from "./manifest.mjs";
import { planSwitch } from "./plan.mjs";

// The module host: the one place the core knows about modules (docs/modules.md). A module is a folder
// modules/<id>/ with module.json (what it adds) and an optional server.mjs (the code behind it). The
// host loads the enabled ones, hands each a small API, and gives the rest of the app four things:
// tool definitions, agent rows, a verdict for the approval guard, and /api/modules routes. A module
// that fails to load is skipped and reported; it never takes the install down.

const ok = (value) => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
const fail = (error) => ({ isError: true, content: [{ type: "text", text: JSON.stringify({ error: String(error?.message || error) }) }] });
const SAFE_SQL = (id) => new RegExp(`^\\s*CREATE\\s+(UNIQUE\\s+)?(TABLE|INDEX)\\s+IF\\s+NOT\\s+EXISTS\\s+(mod_${id.replace(/-/g, "_")}_\\w+|\\w+\\s+ON\\s+mod_${id.replace(/-/g, "_")}_\\w+)`, "i");

/**
 * Which modules are switched on, from the MODULES config:
 *   "" or "default"    the install's preset: every module whose manifest lists this product
 *   "all"              every module
 *   "a,b"              exactly those
 *   "default,-b,+c"    the preset, without b, with c (a "+" or "-" word edits what came before)
 */
export function enabledSet(value, ids, presetIds = []) {
  const words = String(value ?? "").split(",").map((w) => w.trim()).filter(Boolean);
  if (!words.length) return new Set(presetIds.filter((id) => ids.includes(id)));
  const on = new Set();
  for (const word of words) {
    if (word === "default") presetIds.forEach((id) => on.add(id));
    else if (word === "all") ids.forEach((id) => on.add(id));
    else if (word.startsWith("-")) on.delete(word.slice(1));
    else on.add(word.startsWith("+") ? word.slice(1) : word);
  }
  return on;
}

export function listModuleDirs(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith(".") && fs.existsSync(path.join(dir, e.name, "module.json"))).map((e) => e.name).sort();
  } catch {
    return [];
  }
}

/**
 * @param dir where the modules are (the repo's modules/)
 * @param store the app's store (kv, db, agent profiles)
 * @param enabled the MODULES config key (see enabledSet)
 * @param product "griffin" or "karsara": which preset an empty MODULES means
 * @param callTool (name, args) => result: a broker or core tool, which a module may call only if it
 *   listed it in requires.tools
 * @param env (name, fallback) => string: how a module reads its own config (MOD_<ID>_<KEY>)
 * @param getConfig (key) => string: a core config value, read live (a module's `sets` is compared with it)
 * @param setConfig (patch) => void: writes core config (the marketplace applies a module's `sets`)
 * @param onChange () => void: told after the marketplace changed what is on
 */
export async function createModuleHost({ dir, store, enabled = "", product = "griffin", callTool = async () => { throw new Error("no tool source"); }, env = (_n, d = "") => d, getConfig = () => "", setConfig = () => {}, onChange = () => {}, defaultProvider = "cursor", mcpServers = null, complete = async () => "", log = console }) {
  const available = listModuleDirs(dir);
  // The preset needs every manifest read first: a module that does not parse is simply not in it.
  const presetIds = available.filter((id) => {
    try {
      return parseManifest(JSON.parse(fs.readFileSync(path.join(dir, id, "module.json"), "utf8")), id).presets.includes(product);
    } catch {
      return false;
    }
  });
  const manifests = new Map(); // id -> manifest, every installed module that parses
  const broken = new Map(); // id -> why its module.json does not parse
  for (const id of available) {
    try {
      manifests.set(id, parseManifest(JSON.parse(fs.readFileSync(path.join(dir, id, "module.json"), "utf8")), id));
    } catch (error) {
      broken.set(id, error.message);
      log.error?.(`[modules] ${error.message}`);
    }
  }

  // What is on: the MODULES config (or the product's preset), then what the owner switched in the
  // marketplace (kv modules:overrides {id: true|false}), then — for the modules that stand for a
  // value of a core setting (a Telegram variant is TELEGRAM_DM_MODE) — whatever the live setting says,
  // so the marketplace never disagrees with what is really running.
  const overrides = () => store.getKv("modules:overrides") || {};
  const configMatches = (m) => Object.keys(m.sets).length > 0 && Object.entries(m.sets).every(([k, v]) => String(getConfig(k) ?? "") === v);
  function computeOn() {
    const set = enabledSet(enabled, available, presetIds);
    for (const [id, value] of Object.entries(overrides())) {
      if (!manifests.has(id)) continue;
      if (value) set.add(id);
      else set.delete(id);
    }
    const slots = new Set([...manifests.values()].filter((m) => Object.keys(m.sets).length).flatMap((m) => m.provides));
    for (const slot of slots) {
      const group = [...manifests.values()].filter((m) => Object.keys(m.sets).length && m.provides.includes(slot));
      const match = group.filter(configMatches);
      if (match.length === 1) for (const m of group) (m === match[0] ? set.add(m.id) : set.delete(m.id));
    }
    for (const id of [...set]) if (!manifests.has(id)) set.delete(id);
    return set;
  }
  const on = computeOn();
  const loaded = new Map(); // id -> { manifest, tools, sources, actions }
  const failed = new Map(); // id -> why an enabled module did not load

  for (const id of [...on]) {
    try {
      loaded.set(id, await load(manifests.get(id)));
    } catch (error) {
      failed.set(id, error.message);
      log.error?.(`[modules] ${id} not loaded: ${error.message}`);
    }
  }
  const statusList = () => [
    ...[...broken].map(([id, error]) => ({ id, enabled: on.has(id), ok: false, error })),
    ...[...manifests.values()].map((m) => ({ id: m.id, title: m.title, enabled: on.has(m.id), ok: !failed.has(m.id), ...(failed.has(m.id) ? { error: failed.get(m.id) } : {}) })),
  ];

  async function load(manifest) {
    const { id } = manifest;
    const prefix = toolPrefix(id);
    const mod = { manifest, tools: new Map(), sources: new Map(), actions: new Map() };
    const key = (k) => `mod:${id}:${k}`;
    const api = {
      id,
      manifest,
      log: (...a) => log.log?.(`[module ${id}]`, ...a),
      // What the owner set on the module's card in the marketplace, else MOD_<ID>_<KEY>, else the default.
      config: (k) => {
        const spec = manifest.config.find((c) => c.key === k);
        if (!spec) throw new Error(`config «${k}» is not declared in module.json`);
        const own = ownConfig(id)[k];
        return own !== undefined && own !== "" ? String(own) : env(`MOD_${prefix.toUpperCase()}_${k}`, spec.default);
      },
      kv: { get: (k) => store.getKv(key(k)), set: (k, v) => store.setKv(key(k), v), delete: (k) => store.deleteKv(key(k)) },
      // The module's own tables, mod_<id>_*, made once per name. Nothing else may be created here.
      migrate(name, sql) {
        const done = store.getKv(key("schema")) || [];
        if (done.includes(name)) return;
        for (const statement of String(sql).split(";").map((s) => s.trim()).filter(Boolean)) {
          if (!SAFE_SQL(id).test(statement)) throw new Error(`migration «${name}»: only CREATE TABLE/INDEX IF NOT EXISTS on mod_${prefix}_* is allowed`);
          store.db.exec(statement);
        }
        store.setKv(key("schema"), [...done, name]);
      },
      db: {
        all: (sql, ...p) => store.db.prepare(sql).all(...p),
        get: (sql, ...p) => store.db.prepare(sql).get(...p),
        run: (sql, ...p) => store.db.prepare(sql).run(...p),
      },
      call: async (tool, args) => {
        if (!manifest.requires.tools.includes(tool)) throw new Error(`«${tool}» is not in requires.tools of module ${id}`);
        return callTool(tool, args);
      },
      // An MCP server the module declared in requires.mcp: { url, headers } as the owner set it, or null.
      mcpServer: (name) => {
        if (!manifest.requires.mcp.includes(name)) throw new Error(`«${name}» is not in requires.mcp of module ${id}`);
        const server = mcpServers?.get(name);
        return server ? { url: server.url || "", headers: { ...(server.headers || {}) } } : null;
      },
      // One question to the install's small model (the one that names chats), only for a module that
      // declared requires.ai. "" when no account can answer now; the module then shows without it.
      complete: async (prompt) => {
        if (!manifest.requires.ai) throw new Error(`module ${id} does not declare requires.ai`);
        return String((await complete(String(prompt).slice(0, 12_000))) || "").trim();
      },
      tool: (name, def) => mod.tools.set(name, def),
      source: (name, fn) => mod.sources.set(name, fn),
      action: (name, fn) => mod.actions.set(name, fn),
    };
    const file = path.join(dir, id, "server.mjs");
    if (fs.existsSync(file)) {
      const imported = await import(pathToFileURL(file).href);
      if (typeof imported.default !== "function") throw new Error("server.mjs must export default function register(api)");
      await imported.default(api);
    }
    // What module.json says must be what server.mjs does: a page nobody feeds is a bug found at start.
    const declared = new Set(manifest.tools.map((t) => t.name));
    for (const name of mod.tools.keys()) if (!declared.has(name)) throw new Error(`tool «${name}» is registered but not declared in module.json`);
    for (const name of declared) if (!mod.tools.has(name)) throw new Error(`tool «${name}» is declared but server.mjs does not register it`);
    for (const page of manifest.pages.filter((p) => p.kind === "list")) {
      if (!mod.sources.has(page.source)) throw new Error(`page «${page.id}» reads source «${page.source}» which server.mjs does not register`);
      for (const action of page.actions) if (!mod.actions.has(action.id)) throw new Error(`page «${page.id}» has action «${action.id}» which server.mjs does not register`);
    }
    return mod;
  }

  const fullName = (mod, name) => `${toolPrefix(mod.manifest.id)}_${name}`;
  const toolIndex = () => {
    const map = new Map();
    for (const mod of loaded.values()) for (const t of mod.manifest.tools) map.set(fullName(mod, t.name), { mod, spec: t });
    return map;
  };

  // --- the marketplace: what is on, what switching would do, and doing it ---------------------------

  // A module's own settings (module.json config), as the owner set them in the marketplace.
  const ownConfig = (id) => store.getKv(`mod:${id}:config`) || {};
  function setOwnConfig(id, patch) {
    const m = manifests.get(id);
    const next = { ...ownConfig(id) };
    for (const [key, value] of Object.entries(patch || {})) {
      if (!m.config.some((c) => c.key === key)) throw Object.assign(new Error(`«${key}» is not a setting of module ${id}`), { code: "invalid" });
      const text = value == null ? "" : String(value).trim().slice(0, 2000);
      if (text) next[key] = text;
      else delete next[key];
    }
    store.setKv(`mod:${id}:config`, next);
    return next;
  }
  // Which core settings are a module's (shown on its card, not in Settings → پیکربندی): what it lists
  // under settings.config and what it stands for (its `sets`, written by switching). MODULES itself is
  // the marketplace's.
  function configOwners() {
    const owners = { MODULES: ["*"] };
    for (const m of manifests.values()) for (const key of [...m.settings.config, ...Object.keys(m.sets)]) owners[key] = [...new Set([...(owners[key] || []), m.id])];
    return owners;
  }
  const ownSettings = (m) => {
    const values = ownConfig(m.id);
    return m.config.map((c) => ({ key: c.key, description: c.description, default: c.default, value: values[c.key] ?? "", effective: env(`MOD_${toolPrefix(m.id).toUpperCase()}_${c.key}`, "") }));
  };

  const folderName = (m) => `ماژول ${m.title}`;
  const parkedKey = (id) => `mod:${id}:parked`;

  // A module switched off leaves its chats where the owner can still find them: a folder among the
  // ordinary chats, named after the module. Where each chat was is remembered, so switching the module
  // on again puts them back. Nothing is deleted (neither chats nor the module's own tables).
  function parkChats(m) {
    const chats = store.listModuleChats(m.id);
    if (!chats.length) return { moved: 0 };
    const name = folderName(m);
    const group = store.listGroups().find((g) => g.name === name) || store.createGroup(name);
    const parked = store.getKv(parkedKey(m.id)) || [];
    let moved = 0;
    for (const chat of chats) {
      if (chat.group_id === group.id) continue;
      if (!parked.some((e) => e.chatId === chat.id)) parked.push({ chatId: chat.id, prev: chat.group_id || null });
      store.updateChat(chat.id, { groupId: group.id });
      moved += 1;
    }
    store.setKv(parkedKey(m.id), parked);
    store.setKv(`mod:${m.id}:folder`, group.id);
    return { moved, folder: name };
  }

  function restoreChats(m) {
    const parked = store.getKv(parkedKey(m.id)) || [];
    const folder = store.getKv(`mod:${m.id}:folder`);
    if (!parked.length || !folder) return { restored: 0 };
    let restored = 0;
    for (const { chatId, prev } of parked) {
      const chat = store.getChat(chatId);
      // Only a chat still in the module's folder goes back: one the owner moved elsewhere stays there.
      if (!chat || chat.group_id !== folder) continue;
      store.updateChat(chatId, { groupId: prev && store.getGroup(prev) ? prev : null });
      restored += 1;
    }
    store.deleteKv(parkedKey(m.id));
    store.deleteKv(`mod:${m.id}:folder`);
    // The folder was made for this module: gone when empty, kept when the owner put something in it.
    if (store.getGroup(folder) && !hasChatsIn(folder)) store.deleteGroup(folder);
    return { restored };
  }
  const hasChatsIn = (groupId) => store.db.prepare("SELECT 1 FROM chats WHERE group_id = ? LIMIT 1").get(String(groupId)) != null;

  const drift = (m) => {
    if (!on.has(m.id) || !Object.keys(m.sets).length) return null;
    // An unset setting is its own default, which is the preset module's value: not a disagreement.
    const off = Object.entries(m.sets).filter(([k, v]) => String(getConfig(k) ?? "") !== "" && String(getConfig(k)) !== v);
    return off.length ? off.map(([k, v]) => `${k} باید «${v}» باشد ولی «${getConfig(k) || "—"}» است`).join("؛ ") : null;
  };

  /** Every installed module as the marketplace shows it. */
  function market() {
    const rows = [...manifests.values()].map((m) => ({
      id: m.id,
      title: m.title,
      description: m.description,
      maintainer: m.maintainer,
      version: m.version,
      builtin: m.builtin,
      enabled: on.has(m.id),
      ok: !failed.has(m.id),
      error: failed.get(m.id) || null,
      preset: presetIds.includes(m.id),
      provides: m.provides,
      conflicts: m.conflicts,
      requires: m.requires.modules,
      requiredBy: [...manifests.values()].filter((o) => o.requires.modules.includes(m.id)).map((o) => o.id),
      adds: { agents: m.agents.map((a) => a.label), tools: m.tools.length, pages: m.pages.map((pg) => pg.title) },
      chats: store.listModuleChats(m.id).length,
      switchNote: m.switchNote || "",
      drift: drift(m),
      category: m.category,
      icon: m.icon,
      choice: m.choice,
      // Its settings, shown on its card: core config keys, per-user UI flags, its own config, and its
      // pages, by the id the web's menu hides them with (a builtin section's is the module id; the web
      // keeps only those that really are menu entries).
      settings: { config: m.settings.config, flags: m.settings.flags, own: ownSettings(m) },
      nav: m.pages.map((pg) => ({ id: pg.kind === "builtin" ? m.id : `m:${m.id}:${pg.id}`, title: pg.title, builtin: pg.kind === "builtin" })),
    }));
    for (const [id, error] of broken) rows.push({ id, title: id, description: "", version: "", builtin: false, enabled: false, ok: false, error, preset: false, provides: [], conflicts: [], requires: [], requiredBy: [], adds: { agents: [], tools: 0, pages: [] }, chats: 0, switchNote: "", drift: null, category: "other", icon: "puzzle", choice: "", settings: { config: [], flags: [], own: [] }, nav: [] });
    return rows.sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.title.localeCompare(b.title, "fa"));
  }

  /** What switching would do, for the owner to read first. Changes nothing. */
  function plan(id, enable) {
    const m = manifests.get(id);
    const base = planSwitch(manifests, on, id, Boolean(enable));
    const title = (x) => manifests.get(x)?.title || x;
    const steps = [];
    for (const x of base.disable) {
      const n = store.listModuleChats(x).length;
      steps.push({ kind: "disable", id: x, title: title(x), why: base.reasons[x], chats: n, folder: n ? folderName(manifests.get(x)) : null });
    }
    for (const x of base.enable) {
      const parked = (store.getKv(parkedKey(x)) || []).length;
      steps.push({ kind: "enable", id: x, title: title(x), why: base.reasons[x], restores: parked });
    }
    const config = {};
    for (const x of base.enable) Object.assign(config, manifests.get(x).sets);
    // Enabling a module already on whose live setting drifted just puts the setting right.
    if (m && enable && on.has(id) && drift(m)) {
      Object.assign(config, m.sets);
      steps.push({ kind: "fix", id, title: title(id), why: drift(m) });
    }
    // A module's switchNote describes what happens when it comes ON; turning one off is risky too
    // (it has something live behind it) but its note would say the opposite.
    const touched = [...base.enable, ...base.disable].map((x) => manifests.get(x)).filter(Boolean);
    const notes = base.enable.map((x) => manifests.get(x)?.switchNote).filter(Boolean);
    const risky = touched.some((x) => x.switchNote);
    return { ...base, steps, config, notes, risky, empty: !base.blocked && !steps.length };
  }

  /**
   * Do it: modules off first (their chats go to a folder), then on (their chats come back), then the
   * settings they stand for. A module that fails to load stays off and says why; the rest still apply.
   * A plan with notes (it touches something live) needs confirm: true.
   */
  async function apply(id, enable, { confirm = false } = {}) {
    const p = plan(id, enable);
    if (p.blocked) throw Object.assign(new Error(p.blocked), { code: "blocked" });
    if (p.risky && !confirm) throw Object.assign(new Error("این تغییر به چیزی زنده دست می‌زند؛ باید تأیید شود"), { code: "confirm", plan: p });
    const result = { disabled: [], enabled: [], moved: {}, restored: {}, failed: {} };
    const next = { ...overrides() };
    for (const x of p.disable) {
      const m = manifests.get(x);
      loaded.delete(x);
      failed.delete(x);
      on.delete(x);
      next[x] = false;
      result.disabled.push(x);
      const parked = parkChats(m);
      if (parked.moved) result.moved[x] = parked;
    }
    for (const x of p.enable) {
      const m = manifests.get(x);
      on.add(x);
      next[x] = true;
      try {
        loaded.set(x, await load(m));
        failed.delete(x);
        result.enabled.push(x);
        const back = restoreChats(m);
        if (back.restored) result.restored[x] = back.restored;
      } catch (error) {
        // It did not start: keep it off and keep what it would have replaced off too, so the owner sees the real state.
        on.delete(x);
        next[x] = false;
        failed.set(x, error.message);
        result.failed[x] = error.message;
        log.error?.(`[modules] ${x} not loaded: ${error.message}`);
      }
    }
    store.setKv("modules:overrides", next);
    if (Object.keys(p.config).length && !Object.keys(result.failed).length) setConfig(p.config);
    host.seedAgents();
    onChange();
    return { ...result, plan: p };
  }

  const host = {
    market,
    plan,
    apply,
    status: statusList,
    configOwners,
    ids: () => [...loaded.keys()],
    /** The enabled modules as the web needs them (pages and what they read), without any code. */
    list: () => [...loaded.values()].map(({ manifest: m }) => ({ id: m.id, title: m.title, description: m.description, version: m.version, builtin: m.builtin, pages: m.pages, agents: m.agents.map((a) => a.id) })),
    toolNames: () => [...toolIndex().keys()],

    /** customTools for a chat: namespaced, so two modules can never shadow each other or the core. */
    customTools(chatId) {
      const tools = {};
      for (const [name, { mod, spec }] of toolIndex()) {
        const def = mod.tools.get(spec.name);
        tools[name] = {
          description: def.description || spec.description || name,
          inputSchema: def.inputSchema || { type: "object", properties: {}, additionalProperties: false },
          async execute(args) {
            try {
              return ok(await def.execute(args ?? {}, { chatId }));
            } catch (error) {
              return fail(error);
            }
          },
        };
      }
      return tools;
    },

    /** guard.mjs verdictOf: a module's write tool asks the owner first; null = no opinion (the core decides). */
    verdictOf(name) {
      const hit = toolIndex().get(name);
      return hit?.spec.risk === "write" ? { approve: `«${hit.spec.description || name}» (ماژول ${hit.mod.manifest.title})` } : null;
    },

    /**
     * Each module's agents, as ordinary agent rows. Made when missing, never overwritten: from then on
     * they are the owner's to edit like any agent (a new module version does not undo that).
     */
    seedAgents({ catalogNames = [] } = {}) {
      const known = new Set([...catalogNames, ...this.toolNames()]);
      const made = [];
      for (const { manifest } of loaded.values()) {
        for (const a of manifest.agents) {
          if (store.getAgentProfile(a.id)) continue;
          const tools = a.tools.map((t) => (toolIndex().has(`${toolPrefix(manifest.id)}_${t}`) ? `${toolPrefix(manifest.id)}_${t}` : t));
          const missing = tools.filter((t) => catalogNames.length && !known.has(t) && !manifest.requires.tools.includes(t));
          if (missing.length) log.error?.(`[modules] ${manifest.id}: agent ${a.id} lists unknown tools: ${missing.join(", ")}`);
          store.upsertAgentProfile({
            id: a.id,
            label: a.label,
            domain: a.domain,
            blurb: a.blurb,
            provider: defaultProvider,
            tools,
            meta: { module: manifest.id, instructions: a.instructions, callers: customCallers(tools) },
            builtIn: false,
          });
          made.push(a.id);
        }
      }
      return made;
    },

    /** /api/modules for the owner's session (the router that mounts it is the owner-only one). */
    routes(api) {
      api.get("/api/modules", (c) => c.json({ modules: this.list(), status: statusList(), installed: manifests.size }));
      // The marketplace: every installed module, what switching one would do, and doing it.
      api.get("/api/modules/market", (c) => c.json({ modules: market() }));
      // A module's own settings (module.json config), from its card in the marketplace.
      api.patch("/api/modules/:id/config", async (c) => {
        const id = c.req.param("id");
        if (!manifests.has(id)) return c.json({ error: "not found" }, 404);
        const body = await c.req.json().catch(() => ({}));
        try {
          setOwnConfig(id, body && typeof body === "object" ? body : {});
          return c.json({ settings: ownSettings(manifests.get(id)) });
        } catch (error) {
          return c.json({ error: error.message }, 400);
        }
      });
      api.post("/api/modules/:id/plan", async (c) => {
        const body = await c.req.json().catch(() => ({}));
        if (!manifests.has(c.req.param("id"))) return c.json({ error: "not found" }, 404);
        return c.json({ plan: plan(c.req.param("id"), body?.enable !== false) });
      });
      api.post("/api/modules/:id/switch", async (c) => {
        const body = await c.req.json().catch(() => ({}));
        if (!manifests.has(c.req.param("id"))) return c.json({ error: "not found" }, 404);
        try {
          return c.json(await apply(c.req.param("id"), body?.enable !== false, { confirm: body?.confirm === true }));
        } catch (error) {
          return c.json({ error: error.message, code: error.code || "failed", plan: error.plan }, error.code === "confirm" ? 409 : 400);
        }
      });
      api.get("/api/modules/:id/pages/:page/data", async (c) => {
        const mod = loaded.get(c.req.param("id"));
        const page = mod?.manifest.pages.find((p) => p.id === c.req.param("page") && p.kind === "list");
        if (!page) return c.json({ error: "not found" }, 404);
        const query = Object.fromEntries(new URL(c.req.url).searchParams);
        try {
          // A source answers rows, or { rows, meta } when the page has more to say (why the list is empty).
          const out = await mod.sources.get(page.source)(query, {});
          return c.json(Array.isArray(out) ? { rows: out } : { rows: Array.isArray(out?.rows) ? out.rows : [], meta: out?.meta ?? null });
        } catch (error) {
          return c.json({ error: String(error.message || error).slice(0, 300) }, 502);
        }
      });
      api.post("/api/modules/:id/actions/:action", async (c) => {
        const mod = loaded.get(c.req.param("id"));
        const fn = mod?.actions.get(c.req.param("action"));
        if (!fn) return c.json({ error: "not found" }, 404);
        const body = await c.req.json().catch(() => ({}));
        try {
          return c.json(await fn(body && typeof body === "object" ? body : {}, {}));
        } catch (error) {
          return c.json({ error: String(error.message || error).slice(0, 300) }, 400);
        }
      });
    },
  };
  return host;
}
