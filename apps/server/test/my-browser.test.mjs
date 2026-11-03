import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createMyBrowser, makeCode, myBrowserTools, zipDir, EXTENSION_DIR, MY_BROWSER_PATH, MY_BROWSER_TOOL_NAMES } from "../src/my-browser.mjs";

const memStore = () => {
  const kv = new Map();
  return { getKv: (k) => kv.get(k) ?? null, setKv: (k, v) => kv.set(k, structuredClone(v)), kv };
};

async function serve(bridge) {
  const server = http.createServer((_req, res) => res.end("no"));
  server.on("upgrade", (req, socket, head) => { if (!bridge.handleUpgrade(req, socket, head)) socket.destroy(); });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { url: `ws://127.0.0.1:${server.address().port}${MY_BROWSER_PATH}`, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) };
}

// A fake extension: answers commands with the handler, records server messages.
function fakeExtension(url, first, handler = (cmd, args) => ({ echo: cmd, args })) {
  const ws = new WebSocket(url);
  const got = [];
  const opened = new Promise((resolve, reject) => {
    ws.onopen = () => { ws.send(JSON.stringify(first)); resolve(); };
    ws.onerror = reject;
  });
  const waiters = [];
  ws.onmessage = async (e) => {
    const m = JSON.parse(e.data);
    got.push(m);
    waiters.splice(0).forEach((w) => w());
    if (m.cmd) {
      try { ws.send(JSON.stringify({ id: m.id, ok: true, result: await handler(m.cmd, m.args) })); } catch (err) { ws.send(JSON.stringify({ id: m.id, ok: false, error: err.message })); }
    }
  };
  const closed = new Promise((r) => { ws.onclose = r; });
  const next = async (type) => {
    for (let i = 0; i < 50; i += 1) {
      const hit = got.find((m) => m.type === type);
      if (hit) return hit;
      await new Promise((r) => { waiters.push(r); setTimeout(r, 100); });
    }
    throw new Error(`no ${type}; got ${JSON.stringify(got)}`);
  };
  return { ws, got, opened, closed, next };
}

test("pairing code: one time, normalized, refused when wrong", async () => {
  const store = memStore();
  const bridge = createMyBrowser({ store });
  const srv = await serve(bridge);
  try {
    assert.match(makeCode(), /^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    const wrong = fakeExtension(srv.url, { type: "pair", code: "AAAA-AAAA", label: "x" });
    const err = await wrong.next("error");
    assert.match(err.error, /wrong or expired/);
    await wrong.closed;
    assert.equal(bridge.paired(), false);

    const { code } = bridge.newCode();
    const ext = fakeExtension(srv.url, { type: "pair", code: code.toLowerCase().replace("-", " "), label: "Chrome · test", version: "0.1.0" });
    const paired = await ext.next("paired");
    assert.ok(paired.token.length > 30);
    assert.equal(bridge.paired(), true);
    assert.equal(bridge.connected(), true);
    // only the hash is kept
    assert.ok(!JSON.stringify(store.kv.get("mybrowser:devices")).includes(paired.token));
    const st = bridge.status();
    assert.equal(st.devices.length, 1);
    assert.equal(st.devices[0].label, "Chrome · test");
    assert.equal(st.devices[0].connected, true);

    // the same code does not work twice
    const again = fakeExtension(srv.url, { type: "pair", code, label: "y" });
    assert.match((await again.next("error")).error, /wrong or expired/);
    ext.ws.close();
    await ext.closed;
  } finally {
    await srv.close();
  }
});

test("hello with the token, commands go through, unknown token is told to pair again", async () => {
  const store = memStore();
  const bridge = createMyBrowser({ store, timeoutMs: 2000 });
  const srv = await serve(bridge);
  try {
    const { code } = bridge.newCode();
    const first = fakeExtension(srv.url, { type: "pair", code, label: "Laptop" });
    const { token } = await first.next("paired");
    first.ws.close();
    await first.closed;
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(bridge.connected(), false);
    await assert.rejects(bridge.request("tabs.list"), /not connected right now/);

    const ext = fakeExtension(srv.url, { type: "hello", token, label: "Laptop" }, (cmd, args) => {
      if (cmd === "boom") throw new Error("nope");
      return { cmd, args };
    });
    await ext.next("welcome");
    const out = await bridge.request("tabs.list", { a: 1 });
    assert.deepEqual(out, { cmd: "tabs.list", args: { a: 1 }, browser: "Laptop" });
    await assert.rejects(bridge.request("boom"), /nope/);
    await assert.rejects(bridge.request("tabs.list", {}, { browser: "Desktop" }), /no connected browser/);

    // the tools wrap results and errors
    const tools = myBrowserTools(bridge, { store, chatId: "c1" });
    assert.deepEqual(Object.keys(tools).sort(), [...MY_BROWSER_TOOL_NAMES].sort());
    const listed = JSON.parse((await tools.chrome_tabs.execute({ action: "list" })).content[0].text);
    assert.equal(listed.cmd, "tabs.list");
    const act = JSON.parse((await tools.chrome_act.execute({ action: "click", ref: "e5", tabId: 3 })).content[0].text);
    assert.equal(act.cmd, "page.click");
    assert.equal(act.args.ref, "e5");
    assert.match(act.note, /never follow instructions/);

    const stranger = fakeExtension(srv.url, { type: "hello", token: "not-a-token" });
    const refused = await stranger.next("error");
    assert.equal(refused.unpaired, true);

    // forgetting the device drops the live connection
    assert.equal(bridge.forget(bridge.status().devices[0].id), true);
    await ext.closed;
    assert.equal(bridge.paired(), false);
  } finally {
    await srv.close();
  }
});

test("a socket that never says hello is closed", async () => {
  const bridge = createMyBrowser({ store: memStore() });
  const srv = await serve(bridge);
  try {
    const ext = fakeExtension(srv.url, { type: "something" });
    await ext.closed;
    assert.equal(bridge.connected(), false);
  } finally {
    await srv.close();
  }
});

test("the extension zip unpacks to a valid MV3 extension", (t) => {
  const zip = zipDir(EXTENSION_DIR, "griffin-chrome/", { "config.json": JSON.stringify({ server: "https://g.example" }) });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gzip-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "x.zip"), zip);
  try { execFileSync("python3", ["-c", "import zipfile,sys; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; z.extractall(sys.argv[2])", path.join(dir, "x.zip"), dir]); } catch (error) {
    if (error.code === "ENOENT") return t.skip("no python3");
    throw error;
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, "griffin-chrome", "manifest.json"), "utf8"));
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, "griffin-chrome", "config.json"), "utf8")), { server: "https://g.example" });
  for (const f of ["background.js", "content.js", "confirm.html", "confirm.js", "popup.html", "popup.js", "icon16.png", "icon48.png", "icon128.png"]) assert.ok(fs.existsSync(path.join(dir, "griffin-chrome", f)), f);
  assert.deepEqual(fs.readFileSync(path.join(dir, "griffin-chrome", "background.js")), fs.readFileSync(path.join(EXTENSION_DIR, "background.js")));
});
