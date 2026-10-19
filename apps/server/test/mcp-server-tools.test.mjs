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
  assert.deepEqual(seen, [{ name: "tracker", redirectUri: "https://g.example/api/mcp-oauth/callback" }]);
  const bare = createMcpServerTools({ store, chatId: "own", mcp, oauth, publicUrl: "" });
  assert.match((await call(bare.mcp_server_login, { name: "tracker" })).error, /PUBLIC_URL/);
});
