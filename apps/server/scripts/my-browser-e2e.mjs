// End-to-end check of the «مرورگر من» bridge with a real Chromium and the real extension (not part of
// `npm test`: it needs Chromium and playwright-core). In the sandbox:
//   PW_MODULE=/root/.griffin/browser/node_modules/playwright-core/index.mjs node apps/server/scripts/my-browser-e2e.mjs
// It serves a test page and the bridge, loads the unpacked extension, pairs it through its popup, and
// drives every command family through bridge.request — the same path the chrome_* tools take.
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createMyBrowser, EXTENSION_DIR, MY_BROWSER_PATH } from "../src/my-browser.mjs";

const { chromium } = await import(process.env.PW_MODULE || "/root/.griffin/browser/node_modules/playwright-core/index.mjs");

const PAGE = `<!doctype html><html><head><title>Griffin test</title></head><body>
<h1>صفحهٔ تست</h1>
<form onsubmit="event.preventDefault(); document.getElementById('out').textContent = 'sent:' + document.getElementById('name').value + ':' + document.getElementById('color').value;">
  <label>Name <input id="name" name="name" value="old"></label>
  <label>Color <select id="color"><option value="r">Red</option><option value="g">Green</option></select></label>
  <button type="submit">Send</button>
</form>
<p id="out">nothing</p>
<button onclick="this.textContent='clicked ' + (++window.n)">Click me</button>
<a href="/two">Next page</a>
<script>window.n = 0; console.error("boom from page"); fetch("/missing").catch(() => {}); fetch("/api", { method: "POST", headers: { authorization: "Bearer SECRET", "content-type": "application/json" }, body: JSON.stringify({ user: "a", password: "hunter2" }) });</script>
</body></html>`;

const store = (() => { const kv = new Map(); return { getKv: (k) => kv.get(k) ?? null, setKv: (k, v) => kv.set(k, v) }; })();
const bridge = createMyBrowser({ store, log: (l) => console.log(`  [bridge] ${l}`) });
const server = http.createServer((req, res) => {
  if (req.url === "/") { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); return res.end(PAGE); }
  if (req.url === "/two") { res.writeHead(200, { "content-type": "text/html" }); return res.end("<title>Two</title><p>second page</p>"); }
  if (req.url === "/api") { res.writeHead(200, { "content-type": "application/json", "set-cookie": "sid=xyz" }); return res.end('{"ok":true}'); }
  res.writeHead(404); res.end("nope");
});
server.on("upgrade", (req, socket, head) => { if (!bridge.handleUpgrade(req, socket, head)) socket.destroy(); });
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${server.address().port}`;
assert.ok(MY_BROWSER_PATH);

const profile = fs.mkdtempSync(path.join(os.tmpdir(), "griffin-ext-"));
// The extension as Settings hands it out: the folder plus config.json with this Griffin's address.
const extDir = fs.mkdtempSync(path.join(os.tmpdir(), "griffin-extdir-"));
fs.cpSync(EXTENSION_DIR, extDir, { recursive: true });
fs.writeFileSync(path.join(extDir, "config.json"), JSON.stringify({ server: origin }));
const context = await chromium.launchPersistentContext(profile, {
  executablePath: process.env.CHROMIUM || "/usr/bin/chromium-browser",
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage", `--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`],
});
// What Settings → «مرورگر من» does: ask the content script, answer comes back by postMessage.
const askExt = (page, type, extra = {}) => page.evaluate(([type, extra]) => new Promise((resolve) => {
  const id = `t${Math.random()}`;
  addEventListener("message", (e) => { if (e.data?.source === "griffin-ext" && e.data.id === id) resolve(e.data); });
  postMessage({ source: "griffin-page", type, id, ...extra }, location.origin);
  setTimeout(() => resolve(null), 60_000);
}), [type, extra]);
const step = async (name, fn) => { const t = Date.now(); try { const v = await fn(); console.log(`ok  ${name} (${Date.now() - t} ms)`); return v; } catch (e) { console.log(`FAIL ${name}: ${e.stack || e}`); process.exitCode = 1; throw e; } };

try {
  const sw = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker", { timeout: 15_000 });
  const extId = new URL(sw.url()).host;

  await step("fresh install opens Settings; one click pairs it (no code typed, no question)", async () => {
    const deadline = Date.now() + 10_000;
    let settings;
    while (!(settings = context.pages().find((p) => p.url().startsWith(`${origin}/#/settings/mybrowser`))) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
    assert.ok(settings, `settings tab not opened: ${context.pages().map((p) => p.url())}`);
    await settings.waitForLoadState("domcontentloaded");
    const hello = await askExt(settings, "hello");
    assert.equal(hello.paired, false);
    const { code } = bridge.newCode();
    const r = await askExt(settings, "pair", { code });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(bridge.connected(), true);
    assert.equal((await askExt(settings, "hello")).paired, true);
    await settings.close();
  });

  await step("another site cannot pair it silently (owner says no in the extension's window)", async () => {
    const evil = await context.newPage();
    await evil.goto(origin.replace("127.0.0.1", "localhost") + "/");
    const { code } = bridge.newCode();
    const asking = askExt(evil, "pair", { code });
    const confirmWin = await context.waitForEvent("page", { predicate: (p) => p.url().includes("/confirm.html"), timeout: 10_000 });
    await confirmWin.waitForLoadState("domcontentloaded");
    assert.match(await confirmWin.textContent("#origin"), /localhost/);
    await confirmWin.click("#no");
    const r = await asking;
    assert.equal(r.ok, false);
    assert.equal(bridge.status().devices.length, 1);
    assert.equal(bridge.connected(), true);
    await evil.close();
  });

  await step("popup shows it connected", async () => {
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extId}/popup.html`);
    await popup.waitForSelector("#paired:not([hidden])", { timeout: 5_000 });
    assert.match(await popup.textContent("#where"), new RegExp(origin.replace(/[.:/]/g, "\\$&")));
    await popup.close();
  });

  const opened = await step("tabs.open + snapshot + group", async () => {
    const r = await bridge.request("tabs.open", { url: `${origin}/` });
    assert.equal(r.status, 200);
    assert.equal(r.title, "Griffin test");
    assert.match(r.snapshot, /heading "صفحهٔ تست"/);
    assert.match(r.snapshot, /textbox "Name".*\[ref=e\d+\]/);
    assert.ok(!/گریفین در حال کنترل/.test(r.snapshot), "badge must stay out of the snapshot");
    const list = await bridge.request("tabs.list");
    const tab = list.windows.flatMap((w) => w.tabs).find((t) => t.tabId === r.tabId);
    assert.ok(tab.controlled);
    const group = list.groups.find((g) => g.groupId === tab.groupId);
    assert.equal(group?.title, "گریفین");
    // it opened in Griffin's own window, not the owner's, and used that window's blank tab
    const own = list.windows.find((w) => w.griffin);
    assert.ok(own && own.tabs.some((t) => t.tabId === r.tabId), JSON.stringify(list.windows));
    assert.equal(own.tabs.length, 1);
    return r;
  });
  const tabId = opened.tabId;
  const ref = (re) => { const m = re.exec(opened.snapshot); assert.ok(m, `no ref for ${re}`); return m[1]; };

  await step("badge is on the page", async () => {
    const r = await bridge.request("page.eval", { tabId, expression: "!!document.getElementById('__griffin_control_badge__')" });
    assert.equal(r.value, "true");
  });

  await step("type + select + submit", async () => {
    await bridge.request("page.type", { tabId, ref: ref(/textbox "Name"[^\n]*\[ref=(e\d+)\]/), text: "Alex", snapshot: false });
    const sel = await bridge.request("page.select", { tabId, ref: ref(/combobox[^\n]*\[ref=(e\d+)\]/), values: ["Green"], snapshot: false });
    assert.deepEqual(sel.selected, ["g"]);
    const r = await bridge.request("page.click", { tabId, ref: ref(/button "Send"[^\n]*\[ref=(e\d+)\]/) });
    assert.match(r.snapshot, /sent:Alex:g/);
  });

  await step("click by text, twice", async () => {
    await bridge.request("page.click", { tabId, text: "Click me", snapshot: false });
    const r = await bridge.request("page.click", { tabId, text: "clicked", snapshot: false });
    const v = await bridge.request("page.eval", { tabId, expression: "window.n" });
    assert.equal(v.value, "2");
    assert.ok(r.url);
  });

  await step("press keys", async () => {
    await bridge.request("page.type", { tabId, ref: ref(/textbox "Name"[^\n]*\[ref=(e\d+)\]/), text: "abc", snapshot: false });
    await bridge.request("page.press", { tabId, key: "Backspace", snapshot: false });
    const v = await bridge.request("page.eval", { tabId, expression: "document.getElementById('name').value" });
    assert.equal(v.value, '"ab"');
  });

  await step("devtools: console, network, masked request", async () => {
    await bridge.request("tabs.navigate", { tabId, go: "reload" });
    await new Promise((r) => setTimeout(r, 800));
    const c = await bridge.request("debug.console", { tabId });
    assert.ok(c.console.some((e) => e.level === "error" && /boom from page/.test(e.text)), JSON.stringify(c.console));
    const n = await bridge.request("debug.network", { tabId });
    assert.ok(n.requests.some((e) => e.url.endsWith("/missing") && e.status === 404), JSON.stringify(n.requests));
    const errs = await bridge.request("debug.network", { tabId, errorsOnly: true });
    assert.ok(errs.requests.every((e) => e.failed || e.status >= 400));
    const api = n.requests.findLast((e) => e.url.endsWith("/api"));
    const d = await bridge.request("debug.request", { tabId, requestId: api.requestId });
    assert.equal(d.requestHeaders.authorization, "[masked]");
    assert.match(d.postData, /"password":"\[masked\]"/);
    assert.ok(!JSON.stringify(d).includes("xyz") && !JSON.stringify(d).includes("SECRET") && !JSON.stringify(d).includes("hunter2"));
    assert.equal(d.body, '{"ok":true}');
    const perf = await bridge.request("debug.performance", { tabId });
    assert.ok(perf.metrics.Nodes > 0);
    const dom = await bridge.request("debug.dom", { tabId });
    assert.match(dom.html, /<form/);
  });

  await step("screenshot (badge hidden for it)", async () => {
    const r = await bridge.request("page.screenshot", { tabId });
    assert.ok(Buffer.from(r.png, "base64").subarray(1, 4).toString() === "PNG");
    const full = await bridge.request("page.screenshot", { tabId, fullPage: true });
    assert.ok(full.png.length > 1000);
  });

  await step("navigate by link + back", async () => {
    const snap = await bridge.request("page.snapshot", { tabId });
    const link = /link "Next page"[^\n]*\[ref=(e\d+)\]/.exec(snap.snapshot)[1];
    const r = await bridge.request("page.click", { tabId, ref: link });
    assert.equal(r.title, "Two");
    const back = await bridge.request("tabs.navigate", { tabId, go: "back" });
    assert.equal(back.title, "Griffin test");
    const wait = await bridge.request("page.wait", { tabId, text: "صفحهٔ تست", seconds: 5, snapshot: false });
    assert.ok(wait.url);
  });

  await step("raw CDP", async () => {
    const r = await bridge.request("cdp", { tabId, method: "Runtime.evaluate", params: { expression: "1+2", returnByValue: true } });
    assert.equal(r.result.result.value, 3);
  });

  await step("background tab: act + screenshot", async () => {
    const second = await bridge.request("tabs.open", { url: `${origin}/two`, snapshot: false });
    // the first tab is now in the background
    const v = await bridge.request("page.click", { tabId, text: "Click me", snapshot: false });
    assert.ok(v.url);
    const shot = await bridge.request("page.screenshot", { tabId });
    assert.ok(shot.png.length > 1000);
    return second;
  });

  await step("an owner tab moved into Griffin's window; ownWindow:false stays out", async () => {
    const mine = await context.newPage();
    await mine.goto(`${origin}/two`);
    const before = await bridge.request("tabs.list");
    const ownId = before.griffinWindowId;
    const minesTab = before.windows.filter((w) => !w.griffin).flatMap((w) => w.tabs).find((t) => t.url === `${origin}/two`);
    assert.ok(minesTab, JSON.stringify(before.windows));
    const moved = await bridge.request("tabs.window", { tabIds: [minesTab.tabId] });
    assert.equal(moved.windowId, ownId);
    assert.ok(moved.tabs.some((t) => t.tabId === minesTab.tabId));
    const out = await bridge.request("tabs.open", { url: `${origin}/two`, ownWindow: false });
    const after = await bridge.request("tabs.list");
    assert.ok(!after.windows.find((w) => w.griffin).tabs.some((t) => t.tabId === out.tabId));
    await bridge.request("tabs.close", { tabIds: [out.tabId, minesTab.tabId] });
  });

  await step("group, ungroup, move, activate, close", async () => {
    const list = await bridge.request("tabs.list");
    const ids = list.windows.flatMap((w) => w.tabs).filter((t) => t.url?.startsWith(origin)).map((t) => t.tabId);
    const g = await bridge.request("tabs.group", { tabIds: ids, title: "Test group", color: "blue" });
    assert.equal(g.title, "Test group");
    await bridge.request("tabs.ungroup", { tabIds: [ids[0]] });
    await bridge.request("tabs.move", { tabIds: [ids[0]], index: 0 });
    await bridge.request("tabs.activate", { tabId: ids[0] });
    await bridge.request("tabs.close", { tabIds: ids.slice(1) });
    const after = await bridge.request("tabs.list");
    assert.equal(after.windows.flatMap((w) => w.tabs).filter((t) => t.url?.startsWith(origin)).length, 1);
  });

  await step("detach removes the badge", async () => {
    await bridge.request("tabs.detach", { tabId });
    const pages = context.pages().filter((p) => p.url().startsWith(origin));
    const has = await pages[0].evaluate(() => !!document.getElementById("__griffin_control_badge__"));
    assert.equal(has, false);
  });

  await step("restricted page refused", async () => {
    const t = await context.newPage();
    await t.goto("chrome://version").catch(() => {});
    const list = await bridge.request("tabs.list");
    const tab = list.windows.flatMap((w) => w.tabs).find((x) => x.url?.startsWith("chrome://version"));
    await assert.rejects(bridge.request("page.snapshot", { tabId: tab.tabId }), /does not let extensions/);
  });

  await step("stop button pauses the extension", async () => {
    const r = await bridge.request("tabs.open", { url: `${origin}/`, snapshot: false });
    const page = context.pages().findLast((p) => p.url() === `${origin}/`);
    await page.waitForTimeout(300);
    // the badge's shadow root is closed: click at its button's place
    const box = await page.evaluate(() => { const r = document.getElementById("__griffin_control_badge__").getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; });
    await page.mouse.click(box.x + 22, box.y + box.h / 2);
    await new Promise((res) => setTimeout(res, 1000));
    assert.equal(bridge.connected(), false);
    await assert.rejects(bridge.request("tabs.list"), /not connected/);
    assert.ok(r.tabId);
  });
} finally {
  await context.close().catch(() => {});
  bridge.close();
  server.close();
  fs.rmSync(profile, { recursive: true, force: true });
  fs.rmSync(extDir, { recursive: true, force: true });
}
console.log(process.exitCode ? "E2E FAILED" : "E2E OK");
