import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createMcpServers } from "../src/mcp-servers.mjs";
import { createMcpServerTools } from "../src/mcp-server-tools.mjs";

const call = async (tool, args) => JSON.parse((await tool.execute(args)).content[0].text);

test("owner chat gets add/list/remove; anything else gets none; secrets are refused", async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mcpt-")), ".claude.json");
  const mcp = createMcpServers({ file });
  const store = { getChat: (id) => (id === "own" ? { id, caller: "owner" } : { id, caller: "owner", job_id: "j" }), getKv: () => null, linksForChat: () => [] };
  assert.deepEqual(createMcpServerTools({ store, chatId: "job", mcp }), {});
  const t = createMcpServerTools({ store, chatId: "own", mcp });
  const added = await call(t.mcp_server_add, { name: "tracker", type: "http", url: "https://tracker.example.com/mcp" });
  assert.equal(added.server.url, "https://tracker.example.com/mcp");
  assert.equal((await call(t.mcp_server_list, {})).servers[0].name, "tracker");
  assert.match((await call(t.mcp_server_add, { name: "x", type: "http", url: "https://h/mcp", headers: { Authorization: "Bearer abc" } })).error, /credential/);
  assert.equal((await call(t.mcp_server_remove, { name: "tracker" })).removed, true);
  assert.deepEqual(mcp.list(), []);
});

test("mcp_server_login returns the sign-in url from the oauth module and needs a public url", async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mcpt-")), ".claude.json");
  const mcp = createMcpServers({ file });
  const store = { getChat: (id) => ({ id, caller: "owner" }), getKv: () => null, linksForChat: () => [] };
  const seen = [];
  const oauth = { start: async (a) => (seen.push(a), { url: "https://f.example/authorize?state=s" }) };
  const t = createMcpServerTools({ store, chatId: "own", mcp, oauth, publicUrl: "https://g.example/" });
  const out = await call(t.mcp_server_login, { name: "tracker" });
  assert.equal(out.url, "https://f.example/authorize?state=s");
  assert.deepEqual(seen, [{ name: "tracker", redirectUri: "https://g.example/api/public/mcp-oauth/callback" }]);
  const bare = createMcpServerTools({ store, chatId: "own", mcp, oauth, publicUrl: "" });
  assert.match((await call(bare.mcp_server_login, { name: "tracker" })).error, /PUBLIC_URL/);
});

test("mcp_server_add reads fromInfisical secrets itself and never returns them", async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mcpt-")), ".claude.json");
  const mcp = createMcpServers({ file });
  const store = { getChat: (id) => ({ id, caller: "owner" }), getKv: () => null, linksForChat: () => [] };
  const asked = [];
  const vault = { "/support:SUPPORT_API_KEY": "msg_s3cret", "/:BOARD_EMAIL": "me@x", "/:BOARD_PASSWORD": "pw!" };
  const callTool = async (name, a) => (asked.push([name, a.projectId]), { value: vault[`${a.path}:${a.name}`] || "" });
  const t = createMcpServerTools({ store, chatId: "own", mcp, callTool, ownProjects: ["P1"] });
  assert.match((await call(t.mcp_server_add, { name: "z", type: "http", url: "https://s/mcp", fromInfisical: { "X-Api-Key": { projectId: "rezaei", name: "K" } } })).error, /only the owner's own projects/);
  const out = await call(t.mcp_server_add, { name: "helpdesk-support", type: "http", url: "https://s/mcp", fromInfisical: { "X-Api-Key": { projectId: "p1", path: "/support", name: "SUPPORT_API_KEY" } } });
  assert.doesNotMatch(JSON.stringify(out), /msg_s3cret/);
  assert.match(out.note, /X-Api-Key read from Infisical/);
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).mcpServers["helpdesk-support"].headers["X-Api-Key"], "msg_s3cret");
  // a later update without the secret keeps the stored one
  await call(t.mcp_server_add, { name: "helpdesk-support", type: "http", url: "https://s/mcp" });
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).mcpServers["helpdesk-support"].headers["X-Api-Key"], "msg_s3cret");
  await call(t.mcp_server_add, { name: "board-app", type: "stdio", command: "node", args: ["/b.mjs"], fromInfisical: { BOARD_EMAIL: { projectId: "p1", name: "BOARD_EMAIL" }, BOARD_PASSWORD: { projectId: "p1", name: "BOARD_PASSWORD" } } });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).mcpServers["board-app"].env, { BOARD_EMAIL: "me@x", BOARD_PASSWORD: "pw!" });
  assert.match((await call(t.mcp_server_add, { name: "y", type: "http", url: "https://s/mcp", fromInfisical: { "X-Api-Key": { projectId: "p1", name: "NOPE" } } })).error, /empty or missing/);
  assert.match((await call(createMcpServerTools({ store, chatId: "own", mcp }).mcp_server_add, { name: "y", type: "http", url: "https://s/mcp", fromInfisical: { "X-Api-Key": { projectId: "p1", name: "K" } } })).error, /not reachable/);
  assert.ok(asked.every(([name]) => name === "infisical_get"));
});

test("fromInfisical outside the owner's projects asks through askedGet instead of refusing", async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mcpt-")), ".claude.json");
  const mcp = createMcpServers({ file });
  const store = { getChat: (id) => ({ id, caller: "owner" }), getKv: () => null, linksForChat: () => [] };
  const direct = [];
  const asked = [];
  const callTool = async (name, a) => (direct.push(a.projectId), { value: "x" });
  // OWNER_INFISICAL_PROJECTS empty, as on most installs (the Board setup failed with «none set»)
  const approve = createMcpServerTools({ store, chatId: "own", mcp, callTool, askedGet: async (a) => (asked.push(a), { value: a.name === "BOARD_EMAIL" ? "me@x" : "pw" }) });
  const out = await call(approve.mcp_server_add, { name: "board-app", type: "stdio", command: "node", args: ["/b.mjs"], fromInfisical: { BOARD_EMAIL: { projectId: "owner-project", path: "/board-app", name: "BOARD_EMAIL" }, BOARD_PASSWORD: { projectId: "owner-project", path: "/board-app", name: "BOARD_PASSWORD" } } });
  assert.equal(out.error, undefined);
  assert.deepEqual(asked.map((a) => [a.projectId, a.path, a.name, a.environment]), [["owner-project", "/board-app", "BOARD_EMAIL", "prod"], ["owner-project", "/board-app", "BOARD_PASSWORD", "prod"]]);
  assert.deepEqual(direct, []);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).mcpServers["board-app"].env, { BOARD_EMAIL: "me@x", BOARD_PASSWORD: "pw" });
  // the owner's own project still reads without asking
  const own = createMcpServerTools({ store, chatId: "own", mcp, callTool, ownProjects: ["mine"], askedGet: async () => assert.fail("own project must not ask") });
  await call(own.mcp_server_add, { name: "z", type: "http", url: "https://s/mcp", fromInfisical: { "X-Api-Key": { projectId: "MINE", name: "K" } } });
  assert.deepEqual(direct, ["MINE"]);
  // a «no» comes back as the tool's error and nothing is saved
  const denied = createMcpServerTools({ store, chatId: "own", mcp, callTool, askedGet: async () => { throw new Error("not approved"); } });
  assert.match((await call(denied.mcp_server_add, { name: "w", type: "http", url: "https://s/mcp", fromInfisical: { "X-Api-Key": { projectId: "other", name: "K" } } })).error, /not approved/);
  assert.equal(mcp.list().some((s) => s.name === "w"), false);
});
