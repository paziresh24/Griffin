import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { getRequestListener } from "@hono/node-server";
import { Hono } from "hono";
import { clientAddress, createDualServer, loadTls, parseTrustedProxies } from "../src/listen.mjs";

function selfSigned() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "griffin-tls-"));
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=griffin.example.com",
    "-keyout", path.join(dir, "key.pem"), "-out", path.join(dir, "cert.pem")], { stdio: "ignore" });
  return dir;
}

test("one port answers plain HTTP and TLS, and the app sees the right scheme", async () => {
  const dir = selfSigned();
  const app = new Hono();
  app.get("/scheme", (c) => c.text(new URL(c.req.url).protocol));
  const server = createDualServer(getRequestListener(app.fetch), { tls: loadTls(dir) });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    assert.equal(server.tls, true);
    assert.equal(await (await fetch(`http://127.0.0.1:${port}/scheme`)).text(), "http:");
    const body = await new Promise((resolve, reject) => {
      https.get({ host: "127.0.0.1", port, path: "/scheme", rejectUnauthorized: false, agent: false }, (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve(data));
      }).on("error", reject);
    });
    assert.equal(body, "https:");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("without cert files the server is plain HTTP only", () => {
  assert.equal(loadTls(fs.mkdtempSync(path.join(os.tmpdir(), "no-tls-"))), null);
  assert.equal(createDualServer(() => {}).tls, false);
});

test("client address believes X-Forwarded-For only from a trusted proxy", () => {
  const edge = parseTrustedProxies("203.0.113.0/24");
  assert.equal(clientAddress({ headers: { "x-forwarded-for": "198.51.100.9" }, socket: { remoteAddress: "203.0.113.10" } }, edge), "198.51.100.9");
  assert.equal(clientAddress({ headers: { "x-forwarded-for": "198.51.100.9" }, socket: { remoteAddress: "::ffff:203.0.113.10" } }, edge), "198.51.100.9");
  assert.equal(clientAddress({ headers: {}, socket: { remoteAddress: "10.0.0.10" } }), "10.0.0.10");
  // Someone reaching the port directly cannot pick their own address with a forged header.
  assert.equal(clientAddress({ headers: { "x-forwarded-for": "1.2.3.4" }, socket: { remoteAddress: "198.51.100.7" } }, edge), "198.51.100.7");
  assert.equal(clientAddress({ headers: { "x-forwarded-for": "1.2.3.4" }, socket: { remoteAddress: "198.51.100.7" } }), "198.51.100.7");
  assert.equal(clientAddress({ headers: { "x-forwarded-for": "1.2.3.4" }, socket: { remoteAddress: "127.0.0.1" } }), "1.2.3.4", "loopback is trusted by default");
  // The edge appends the real client to whatever the client sent: read from the right.
  assert.equal(clientAddress({ headers: { "x-forwarded-for": "1.2.3.4, 198.51.100.9" }, socket: { remoteAddress: "203.0.113.10" } }, edge), "198.51.100.9");
  assert.equal(clientAddress({ headers: { "x-forwarded-for": "198.51.100.9, 203.0.113.7" }, socket: { remoteAddress: "203.0.113.10" } }, edge), "198.51.100.9", "a trusted hop is skipped");
  assert.equal(clientAddress({ headers: { "x-forwarded-for": "not-an-ip" }, socket: { remoteAddress: "203.0.113.10" } }, edge), "203.0.113.10");
});

test("trusted proxies take addresses and ranges; a bad entry is refused", () => {
  const list = parseTrustedProxies(" 203.0.113.10 , 10.0.0.0/8, ::ffff:192.0.2.1,2001:db8::/32");
  for (const ip of ["203.0.113.10", "10.9.8.7", "192.0.2.1"]) assert.equal(list.check(ip, "ipv4"), true, ip);
  assert.equal(list.check("2001:db8::5", "ipv6"), true);
  assert.equal(list.check("203.0.113.11", "ipv4"), false);
  const loopback = parseTrustedProxies("");
  assert.equal(loopback.check("127.0.0.1", "ipv4"), true);
  assert.equal(loopback.check("::1", "ipv6"), true);
  assert.equal(loopback.check("10.0.0.1", "ipv4"), false);
  assert.throws(() => parseTrustedProxies("edge.example.com"), /not an address or range/);
});
