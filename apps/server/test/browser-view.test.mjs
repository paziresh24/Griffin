import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { createBrowserView, VIEW_PATH } from "../src/browser-view.mjs";

const fake = (calls = []) => ({
  peek: async (chatId) => { calls.push(["peek", chatId]); return { exists: chatId === "has" }; },
  streamTarget: async (chatId) => { calls.push(["stream", chatId]); throw new Error("no daemon in this test"); },
});

test("tickets: owner chats only, one use, 60 seconds", () => {
  let t = 1_000;
  const view = createBrowserView({ browser: fake(), mayView: (id) => id !== "colleague", now: () => t });
  assert.throws(() => view.ticket("colleague"), /not yours/);
  const a = view.ticket("mine");
  const b = view.ticket("mine");
  assert.notEqual(a, b);
  t += 61_000;
  // expired tickets are dropped on the next mint
  view.ticket("mine");
});

test("status never opens a browser and hides other people's chats", async () => {
  const calls = [];
  const view = createBrowserView({ browser: fake(calls), mayView: (id) => id !== "colleague" });
  assert.deepEqual(await view.status("has"), { exists: true });
  assert.deepEqual(await view.status("colleague"), { exists: false });
  assert.deepEqual(calls, [["peek", "has"]]);
});

test("the socket: refused without a ticket, a ticket works once", async (t) => {
  const calls = [];
  const view = createBrowserView({ browser: fake(calls) });
  const server = http.createServer((_q, r) => r.end());
  server.on("upgrade", (req, s, h) => { if (!view.handleUpgrade(req, s, h)) s.destroy(); });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  const knock = (ticket) => new Promise((resolve) => {
    const c = net.connect(server.address().port, "127.0.0.1", () => c.write(`GET ${VIEW_PATH}?t=${ticket} HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: a\r\nSec-WebSocket-Version: 13\r\n\r\n`));
    c.once("data", (d) => { resolve(d.toString().split("\r\n")[0]); c.destroy(); });
  });
  assert.match(await knock("wrong"), /403/);
  const ticket = view.ticket("chat-1");
  assert.match(await knock(ticket), /502/); // reached the browser side (no daemon here)
  assert.deepEqual(calls, [["stream", "chat-1"]]);
  assert.match(await knock(ticket), /403/); // used up
  assert.equal(view.handleUpgrade({ url: "/api/phone/ws", headers: {} }, null, null), false);
});
