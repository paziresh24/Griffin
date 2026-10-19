import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { classifyProbe, probeEgress } from "../src/egress-probe.mjs";
import { NAMES, nameFreshInstall, randomName } from "../src/first-name.mjs";
import { historyImportRoutes, resolveSource } from "../src/history-import.mjs";
import { openStore } from "../src/db.mjs";

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), `griffin-${p}-`));

test("proxy probe: an answer is a working path, a refusal without a key is the country, silence is a filter", () => {
  assert.equal(classifyProbe({ status: 401, text: "invalid x-api-key" }), "ok");
  assert.equal(classifyProbe({ status: 404 }), "ok");
  assert.equal(classifyProbe({ status: 403, text: '{"error":{"type":"forbidden","message":"Request not allowed"}}' }), "region");
  assert.equal(classifyProbe({ status: 400, text: "unsupported_country_region_territory" }), "region");
  assert.equal(classifyProbe({ status: 451 }), "region");
  assert.equal(classifyProbe({ error: "ECONNRESET" }), "unreachable");
  assert.equal(classifyProbe({ error: "timeout" }), "unreachable");
  assert.equal(classifyProbe({ error: "proxy: ECONNREFUSED", viaProxy: true }), "proxy");
  assert.equal(classifyProbe({ error: "proxy CONNECT api.openai.com:443 failed: HTTP/1.1 407", viaProxy: true }), "proxy");
  assert.equal(classifyProbe({ error: "ECONNREFUSED" }), "unreachable");
});

test("proxy probe: every host, through the proxy when one is given", async () => {
  const seen = [];
  const results = await probeEgress("http://127.0.0.1:1", {
    hosts: [{ host: "a.test", label: "A", path: "/" }, { host: "b.test", label: "B", path: "/" }],
    request: async (h, proxy) => {
      seen.push([h.host, proxy]);
      return h.host === "a.test" ? { status: 401 } : { status: 403, text: "not available in your region" };
    },
  });
  assert.deepEqual(seen, [["a.test", "http://127.0.0.1:1"], ["b.test", "http://127.0.0.1:1"]]);
  assert.deepEqual(results.map((r) => r.result), ["ok", "region"]);
});

test("proxy probe: the real request goes through the given proxy (CONNECT), and its refusal reads as the proxy's fault", async () => {
  const http = await import("node:http");
  const targets = [];
  const proxy = http.createServer();
  proxy.on("connect", (req, client) => {
    targets.push(req.url);
    client.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
  });
  await new Promise((r) => proxy.listen(0, "127.0.0.1", r));
  try {
    const [row] = await probeEgress(`http://127.0.0.1:${proxy.address().port}`, { hosts: [{ host: "engine.test", label: "E", path: "/" }], timeoutMs: 3000 });
    assert.deepEqual(targets, ["engine.test:443"]);
    assert.equal(row.result, "proxy");
  } finally {
    proxy.close();
  }
});

test("random name: picked once on a fresh install, never over an env name, a saved one or an existing database", () => {
  assert.ok(NAMES.length >= 30);
  assert.notEqual(randomName(() => 0, NAMES[0][0]).name, NAMES[0][0]);
  const env = (data, more = {}) => ({ GRIFFIN_DATA: data, ...more });
  // fresh: written to persona.json, stable on the next start
  const fresh = tmp("fresh");
  const picked = nameFreshInstall({ env: env(fresh), random: () => 0.5 });
  assert.ok(NAMES.some(([n, l]) => n === picked.name && l === picked.latin));
  assert.equal(JSON.parse(fs.readFileSync(path.join(fresh, "persona.json"), "utf8")).name, picked.name);
  assert.equal(nameFreshInstall({ env: env(fresh), random: () => 0 }), null);
  // env wins (an install named by ASSISTANT_NAME)
  const named = tmp("env");
  assert.equal(nameFreshInstall({ env: env(named, { GRIFFIN_ASSISTANT_NAME: "نیلو" }) }), null);
  assert.ok(!fs.existsSync(path.join(named, "persona.json")));
  // an install that already runs keeps its name, even the old default
  const old = tmp("old");
  fs.writeFileSync(path.join(old, "griffin.sqlite"), "");
  assert.equal(nameFreshInstall({ env: env(old) }), null);
  // persona.json with a name or an owner block: the name stays / the block stays
  const owner = tmp("owner");
  fs.writeFileSync(path.join(owner, "persona.json"), JSON.stringify({ owner: { name: "Ebrahim" } }));
  nameFreshInstall({ env: env(owner) });
  assert.equal(JSON.parse(fs.readFileSync(path.join(owner, "persona.json"), "utf8")).owner.name, "Ebrahim");
});

test("random name: persona.mjs reads it as the assistant's name", () => {
  const data = tmp("persona");
  const picked = nameFreshInstall({ env: { GRIFFIN_DATA: data }, random: () => 0.1 });
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GRIFFIN_")));
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", `const { PERSONA } = await import(${JSON.stringify(path.join(import.meta.dirname, "../src/persona.mjs"))}); process.stdout.write(PERSONA.name + "|" + PERSONA.latin);`], { env: { ...clean, GRIFFIN_DATA: data }, encoding: "utf8" });
  assert.equal(out, `${picked.name}|${picked.latin}`);
});

function claudeHomeWith(sessions) {
  const home = tmp("claude");
  const dir = path.join(home, ".claude", "projects", "-home-x-work");
  fs.mkdirSync(dir, { recursive: true });
  for (const [id, text] of sessions) {
    const lines = [
      { type: "user", cwd: "/home/x/work", message: { content: text }, timestamp: "2026-10-01T10:00:00Z" },
      { type: "assistant", message: { content: [{ type: "text", text: "باشه" }] }, timestamp: "2026-10-01T10:01:00Z" },
    ];
    fs.writeFileSync(path.join(dir, `${id}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n"));
  }
  return home;
}

test("history import: typed paths stay inside the allowed folders", () => {
  const home = claudeHomeWith([]);
  const root = path.join(home, ".claude");
  assert.equal(resolveSource(root, [home]), fs.realpathSync(path.join(root, "projects")));
  assert.equal(resolveSource("~/.claude", [home]), fs.realpathSync(path.join(root, "projects")));
  assert.throws(() => resolveSource(`${home}/${"../".repeat(30)}etc`, [home]), /فقط داخل/);
  assert.throws(() => resolveSource("/etc", [home]), /فقط داخل/);
  assert.throws(() => resolveSource("relative/path", [home]), /کامل/);
  fs.symlinkSync("/etc", path.join(home, "escape"));
  assert.throws(() => resolveSource(path.join(home, "escape"), [home]), /فقط داخل/);
});

test("history import route: dry run counts, the import brings them in once, traversal is refused", async () => {
  const ids = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"];
  const home = claudeHomeWith([[ids[0], "اولی"], [ids[1], "دومی"]]);
  const data = tmp("data");
  const dbFile = path.join(data, "griffin.sqlite");
  const store = openStore(dbFile);
  const target = path.join(data, "home", ".claude");
  let imported = 0;
  const app = new Hono();
  historyImportRoutes(app, { dataDir: data, roots: [home], dbFile, claudeHome: target, workspace: "/ws", onImported: () => (imported += 1) });
  const post = (body) => app.request("/api/setup/import", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  const bad = await post({ path: "/etc" });
  assert.equal(bad.status, 400);

  const dry = await (await post({ path: path.join(home, ".claude") })).json();
  assert.equal(dry.dryRun, true);
  assert.equal(dry.sessions, 2);
  assert.equal(dry.projects, 1);
  assert.equal(dry.toImport, 2);
  assert.equal(store.listChats().length, 0);
  assert.ok(!JSON.stringify(dry).includes("باشه"), "no transcript text goes back");

  const real = await (await post({ path: path.join(home, ".claude"), dryRun: false })).json();
  assert.equal(real.imported, 2);
  assert.equal(imported, 1);
  const chats = store.listChats();
  assert.equal(chats.length, 2);
  assert.deepEqual(chats.map((c) => c.agent_id).sort(), ids);
  // Where this install's Claude Code resumes them: its own workspace, never a repo.
  assert.deepEqual(fs.readdirSync(path.join(target, "projects", "-ws-agents-griffin")).sort(), ids.map((id) => `${id}.jsonl`));
  assert.ok(chats.every((c) => !c.repo));

  const again = await (await post({ path: path.join(home, ".claude") })).json();
  assert.equal(again.toImport, 0);
  assert.equal(again.already, 2);
  store.close?.();
});

test("history import: an uploaded tar.gz comes in, links in it are dropped", async () => {
  const ids = ["33333333-3333-4333-8333-333333333333"];
  const home = claudeHomeWith([[ids[0], "از آرشیو"]]);
  fs.symlinkSync("/etc/passwd", path.join(home, ".claude", "projects", "-home-x-work", "link"));
  const archive = path.join(tmp("tar"), "claude.tgz");
  execFileSync("tar", ["czf", archive, "-C", path.join(home, ".claude"), "projects"]);
  const data = tmp("updata");
  const dbFile = path.join(data, "griffin.sqlite");
  openStore(dbFile);
  const app = new Hono();
  historyImportRoutes(app, { dataDir: data, roots: [home], dbFile, claudeHome: path.join(data, "home", ".claude") });
  const up = await app.request("/api/setup/import/upload", { method: "POST", body: fs.readFileSync(archive) });
  const { upload } = await up.json();
  assert.match(upload, /^[a-f0-9]{16}$/);
  const unpacked = path.join(data, "import-upload", upload, "files", "projects", "-home-x-work");
  assert.ok(!fs.existsSync(path.join(unpacked, "link")));
  const dry = await (await app.request("/api/setup/import", { method: "POST", body: JSON.stringify({ upload }) })).json();
  assert.equal(dry.toImport, 1);
  const zip = await app.request("/api/setup/import/upload", { method: "POST", body: Buffer.from("PK\u0003\u0004rest") });
  assert.equal(zip.status, 400);
  assert.match((await zip.json()).error, /zip/);
  const bad = await app.request("/api/setup/import", { method: "POST", body: JSON.stringify({ upload: "../../etc" }) });
  assert.equal(bad.status, 400);
});
