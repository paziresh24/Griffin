import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createMcpServers, syncMcpServers } from "../src/mcp-servers.mjs";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "mcps-"));
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

test("the written list reaches the session's CLAUDE_CONFIG_DIR, other keys stay, removals carry over", () => {
  const home = path.join(tmp(), ".claude.json");
  const account = tmp();
  const mcp = createMcpServers({ file: home });
  fs.writeFileSync(path.join(account, ".claude.json"), JSON.stringify({ userID: "u", mcpServers: { old: { type: "http", url: "https://o/mcp" } } }));
  mcp.save({ name: "board-app", server: { type: "http", url: "https://f.example/mcp" } });
  assert.equal(syncMcpServers({ to: account, from: home }), true);
  const got = readJson(path.join(account, ".claude.json"));
  assert.equal(got.userID, "u");
  assert.deepEqual(Object.keys(got.mcpServers), ["board-app"]);
  assert.equal(syncMcpServers({ to: account, from: home }), false, "same list: nothing written");
  mcp.remove("board-app");
  assert.equal(syncMcpServers({ to: account, from: home }), true);
  assert.equal(readJson(path.join(account, ".claude.json")).mcpServers, undefined);
  assert.equal(readJson(path.join(account, ".claude.json")).userID, "u");
});

test("same file, or no target: nothing happens", () => {
  const dir = tmp();
  const file = path.join(dir, ".claude.json");
  fs.writeFileSync(file, JSON.stringify({ mcpServers: { a: { type: "http", url: "https://a/mcp" } } }));
  assert.equal(syncMcpServers({ to: dir, from: file }), false);
  assert.equal(syncMcpServers({ to: "", from: file }), false);
});
