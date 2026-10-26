import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { openStore } from "../src/db.mjs";
import { parseManifest } from "../src/modules/manifest.mjs";
import { createModuleHost, enabledSet, listModuleDirs } from "../src/modules/host.mjs";

const quiet = { log() {}, error() {} };
const REAL = fileURLToPath(new URL("../../../modules", import.meta.url));

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "modules-"));
}
function put(dir, id, manifest, code) {
  fs.mkdirSync(path.join(dir, id), { recursive: true });
  fs.writeFileSync(path.join(dir, id, "module.json"), JSON.stringify({ id, title: id, ...manifest }));
  if (code) fs.writeFileSync(path.join(dir, id, "server.mjs"), code);
}
const store = () => openStore(path.join(tmp(), "t.sqlite"));

test("the manifest: id equals the folder, agents and tools are namespaced", () => {
  assert.equal(parseManifest({ id: "tix", title: "T" }, "tix").id, "tix");
  assert.throws(() => parseManifest({ id: "tix", title: "T" }, "other"), /equal its folder/);
  assert.throws(() => parseManifest({ id: "Tix", title: "T" }, "Tix"), /not a-z/);
  assert.throws(() => parseManifest({ id: "tix", title: "T", agents: [{ id: "bot", label: "b", domain: "d" }] }, "tix"), /must be «tix»/);
  assert.equal(parseManifest({ id: "tix", title: "T", agents: [{ id: "tix-triage", label: "b", domain: "d" }] }, "tix").agents[0].id, "tix-triage");
  assert.throws(() => parseManifest({ id: "tix", title: "T", tools: [{ name: "Bad-Name" }] }, "tix"), /tool name/);
  assert.throws(() => parseManifest({ id: "tix", title: "T", tools: [{ name: "a", risk: "root" }] }, "tix"), /risk/);
  assert.throws(() => parseManifest({ id: "tix", title: "T", pages: [{ id: "p", title: "P", kind: "iframe", source: "s", fields: [{ key: "a" }] }] }, "tix"), /kind/);
  // A list page may name its own screen (modules/<id>/web/<view>.jsx); a name that is not a file name is refused.
  const page = (view) => ({ id: "tix", title: "T", pages: [{ id: "p", title: "P", kind: "list", source: "s", fields: [{ key: "a" }], view }] });
  assert.equal(parseManifest(page("board"), "tix").pages[0].view, "board");
  assert.equal(parseManifest(page(undefined), "tix").pages[0].view, "");
  assert.throws(() => parseManifest(page("../x"), "tix"), /view/);
  // The marketplace's shelf and icon: an unknown shelf is «other», the icon falls back to the first page's.
  assert.equal(parseManifest({ ...page("board"), category: "dev" }, "tix").category, "dev");
  assert.equal(parseManifest({ ...page("board"), category: "games" }, "tix").category, "other");
  assert.equal(parseManifest(page("board"), "tix").icon, "puzzle");
  assert.equal(parseManifest({ id: "tix", title: "T", choice: "کدام؟" }, "tix").choice, "", "a choice only means something for a module that fills a slot");
});

test("which modules are on: the preset when empty, all, an exact list, or the preset edited", () => {
  const ids = ["a", "b", "c"];
  assert.deepEqual([...enabledSet("", ids, ["a", "b"])], ["a", "b"]);
  assert.deepEqual([...enabledSet("", ids)], []);
  assert.deepEqual([...enabledSet("default", ids, ["a"])], ["a"]);
  assert.deepEqual([...enabledSet("all", ids, ["a"])], ["a", "b", "c"]);
  assert.deepEqual([...enabledSet("a, c", ids, ["b"])], ["a", "c"]);
  assert.deepEqual([...enabledSet("default,-a,+c", ids, ["a", "b"])].sort(), ["b", "c"]);
});

test("builtin modules: a core section that can be switched off, with the product presets", async () => {
  const dir = tmp();
  put(dir, "telegram", { builtin: true, presets: ["griffin", "karsara"], pages: [{ id: "main", title: "تلگرام", icon: "message-circle", kind: "builtin", route: "/telegram" }] });
  put(dir, "helpdesk", { presets: ["karsara"] }, "export default () => {}");
  assert.throws(() => parseManifest({ id: "xx", title: "xx", builtin: true, tools: [{ name: "t" }] }, "xx"), /no agents or tools/);
  assert.throws(() => parseManifest({ id: "xx", title: "xx", pages: [{ id: "mm", title: "mm", kind: "builtin", route: "telegram" }] }, "xx"), /route/);
  assert.throws(() => parseManifest({ id: "xx", title: "xx", presets: ["nope"] }, "xx"), /preset/);
  const griffin = await createModuleHost({ dir, store: store(), enabled: "", product: "griffin", log: quiet });
  assert.deepEqual(griffin.ids(), ["telegram"]);
  assert.equal(griffin.list()[0].builtin, true);
  assert.equal(griffin.list()[0].pages[0].route, "/telegram");
  const karsara = await createModuleHost({ dir, store: store(), enabled: "", product: "karsara", log: quiet });
  assert.deepEqual(karsara.ids().sort(), ["helpdesk", "telegram"]);
  const edited = await createModuleHost({ dir, store: store(), enabled: "default,-telegram", product: "karsara", log: quiet });
  assert.deepEqual(edited.ids(), ["helpdesk"]);
});

test("the real builtin sections and the first module parse, and Griffin's preset has them all", async () => {
  const host = await createModuleHost({ dir: REAL, store: store(), enabled: "", product: "griffin", log: quiet });
  assert.deepEqual(host.ids().sort(), ["incidents", "jobs", "peers", "telegram", "workbench"]);
  assert.ok(host.status().every((s) => s.ok));
  const karsara = await createModuleHost({ dir: REAL, store: store(), enabled: "", product: "karsara", log: quiet });
  assert.deepEqual(karsara.ids().sort(), ["incidents", "jobs", "peers", "telegram", "workbench"]);
});

test("a module that is not switched on is listed but never run", async () => {
  const dir = tmp();
  put(dir, "tix", {}, 'throw new Error("must not be imported");');
  const host = await createModuleHost({ dir, store: store(), enabled: "", log: quiet });
  assert.deepEqual(host.ids(), []);
  assert.deepEqual(host.status(), [{ id: "tix", title: "tix", enabled: false, ok: true }]);
  assert.deepEqual(listModuleDirs(dir), ["tix"]);
});

test("a broken module is reported and skipped, the others load", async () => {
  const dir = tmp();
  put(dir, "good", {}, "export default function register() {}");
  put(dir, "bad", {}, 'export default function register() { throw new Error("boom"); }');
  put(dir, "nofn", {}, "export const x = 1;");
  const host = await createModuleHost({ dir, store: store(), enabled: "all", log: quiet });
  assert.deepEqual(host.ids(), ["good"]);
  const bad = host.status().find((s) => s.id === "bad");
  assert.equal(bad.ok, false);
  assert.match(bad.error, /boom/);
  assert.match(host.status().find((s) => s.id === "nofn").error, /default function/);
});

test("module.json and server.mjs must agree", async () => {
  const dir = tmp();
  put(dir, "extra", { tools: [] }, 'export default (api) => api.tool("sneak", { execute() {} });');
  put(dir, "missing", { tools: [{ name: "t" }] }, "export default () => {}");
  put(dir, "nosource", { pages: [{ id: "p", title: "P", kind: "list", source: "rows", fields: [{ key: "a" }] }] }, "export default () => {}");
  put(dir, "noaction", { pages: [{ id: "p", title: "P", kind: "list", source: "rows", fields: [{ key: "a" }], actions: [{ id: "go" }] }] }, 'export default (api) => api.source("rows", () => []);');
  const host = await createModuleHost({ dir, store: store(), enabled: "all", log: quiet });
  assert.deepEqual(host.ids(), []);
  const err = (id) => host.status().find((s) => s.id === id).error;
  assert.match(err("extra"), /not declared/);
  assert.match(err("missing"), /does not register/);
  assert.match(err("nosource"), /source «rows»/);
  assert.match(err("noaction"), /action «go»/);
});

test("tools are namespaced, run with the chat, and a failure is an error result, not a crash", async () => {
  const dir = tmp();
  put(dir, "tix-desk", { tools: [{ name: "count", description: "count" }, { name: "boom" }] }, `
    export default (api) => {
      api.tool("count", { inputSchema: { type: "object", properties: {} }, execute: (args, ctx) => ({ chat: ctx.chatId, n: 2 }) });
      api.tool("boom", { execute() { throw new Error("nope"); } });
    };`);
  const host = await createModuleHost({ dir, store: store(), enabled: "all", log: quiet });
  assert.deepEqual(host.toolNames().sort(), ["tix_desk_boom", "tix_desk_count"]);
  const tools = host.customTools("chat-1");
  assert.deepEqual(JSON.parse((await tools.tix_desk_count.execute({})).content[0].text), { chat: "chat-1", n: 2 });
  const failed = await tools.tix_desk_boom.execute({});
  assert.equal(failed.isError, true);
  assert.match(failed.content[0].text, /nope/);
});

test("a write tool asks the owner first (verdict for the approval guard); a read tool has no opinion", async () => {
  const dir = tmp();
  put(dir, "tix", { tools: [{ name: "close", risk: "write", description: "بستن درخواست" }, { name: "look" }] }, 'export default (api) => { api.tool("close", { execute() {} }); api.tool("look", { execute() {} }); };');
  const host = await createModuleHost({ dir, store: store(), enabled: "all", log: quiet });
  assert.match(host.verdictOf("tix_close").approve, /بستن درخواست/);
  assert.equal(host.verdictOf("tix_look"), null);
  assert.equal(host.verdictOf("kube_get"), null);
});

test("a module may call only the tools it listed", async () => {
  const dir = tmp();
  put(dir, "tix", { requires: { tools: ["gitlab_mrs"] }, tools: [{ name: "t" }] }, `
    export default (api) => api.tool("t", { async execute({ name }) { return api.call(name, {}); } });`);
  const calls = [];
  const host = await createModuleHost({ dir, store: store(), enabled: "all", callTool: async (name) => (calls.push(name), { ok: 1 }), log: quiet });
  const run = async (name) => JSON.parse((await host.customTools("c").tix_t.execute({ name })).content[0].text);
  assert.deepEqual(await run("gitlab_mrs"), { ok: 1 });
  assert.match((await run("pg_query")).error, /not in requires/);
  assert.deepEqual(calls, ["gitlab_mrs"]);
});

test("its agents are made once, as ordinary rows the owner may edit", async () => {
  const dir = tmp();
  put(dir, "tix", { agents: [{ id: "tix", label: "درخواست", domain: "تریاژ", instructions: "do it", tools: ["count", "ask_owner"] }], tools: [{ name: "count" }] }, 'export default (api) => api.tool("count", { execute() {} });');
  const s = store();
  const host = await createModuleHost({ dir, store: s, enabled: "all", log: quiet });
  assert.deepEqual(host.seedAgents(), ["tix"]);
  const row = s.getAgentProfile("tix");
  assert.equal(row.label, "درخواست");
  assert.deepEqual(row.tools, ["tix_count", "ask_owner"]);
  assert.equal(row.meta.module, "tix");
  assert.equal(row.meta.callers.owner.tools, "*");
  s.upsertAgentProfile({ ...row, label: "ویرایش‌شده", meta: row.meta, tools: row.tools });
  assert.deepEqual(host.seedAgents(), []);
  assert.equal(s.getAgentProfile("tix").label, "ویرایش‌شده");
});

test("a module's tables are its own: only CREATE … IF NOT EXISTS on mod_<id>_*, once", async () => {
  const dir = tmp();
  put(dir, "tix", {}, `
    export default (api) => {
      api.migrate("1", "CREATE TABLE IF NOT EXISTS mod_tix_items (id INTEGER PRIMARY KEY, title TEXT); CREATE INDEX IF NOT EXISTS mod_tix_t ON mod_tix_items (title)");
      api.migrate("1", "CREATE TABLE IF NOT EXISTS mod_tix_again (id INTEGER)");
      api.db.run("INSERT INTO mod_tix_items (title) VALUES (?)", "a");
      api.kv.set("seen", api.db.all("SELECT * FROM mod_tix_items").length);
    };`);
  put(dir, "evil", {}, 'export default (api) => api.migrate("1", "DROP TABLE chats");');
  put(dir, "evil2", {}, 'export default (api) => api.migrate("1", "CREATE TABLE IF NOT EXISTS chats2 (id TEXT)");');
  const s = store();
  const host = await createModuleHost({ dir, store: s, enabled: "all", log: quiet });
  assert.deepEqual(host.ids(), ["tix"]);
  assert.equal(s.getKv("mod:tix:seen"), 1);
  assert.throws(() => s.db.prepare("SELECT 1 FROM mod_tix_again").get(), /no such table/);
  assert.match(host.status().find((x) => x.id === "evil").error, /only CREATE/);
  assert.match(host.status().find((x) => x.id === "evil2").error, /only CREATE/);
});

test("the routes: list, a page's rows with the query, an action", async () => {
  const dir = tmp();
  put(dir, "tix", {
    pages: [{ id: "all", title: "همه", kind: "list", source: "rows", fields: [{ key: "t", primary: true }], actions: [{ id: "open", label: "باز کن" }] }],
  }, `export default (api) => {
    api.source("rows", (q) => [{ id: "1", t: q.state || "none" }]);
    api.action("open", ({ row }) => { if (!row) throw new Error("no row"); return { openChat: { agent: "tix", title: "t", text: "hi " + row.id } }; });
  };`);
  const host = await createModuleHost({ dir, store: store(), enabled: "all", log: quiet });
  const app = new Hono();
  host.routes(app);
  const get = async (p, init) => (await app.request(p, init)).json();
  assert.equal((await get("/api/modules")).modules[0].pages[0].source, "rows");
  assert.deepEqual((await get("/api/modules/tix/pages/all/data?state=merged")).rows, [{ id: "1", t: "merged" }]);
  assert.deepEqual((await get("/api/modules/tix/actions/open", { method: "POST", body: JSON.stringify({ row: { id: "7" } }), headers: { "content-type": "application/json" } })).openChat.text, "hi 7");
  assert.equal((await app.request("/api/modules/tix/actions/open", { method: "POST", body: "{}" })).status, 400);
  assert.equal((await app.request("/api/modules/nope/pages/all/data")).status, 404);
  assert.equal((await app.request("/api/modules/tix/actions/missing", { method: "POST" })).status, 404);
});

test("mr-explainer (the first real module): rows, the button, the overview tool, its agent", async () => {
  const mr = { iid: 7, project: "root/griffin-private", title: "feat: x", author: "rezaei", state: "opened", draft: true, pipeline: "success", updatedAt: "2026-10-19T10:00:00Z", webUrl: "https://gl/x" };
  const calls = [];
  const callTool = async (name, args) => {
    calls.push([name, args]);
    if (name === "gitlab_mrs") return { mergeRequests: [mr] };
    if (name === "gitlab_mr") return { title: "feat: x", state: "opened", draft: true, description: "d", pipeline: { status: "success" } };
    if (name === "gitlab_mr_changes") return { fileCount: 3, files: [{ path: "apps/server/a.mjs", added: 5, removed: 1 }, { path: "apps/server/b.mjs", added: 1, removed: 0 }, { path: "docs/x.md", added: 20, removed: 0 }] };
    throw new Error(`unexpected ${name}`);
  };
  const s = store();
  const host = await createModuleHost({ dir: REAL, store: s, enabled: "mr-explainer", callTool, log: quiet });
  assert.deepEqual(host.ids(), ["mr-explainer"]);

  const app = new Hono();
  host.routes(app);
  const rows = (await (await app.request("/api/modules/mr-explainer/pages/mrs/data?state=opened&project=a/b")).json()).rows;
  assert.equal(rows[0].id, "root/griffin-private!7");
  assert.equal(rows[0].title, "feat: x");
  assert.equal(rows[0].category, "draft");
  assert.ok(calls.some(([n, a]) => n === "gitlab_mr" && a.iid === 7)); // the open MR was read once for its pipeline
  assert.deepEqual(calls[0], ["gitlab_mrs", { project: "a/b", state: "opened", limit: 50 }]);
  // «*» = every project; an author filter is passed on, a bad one refused
  await app.request("/api/modules/mr-explainer/pages/mrs/data?project=*&author=@rezaei");
  assert.deepEqual(calls.filter(([n]) => n === "gitlab_mrs").at(-1), ["gitlab_mrs", { state: "opened", limit: 50, author: "rezaei" }]);
  assert.equal((await app.request("/api/modules/mr-explainer/pages/mrs/data?author=a%20b")).status, 502);
  assert.equal((await app.request("/api/modules/mr-explainer/pages/mrs/data?project=%3Bdrop")).status, 502);

  const act = await (await app.request("/api/modules/mr-explainer/actions/explain", { method: "POST", body: JSON.stringify({ row: mr }), headers: { "content-type": "application/json" } })).json();
  assert.equal(act.openChat.agent, "mr-explainer");
  assert.match(act.openChat.text, /7/);

  const overview = JSON.parse((await host.customTools("c").mr_explainer_overview.execute({ project: "root/griffin-private", iid: 7 })).content[0].text);
  assert.equal(overview.fileCount, 3);
  assert.deepEqual(overview.areas.map((a) => a.area), ["docs/x.md", "apps/server"]);

  host.seedAgents();
  const agent = s.getAgentProfile("mr-explainer");
  assert.ok(agent.tools.includes("mr_explainer_overview"));
  assert.ok(agent.tools.includes("gitlab_mr_changes"));
  assert.ok(!agent.tools.some((t) => ["gitlab_mr_merge", "debug_exec", "kube_secret"].includes(t)));
});

// --- the marketplace: conflicts, dependencies, migrations ----------------------------------------

import { planSwitch } from "../src/modules/plan.mjs";

const mf = (id, extra = {}) => parseManifest({ id, title: id, ...extra }, id);
const world = (...list) => new Map(list.map((m) => [m.id, m]));

test("plan: a module filling a taken slot switches the old one off; requirements come on with it", () => {
  const m = world(mf("tg-a", { provides: ["telegram-dm"] }), mf("tg-b", { provides: ["telegram-dm"] }), mf("tix", { requires: { modules: ["tix-core"] } }), mf("tix-core"));
  const swap = planSwitch(m, new Set(["tg-a"]), "tg-b", true);
  assert.deepEqual([swap.enable, swap.disable], [["tg-b"], ["tg-a"]]);
  assert.match(swap.reasons["tg-a"], /هم‌جایگزین/);
  const dep = planSwitch(m, new Set(), "tix", true);
  assert.deepEqual(dep.enable.sort(), ["tix", "tix-core"]);
  // off cascades to whoever needs it
  const off = planSwitch(m, new Set(["tix", "tix-core"]), "tix-core", false);
  assert.deepEqual(off.disable.sort(), ["tix", "tix-core"]);
  // nothing changes when already so
  assert.deepEqual(planSwitch(m, new Set(["tg-a"]), "tg-a", true).enable, []);
});

test("plan: blocked when the requirement is missing, or the module and what it needs cannot live together", () => {
  const m = world(mf("mod-a", { requires: { modules: ["mod-ghost"] } }), mf("mod-b", { requires: { modules: ["mod-c"] }, conflicts: ["mod-d"] }), mf("mod-c", { conflicts: ["mod-d"] }), mf("mod-d"));
  assert.match(planSwitch(m, new Set(), "mod-a", true).blocked, /نصب نیست/);
  assert.equal(planSwitch(m, new Set(), "mod-nope", true).ok, false);
  // b needs c, and b conflicts with d (which is on): d goes off, c comes on with b
  const both = planSwitch(m, new Set(["mod-d"]), "mod-b", true);
  assert.equal(both.ok, true);
  assert.deepEqual(both.disable, ["mod-d"]);
  assert.equal(planSwitch(world(mf("mod-x", { requires: { modules: ["mod-y"] } }), mf("mod-y", { conflicts: ["mod-x"] })), new Set(), "mod-x", true).ok, false);
});

test("switching a module off moves its chats into a folder «ماژول …»; switching on puts them back", async () => {
  const dir = tmp();
  put(dir, "helpdesk", { title: "میز کمک", presets: ["griffin"] }, "export default () => {}");
  const s = store();
  const host = await createModuleHost({ dir, store: s, enabled: "", product: "griffin", log: quiet });
  assert.deepEqual(host.ids(), ["helpdesk"]);
  const mine = s.createChat({ title: "درخواست ۱" });
  const inGroup = s.createChat({ title: "درخواست ۲" });
  const other = s.createChat({ title: "عادی" });
  const keep = s.createGroup("کارهای من");
  s.updateChat(mine.id, { module: "helpdesk" });
  s.updateChat(inGroup.id, { module: "helpdesk", groupId: keep.id });

  const p = host.plan("helpdesk", false);
  assert.equal(p.steps[0].chats, 2);
  assert.equal(p.steps[0].folder, "ماژول میز کمک");
  const out = await host.apply("helpdesk", false);
  assert.deepEqual(host.ids(), []);
  assert.equal(out.moved.helpdesk.moved, 2);
  const folder = s.listGroups().find((g) => g.name === "ماژول میز کمک");
  assert.ok(folder);
  assert.equal(s.getChat(mine.id).group_id, folder.id);
  assert.equal(s.getChat(inGroup.id).group_id, folder.id);
  assert.equal(s.getChat(other.id).group_id, null, "ordinary chats stay");
  assert.equal(host.market()[0].enabled, false);

  // a chat the owner moves elsewhere meanwhile stays where they put it
  s.updateChat(inGroup.id, { groupId: null });
  const back = await host.apply("helpdesk", true);
  assert.deepEqual(host.ids(), ["helpdesk"]);
  assert.equal(back.restored.helpdesk, 1);
  assert.equal(s.getChat(mine.id).group_id, null);
  assert.equal(s.getChat(inGroup.id).group_id, null);
  assert.equal(s.listGroups().some((g) => g.name === "ماژول میز کمک"), false, "the emptied folder is removed");
  // the choice survives a restart and wins over the preset
  await host.apply("helpdesk", false);
  const again = await createModuleHost({ dir, store: s, enabled: "", product: "griffin", log: quiet });
  assert.deepEqual(again.ids(), []);
});

test("a Telegram variant is the value of a setting: switching writes it, and the live setting wins at start", async () => {
  const dir = tmp();
  put(dir, "tg", { builtin: true, presets: ["griffin"], provides: ["telegram-dm"], sets: { MODE: "assistant" }, switchNote: "live account" });
  put(dir, "tg-inbox", { builtin: true, presets: [], provides: ["telegram-dm"], sets: { MODE: "inbox" } });
  const s = store();
  const config = { MODE: "" };
  const make = (extra = {}) => createModuleHost({ dir, store: s, enabled: "", product: "griffin", getConfig: (k) => config[k], setConfig: (patch) => Object.assign(config, patch), log: quiet, ...extra });

  let host = await make();
  assert.deepEqual(host.ids(), ["tg"], "unset setting: the preset decides");
  const p = host.plan("tg-inbox", true);
  assert.deepEqual([p.enable, p.disable], [["tg-inbox"], ["tg"]]);
  assert.deepEqual(p.config, { MODE: "inbox" });
  assert.equal(p.risky, true, "tg carries the note about the live account and is being turned off");
  const back = host.plan("tg", true);
  assert.equal(back.empty, true);

  await assert.rejects(host.apply("tg-inbox", true), /تأیید/);
  await host.apply("tg-inbox", true, { confirm: true });
  assert.equal(config.MODE, "inbox");
  assert.deepEqual(host.ids(), ["tg-inbox"]);

  // someone edits the setting by hand: the marketplace shows the drift and a restart follows the setting
  config.MODE = "assistant";
  host = await make();
  assert.deepEqual(host.ids(), ["tg"], "the live setting says assistant, so tg is on whatever was switched before");
  config.MODE = "inbox";
  assert.equal(host.market().find((m) => m.id === "tg").drift, "MODE باید «assistant» باشد ولی «inbox» است");
  const fix = host.plan("tg", true);
  assert.equal(fix.steps[0].kind, "fix");
  assert.deepEqual(fix.config, { MODE: "assistant" });
});

test("a risky switch needs the owner's confirm; the routes answer 409 until then", async () => {
  const dir = tmp();
  put(dir, "tg", { builtin: true, presets: [], provides: ["telegram-dm"], sets: { MODE: "assistant" }, switchNote: "touches the live Telegram account" });
  const s = store();
  const config = {};
  const host = await createModuleHost({ dir, store: s, enabled: "", getConfig: (k) => config[k], setConfig: (p) => Object.assign(config, p), log: quiet });
  const app = new Hono();
  host.routes(app);
  const post = (url, body) => app.request(url, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
  const plan = await (await post("/api/modules/tg/plan", { enable: true })).json();
  assert.equal(plan.plan.risky, true);
  assert.equal((await post("/api/modules/tg/switch", { enable: true })).status, 409);
  assert.equal(config.MODE, undefined, "nothing was written");
  const done = await post("/api/modules/tg/switch", { enable: true, confirm: true });
  assert.equal(done.status, 200);
  assert.equal(config.MODE, "assistant");
  assert.equal((await post("/api/modules/ghost/switch", { enable: true })).status, 404);
  const market = (await (await app.request("/api/modules/market")).json()).modules;
  assert.equal(market[0].enabled, true);
  assert.equal(market[0].switchNote, "touches the live Telegram account");
});

test("the real modules: Telegram variants exclude each other and every manifest parses", async () => {
  const host = await createModuleHost({ dir: REAL, store: store(), enabled: "", product: "griffin", log: quiet });
  const ids = host.market().map((m) => m.id);
  assert.ok(ids.includes("telegram") && ids.includes("telegram-inbox"));
  const p = host.plan("telegram-inbox", true);
  assert.deepEqual(p.disable, ["telegram"]);
  assert.deepEqual(p.config, { TELEGRAM_DM_MODE: "inbox" });
  assert.equal(p.risky, true);
  assert.ok(host.market().every((m) => m.ok));
});

test("mr-explainer shelves: what needs attention, what is ready, and why", async () => {
  const { categorize } = await import("../../../modules/mr-explainer/categorize.mjs");
  const base = { state: "opened", draft: false, pipeline: "success", detailedMergeStatus: "mergeable", hasConflicts: false };
  assert.equal(categorize(base).category, "ready");
  assert.equal(categorize({ ...base, draft: true }).category, "draft");
  assert.equal(categorize({ ...base, hasConflicts: true, detailedMergeStatus: "conflict" }).category, "attention");
  assert.equal(categorize({ ...base, pipeline: "failed", detailedMergeStatus: "ci_must_pass" }).category, "attention");
  assert.match(categorize({ ...base, pipeline: "failed" }).reason, /قرمز/);
  assert.equal(categorize({ ...base, pipeline: "running", detailedMergeStatus: "ci_still_running" }).category, "running");
  assert.equal(categorize({ ...base, detailedMergeStatus: "not_approved" }).category, "waiting");
  assert.equal(categorize({ ...base, detailedMergeStatus: "discussions_not_resolved" }).category, "waiting");
  assert.equal(categorize({ ...base, detailedMergeStatus: "need_rebase" }).category, "attention");
  assert.equal(categorize({ ...base, detailedMergeStatus: "unchecked", pipeline: null }).category, "running");
  assert.equal(categorize({ state: "opened", pipeline: null }).category, "ready"); // no CI, no status: nothing blocks it
  assert.equal(categorize({ ...base, state: "merged" }).category, "merged");
  // the page's shelves come from module.json, and every category the code can give is one of them
  const page = parseManifest(JSON.parse(fs.readFileSync(path.join(REAL, "mr-explainer/module.json"), "utf8")), "mr-explainer").pages[0];
  const keys = page.groupBy.groups.map((g) => g.key);
  for (const c of ["attention", "ready", "running", "waiting", "draft", "merged", "closed"]) assert.ok(keys.includes(c), c);
  assert.equal(page.search, true);
  assert.deepEqual(page.filters.find((f) => f.key === "state").options[0], { value: "opened", label: "باز" });
});

test("a module reads only the MCP servers its module.json declares", async () => {
  const dir = tmp();
  const servers = { get: (n) => ({ url: `https://${n}.example/mcp`, headers: { "x-api-key": "k" } }) };
  put(dir, "okmod", { requires: { mcp: ["svc"] } }, 'export default (api) => { if (api.mcpServer("svc").url !== "https://svc.example/mcp") throw new Error("wrong"); }');
  put(dir, "sneaky", { requires: { mcp: ["svc"] } }, 'export default (api) => { api.mcpServer("other"); }');
  const host = await createModuleHost({ dir, store: store(), enabled: "all", mcpServers: servers, log: quiet });
  assert.deepEqual(host.ids(), ["okmod"]);
  assert.match(host.status().find((s) => s.id === "sneaky").error, /requires\.mcp/);
  assert.throws(() => parseManifest({ id: "tix", title: "T", requires: { mcp: ["bad name"] } }, "tix"), /requires\.mcp/);
});

test("a module asks the small model only if its module.json declares requires.ai", async () => {
  const dir = tmp();
  put(dir, "asks", { requires: { ai: true } }, 'export default async (api) => { if ((await api.complete("q")) !== "a:q") throw new Error("wrong answer"); }');
  put(dir, "mute", {}, 'export default async (api) => { await api.complete("q"); }');
  const host = await createModuleHost({ dir, store: store(), enabled: "all", complete: async (prompt) => ` a:${prompt} `, log: quiet });
  assert.deepEqual(host.ids(), ["asks"]); // the answer comes back trimmed
  assert.match(host.status().find((s) => s.id === "mute").error, /requires\.ai/);
});

test("a module's settings: the core keys it owns, its UI flags, its own config edited from its card", async () => {
  assert.throws(() => parseManifest({ id: "aa", title: "aa", settings: { config: ["lower"] } }, "aa"), /UPPER_SNAKE/);
  assert.throws(() => parseManifest({ id: "aa", title: "aa", settings: { flags: ["Bad-flag"] } }, "aa"), /camelCase/);
  const dir = tmp();
  put(dir, "tg", { settings: { config: ["TELEGRAM_FILES"], flags: ["inboxRow"] }, provides: ["dm"], sets: { TELEGRAM_DM_MODE: "x" }, pages: [{ id: "main", title: "تلگرام", kind: "builtin", route: "/telegram" }] });
  put(dir, "mr", {
    config: [{ key: "DEFAULT_PROJECT", description: "پروژه", default: "a/b" }],
    pages: [{ id: "mrs", title: "MRها", kind: "list", source: "rows", fields: [{ key: "t" }] }],
  }, `export default (api) => { api.source("rows", () => [{ t: api.config("DEFAULT_PROJECT") }]); };`);
  const host = await createModuleHost({ dir, store: store(), enabled: "all", log: quiet });
  // Settings → پیکربندی leaves these to the cards: what a module lists, what it stands for, and MODULES.
  const owners = host.configOwners();
  assert.deepEqual(owners.TELEGRAM_FILES, ["tg"]);
  assert.deepEqual(owners.TELEGRAM_DM_MODE, ["tg"]);
  assert.ok(owners.MODULES);
  assert.equal(owners.OPS_MODE, undefined);
  const app = new Hono();
  host.routes(app);
  const json = async (p, init) => (await app.request(p, init)).json();
  const market = (await json("/api/modules/market")).modules;
  const tg = market.find((m) => m.id === "tg");
  assert.deepEqual(tg.settings.flags, ["inboxRow"]);
  assert.deepEqual(tg.nav, [{ id: "tg", title: "تلگرام", builtin: true }]);
  const mr = market.find((m) => m.id === "mr");
  assert.deepEqual(mr.nav, [{ id: "m:mr:mrs", title: "MRها", builtin: false }]);
  assert.equal(mr.settings.own[0].default, "a/b");
  assert.equal((await json("/api/modules/mr/pages/mrs/data")).rows[0].t, "a/b");
  const patch = (body) => app.request("/api/modules/mr/config", { method: "PATCH", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
  assert.equal((await (await patch({ DEFAULT_PROJECT: "root/x" })).json()).settings[0].value, "root/x");
  assert.equal((await json("/api/modules/mr/pages/mrs/data")).rows[0].t, "root/x");
  assert.equal((await patch({ OTHER: "1" })).status, 400);
  await patch({ DEFAULT_PROJECT: "" });
  assert.equal((await json("/api/modules/mr/pages/mrs/data")).rows[0].t, "a/b");
});

test("the real modules own real config keys", async () => {
  const { CONFIG_SCHEMA } = await import("../src/config.mjs");
  const keys = new Set(CONFIG_SCHEMA.map((c) => c.key));
  const host = await createModuleHost({ dir: REAL, store: store(), enabled: "", product: "griffin", log: quiet });
  for (const key of Object.keys(host.configOwners())) assert.ok(keys.has(key), `${key} is not a core setting`);
});
