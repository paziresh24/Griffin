// Runs INSIDE the sandbox, never in the app (browser.mjs writes it there and starts it): one headless
// Chromium driven by Playwright, a browser context per chat, so agents can test pages and use web
// panels that have no API. The app reaches it over the sandbox's bridge address with a random token;
// the port is not published anywhere. No dependency but playwright-core (PW_MODULE) and Chromium
// (CHROMIUM). One JSON request per action: POST /act {session, action, ...args} -> JSON.
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

if (!TOKEN) throw new Error("TOKEN is required");
const { chromium } = await import(process.env.PW_MODULE || path.join(HOME, "node_modules/playwright-core/index.mjs"));

let browser = null;
/** @type {Map<string, {context, pages: any[], current: number, profile: string|null, lastUsed: number, events: string[]}>} */
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

const profileFile = (scope, name) => path.join(HOME, "profiles", scope, `${name}.json`);

function note(session, line) {
  session.events.push(line.slice(0, 500));
  if (session.events.length > 200) session.events.splice(0, session.events.length - 200);
}

function watchPage(session, page) {
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
    const i = session.pages.indexOf(page);
    if (i >= 0) session.pages.splice(i, 1);
    if (session.current >= session.pages.length) session.current = Math.max(0, session.pages.length - 1);
  });
}

async function closeSession(id) {
  const session = sessions.get(id);
  if (!session) return false;
  sessions.delete(id);
  await saveProfile(session).catch(() => {});
  await session.context.close().catch(() => {});
  return true;
}

async function saveProfile(session) {
  if (!session.profile) return;
  const file = profileFile(session.scope, session.profile);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  await session.context.storageState({ path: file });
  fs.chmodSync(file, 0o600);
}

async function openSession(id, { scope, profile }) {
  const existing = sessions.get(id);
  if (existing && (profile === undefined || existing.profile === (profile || null))) return existing;
  if (existing) await closeSession(id);
  while (sessions.size >= MAX_SESSIONS) {
    const oldest = [...sessions.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0][0];
    await closeSession(oldest);
  }
  const b = await getBrowser();
  const stored = profile ? profileFile(scope, profile) : null;
  const context = await b.newContext({
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
  const session = { context, pages: [], current: 0, scope, profile: profile || null, lastUsed: Date.now(), events: [] };
  context.on("page", (page) => {
    session.pages.push(page);
    session.current = session.pages.length - 1;
    watchPage(session, page);
  });
  sessions.set(id, session);
  await context.newPage();
  return session;
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
    if (newTab || !page) page = await session.context.newPage();
    session.current = session.pages.indexOf(page);
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
      const page = await session.context.newPage();
      session.current = session.pages.indexOf(page);
      if (url) { await page.goto(String(url), { waitUntil: "domcontentloaded" }); await settle(page); }
    } else if (action === "select") {
      if (!session.pages[Number(index)]) throw new Error(`no tab ${index}`);
      session.current = Number(index);
      await session.pages[session.current].bringToFront();
    } else if (action === "close") {
      const page = session.pages[index == null ? session.current : Number(index)];
      if (!page) throw new Error(`no tab ${index}`);
      await page.close();
    }
    const list = await Promise.all(session.pages.map(async (p, i) => ({ index: i, url: p.url(), title: await p.title().catch(() => ""), current: i === session.current })));
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
  if (body.action === "close") return { closed: await closeSession(id) };
  if (body.action === "profiles") {
    const dir = path.join(HOME, "profiles", scope);
    return { profiles: fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)) : [] };
  }
  const fn = ACTIONS[body.action];
  if (!fn) throw new Error(`unknown action ${body.action}`);
  const session = await openSession(id, { scope, profile: body.action === "open" ? (body.profile ?? undefined) : undefined });
  session.lastUsed = Date.now();
  const out = await fn(session, body);
  await saveProfile(session).catch(() => {});
  return { ...(session.profile ? { profile: session.profile } : {}), ...out };
}

// Idle chats give their memory back; with nothing open the browser itself goes too.
setInterval(async () => {
  for (const [id, s] of sessions) if (Date.now() - s.lastUsed > IDLE_MS) await closeSession(id);
  if (!sessions.size && browser) { const b = browser; browser = null; await b.close().catch(() => {}); }
}, 60_000).unref();

const server = http.createServer(async (req, res) => {
  const send = (code, value) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
  if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { error: "unauthorized" });
  if (req.method === "GET" && req.url === "/health") return send(200, { ok: true, version: VERSION, sessions: sessions.size, browser: Boolean(browser) });
  if (req.method !== "POST" || req.url !== "/act") return send(404, { error: "not found" });
  let raw = "";
  for await (const chunk of req) { raw += chunk; if (raw.length > 1_000_000) return send(413, { error: "too large" }); }
  try {
    send(200, await act(JSON.parse(raw || "{}")));
  } catch (error) {
    send(200, { error: String(error?.message || error).split("\n").slice(0, 6).join("\n") });
  }
});
server.listen(PORT, "0.0.0.0", () => console.log(`browser daemon ${VERSION} on :${PORT}`));
