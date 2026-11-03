import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { checkMcpServer } from "../src/mcp-health.mjs";

const serve = (handler) =>
  new Promise((resolve) => {
    const srv = http.createServer(handler).listen(0, "127.0.0.1", () => resolve({ url: `http://127.0.0.1:${srv.address().port}/mcp`, close: () => srv.close() }));
  });

const body = (req) => new Promise((r) => { let d = ""; req.on("data", (c) => (d += c)); req.on("end", () => r(d ? JSON.parse(d) : {})); });

// A tiny streamable-http MCP server that wants `Authorization: Bearer ok`, answers as SSE or JSON.
const mcp = ({ sse = false } = {}) => async (req, res) => {
  if (req.headers.authorization !== "Bearer ok") return res.writeHead(401).end("no");
  const msg = await body(req);
  if (!("id" in msg)) return res.writeHead(202).end();
  const result = msg.method === "initialize" ? { serverInfo: { name: "fake" } } : { tools: [{ name: "a" }, { name: "b" }, { name: "c" }] };
  const payload = JSON.stringify({ jsonrpc: "2.0", id: msg.id, result });
  res.writeHead(200, { "Content-Type": sse ? "text/event-stream" : "application/json" });
  res.end(sse ? `event: message\ndata: ${payload}\n\n` : payload);
};

test("http server: ok with name and tool count, for JSON and SSE replies", async () => {
  for (const sse of [false, true]) {
    const s = await serve(mcp({ sse }));
    const r = await checkMcpServer({ type: "http", url: s.url, headers: { Authorization: "Bearer ok" } });
    s.close();
    assert.deepEqual({ ok: r.ok, server: r.server, tools: r.tools, checked: r.checked }, { ok: true, server: "fake", tools: 3, checked: true });
  }
});

test("wrong token is «auth», unreachable and slow servers say why, no header value leaks", async () => {
  const s = await serve(mcp());
  const bad = await checkMcpServer({ type: "http", url: s.url, headers: { Authorization: "Bearer WRONG-secret" } });
  s.close();
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, "auth");
  assert.ok(!JSON.stringify(bad).includes("WRONG-secret"));
  const gone = await serve(() => {});
  gone.close(); // its port is now closed
  const down = await checkMcpServer({ type: "http", url: gone.url });
  assert.equal(down.ok, false);
  assert.ok(down.reason && down.reason !== "timeout");
  const hang = await serve(() => {});
  const slow = await checkMcpServer({ type: "http", url: hang.url }, { timeoutMs: 150 });
  hang.close();
  assert.deepEqual({ ok: slow.ok, reason: slow.reason }, { ok: false, reason: "timeout" });
});

test("sse server needs the endpoint event; stdio is not probed", async () => {
  const good = await serve((req, res) => { res.writeHead(200, { "Content-Type": "text/event-stream" }); res.write("event: endpoint\ndata: /m\n\n"); });
  const r = await checkMcpServer({ type: "sse", url: good.url });
  good.close();
  assert.equal(r.ok, true);
  const plain = await serve((req, res) => res.writeHead(200).end("hello"));
  const p = await checkMcpServer({ type: "sse", url: plain.url });
  plain.close();
  assert.deepEqual({ ok: p.ok, reason: p.reason }, { ok: false, reason: "no_endpoint_event" });
  assert.deepEqual(await checkMcpServer({ type: "stdio" }), { checked: false, type: "stdio", note: "stdio" });
});

// A fake stdio MCP server: `node -e <script>` speaking newline-delimited JSON-RPC.
const FAKE = `
let b="";process.stdin.on("data",d=>{b+=d;let i;while((i=b.indexOf("\\n"))>=0){const m=JSON.parse(b.slice(0,i));b=b.slice(i+1);
if(m.id==null)continue;
const r=m.method==="initialize"?{serverInfo:{name:"fake-stdio"}}:{tools:[{name:"a"},{name:"b"}]};
if(process.env.MODE==="bad"&&m.method==="initialize"){console.log(JSON.stringify({jsonrpc:"2.0",id:m.id,error:{message:"x"}}));continue}
console.log(JSON.stringify({jsonrpc:"2.0",id:m.id,result:r}))}});`;

test("stdio server: initialize + tools/list, env reaches the child but not the result", async () => {
  const r = await checkMcpServer({ type: "stdio", command: process.execPath, args: ["-e", FAKE], env: { TOKEN: "SECRET-env-value" } });
  assert.deepEqual({ checked: r.checked, type: r.type, ok: r.ok, server: r.server, tools: r.tools }, { checked: true, type: "stdio", ok: true, server: "fake-stdio", tools: 2 });
  assert.equal(typeof r.ms, "number");
  assert.ok(!JSON.stringify(r).includes("SECRET-env-value"));
  const bad = await checkMcpServer({ command: process.execPath, args: ["-e", FAKE], env: { MODE: "bad" } });
  assert.deepEqual({ ok: bad.ok, reason: bad.reason }, { ok: false, reason: "bad_initialize" });
});

test("stdio server: missing command, early exit and silence say why", async () => {
  const gone = await checkMcpServer({ command: "definitely-not-a-command-xyz" });
  assert.deepEqual({ ok: gone.ok, reason: gone.reason }, { ok: false, reason: "ENOENT" });
  const exited = await checkMcpServer({ command: process.execPath, args: ["-e", "process.exit(1)"] });
  assert.deepEqual({ ok: exited.ok, reason: exited.reason }, { ok: false, reason: "exited" });
  const slow = await checkMcpServer({ command: process.execPath, args: ["-e", "setInterval(()=>{},1000)"] }, { timeoutMs: 300 });
  assert.deepEqual({ ok: slow.ok, reason: slow.reason }, { ok: false, reason: "timeout" });
});

test("baseEnv: only what a command needs to run, never the app's settings or keys", async () => {
  const { baseEnv } = await import("../src/mcp-health.mjs");
  assert.deepEqual(baseEnv({ PATH: "/bin", HOME: "/h", GRIFFIN_OWNER_TOKEN: "x", ANTHROPIC_API_KEY: "y" }), { PATH: "/bin", HOME: "/h" });
});
