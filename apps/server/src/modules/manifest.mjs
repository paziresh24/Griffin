// The manifest of a module (modules/<id>/module.json). Pure validation: no file, no network, so the
// host and the tests share it. A module says WHAT it adds here; the code that does it is server.mjs.
// See docs/modules.md.

export const MODULE_ID = /^[a-z][a-z0-9-]{1,31}$/;
const NAME = /^[a-z][a-z0-9_]{0,40}$/;
// list: drawn by the generic ModulePage from the module's source. builtin: a section whose screen is
// code in the core web app (telegram, jobs, …); the module only says it exists and may be switched off.
const PAGE_KINDS = new Set(["list", "builtin"]);
const PRODUCTS = new Set(["griffin", "karsara"]);
const FIELD_TYPES = new Set(["text", "badge", "time", "link"]);
const RISKS = new Set(["read", "write"]);
const SLOT = /^[a-z][a-z0-9-]{1,40}$/;
// The marketplace's shelves (their names and order are the web's, modules.js MARKET_SHELVES).
const CATEGORIES = new Set(["team", "support", "ops", "dev", "tools", "other"]);

const fail = (id, message) => Object.assign(new Error(`module ${id}: ${message}`), { code: "invalid" });
const str = (value, max) => (typeof value === "string" ? value.trim().slice(0, max) : "");

/** An id usable as a tool-name prefix: `mr-explainer` -> `mr_explainer`. */
export const toolPrefix = (id) => id.replace(/-/g, "_");

/**
 * @param raw the parsed module.json
 * @param dirName the folder it was read from: the id must match it, so two modules never share one
 * @returns the manifest, normalised. Throws Error{code:"invalid"} with a message fit to log.
 */
export function parseManifest(raw, dirName) {
  const id = str(raw?.id, 40);
  if (!MODULE_ID.test(id)) throw fail(dirName, `id «${id}» is not a-z, 0-9 and dashes (2-32)`);
  if (id !== dirName) throw fail(id, `id must equal its folder name «${dirName}»`);
  const title = str(raw.title, 80);
  if (!title) throw fail(id, "title is required");

  const requires = {
    tools: Array.isArray(raw.requires?.tools) ? raw.requires.tools.map(String) : [],
    // Other modules that must be on for this one to work (the marketplace switches them on with it).
    modules: Array.isArray(raw.requires?.modules) ? raw.requires.modules.map(String) : [],
    // The owner's MCP servers (Settings → MCP servers) whose address and headers this module may read
    // on the server, e.g. a personal API key it calls a service with. Never sent to the browser.
    mcp: Array.isArray(raw.requires?.mcp) ? raw.requires.mcp.map(String) : [],
    // true = the module may ask the install's small model one question at a time (api.complete): a
    // summary, a label. The text it sends leaves the server like a chat's does, so it says so here.
    ai: raw.requires?.ai === true,
  };
  const badMcp = requires.mcp.find((n) => !/^[\w.-]{1,64}$/.test(n));
  if (badMcp) throw fail(id, `requires.mcp «${badMcp}» is not a server name`);
  const badRequired = requires.modules.find((m) => !MODULE_ID.test(m) || m === id);
  if (badRequired) throw fail(id, `requires.modules «${badRequired}» is not another module id`);

  // Slots this module fills (a slot has one provider at a time: two modules that provide the same
  // slot are alternatives and the marketplace switches between them) and modules it cannot share an
  // install with for any other reason.
  const provides = (Array.isArray(raw.provides) ? raw.provides : []).map(String);
  const badSlot = provides.find((x) => !SLOT.test(x));
  if (badSlot) throw fail(id, `provides «${badSlot}» must be a-z, 0-9, dashes`);
  const conflicts = (Array.isArray(raw.conflicts) ? raw.conflicts : []).map(String);
  const badConflict = conflicts.find((m) => !MODULE_ID.test(m) || m === id);
  if (badConflict) throw fail(id, `conflicts «${badConflict}» is not another module id`);
  // Config the module's switch-on writes (the marketplace applies it): e.g. a Telegram variant is
  // the value of TELEGRAM_DM_MODE. At start the module whose values match the live config is the one on.
  const sets = {};
  for (const [key, value] of Object.entries(raw.sets && typeof raw.sets === "object" ? raw.sets : {})) {
    if (!/^[A-Z][A-Z0-9_]{1,39}$/.test(key)) throw fail(id, `sets key «${key}» must be UPPER_SNAKE`);
    sets[key] = String(value);
  }
  // A risky switch (it touches something live: an account, a webhook) must be confirmed by the owner.
  const risk = str(raw.switchNote, 400);

  const agents = (Array.isArray(raw.agents) ? raw.agents : []).map((a) => {
    const agentId = str(a?.id, 40);
    if (agentId !== id && !agentId.startsWith(`${id}-`)) throw fail(id, `agent id «${agentId}» must be «${id}» or start with «${id}-»`);
    if (!str(a.label, 60) || !str(a.domain, 500)) throw fail(id, `agent «${agentId}» needs a label and a domain`);
    const tools = (Array.isArray(a.tools) ? a.tools : []).map(String);
    return { id: agentId, label: str(a.label, 60), domain: str(a.domain, 500), blurb: str(a.blurb, 500), instructions: str(a.instructions, 6000), tools };
  });

  const tools = (Array.isArray(raw.tools) ? raw.tools : []).map((t) => {
    const name = str(t?.name, 41);
    if (!NAME.test(name)) throw fail(id, `tool name «${name}» is not a-z, 0-9 and underscores`);
    const risk = t.risk ?? "read";
    if (!RISKS.has(risk)) throw fail(id, `tool «${name}» risk must be read or write`);
    return { name, risk, description: str(t.description, 400) };
  });
  const toolNames = tools.map((t) => t.name);
  if (new Set(toolNames).size !== toolNames.length) throw fail(id, "two tools share a name");

  const pages = (Array.isArray(raw.pages) ? raw.pages : []).map((p) => {
    const pageId = str(p?.id, 40);
    if (!NAME.test(pageId.replace(/-/g, "_"))) throw fail(id, `page id «${pageId}» is not a-z, 0-9, dashes`);
    if (!PAGE_KINDS.has(p.kind)) throw fail(id, `page «${pageId}» kind must be one of: ${[...PAGE_KINDS].join(", ")}`);
    if (!str(p.title, 60)) throw fail(id, `page «${pageId}» needs a title`);
    if (p.kind === "builtin") {
      if (!/^\/[a-z0-9-]{1,40}$/.test(str(p.route, 41))) throw fail(id, `page «${pageId}» needs a route like /telegram`);
      return { id: pageId, title: str(p.title, 60), icon: str(p.icon, 30) || "puzzle", kind: "builtin", route: p.route, fields: [], actions: [], filters: [], groupBy: null, search: false };
    }
    if (!NAME.test(str(p.source, 40))) throw fail(id, `page «${pageId}» needs a source`);
    const fields = (Array.isArray(p.fields) ? p.fields : []).map((f) => {
      const type = f.type ?? "text";
      if (!FIELD_TYPES.has(type)) throw fail(id, `page «${pageId}» field type «${type}» is unknown`);
      return { key: str(f.key, 40), label: str(f.label, 60), type, primary: Boolean(f.primary) };
    });
    if (!fields.length) throw fail(id, `page «${pageId}» needs fields`);
    const actions = (Array.isArray(p.actions) ? p.actions : []).map((a) => {
      if (!NAME.test(str(a?.id, 40))) throw fail(id, `page «${pageId}» action id is not a-z, 0-9, underscores`);
      return { id: a.id, label: str(a.label, 40) || a.id };
    });
    const filters = (Array.isArray(p.filters) ? p.filters : []).map((f) => ({
      key: str(f.key, 40),
      label: str(f.label, 60),
      type: f.type === "select" ? "select" : "text",
      options: f.type === "select" ? (Array.isArray(f.options) ? f.options.map((o) => (o && typeof o === "object" ? { value: str(o.value, 60), label: str(o.label, 60) || str(o.value, 60) } : String(o))) : []) : undefined,
      default: typeof f.default === "string" ? f.default : "",
    }));
    // Optional: rows sit on named shelves (a field of the row says which), shown with counts.
    const groupBy = p.groupBy && NAME.test(str(p.groupBy.field, 40)) && Array.isArray(p.groupBy.groups)
      ? { field: p.groupBy.field, groups: p.groupBy.groups.filter((g) => str(g?.key, 40)).map((g) => ({ key: str(g.key, 40), label: str(g.label, 60) || str(g.key, 40), tone: ["ok", "warn", "bad", "info", "muted"].includes(g.tone) ? g.tone : "muted", hint: str(g.hint, 120) })) }
      : null;
    // Optional: the module's own screen for these rows (modules/<id>/web/<view>.jsx, built into the
    // web). The rows, actions and guards stay the list's; a build without the file shows the list.
    const view = p.view === undefined ? "" : str(p.view, 40);
    if (view && !NAME.test(view.replace(/-/g, "_"))) throw fail(id, `page «${pageId}» view «${view}» is not a-z, 0-9, dashes`);
    return { id: pageId, title: str(p.title, 60), icon: str(p.icon, 30) || "puzzle", kind: p.kind, source: p.source, fields, actions, filters, groupBy, search: Boolean(p.search), view };
  });
  const pageIds = pages.map((p) => p.id);
  if (new Set(pageIds).size !== pageIds.length) throw fail(id, "two pages share an id");

  const config = (Array.isArray(raw.config) ? raw.config : []).map((c) => {
    const key = str(c?.key, 40);
    if (!/^[A-Z][A-Z0-9_]{1,39}$/.test(key)) throw fail(id, `config key «${key}» must be UPPER_SNAKE`);
    return { key, description: str(c.description, 200), default: typeof c.default === "string" ? c.default : "" };
  });

  // Which products switch it on when MODULES is empty (the install's preset): none = off until asked.
  const presets = (Array.isArray(raw.presets) ? raw.presets : []).map(String);
  const badPreset = presets.find((x) => !PRODUCTS.has(x));
  if (badPreset) throw fail(id, `preset «${badPreset}» is not one of: ${[...PRODUCTS].join(", ")}`);
  const builtin = raw.builtin === true;
  if (builtin && (agents.length || tools.length)) throw fail(id, "a builtin module has no agents or tools of its own");

  // For the marketplace only: which shelf it sits on, its icon (else its first page's), and — for
  // modules that fill the same slot — the question the owner answers by picking one of them.
  const category = CATEGORIES.has(raw.category) ? raw.category : "other";
  const icon = str(raw.icon, 30) || pages[0]?.icon || "puzzle";
  const choice = provides.length ? str(raw.choice, 160) : "";

  // Core settings that belong to this module (owner 2026-10-20: «تنظیماتش یکپارچه بشه»): the
  // marketplace shows them on the module's card, and Settings → پیکربندی/ظاهر no longer does.
  // config = keys of the core config (config.mjs), flags = keys of the per-user UI flags (ui-prefs.js).
  const owned = raw.settings && typeof raw.settings === "object" ? raw.settings : {};
  const settings = {
    config: (Array.isArray(owned.config) ? owned.config : []).map(String),
    flags: (Array.isArray(owned.flags) ? owned.flags : []).map(String),
  };
  const badOwned = settings.config.find((k) => !/^[A-Z][A-Z0-9_]{1,39}$/.test(k));
  if (badOwned) throw fail(id, `settings.config «${badOwned}» must be UPPER_SNAKE`);
  const badFlag = settings.flags.find((k) => !/^[a-z][A-Za-z0-9]{1,39}$/.test(k));
  if (badFlag) throw fail(id, `settings.flags «${badFlag}» must be camelCase`);

  return { id, version: str(raw.version, 20) || "0.0.0", title, description: str(raw.description, 400), maintainer: str(raw.maintainer, 80), builtin, presets, requires, provides, conflicts, sets, switchNote: risk, agents, tools, pages, config, settings, category, icon, choice };
}
