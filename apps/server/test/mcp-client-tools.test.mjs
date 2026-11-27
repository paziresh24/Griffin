import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { createMcpClientManager, mcpToolName, sanitizeToolSchema } from "../src/mcp-client-tools.mjs";

async function startTestMcpServer({ requireApiKey = "" } = {}) {
  const server = http.createServer(async (req, res) => {
    if (requireApiKey && req.headers["x-api-key"] !== requireApiKey) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    const mcp = new McpServer({ name: "test-support", version: "1.0.0" });
    mcp.tool(
      "get_ticket",
      "Fetch a ticket by ID",
      { id: z.string().describe("Ticket ID") },
      async ({ id }) => ({
        content: [{ type: "text", text: JSON.stringify({ id, status: "open", ok: true }) }],
      }),
    );
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      transport.close().catch(() => {});
      mcp.close().catch(() => {});
    });
    await mcp.connect(transport);
    await transport.handleRequest(req, res);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  return {
    url: `http://127.0.0.1:${addr.port}/mcp`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test("mcpToolName enforces 64-char limit, allowed charset, and uniqueness", () => {
  const used = new Set();
  assert.equal(mcpToolName("p24-support", "get_ticket", used), "mcp__p24-support__get_ticket");
  const longA = mcpToolName("very-long-server-name", "very_long_tool_name_that_exceeds_sixty_four_characters_alpha", used);
  const longB = mcpToolName("very-long-server-name", "very_long_tool_name_that_exceeds_sixty_four_characters_beta", used);
  assert.ok(longA.length <= 64 && longB.length <= 64);
  assert.notEqual(longA, longB);
  assert.match(longA, /^[A-Za-z0-9_-]{1,64}$/);
});

test("sanitizeToolSchema ensures object root and strips $schema/$id", () => {
  const clean = sanitizeToolSchema({
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "test",
    properties: { a: { type: "string", $schema: "x" } },
  });
  assert.equal(clean.type, "object");
  assert.equal("$schema" in clean, false);
  assert.equal("$id" in clean, false);
  assert.equal("$schema" in clean.properties.a, false);
});

test("createMcpClientManager discovers and calls StreamableHTTP MCP tools, isolates broken servers, and redacts secrets", async () => {
  const srv = await startTestMcpServer({ requireApiKey: "secret-header-value-999" });
  const dead = http.createServer((_req, res) => {
    res.writeHead(500);
    res.end("boom");
  });
  await new Promise((resolve) => dead.listen(0, "127.0.0.1", resolve));
  const deadPort = dead.address().port;

  try {
    const mgr = createMcpClientManager({ timeoutMs: 2000, callTimeoutMs: 5000, log: { warn() {} } });
    const tools = await mgr.toolsFor([
      { name: "p24-support", type: "http", url: srv.url, headers: { "X-Api-Key": "secret-header-value-999" } },
      { name: "broken-mcp", type: "http", url: `http://127.0.0.1:${deadPort}/mcp` },
    ]);

    assert.ok("mcp__p24-support__get_ticket" in tools);
    const out = await tools["mcp__p24-support__get_ticket"].execute({ id: "832210" });
    assert.equal(out.isError, false);
    assert.deepEqual(JSON.parse(out.content[0].text), { id: "832210", status: "open", ok: true });

    // Even if a server fails on execute with a secret in the error message, redactSecrets scrubs it
    const badKeyMgr = createMcpClientManager({ timeoutMs: 2000, callTimeoutMs: 5000, log: { warn() {} } });
    const leakSrv = await startTestMcpServer({ requireApiKey: "my-ultra-secret-token-xyz" });
    try {
      const leakTools = await badKeyMgr.toolsFor([
        { name: "p24-leak", type: "http", url: leakSrv.url, headers: { "X-Api-Key": "my-ultra-secret-token-xyz" } },
      ]);
      assert.ok("mcp__p24-leak__get_ticket" in leakTools);
      await leakSrv.close();
      const errOut = await leakTools["mcp__p24-leak__get_ticket"].execute({ id: "1" });
      assert.equal(errOut.isError, true);
      assert.equal(errOut.content[0].text.includes("my-ultra-secret-token-xyz"), false);
    } finally {
      await leakSrv.close().catch(() => {});
    }
  } finally {
    await srv.close();
    await new Promise((resolve) => dead.close(resolve));
  }
});
