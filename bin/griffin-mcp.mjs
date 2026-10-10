#!/usr/bin/env node
// MCP over stdio for clients that only speak stdio (Claude Desktop, registries that introspect a
// container). Answers initialize/tools/list itself and forwards everything else to a Griffin
// server's /mcp endpoint:
//   GRIFFIN_URL=https://griffin.example.com GRIFFIN_TOKEN=grf_… node bin/griffin-mcp.mjs
import { createInterface } from "node:readline";
import { MCP_TOOLS } from "../apps/server/src/mcp-tools.mjs";

const url = process.env.GRIFFIN_URL?.replace(/\/+$/, "");
const token = process.env.GRIFFIN_TOKEN;
const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");

async function forward(msg) {
  if (!url || !token) throw new Error("set GRIFFIN_URL and GRIFFIN_TOKEN to reach a Griffin server");
  const res = await fetch(`${url}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(msg),
  });
  if (res.status === 202) return null;
  if (!res.ok) throw new Error(`griffin http ${res.status}`);
  return res.json();
}

async function handle(msg) {
  const { id, method, params } = msg;
  const reply = (result) => id != null && send({ jsonrpc: "2.0", id, result });
  if (method === "initialize")
    return reply({
      protocolVersion: params?.protocolVersion || "2025-06-18",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "griffin", version: "stdio" },
    });
  if (method === "tools/list") return reply({ tools: MCP_TOOLS });
  if (method === "ping") return reply({});
  if (method?.startsWith("notifications/")) return;
  try {
    const answer = await forward(msg);
    if (answer && id != null) send(answer);
  } catch (error) {
    if (id != null) send({ jsonrpc: "2.0", id, error: { code: -32000, message: String(error.message || error) } });
  }
}

for await (const line of createInterface({ input: process.stdin })) {
  if (!line.trim()) continue;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
    continue;
  }
  handle(msg);
}
