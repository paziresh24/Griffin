// Runs INSIDE the sandbox, never in the app (browser.mjs writes it there and starts it): one headless
// Chromium driven by Playwright, a browser context per chat, so agents can test pages and use web
// panels that have no API. The app reaches it over the sandbox's bridge address with a random token;
// the port is not published anywhere. No dependency but playwright-core (PW_MODULE) and Chromium
// (CHROMIUM). One JSON request per action: POST /act {session, action, ...args} -> JSON.
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

const PORT = Number(process.env.PORT) || 40990;
const TOKEN = process.env.TOKEN || "";
const HOME = process.env.BROWSER_HOME || "/root/.griffin/browser";
const VERSION = process.env.DAEMON_VERSION || "dev";
const IDLE_MS = Number(process.env.IDLE_MS) || 30 * 60_000;
const MAX_SESSIONS = Number(process.env.MAX_SESSIONS) || 6;
const SNAPSHOT_CHARS = 14_000;
const NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;
// Printable ASCII only: it goes into a request header.
const UA_RE = /^[\x20-\x7e]{1,400}$/;

if (!TOKEN) throw new Error("TOKEN is required");
const { chromium } = await import(process.env.PW_MODULE || path.join(HOME, "node_modules/playwright-core/index.mjs"));

let browser = null;
// The live browser (owner 2026-10-31: «یه بروزر داشته باشیم روی سرور… هم تستا بره روی اون هم خودمون بتونیم
// باهاش کار کنیم»): with LIVE=1 the owner's chats do not get a headless context of their own but share ONE
// headed Chromium on the sandbox's virtual display (Xvfb :99, watched and driven by the owner through
// noVNC, live-browser.mjs). Its profile is a real user-data dir, so logins the owner makes by hand
// (captcha, OTP) stay for the agent and the next day. Colleague chains keep their own headless contexts.
const LIVE = process.env.LIVE === "1";
const LIVE_SCOPE = "owner";
const LIVE_SIZE = (process.env.LIVE_SIZE || "1440x900").split("x").map(Number);
let live = null;
let liveStarting = null;
// The context's User-Agent: the same Chromium, without "HeadlessChrome". Some WAFs answer that word with
// 410 "Web Page Blocked" (console.kavenegar.com, 2026-10-28: an agent could not reach a login page that
// curl with a desktop UA opened fine).
export const desktopUserAgent = (version) =>
  `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${String(version || "").split(".")[0] || "142"}.0.0.0 Safari/537.36`;
/** @type {Map<string, {context, pages: any[], current: number, profile: string|null, userAgent: string, lastUsed: number, events: string[]}>} */
const sessions = new Map();

async function getBrowser() {
  if (browser?.isConnected()) return browser;
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM || "/usr/bin/chromium-browser",
    headless: true,
    // In a container: no user namespaces for Chrome's own sandbox, and /dev/shm is 64M.
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--no-first-run", "--lang=fa-IR"],
  });
  browser.on("disconnected", () => { browser = null; sessions.clear(); });
  return browser;
}

async function getLive() {
  if (live) return live;
  liveStarting ??= (async () => {
    const dir = path.join(HOME, "live-profile");
    fs.mkdirSync(dir, { recursive: true });
    // A Chromium killed with the old daemon leaves its lock behind.
    for (const f of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) fs.rmSync(path.join(dir, f), { force: true });
    const [w, h] = LIVE_SIZE;
    const ctx = await chromium.launchPersistentContext(dir, {
      executablePath: process.env.CHROMIUM || "/usr/bin/chromium-browser",
      headless: false,
      viewport: null,
      locale: "fa-IR",
      timezoneId: "Asia/Tehran",
      ignoreHTTPSErrors: true,
      acceptDownloads: true,
      env: { ...process.env, DISPLAY: process.env.DISPLAY || ":99" },
      args: ["--no-sandbox", "--disable-dev-shm-usage", "--no-first-run", "--no-default-browser-check", "--lang=fa-IR", "--window-position=0,0", `--window-size=${w},${h}`, "--start-maximized", "--disable-features=Translate", ...(process.env.LIVE_PROXY ? [`--proxy-server=${process.env.LIVE_PROXY}`] : [])],
    });
    ctx.setDefaultTimeout(15_000);
    ctx.setDefaultNavigationTimeout(45_000);
    ctx.on("close", () => { live = null; for (const [id, s] of sessions) if (s.live) sessions.delete(id); });
    live = ctx;
    return ctx;
  })().finally(() => { liveStarting = null; });
  return liveStarting;
}

// In the live browser every owner chat sees every tab (the owner's own too); each chat keeps its own
// «current» tab and hears the events of the tabs it has seen.
async function syncLive(session) {
  const pages = session.context.pages();
  const known = session.seen;
  let opened = null;
  for (const page of pages) {
    if (known.has(page)) continue;
    known.add(page);
    watchPage(session, page, { live: true });
    const opener = await page.opener().catch(() => null);
    if (opener && opener === session.pages[session.current]) opened = page;
  }
  const current = session.pages[session.current];
  session.pages = pages;
  session.current = Math.max(0, opened ? pages.indexOf(opened) : current ? pages.indexOf(current) : pages.length - 1);
}

const profileFile = (scope, name) => path.join(HOME, "profiles", scope, `${name}.json`);
// A profile's User-Agent sits beside its login (not in the .json, so `profiles` lists logins only).
const uaFile = (scope, name) => path.join(HOME, "profiles", scope, `${name}.ua`);

// The UA the caller asked for, else the one saved with the profile, else the desktop default.
function userAgentFor(b, { scope, profile, userAgent }) {
  if (userAgent) return userAgent;
  const stored = profile ? uaFile(scope, profile) : null;
  if (stored && fs.existsSync(stored)) {
    const value = fs.readFileSync(stored, "utf8").trim();
    if (UA_RE.test(value)) return value;
  }
  return desktopUserAgent(b.version());
}

function note(session, line) {
  session.events.push(line.slice(0, 500));
  if (session.events.length > 200) session.events.splice(0, session.events.length - 200);
}

function watchPage(session, page, { live: shared = false } = {}) {
  page.on("console", (msg) => { if (["error", "warning"].includes(msg.type())) note(session, `console.${msg.type()}: ${msg.text()}`); });
  page.on("pageerror", (err) => note(session, `page error: ${err.message}`));
  page.on("requestfailed", (req) => note(session, `request failed: ${req.method()} ${req.url()} — ${req.failure()?.errorText || "?"}`));
  page.on("response", (res) => { if (res.status() >= 400) note(session, `http ${res.status()}: ${res.request().method()} ${res.url()}`); });
  // A confirm() / alert() would block the page; it is accepted (the agent clicked what led to it) and reported.
  page.on("dialog", (dialog) => { note(session, `dialog ${dialog.type()} «${dialog.message()}» accepted`); dialog.accept().catch(() => {}); });
  page.on("download", async (download) => {
    const dir = path.join(HOME, "downloads");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${Date.now()}-${path.basename(download.suggestedFilename() || "file")}`);
    await download.saveAs(file).then(() => note(session, `download saved: ${file}`), (e) => note(session, `download failed: ${e.message}`));
  });
  page.on("close", () => {
    if (shared) return; // syncLive rebuilds the list from the context
    const i = session.pages.indexOf(page);
    if (i >= 0) session.pages.splice(i, 1);
    if (session.current >= session.pages.length) session.current = Math.max(0, session.pages.length - 1);
  });
}

async function closeSession(id, { closeTabs = false } = {}) {
  const session = sessions.get(id);
  if (!session) return false;
  sessions.delete(id);
  // The live browser outlives any chat: an idle chat just lets go; browser_close closes the tab it is on.
  if (session.live) {
    if (closeTabs) await session.pages[session.current]?.close().catch(() => {});
    return true;
  }
  await saveProfile(session).catch(() => {});
  await session.context.close().catch(() => {});
  return true;
}

async function saveProfile(session) {
  if (!session.profile || session.live) return;
  const file = profileFile(session.scope, session.profile);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  await session.context.storageState({ path: file });
  fs.chmodSync(file, 0o600);
}

async function openLiveSession(id, { profile }) {
  const existing = sessions.get(id);
  if (existing?.live) return existing;
  const ctx = await getLive();
  // A login saved earlier as a headless profile comes along once (the live profile keeps it after that).
  const stored = profile ? profileFile(LIVE_SCOPE, profile) : null;
  if (stored && fs.existsSync(stored)) {
    try { await ctx.addCookies(JSON.parse(fs.readFileSync(stored, "utf8")).cookies || []); } catch {}
  }
  const session = { context: ctx, live: true, pages: [], seen: new WeakSet(), current: 0, scope: LIVE_SCOPE, profile: profile || null, userAgent: "live", lastUsed: Date.now(), events: [] };
  sessions.set(id, session);
  await syncLive(session);
  return session;
}

async function openSession(id, { scope, profile, userAgent }) {
  if (LIVE && scope === LIVE_SCOPE) return openLiveSession(id, { profile });
  const existing = sessions.get(id);
  if (existing && (profile === undefined || existing.profile === (profile || null)) && (!userAgent || existing.userAgent === userAgent)) return existing;
  // A new User-Agent needs a new context; the same profile (or, with none given, the one open now) carries over.
  if (existing && profile === undefined) profile = existing.profile || "";
  if (existing) await closeSession(id);
  while ([...sessions.values()].filter((x) => !x.live).length >= MAX_SESSIONS) {
    const oldest = [...sessions.entries()].filter(([, x]) => !x.live).sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0][0];
    await closeSession(oldest);
  }
  const b = await getBrowser();
  const stored = profile ? profileFile(scope, profile) : null;
  const ua = userAgentFor(b, { scope, profile, userAgent });
  if (profile && userAgent) {
    fs.mkdirSync(path.dirname(uaFile(scope, profile)), { recursive: true });
    fs.writeFileSync(uaFile(scope, profile), userAgent, { mode: 0o600 });
  }
  const context = await b.newContext({
    userAgent: ua,
    viewport: { width: 1366, height: 860 },
    locale: "fa-IR",
    timezoneId: "Asia/Tehran",
    ignoreHTTPSErrors: true,
    bypassCSP: true,
    acceptDownloads: true,
    ...(stored && fs.existsSync(stored) ? { storageState: stored } : {}),
  });
  context.setDefaultTimeout(15_000);
  context.setDefaultNavigationTimeout(45_000);
  const session = { context, pages: [], current: 0, scope, profile: profile || null, userAgent: ua, lastUsed: Date.now(), events: [] };
  context.on("page", (page) => {
    session.pages.push(page);
    session.current = session.pages.length - 1;
    watchPage(session, page);
  });
  sessions.set(id, session);
  await context.newPage();
  return session;
}

// A new tab for this chat. In the live browser it is this chat's own (it may navigate it freely) and comes
// to the front, so the owner watching sees what the agent is doing.
async function openTab(session) {
  const page = await session.context.newPage();
  if (session.live) {
    session.own ??= new WeakSet();
    session.own.add(page);
    await syncLive(session);
    await page.bringToFront().catch(() => {});
  }
  session.current = Math.max(0, session.pages.indexOf(page));
  return page;
}

const pageOf = (session) => {
  const page = session.pages[session.current];
  if (!page) throw new Error("no open page: call browser_open with a url");
  return page;
};

function target(page, { ref, selector, text }) {
  if (ref) return page.locator(`aria-ref=${String(ref).replace(/^\[?ref=|\]$/g, "")}`);
  if (selector) return page.locator(String(selector)).first();
  if (text) return page.getByText(String(text), { exact: false }).first();
  throw new Error("give ref (from the snapshot), selector or text");
}

async function snapshot(page, { depth } = {}) {
  let text = await page.ariaSnapshot({ mode: "ai", ...(depth ? { depth: Number(depth) } : {}) }).catch((e) => `(snapshot failed: ${e.message})`);
  const full = text.length;
  if (full > SNAPSHOT_CHARS) text = `${text.slice(0, SNAPSHOT_CHARS)}\n… [${full - SNAPSHOT_CHARS} more characters: call browser_snapshot with depth to see less, or browser_eval to read a part]`;
  return text;
}

async function state(session, { withSnapshot = true, depth } = {}) {
  const page = session.pages[session.current];
  const out = { tab: session.current, tabs: session.pages.length };
  if (!page) return { ...out, url: null };
  await page.waitForLoadState("domcontentloaded", { timeout: 8000 }).catch(() => {});
  out.url = page.url();
  out.title = await page.title().catch(() => "");
  if (session.events.length) {
    out.events = session.events.slice(-12);
    if (session.events.length > 12) out.moreEvents = session.events.length - 12;
    session.events = [];
  }
  if (withSnapshot) out.snapshot = await snapshot(page, { depth });
  return out;
}

// A click or a key often starts a navigation; give it a moment to begin and settle.
async function settle(page) {
  await page.waitForLoadState("domcontentloaded", { timeout: 10_000 }).catch(() => {});
  await page.waitForLoadState("networkidle", { timeout: 2500 }).catch(() => {});
}

const ACTIONS = {
  async open(session, { url, go, newTab }) {
    if (go) {
      const page = pageOf(session);
      if (go === "back") await page.goBack();
      else if (go === "forward") await page.goForward();
      else if (go === "reload") await page.reload();
      else throw new Error("go is back, forward or reload");
      await settle(page);
      return state(session);
    }
    if (!/^(https?:\/\/|about:blank$)/i.test(String(url || ""))) throw new Error("url must start with http:// or https://");
    let page = session.pages[session.current];
    // In the live browser a chat never takes over a tab it did not open (the owner's own, another chat's).
    const foreign = session.live && page && !session.own?.has(page);
    if (newTab || !page || foreign) page = await openTab(session);
    else session.current = session.pages.indexOf(page);
    const response = await page.goto(url, { waitUntil: "domcontentloaded" });
    await settle(page);
    return { status: response?.status() ?? null, ...(await state(session)) };
  },
  async snapshot(session, { depth }) {
    return state(session, { depth });
  },
  async click(session, args) {
    const page = pageOf(session);
    const options = { button: args.button || "left", ...(args.modifiers ? { modifiers: args.modifiers } : {}) };
    if (args.double) await target(page, args).dblclick(options);
    else await target(page, args).click(options);
    await settle(page);
    return state(session);
  },
  async hover(session, args) {
    const page = pageOf(session);
    await target(page, args).hover();
    return state(session);
  },
  async type(session, args) {
    const page = pageOf(session);
    const el = target(page, args);
    if (args.slowly) { await el.click(); await el.pressSequentially(String(args.text ?? ""), { delay: 40 }); }
    else await el.fill(String(args.text ?? ""));
    if (args.submit) { await el.press("Enter"); await settle(page); }
    return state(session);
  },
  async select(session, args) {
    const page = pageOf(session);
    const chosen = await target(page, args).selectOption((args.values || []).map(String));
    return { selected: chosen, ...(await state(session)) };
  },
  async press(session, { key }) {
    const page = pageOf(session);
    await page.keyboard.press(String(key));
    await settle(page);
    return state(session);
  },
  async upload(session, args) {
    const page = pageOf(session);
    const files = (args.paths || []).map(String);
    for (const f of files) if (!fs.existsSync(f)) throw new Error(`${f} does not exist in the sandbox`);
    const el = target(page, args);
    // An <input type=file> takes the files directly; a button that opens the picker is clicked.
    const isInput = await el.evaluate((node) => node.tagName === "INPUT" && node.type === "file").catch(() => false);
    if (isInput) await el.setInputFiles(files);
    else {
      const [chooser] = await Promise.all([page.waitForEvent("filechooser", { timeout: 10_000 }), el.click()]);
      await chooser.setFiles(files);
    }
    await settle(page);
    return state(session);
  },
  async wait(session, { text, textGone, selector, seconds }) {
    const page = pageOf(session);
    const timeout = Math.min(Number(seconds) || 15, 60) * 1000;
    if (text) await page.getByText(String(text)).first().waitFor({ state: "visible", timeout });
    else if (textGone) await page.getByText(String(textGone)).first().waitFor({ state: "hidden", timeout });
    else if (selector) await page.locator(String(selector)).first().waitFor({ state: "visible", timeout });
    else await page.waitForTimeout(timeout);
    return state(session);
  },
  async eval(session, { expression, ref, selector }) {
    const page = pageOf(session);
    const code = String(expression || "");
    // An expression, or a function's source; with ref/selector the function gets the element.
    // (bypassCSP lets eval run on pages whose CSP forbids it.)
    const value = ref || selector
      ? await target(page, { ref, selector }).evaluate((el, src) => (0, eval)(`(${src})`)(el), code)
      : await page.evaluate(code);
    let json;
    try { json = JSON.stringify(value === undefined ? null : value); } catch { json = JSON.stringify(String(value)); }
    if (json.length > 40_000) json = `${json.slice(0, 40_000)}… [truncated]`;
    return { value: json, ...(await state(session, { withSnapshot: false })) };
  },
  async screenshot(session, { fullPage, ref, selector }) {
    const page = pageOf(session);
    const buf = ref || selector
      ? await target(page, { ref, selector }).screenshot({ type: "png" })
      : await page.screenshot({ type: "png", fullPage: Boolean(fullPage) });
    return { png: buf.toString("base64"), ...(await state(session, { withSnapshot: false })) };
  },
  async tabs(session, { action = "list", index, url }) {
    if (action === "new") {
      const page = await openTab(session);
      if (url) { await page.goto(String(url), { waitUntil: "domcontentloaded" }); await settle(page); }
    } else if (action === "select") {
      if (!session.pages[Number(index)]) throw new Error(`no tab ${index}`);
      session.current = Number(index);
      // Picked on purpose (e.g. the tab the owner opened): from now on this chat may work in it.
      if (session.live) { session.own ??= new WeakSet(); session.own.add(session.pages[session.current]); }
      await session.pages[session.current].bringToFront();
    } else if (action === "close") {
      const page = session.pages[index == null ? session.current : Number(index)];
      if (!page) throw new Error(`no tab ${index}`);
      await page.close();
    }
    const list = await Promise.all(session.pages.map(async (p, i) => ({ index: i, url: p.url(), title: await p.title().catch(() => ""), current: i === session.current, ...(session.live && !session.own?.has(p) ? { notMine: true } : {}) })));
    return { list, ...(await state(session, { withSnapshot: action !== "list" })) };
  },
  async console(session) {
    const events = session.events;
    session.events = [];
    return { events, ...(await state(session, { withSnapshot: false })) };
  },
};

async function act(body) {
  const id = String(body.session || "");
  if (!NAME_RE.test(id)) throw new Error("bad session");
  const scope = NAME_RE.test(String(body.scope || "")) ? String(body.scope) : "default";
  if (body.profile != null && body.profile !== "" && !NAME_RE.test(String(body.profile))) throw new Error("profile is letters, digits, . _ - (up to 64)");
  if (body.userAgent != null && body.userAgent !== "" && !UA_RE.test(String(body.userAgent))) throw new Error("userAgent is printable ASCII, up to 400 characters");
  if (body.action === "close") return { closed: await closeSession(id, { closeTabs: true }) };
  // Does this chat have a browser, and what is in it? Never opens one.
  if (body.action === "peek") {
    const s0 = sessions.get(id);
    if (!s0) return { exists: false };
    const page = s0.pages[s0.current];
    return { exists: true, tabs: s0.pages.length, url: page?.url() || null, title: page ? await page.title().catch(() => "") : null, viewers: s0.viewers || 0 };
  }
  // The owner's screen asks for the live browser: start it, and give it a tab if it has none.
  if (body.action === "live") {
    if (!LIVE) throw new Error("the live browser is off");
    const ctx = await getLive();
    if (!ctx.pages().length) await ctx.newPage();
    return { tabs: await Promise.all(ctx.pages().map(async (p) => ({ url: p.url(), title: await p.title().catch(() => "") }))) };
  }
  if (body.action === "profiles") {
    const dir = path.join(HOME, "profiles", scope);
    return { profiles: fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)) : [] };
  }
  const fn = ACTIONS[body.action];
  if (!fn) throw new Error(`unknown action ${body.action}`);
  const opening = body.action === "open";
  const session = await openSession(id, { scope, profile: opening ? (body.profile ?? undefined) : undefined, userAgent: opening && body.userAgent ? String(body.userAgent) : undefined });
  session.lastUsed = Date.now();
  if (session.live) await syncLive(session);
  const out = await fn(session, body);
  await saveProfile(session).catch(() => {});
  return { ...(session.profile ? { profile: session.profile } : {}), ...(opening ? { userAgent: session.userAgent } : {}), ...out };
}


// ---- the chat's browser on the owner's screen (browser-view.mjs) ------------------------------------
// One WebSocket per viewer: the current tab as JPEG frames (CDP screencast) plus its url/title/tabs, and
// the viewer's mouse, wheel, keys and navigation back into the same tab. The agent keeps working in it
// at the same time; when it switches tabs the stream follows. GET /stream?session=…&scope=… (Bearer).

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
function wsFrame(payload, opcode = 0x1) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const n = data.length;
  const head = n < 126 ? Buffer.from([0x80 | opcode, n]) : n < 65536 ? Buffer.alloc(4) : Buffer.alloc(10);
  if (n >= 126 && n < 65536) { head[0] = 0x80 | opcode; head[1] = 126; head.writeUInt16BE(n, 2); }
  if (n >= 65536) { head[0] = 0x80 | opcode; head[1] = 127; head.writeBigUInt64BE(BigInt(n), 2); }
  return Buffer.concat([head, data]);
}
function wsReader(max = 1 << 20) {
  let buf = Buffer.alloc(0);
  return (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    const out = [];
    for (;;) {
      if (buf.length < 2) break;
      const opcode = buf[0] & 0x0f;
      let len = buf[1] & 0x7f;
      let off = 2;
      if (len === 126) { if (buf.length < 4) break; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) break; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      if (len > max) throw new Error("frame too large");
      if (!(buf[1] & 0x80)) throw new Error("unmasked");
      if (buf.length < off + 4 + len) break;
      const mask = buf.subarray(off, off + 4);
      const data = Buffer.from(buf.subarray(off + 4, off + 4 + len));
      for (let i = 0; i < data.length; i += 1) data[i] ^= mask[i & 3];
      buf = buf.subarray(off + 4 + len);
      out.push({ opcode, data });
    }
    return out;
  };
}

const KEYCODES = { Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46, ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39, Home: 36, End: 35, PageUp: 33, PageDown: 34, " ": 32 };

async function stream(socket, { id, scope }) {
  const session = await openSession(id, { scope, profile: undefined, userAgent: undefined });
  if (session.live) await syncLive(session);
  if (!session.pages.length) await session.context.newPage();
  session.viewers = (session.viewers || 0) + 1;
  let closed = false;
  let cdp = null;
  let streaming = null;
  let lastState = "";
  const send = (obj) => { if (!closed) { try { socket.write(wsFrame(JSON.stringify(obj))); } catch {} } };
  const viewport = () => streaming?.viewportSize() || { width: 1366, height: 860 };

  async function follow() {
    const page = session.pages[session.current];
    if (!page || page === streaming || closed) return;
    if (cdp) { await cdp.send("Page.stopScreencast").catch(() => {}); await cdp.detach().catch(() => {}); }
    streaming = page;
    cdp = await session.context.newCDPSession(page).catch(() => null);
    if (!cdp) return;
    cdp.on("Page.screencastFrame", ({ data, metadata, sessionId }) => {
      send({ type: "frame", data, w: metadata?.deviceWidth, h: metadata?.deviceHeight });
      cdp?.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
    });
    const { width, height } = viewport();
    await cdp.send("Page.startScreencast", { format: "jpeg", quality: 70, maxWidth: width, maxHeight: height, everyNthFrame: 1 }).catch(() => {});
  }

  async function report() {
    const tabs = await Promise.all(session.pages.map(async (p, i) => ({ index: i, url: p.url(), title: await p.title().catch(() => "") })));
    const page = session.pages[session.current];
    const state = { type: "state", url: page?.url() || "", title: page ? await page.title().catch(() => "") : "", current: session.current, tabs, viewport: viewport() };
    const key = JSON.stringify(state);
    if (key !== lastState) { lastState = key; send(state); }
  }

  const tick = setInterval(async () => {
    if (closed) return;
    session.lastUsed = Date.now();
    if (session.live) await syncLive(session).catch(() => {});
    await follow().catch(() => {});
    await report().catch(() => {});
  }, 400);

  async function input(m) {
    const page = session.pages[session.current];
    if (!page) return;
    session.lastUsed = Date.now();
    const { width, height } = viewport();
    const x = Math.max(0, Math.min(1, Number(m.x) || 0)) * width;
    const y = Math.max(0, Math.min(1, Number(m.y) || 0)) * height;
    const modifiers = Number(m.modifiers) || 0;
    if (m.type === "mouse" && cdp) {
      const button = ["left", "middle", "right"][Number(m.button) || 0] || "left";
      const type = { down: "mousePressed", up: "mouseReleased", move: "mouseMoved" }[m.event];
      if (type) await cdp.send("Input.dispatchMouseEvent", { type, x, y, button: m.event === "move" ? "none" : button, buttons: m.event === "down" ? 1 : 0, clickCount: Number(m.clicks) || 1, modifiers }).catch(() => {});
    } else if (m.type === "wheel" && cdp) {
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: Number(m.dx) || 0, deltaY: Number(m.dy) || 0, modifiers }).catch(() => {});
    } else if (m.type === "key" && cdp) {
      const key = String(m.key || "");
      const printable = key.length === 1 && !(modifiers & (2 | 4));
      const vk = KEYCODES[key] ?? (key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0);
      const base = { modifiers, key, code: String(m.code || ""), windowsVirtualKeyCode: vk };
      if (m.event === "down") await cdp.send("Input.dispatchKeyEvent", { ...base, type: printable || key === "Enter" ? "keyDown" : "rawKeyDown", ...(printable ? { text: key } : key === "Enter" ? { text: "\r" } : {}) }).catch(() => {});
      else await cdp.send("Input.dispatchKeyEvent", { ...base, type: "keyUp" }).catch(() => {});
    } else if (m.type === "text" && cdp) {
      await cdp.send("Input.insertText", { text: String(m.text || "").slice(0, 4000) }).catch(() => {});
    } else if (m.type === "nav") {
      if (m.go === "back") await page.goBack().catch(() => {});
      else if (m.go === "forward") await page.goForward().catch(() => {});
      else if (m.go === "reload") await page.reload().catch(() => {});
      else if (/^https?:\/\//i.test(String(m.url || ""))) await page.goto(String(m.url)).catch((e) => send({ type: "error", error: e.message.split("\n")[0] }));
    } else if (m.type === "tab") {
      if (m.action === "new") { const p = await session.context.newPage(); session.current = session.pages.indexOf(p); if (/^https?:\/\//i.test(String(m.url || ""))) await p.goto(String(m.url)).catch(() => {}); }
      else if (m.action === "close") await session.pages[Number(m.index ?? session.current)]?.close().catch(() => {});
      else if (session.pages[Number(m.index)]) session.current = Number(m.index);
    }
  }

  const read = wsReader();
  socket.on("data", (chunk) => {
    let msgs;
    try { msgs = read(chunk); } catch { return socket.destroy(); }
    for (const { opcode, data } of msgs) {
      if (opcode === 0x8) return socket.destroy();
      if (opcode === 0x9) { try { socket.write(wsFrame(data, 0xa)); } catch {} continue; }
      if (opcode !== 0x1) continue;
      let m;
      try { m = JSON.parse(data.toString("utf8")); } catch { continue; }
      input(m).catch(() => {});
    }
  });
  const done = async () => {
    if (closed) return;
    closed = true;
    clearInterval(tick);
    session.viewers = Math.max(0, (session.viewers || 1) - 1);
    if (cdp) { await cdp.send("Page.stopScreencast").catch(() => {}); await cdp.detach().catch(() => {}); }
    // A login the owner typed by hand is kept under the chat's profile, if it has one.
    await saveProfile(session).catch(() => {});
  };
  socket.on("close", done);
  socket.on("error", done);
  await follow();
  await report();
}

// Idle chats give their memory back; with nothing open the browser itself goes too. A chat someone is
// watching is not idle.
setInterval(async () => {
  for (const [id, s] of sessions) if (!s.viewers && Date.now() - s.lastUsed > IDLE_MS) await closeSession(id);
  if (!sessions.size && browser) { const b = browser; browser = null; await b.close().catch(() => {}); }
}, 60_000).unref();

const server = http.createServer(async (req, res) => {
  const send = (code, value) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
  if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { error: "unauthorized" });
  if (req.method === "GET" && req.url === "/health") return send(200, { ok: true, version: VERSION, sessions: sessions.size, browser: Boolean(browser), live: LIVE ? { on: Boolean(live), tabs: live ? live.pages().length : 0 } : null });
  if (req.method !== "POST" || req.url !== "/act") return send(404, { error: "not found" });
  let raw = "";
  for await (const chunk of req) { raw += chunk; if (raw.length > 1_000_000) return send(413, { error: "too large" }); }
  try {
    send(200, await act(JSON.parse(raw || "{}")));
  } catch (error) {
    send(200, { error: String(error?.message || error).split("\n").slice(0, 6).join("\n") });
  }
});
server.on("upgrade", (req, socket) => {
  let url;
  try { url = new URL(req.url, "http://x"); } catch { return socket.destroy(); }
  const id = url.searchParams.get("session") || "";
  const scope = url.searchParams.get("scope") || "default";
  if (req.headers.authorization !== `Bearer ${TOKEN}` || url.pathname !== "/stream" || !NAME_RE.test(id) || !NAME_RE.test(scope) || !req.headers["sec-websocket-key"]) {
    socket.end("HTTP/1.1 403 Forbidden\r\nconnection: close\r\n\r\n");
    return;
  }
  const accept = crypto.createHash("sha1").update(`${req.headers["sec-websocket-key"]}${WS_GUID}`).digest("base64");
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  socket.setNoDelay(true);
  stream(socket, { id, scope }).catch((e) => { try { socket.write(wsFrame(JSON.stringify({ type: "error", error: String(e?.message || e) }))); } catch {} socket.destroy(); });
});
server.listen(PORT, "0.0.0.0", () => console.log(`browser daemon ${VERSION} on :${PORT}`));
