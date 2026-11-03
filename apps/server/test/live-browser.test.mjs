import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { createLiveBrowser, LIVE_PATH } from "../src/live-browser.mjs";
import { liveScript, runVersion, screenSize, startScript, DAEMON_VERSION } from "../src/browser.mjs";

const fakeBrowser = { liveUp: async () => ({ vncPassword: "abcd1234", tabs: [{ url: "about:blank" }] }) };

test("open: a ticketed noVNC URL with an absolute socket path; off refuses", async () => {
  const lb = createLiveBrowser({ browser: fakeBrowser, address: async () => "127.0.0.1" });
  const { url } = await lb.open();
  const q = new URLSearchParams(url.split("?")[1]);
  assert.ok(url.startsWith("/api/livebrowser/view/vnc.html?"));
  assert.equal(q.get("autoconnect"), "true");
  assert.equal(q.get("password"), "abcd1234");
  const path = q.get("path");
  assert.ok(path.startsWith(`${LIVE_PATH}?t=`), path);
  assert.equal(lb.validTicket(path.split("t=")[1]), true);
  assert.equal(lb.validTicket("nope"), false);
  const off = createLiveBrowser({ browser: fakeBrowser, address: async () => "127.0.0.1", enabled: () => false });
  await assert.rejects(off.open(), /off/);
});

test("tickets expire after 12 hours", () => {
  let t = 1_000_000;
  const lb = createLiveBrowser({ browser: fakeBrowser, address: async () => "127.0.0.1", now: () => t });
  const id = lb.ticket();
  t += 11 * 3600_000;
  assert.equal(lb.validTicket(id), true);
  t += 2 * 3600_000;
  assert.equal(lb.validTicket(id), false);
});

test("view refuses paths that climb out", async () => {
  const lb = createLiveBrowser({ browser: fakeBrowser, address: async () => "127.0.0.1" });
  assert.equal((await lb.view(null, "../etc/passwd")).status, 400);
  assert.equal((await lb.view(null, "app/%2e%2e/x")).status, 400);
});

test("the socket is refused without a valid ticket", async (t) => {
  const lb = createLiveBrowser({ browser: fakeBrowser, address: async () => "127.0.0.1" });
  const server = http.createServer((_q, r) => r.end());
  server.on("upgrade", (req, s, h) => { if (!lb.handleUpgrade(req, s, h)) s.destroy(); });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  const answer = await new Promise((resolve) => {
    const c = net.connect(server.address().port, "127.0.0.1", () => c.write(`GET ${LIVE_PATH}?t=wrong HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: a\r\nSec-WebSocket-Version: 13\r\n\r\n`));
    c.once("data", (d) => { resolve(d.toString()); c.destroy(); });
  });
  assert.match(answer, /^HTTP\/1.1 403/);
  // other paths are not this module's
  assert.equal(lb.handleUpgrade({ url: "/api/phone/ws" }, null, null), false);
});

test("live settings restart the daemon; the screen script is safe with odd input", () => {
  assert.equal(runVersion({ on: false }), DAEMON_VERSION);
  assert.notEqual(runVersion({ on: true }), DAEMON_VERSION);
  assert.notEqual(runVersion({ on: true, proxy: "http://a:1" }), runVersion({ on: true }));
  assert.equal(screenSize("1920x1080"), "1920x1080");
  assert.equal(screenSize("1x1;rm -rf /"), "1440x900");
  assert.match(liveScript({ size: "$(evil)" }), /Xvfb :99 -screen 0 1440x900x24/);
  const start = startScript({ on: true, proxy: "http://p:1'; touch /x; '" });
  assert.match(start, /export LIVE=1 DISPLAY=:99/);
  assert.ok(start.includes(`LIVE_PROXY='http://p:1'\\''; touch /x; '\\'''`), start);
  assert.match(startScript({ on: false }), /unset LIVE/);
});
