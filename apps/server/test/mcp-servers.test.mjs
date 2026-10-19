import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createMcpServers, maskValue } from "../src/mcp-servers.mjs";

const setup = (state) => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mcp-")), ".claude.json");
  if (state) fs.writeFileSync(file, JSON.stringify(state));
  return { file, mcp: createMcpServers({ file }), read: () => JSON.parse(fs.readFileSync(file, "utf8")) };
};

test("list masks env and header values; other keys of the file survive writes", () => {
  const { mcp, read } = setup({ numStartups: 7, projects: { "/x": { a: 1 } }, mcpServers: { gh: { type: "http", url: "https://h/mcp", headers: { Authorization: "Bearer secret-token-1234" }, oauth: { x: 1 } } } });
  const [gh] = mcp.list();
  assert.equal(gh.headers.Authorization, maskValue("Bearer secret-token-1234"));
  assert.ok(!JSON.stringify(mcp.list()).includes("secret-token"));
  mcp.save({ name: "fs", server: { type: "stdio", command: "npx", args: ["-y", "srv", ""], env: { KEY: "abc" } } });
  const state = read();
  assert.equal(state.numStartups, 7);
  assert.deepEqual(state.projects, { "/x": { a: 1 } });
  assert.deepEqual(state.mcpServers.fs, { type: "stdio", command: "npx", args: ["-y", "srv"], env: { KEY: "abc" } });
  assert.equal(state.mcpServers.gh.headers.Authorization, "Bearer secret-token-1234");
});

test("a mask sent back keeps the stored secret, also across a rename; new values replace", () => {
  const { mcp, read } = setup({ mcpServers: { gh: { type: "http", url: "https://h/mcp", headers: { Authorization: "Bearer secret-token-1234", X: "old" }, oauth: { k: 1 } } } });
  const [gh] = mcp.list();
  mcp.save({ name: "github", previous: "gh", server: { type: "http", url: "https://h2/mcp", headers: { Authorization: gh.headers.Authorization, X: "new" } } });
  const s = read().mcpServers;
  assert.equal(s.gh, undefined);
  assert.deepEqual(s.github, { type: "http", url: "https://h2/mcp", headers: { Authorization: "Bearer secret-token-1234", X: "new" }, oauth: { k: 1 } });
  assert.throws(() => mcp.save({ name: "github", server: { type: "http", url: "https://h/mcp", headers: { New: maskValue("x") } } }), /no stored value/);
});

test("validation and remove", () => {
  const { mcp, read } = setup();
  assert.throws(() => mcp.save({ name: "bad name", server: { command: "x" } }), /invalid name/);
  assert.throws(() => mcp.save({ name: "a", server: { type: "stdio" } }), /command/);
  assert.throws(() => mcp.save({ name: "a", server: { type: "sse", url: "ftp://x" } }), /url/);
  mcp.save({ name: "a", server: { type: "sse", url: "https://x/sse" } });
  assert.throws(() => mcp.save({ name: "a", previous: "b", server: { type: "sse", url: "https://x/sse" } }), /already exists/);
  assert.equal(mcp.remove("a"), true);
  assert.equal(mcp.remove("a"), false);
  assert.deepEqual(read().mcpServers, {});
});
