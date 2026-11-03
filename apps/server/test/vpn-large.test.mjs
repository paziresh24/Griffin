import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import { carriesLarge } from "../src/vpn.mjs";

// A fake api.anthropic.com behind a CONNECT proxy: `cutAfter` bytes of body, then the server hangs up
// (what a VPN server that cuts large uploads looks like); without it the whole body is read and 401 comes back.
async function rig({ cutAfter = Infinity } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vpn-large-"));
  const key = path.join(dir, "k.pem");
  const cert = path.join(dir, "c.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=api.anthropic.com", "-addext", "subjectAltName=DNS:api.anthropic.com", "-keyout", key, "-out", cert], { stdio: "ignore" });
  const ca = fs.readFileSync(cert);
  const origin = tls.createServer({ key: fs.readFileSync(key), cert: ca }, (socket) => {
    let seen = 0;
    let want = null;
    let head = "";
    socket.on("data", (d) => {
      seen += d.length;
      if (want === null) {
        head += d.toString("latin1");
        const end = head.indexOf("\r\n\r\n");
        if (end < 0) return;
        want = Number(/content-length: (\d+)/i.exec(head)[1]) + end + 4;
      }
      if (seen > cutAfter) return socket.destroy();
      if (seen >= want) socket.end("HTTP/1.1 401 Unauthorized\r\ncontent-length: 0\r\n\r\n");
    });
    socket.on("error", () => {});
  });
  await new Promise((r) => origin.listen(0, "127.0.0.1", r));
  const proxy = http.createServer();
  proxy.on("connect", (req, client) => {
    const up = net.connect(origin.address().port, "127.0.0.1", () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      up.pipe(client);
      client.pipe(up);
    });
    up.on("error", () => client.destroy());
    client.on("error", () => up.destroy());
  });
  await new Promise((r) => proxy.listen(0, "127.0.0.1", r));
  return {
    ca,
    url: `http://127.0.0.1:${proxy.address().port}`,
    close() {
      proxy.close();
      origin.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("a server that carries the whole large body counts as carrying large Claude requests", async () => {
  const r = await rig();
  try {
    assert.equal(await carriesLarge(r.url, "api.anthropic.com", { bytes: 3 * 1024 * 1024, ca: r.ca, timeoutMs: 20_000 }), true);
  } finally {
    r.close();
  }
});

test("a server that cuts a large upload does not, though it passes the handshake", async () => {
  const r = await rig({ cutAfter: 1024 * 1024 });
  try {
    assert.equal(await carriesLarge(r.url, "api.anthropic.com", { bytes: 3 * 1024 * 1024, ca: r.ca, timeoutMs: 20_000 }), false);
  } finally {
    r.close();
  }
});

test("no proxy at all is not carrying either", async () => {
  assert.equal(await carriesLarge("http://127.0.0.1:1", "api.anthropic.com", { bytes: 1024, timeoutMs: 5_000 }), false);
});
