import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import tls from "node:tls";
import { connectTunnel, installCursorEgress, isCursorHost } from "../src/egress.mjs";

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

// Minimal CONNECT proxy: records targets; tunnels "echo.test" to a local echo server, refuses the rest.
async function startProxy(echoPort) {
  const targets = [];
  const proxy = http.createServer();
  proxy.on("connect", (req, client, head) => {
    targets.push(req.url);
    if (!req.url.startsWith("echo.test:")) {
      client.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
      return;
    }
    const upstream = net.connect(echoPort, "127.0.0.1", () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
  });
  const port = await listen(proxy);
  return { proxy, port, targets };
}

test("cursor host matching", () => {
  assert.ok(isCursorHost("api2.cursor.sh"));
  assert.ok(isCursorHost("api.cursor.com"));
  assert.ok(isCursorHost("repo42.cursor.sh"));
  assert.ok(isCursorHost("api.anthropic.com"));
  assert.ok(isCursorHost("claude.ai"));
  assert.ok(!isCursorHost("notcursor.sh"));
  assert.ok(!isCursorHost("k8s.example.com"));
});

test("tunnel buffers writes until CONNECT succeeds, then streams both ways", async () => {
  const echo = net.createServer((socket) => socket.pipe(socket));
  const echoPort = await listen(echo);
  const { proxy, port, targets } = await startProxy(echoPort);
  try {
    const tunnel = connectTunnel({ hostname: "127.0.0.1", port }, "echo.test", 443);
    tunnel.write("سلام"); // written before the proxy has answered
    const reply = await new Promise((resolve) => tunnel.once("data", (d) => resolve(d.toString())));
    assert.equal(reply, "سلام");
    assert.deepEqual(targets, ["echo.test:443"]);
    tunnel.destroy();
  } finally {
    proxy.close();
    echo.close();
  }
});

test("tls.connect to Cursor goes through the proxy; other hosts do not", async () => {
  const { proxy, port, targets } = await startProxy(1);
  const original = tls.connect;
  try {
    assert.equal(installCursorEgress(`http://127.0.0.1:${port}`, { log: {} }), true);
    const error = await new Promise((resolve) => {
      const socket = tls.connect({ host: "api2.cursor.sh", port: 443 });
      socket.on("error", resolve);
    });
    assert.match(error.message, /proxy CONNECT api2\.cursor\.sh:443 failed: HTTP\/1\.1 502/);
    assert.deepEqual(targets, ["api2.cursor.sh:443"]);

    // non-Cursor host: direct connection attempt, proxy not contacted
    await new Promise((resolve) => {
      const socket = tls.connect(1, "127.0.0.1", {});
      socket.on("error", resolve);
    });
    assert.deepEqual(targets, ["api2.cursor.sh:443"]);
  } finally {
    tls.connect = original;
    proxy.close();
  }
});
