// Griffin — مرورگر من. The service worker: one WebSocket out to the owner's Griffin server (so a laptop
// behind NAT is reachable), and every command it sends is run here on real tabs through chrome.debugger
// (the DevTools protocol): tabs and groups through chrome.tabs / chrome.tabGroups, pages through CDP
// (accessibility tree for reading, Input.* for real mouse and keyboard, Runtime for JS, Network / Runtime /
// Log events kept per tab for debugging). Each tab it works in carries a badge at the top: «گریفین در حال
// کنترل این تب است» with a stop button that pauses the extension.

const GROUP_TITLE = "گریفین";
const BADGE_ID = "__griffin_control_badge__";
const IDLE_DETACH_MS = 10 * 60_000;
const MAX_CONSOLE = 400;
const MAX_REQUESTS = 600;
const SNAPSHOT_CHARS = 14_000;
const PROTOCOL = "1.3";

let ws = null;
let state = "off"; // off | connecting | on | paused | error
let lastError = "";
let pairWaiter = null;
let currentTab = null;
const attached = new Map(); // tabId -> { lastUsed, console: [], reported: 0, net: Map }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cfg = () => chrome.storage.local.get(["server", "token", "enabled", "label", "deviceId"]);

function wsUrl(server) {
  const u = new URL(server);
  u.protocol = u.protocol === "http:" ? "ws:" : "wss:";
  u.pathname = "/api/mybrowser/ws";
  u.search = "";
  u.hash = "";
  return u.toString();
}

function defaultLabel() {
  const ua = navigator.userAgent;
  const brand = /Edg\//.test(ua) ? "Edge" : /OPR\//.test(ua) ? "Opera" : "Chrome";
  const os = /Mac OS X/.test(ua) ? "macOS" : /Windows/.test(ua) ? "Windows" : /CrOS/.test(ua) ? "ChromeOS" : /Linux/.test(ua) ? "Linux" : "";
  return os ? `${brand} · ${os}` : brand;
}

function setState(next, error = "") {
  state = next;
  if (error) lastError = error;
  if (next === "on") lastError = "";
  const badge = { on: ["", "#f97316"], connecting: ["…", "#a3a3a3"], paused: ["II", "#737373"], error: ["!", "#dc2626"], off: ["", "#737373"] }[next] || ["", "#737373"];
  chrome.action.setBadgeText({ text: badge[0] }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ color: badge[1] }).catch(() => {});
  chrome.runtime.sendMessage({ type: "state", state, error: lastError }).catch(() => {});
}

// ---- the connection -----------------------------------------------------------------------------

async function connect({ pairCode = null } = {}) {
  const c = await cfg();
  if (!c.server) return;
  if (!pairCode && (!c.enabled || !c.token)) return;
  if (ws && ws.readyState <= 1) {
    if (!pairCode) return;
    try { ws.close(); } catch {}
  }
  let sock;
  try { sock = new WebSocket(wsUrl(c.server)); } catch (e) { setState("error", String(e.message || e)); return; }
  ws = sock;
  setState("connecting");
  const info = { version: chrome.runtime.getManifest().version, browser: (navigator.userAgent.match(/(Edg|OPR|Chrome)\/[\d.]+/) || ["Chromium"])[0], label: c.label || defaultLabel() };
  sock.onopen = () => sock.send(JSON.stringify(pairCode ? { type: "pair", code: pairCode, ...info } : { type: "hello", token: c.token, ...info }));
  sock.onmessage = (e) => onMessage(sock, e.data);
  sock.onerror = () => { if (ws === sock && state === "connecting") lastError = "could not reach the server"; };
  sock.onclose = () => {
    if (ws !== sock) return;
    ws = null;
    if (pairWaiter) { pairWaiter({ ok: false, error: lastError || "the server closed the connection" }); pairWaiter = null; }
    if (state !== "paused") setState(lastError ? "error" : "off", lastError);
  };
}

async function onMessage(sock, data) {
  let m;
  try { m = JSON.parse(data); } catch { return; }
  if (m.type === "paired") {
    await chrome.storage.local.set({ token: m.token, deviceId: m.deviceId, label: m.label, enabled: true });
    setState("on");
    if (pairWaiter) { pairWaiter({ ok: true, label: m.label }); pairWaiter = null; }
    return;
  }
  if (m.type === "welcome") { setState("on"); return noteLatest(m.latest); }
  if (m.type === "pong") return;
  if (m.type === "error") {
    lastError = m.error || "error";
    if (m.unpaired) await chrome.storage.local.remove(["token", "deviceId"]);
    setState("error", lastError);
    return;
  }
  if (m.id != null && m.cmd) {
    let reply;
    try {
      reply = { id: m.id, ok: true, result: await handle(m.cmd, m.args || {}) };
    } catch (e) {
      reply = { id: m.id, ok: false, error: String(e?.message || e).slice(0, 1200) };
    }
    try { sock.send(JSON.stringify(reply)); } catch {}
  }
}

// The server hands out a newer version: an orange «↑» on the icon and a line in the popup until reloaded.
let latest = null;
const newer = (a, b) => { const x = String(a).split(".").map(Number); const y = String(b).split(".").map(Number); for (let i = 0; i < 3; i += 1) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); return false; };
function noteLatest(version) {
  latest = version && newer(version, chrome.runtime.getManifest().version) ? version : null;
  if (latest) { chrome.action.setBadgeText({ text: "↑" }).catch(() => {}); chrome.action.setBadgeBackgroundColor({ color: "#f97316" }).catch(() => {}); }
}

// A WebSocket message every 20 s keeps the service worker alive (Chrome 116+); the alarm brings the
// connection back after Chrome restarts it, and gives idle tabs back.
setInterval(() => { if (ws?.readyState === 1) ws.send(JSON.stringify({ type: "ping" })); }, 20_000);
chrome.alarms.create("griffin-tick", { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener(async () => {
  for (const [tabId, rec] of attached) if (Date.now() - rec.lastUsed > IDLE_DETACH_MS) await detach(tabId);
  connect();
});
chrome.runtime.onStartup.addListener(() => connect());
// A fresh install from Settings knows its Griffin: open the page where one click pairs it.
chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  connect();
  const server = await bakedServer();
  const c = await cfg();
  if (reason === "install" && server && !c.token) chrome.tabs.create({ url: `${server}/#/settings/mybrowser` });
});
connect();

async function pause() {
  await chrome.storage.local.set({ enabled: false });
  for (const tabId of [...attached.keys()]) await detach(tabId);
  setState("paused");
  if (ws) { const s = ws; ws = null; try { s.close(); } catch {} }
}

// The Griffin address baked into a download from Settings (config.json, no secret): pages on it may pair
// without asking. Any other page that asks is confirmed by the owner in an extension window first, so a
// random site can never point this browser at its own server.
let baked = null;
const bakedServer = async () => {
  if (baked !== null) return baked;
  try { baked = (await (await fetch(chrome.runtime.getURL("config.json"))).json()).server || ""; } catch { baked = ""; }
  return baked;
};

function checkServer(raw) {
  const u = new URL(String(raw || "").trim());
  if (u.protocol !== "https:" && !(u.protocol === "http:" && /^(localhost|127\.|10\.|192\.168\.|172\.)/.test(u.hostname))) throw new Error("https:// address needed");
  return u.origin;
}

async function pair(server, code, label) {
  await chrome.storage.local.set({ server, label: String(label || "").trim() || defaultLabel() });
  lastError = "";
  const done = new Promise((resolve) => { pairWaiter = resolve; setTimeout(() => resolve({ ok: false, error: "no answer from the server" }), 15_000); });
  await connect({ pairCode: String(code || "") });
  return done;
}

let confirming = null; // { origin, resolve }
async function confirmOrigin(origin) {
  const c = await cfg();
  if (origin === (await bakedServer()) || (c.token && origin === c.server)) return true;
  if (confirming) return false;
  return new Promise((resolve) => {
    confirming = { origin, resolve };
    chrome.windows.create({ url: chrome.runtime.getURL(`confirm.html#${encodeURIComponent(origin)}`), type: "popup", width: 420, height: 300, focused: true }, (win) => {
      const gone = (id) => { if (id === win?.id && confirming?.resolve === resolve) { confirming = null; resolve(false); chrome.windows.onRemoved.removeListener(gone); } };
      chrome.windows.onRemoved.addListener(gone);
    });
  });
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  (async () => {
    const fromExtension = sender.id === chrome.runtime.id && String(sender.url || "").startsWith(chrome.runtime.getURL(""));
    if (msg.type === "pageHello" || msg.type === "pagePair") {
      const origin = sender.origin || new URL(sender.url).origin;
      const c = await cfg();
      const here = Boolean(c.token) && c.server === origin;
      if (msg.type === "pageHello") return { version: chrome.runtime.getManifest().version, paired: here, state: here ? state : null, label: c.label || defaultLabel() };
      if (here && state === "on") return { ok: true, label: c.label };
      if (!(await confirmOrigin(origin))) return { ok: false, error: "not confirmed" };
      return pair(checkServer(origin), msg.code, c.label);
    }
    if (msg.type === "stop" && sender.tab) { await pause(); return { ok: true }; }
    if (!fromExtension) return { ok: false };
    if (msg.type === "confirmAnswer") {
      if (confirming) { const { resolve } = confirming; confirming = null; resolve(Boolean(msg.yes)); }
      return { ok: true };
    }
    if (msg.type === "status") {
      const c = await cfg();
      return { state, error: lastError, server: c.server || (await bakedServer()), label: c.label || defaultLabel(), paired: Boolean(c.token), enabled: Boolean(c.enabled), controlled: attached.size, version: chrome.runtime.getManifest().version, latest };
    }
    if (msg.type === "pair") {
      let server;
      try { server = checkServer(msg.server); } catch (e) { return { ok: false, error: `bad address: ${e.message}` }; }
      return pair(server, msg.code, msg.label);
    }
    if (msg.type === "pause" || msg.type === "stop") { await pause(); return { ok: true }; }
    if (msg.type === "resume") { await chrome.storage.local.set({ enabled: true }); lastError = ""; await connect(); return { ok: true }; }
    if (msg.type === "unpair") {
      await pause();
      await chrome.storage.local.remove(["token", "deviceId"]);
      setState("off");
      return { ok: true };
    }
    return { ok: false };
  })().then(reply, (e) => reply({ ok: false, error: String(e?.message || e) }));
  return true;
});

// ---- tabs, the debugger, the badge ----------------------------------------------------------------

const cdp = (tabId, method, params = {}) => chrome.debugger.sendCommand({ tabId }, method, params);

const RESTRICTED = /^(chrome|edge|brave|opera|vivaldi|chrome-extension|chrome-search|devtools|view-source):/i;

async function resolveTab(args = {}) {
  const ids = [args.tabId, currentTab].filter((v) => v != null);
  for (const id of ids) {
    try { const tab = await chrome.tabs.get(Number(id)); currentTab = tab.id; return tab; } catch {
      if (id === args.tabId) throw new Error(`no tab ${id}: take chrome_tabs list`);
    }
  }
  const own = await griffinWindow({ create: false });
  const [tab] = own ? await chrome.tabs.query({ active: true, windowId: own.id }) : await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab) throw new Error("no open tab");
  currentTab = tab.id;
  return tab;
}

async function ensureAttached(tabId) {
  const rec = attached.get(tabId);
  if (rec) { rec.lastUsed = Date.now(); return rec; }
  const tab = await chrome.tabs.get(tabId);
  const url = tab.pendingUrl || tab.url || "";
  if (RESTRICTED.test(url) || /^https:\/\/chromewebstore\.google\.com/.test(url)) throw new Error(`Chrome does not let extensions control this page (${url})`);
  try {
    await chrome.debugger.attach({ tabId }, PROTOCOL);
  } catch (e) {
    // Still attached from before the service worker restarted: take it over again.
    if (!/already attached/i.test(String(e.message))) throw e;
    try { await chrome.debugger.detach({ tabId }); } catch {}
    await chrome.debugger.attach({ tabId }, PROTOCOL);
  }
  const fresh = { lastUsed: Date.now(), console: [], reported: 0, net: new Map() };
  attached.set(tabId, fresh);
  await Promise.all(["Page.enable", "Runtime.enable", "Network.enable", "Log.enable", "Accessibility.enable"].map((m) => cdp(tabId, m).catch(() => {})));
  await cdp(tabId, "Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {});
  await badge(tabId, true);
  return fresh;
}

async function detach(tabId) {
  attached.delete(tabId);
  await badge(tabId, false);
  try { await chrome.debugger.detach({ tabId }); } catch {}
}

chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId == null) return;
  attached.delete(source.tabId);
  badge(source.tabId, false);
});
chrome.tabs.onRemoved.addListener((tabId) => { attached.delete(tabId); if (currentTab === tabId) currentTab = null; });
chrome.tabs.onUpdated.addListener((tabId, change) => { if (change.status === "complete" && attached.has(tabId)) badge(tabId, true); });

// The badge lives in the page (a closed shadow root, aria-hidden so the snapshot never sees it).
function badgeFn(show, id) {
  let host = document.getElementById(id);
  if (!show) { if (host) host.remove(); return; }
  if (host) { host.style.visibility = ""; return; }
  host = document.createElement("div");
  host.id = id;
  host.setAttribute("aria-hidden", "true");
  host.style.cssText = "all:initial;position:fixed;top:0;left:50%;transform:translateX(-50%);z-index:2147483647;";
  const root = host.attachShadow({ mode: "closed" });
  root.innerHTML = `<style>
    .b{display:flex;align-items:center;gap:8px;padding:3px 10px 4px;background:#f97316;color:#fff;font:600 12px/1.7 Vazirmatn,Tahoma,"Segoe UI",system-ui,sans-serif;border-radius:0 0 10px 10px;box-shadow:0 2px 10px rgba(0,0,0,.25);direction:rtl;white-space:nowrap;user-select:none}
    .d{width:7px;height:7px;border-radius:50%;background:#fff;animation:p 1.4s ease-in-out infinite}
    @keyframes p{50%{opacity:.3}}
    button{all:unset;cursor:pointer;background:rgba(0,0,0,.2);padding:0 8px;border-radius:6px}
    button:hover{background:rgba(0,0,0,.35)}
  </style><div class="b"><span class="d"></span><span>گریفین در حال کنترل این تب است</span><button type="button" title="Griffin را متوقف کن">توقف</button></div>`;
  root.querySelector("button").addEventListener("click", () => chrome.runtime.sendMessage({ type: "stop" }));
  (document.body || document.documentElement).appendChild(host);
}

async function badge(tabId, show) {
  try { await chrome.scripting.executeScript({ target: { tabId }, func: badgeFn, args: [show, BADGE_ID] }); } catch {}
}

// Out of the way for a screenshot or a click under it; back afterwards.
const badgeVisibility = (tabId, visible) =>
  cdp(tabId, "Runtime.evaluate", { expression: `(()=>{const b=document.getElementById(${JSON.stringify(BADGE_ID)});if(b)b.style.visibility=${visible ? "''" : "'hidden'"}})()` }).catch(() => {});

// Griffin's own window (owner 2026-10-31: «یه مرورگر جدید باز کنی و کلا توی اون کار کنی»): every tab it
// opens goes there, so its work never mixes with the owner's own tabs. Its id survives a service-worker
// restart (storage.session); closed by the owner, the next open makes a new one.
async function griffinWindow({ create = true } = {}) {
  const { griffinWindowId } = await chrome.storage.session.get("griffinWindowId");
  if (griffinWindowId != null) {
    try { return await chrome.windows.get(griffinWindowId, { populate: true }); } catch {}
  }
  if (!create) return null;
  const win = await chrome.windows.create({ url: "about:blank", type: "normal", focused: true, state: "normal" });
  await chrome.storage.session.set({ griffinWindowId: win.id });
  return chrome.windows.get(win.id, { populate: true });
}
chrome.windows.onRemoved.addListener(async (id) => {
  const { griffinWindowId } = await chrome.storage.session.get("griffinWindowId");
  if (id === griffinWindowId) await chrome.storage.session.remove("griffinWindowId");
});

async function addToGroup(tabId) {
  const tab = await chrome.tabs.get(tabId);
  const [group] = await chrome.tabGroups.query({ title: GROUP_TITLE, windowId: tab.windowId });
  if (group) await chrome.tabs.group({ groupId: group.id, tabIds: [tabId] });
  else {
    const groupId = await chrome.tabs.group({ tabIds: [tabId], createProperties: { windowId: tab.windowId } });
    await chrome.tabGroups.update(groupId, { title: GROUP_TITLE, color: "orange" });
  }
}

async function waitLoaded(tabId, ms = 30_000) {
  await sleep(250);
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab || tab.status === "complete") return;
    await sleep(200);
  }
}

// ---- DevTools events, kept per tab ----------------------------------------------------------------

function remote(a) {
  if (!a) return "";
  if ("value" in a) return typeof a.value === "string" ? a.value : JSON.stringify(a.value);
  if (a.unserializableValue) return a.unserializableValue;
  if (a.preview?.properties) return `${a.preview.description || a.className || "Object"} {${a.preview.properties.map((p) => `${p.name}: ${p.value}`).join(", ")}${a.preview.overflow ? ", …" : ""}}`;
  return a.description || a.type || "";
}
const where = (url, line) => (url ? `${url}${line != null ? `:${line + 1}` : ""}` : undefined);

chrome.debugger.onEvent.addListener((source, method, p) => {
  const rec = attached.get(source.tabId);
  if (!rec) return;
  const log = (entry) => { rec.console.push({ at: new Date().toISOString(), ...entry }); if (rec.console.length > MAX_CONSOLE) { rec.console.splice(0, rec.console.length - MAX_CONSOLE); rec.reported = Math.max(0, rec.reported - 1); } };
  if (method === "Runtime.consoleAPICalled") {
    const frame = p.stackTrace?.callFrames?.[0];
    log({ level: p.type, text: (p.args || []).map(remote).join(" ").slice(0, 2000), source: where(frame?.url, frame?.lineNumber) });
  } else if (method === "Runtime.exceptionThrown") {
    const d = p.exceptionDetails || {};
    log({ level: "exception", text: String(d.exception?.description || d.text || "").slice(0, 2000), source: where(d.url, d.lineNumber) });
  } else if (method === "Log.entryAdded") {
    const e = p.entry || {};
    log({ level: `browser.${e.level}`, text: String(e.text || "").slice(0, 2000), source: e.url });
  } else if (method === "Network.requestWillBeSent") {
    const old = rec.net.get(p.requestId);
    if (old && p.redirectResponse) { old.redirects = [...(old.redirects || []), { url: old.url, status: p.redirectResponse.status }]; }
    const entry = old || { requestId: p.requestId };
    Object.assign(entry, { method: p.request.method, url: p.request.url, type: p.type, start: p.timestamp, requestHeaders: p.request.headers, hasPostData: Boolean(p.request.hasPostData), postData: postDataOf(p.request), initiator: p.initiator?.type });
    rec.net.set(p.requestId, entry);
    if (rec.net.size > MAX_REQUESTS) rec.net.delete(rec.net.keys().next().value);
  } else if (method === "Network.responseReceived") {
    const entry = rec.net.get(p.requestId);
    if (entry) Object.assign(entry, { status: p.response.status, statusText: p.response.statusText, mimeType: p.response.mimeType, responseHeaders: p.response.headers, remote: p.response.remoteIPAddress, protocol: p.response.protocol, fromCache: p.response.fromDiskCache || p.response.fromServiceWorker || p.response.fromPrefetchCache || undefined });
  } else if (method === "Network.loadingFinished") {
    const entry = rec.net.get(p.requestId);
    if (entry) Object.assign(entry, { size: p.encodedDataLength, ms: Math.round((p.timestamp - entry.start) * 1000) });
  } else if (method === "Network.loadingFailed") {
    const entry = rec.net.get(p.requestId);
    if (entry) Object.assign(entry, { failed: true, errorText: p.errorText, canceled: p.canceled || undefined, blockedReason: p.blockedReason, ms: Math.round((p.timestamp - entry.start) * 1000) });
    if (entry && !p.canceled) log({ level: "network", text: `${entry.method} ${entry.url} failed: ${p.errorText}${p.blockedReason ? ` (${p.blockedReason})` : ""}` });
  }
});

// The body is in the event itself (postData, or base64 postDataEntries on newer Chrome); asked for later
// it is usually gone.
function postDataOf(req) {
  if (typeof req.postData === "string") return req.postData.slice(0, 16_000);
  if (!req.postDataEntries?.length) return undefined;
  try {
    const bytes = Uint8Array.from(req.postDataEntries.map((e) => atob(e.bytes || "")).join(""), (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes).slice(0, 16_000);
  } catch { return undefined; }
}

// New console errors and failed or 4xx/5xx requests since the last answer, for the agent to notice.
function freshEvents(rec, since) {
  const out = rec.console.slice(rec.reported).filter((e) => /error|exception|network|assert/.test(e.level)).map((e) => `${e.level}: ${e.text}`.slice(0, 300));
  rec.reported = rec.console.length;
  for (const e of rec.net.values()) if (e.start * 1000 >= since - 50 && e.status >= 400 && e.type !== "Ping") out.push(`http ${e.status}: ${e.method} ${e.url}`.slice(0, 300));
  return out.slice(-12);
}

// ---- reading the page -----------------------------------------------------------------------------

const SKIP = new Set(["generic", "none", "presentation", "InlineTextBox", "LineBreak", "GenericContainer", "Ignored"]);
const PROPS = new Set(["checked", "expanded", "selected", "disabled", "focused", "required", "level", "pressed", "readonly", "invalid", "url", "modal"]);
const quote = (s) => JSON.stringify(String(s).replace(/\s+/g, " ").trim().slice(0, 200));

function renderTree(nodes, { depth, indent = 0 } = {}) {
  const byId = new Map(nodes.map((n) => [n.nodeId, n]));
  const root = nodes.find((n) => !n.parentId) || nodes[0];
  const lines = [];
  const walk = (n, d) => {
    if (!n) return;
    const role = n.role?.value || "";
    const name = String(n.name?.value ?? "").trim();
    const kids = (n.childIds || []).map((id) => byId.get(id));
    if (n.ignored || role === "RootWebArea" || (SKIP.has(role) && !name)) { for (const k of kids) walk(k, d); return; }
    if (depth && d >= depth) return;
    const pad = "  ".repeat(d + indent);
    if (role === "StaticText") { if (name) lines.push(`${pad}- text: ${quote(name)}`); return; }
    let line = `${pad}- ${role}${name ? ` ${quote(name)}` : ""}`;
    const value = n.value?.value;
    if (value != null && value !== "" && String(value) !== name) line += `: ${quote(value)}`;
    for (const p of n.properties || []) {
      if (!PROPS.has(p.name)) continue;
      const v = p.value?.value;
      if (v === false || v === "false" || v == null || v === "") continue;
      if (p.name === "url") { if (role === "link") line += ` <${String(v).slice(0, 160)}>`; continue; }
      line += v === true || v === "true" ? ` [${p.name}]` : ` [${p.name}=${v}]`;
    }
    if (n.backendDOMNodeId) line += ` [ref=e${n.backendDOMNodeId}]`;
    lines.push(line);
    const onlyText = name && kids.every((k) => !k || ["StaticText", "InlineTextBox"].includes(k.role?.value));
    if (!onlyText) for (const k of kids) walk(k, d + 1);
  };
  walk(root, 0);
  return lines;
}

async function snapshot(tabId, { depth, maxChars } = {}) {
  const { nodes } = await cdp(tabId, "Accessibility.getFullAXTree", {});
  const lines = renderTree(nodes || [], { depth });
  // Same-process iframes: their own tree under a header (cross-site frames run elsewhere and are left out).
  try {
    const { frameTree } = await cdp(tabId, "Page.getFrameTree");
    const frames = [];
    const collect = (t) => { for (const c of t.childFrames || []) { frames.push(c.frame); collect(c); } };
    collect(frameTree);
    for (const f of frames.slice(0, 8)) {
      try {
        const sub = await cdp(tabId, "Accessibility.getFullAXTree", { frameId: f.id });
        const inner = renderTree(sub.nodes || [], { depth, indent: 1 });
        if (inner.length) lines.push(`- iframe ${quote(f.url)}`, ...inner);
      } catch {}
    }
  } catch {}
  let text = lines.join("\n");
  const cap = Number(maxChars) || SNAPSHOT_CHARS;
  if (text.length > cap) text = `${text.slice(0, cap)}\n… [${text.length - cap} more characters: chrome_snapshot with depth, or chrome_eval to read one part]`;
  return text;
}

async function pageState(tabId, { withSnapshot = true, depth, maxChars, since = Date.now() } = {}) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) return { tabId, closed: true };
  const out = { tabId, url: tab.url, title: tab.title, ...(tab.status !== "complete" ? { loading: true } : {}) };
  const rec = attached.get(tabId);
  if (rec) { const events = freshEvents(rec, since); if (events.length) out.events = events; }
  if (withSnapshot && rec) out.snapshot = await snapshot(tabId, { depth, maxChars }).catch((e) => `(snapshot failed: ${e.message})`);
  return out;
}

// ---- acting on the page ---------------------------------------------------------------------------

async function call(tabId, objectId, fn, args = []) {
  const r = await cdp(tabId, "Runtime.callFunctionOn", { objectId, functionDeclaration: String(fn), arguments: args.map((value) => ({ value })), returnByValue: true, awaitPromise: true, userGesture: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text || "script error");
  return r.result?.value;
}

async function resolveRef(tabId, ref) {
  const id = Number(String(ref || "").replace(/^\[?(ref=)?e?/, "").replace(/\]$/, ""));
  if (!id) throw new Error("ref is like e123 (from chrome_snapshot)");
  try {
    const { object } = await cdp(tabId, "DOM.resolveNode", { backendNodeId: id });
    return object.objectId;
  } catch {
    await cdp(tabId, "DOM.getDocument", { depth: 0 }).catch(() => {});
    try { const { object } = await cdp(tabId, "DOM.resolveNode", { backendNodeId: id }); return object.objectId; } catch {}
    throw new Error(`ref ${ref} is gone (the page changed): take a new chrome_snapshot`);
  }
}

// The element under some visible text, smallest first, clickable things preferred.
async function findByText(tabId, text) {
  const r = await cdp(tabId, "Runtime.evaluate", {
    expression: `(() => { const want = ${JSON.stringify(String(text))}.toLowerCase(); const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      const all = [...document.querySelectorAll("a,button,[role=button],[role=link],[role=menuitem],[role=tab],[role=option],input[type=submit],input[type=button],label,summary,li,td,span,div,p,h1,h2,h3,h4")];
      const hits = all.filter((e) => vis(e) && ((e.innerText || e.value || "").toLowerCase().includes(want) || (e.getAttribute("aria-label") || "").toLowerCase().includes(want)));
      const score = (e) => (e.matches("a,button,[role=button],[role=link],[role=menuitem],[role=tab],[role=option],input,summary,label") ? 0 : 1e6) + (e.innerText || "").length;
      hits.sort((a, b) => score(a) - score(b)); return hits[0] || null; })()`,
  });
  if (!r.result?.objectId) throw new Error(`no visible element with the text «${text}»`);
  return r.result.objectId;
}

async function point(tabId, objectId) {
  const p = await call(tabId, objectId, function (badgeId) {
    const el = this.nodeType === 1 ? this : this.parentElement;
    if (!el) return null;
    el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    const r = el.getBoundingClientRect();
    let x = r.left + r.width / 2;
    let y = r.top + r.height / 2;
    let win = el.ownerDocument.defaultView;
    while (win && win.frameElement) {
      const f = win.frameElement.getBoundingClientRect();
      x += f.left + win.frameElement.clientLeft;
      y += f.top + win.frameElement.clientTop;
      win = win.parent;
    }
    const b = document.getElementById(badgeId);
    if (b) b.style.visibility = "hidden";
    return { x, y, w: r.width, h: r.height };
  }, [BADGE_ID]);
  if (!p || (p.w === 0 && p.h === 0)) throw new Error("the element is not visible on the page");
  return p;
}

const mouse = (tabId, type, x, y, extra = {}) => cdp(tabId, "Input.dispatchMouseEvent", { type, x, y, ...extra });

async function click(tabId, objectId, { button = "left", double = false } = {}) {
  const { x, y } = await point(tabId, objectId);
  const buttons = { left: 1, right: 2, middle: 4 }[button] || 1;
  await mouse(tabId, "mouseMoved", x, y, { button: "none" });
  await mouse(tabId, "mousePressed", x, y, { button, buttons, clickCount: 1 });
  await mouse(tabId, "mouseReleased", x, y, { button, buttons: 0, clickCount: 1 });
  if (double) {
    await mouse(tabId, "mousePressed", x, y, { button, buttons, clickCount: 2 });
    await mouse(tabId, "mouseReleased", x, y, { button, buttons: 0, clickCount: 2 });
  }
  await badgeVisibility(tabId, true);
}

const KEYS = {
  Enter: [13, "Enter", "\r"], Tab: [9, "Tab"], Escape: [27, "Escape"], Backspace: [8, "Backspace"], Delete: [46, "Delete"],
  ArrowUp: [38, "ArrowUp"], ArrowDown: [40, "ArrowDown"], ArrowLeft: [37, "ArrowLeft"], ArrowRight: [39, "ArrowRight"],
  Home: [36, "Home"], End: [35, "End"], PageUp: [33, "PageUp"], PageDown: [34, "PageDown"], Space: [32, "Space", " "], " ": [32, "Space", " "],
  F5: [116, "F5"], F12: [123, "F12"],
};
const MODS = { Alt: 1, Control: 2, Ctrl: 2, Meta: 4, Command: 4, Cmd: 4, Shift: 8 };
const EDIT_COMMANDS = { a: "selectAll", c: "copy", v: "paste", x: "cut", z: "undo", y: "redo" };

async function press(tabId, chord) {
  const parts = String(chord).split("+").filter(Boolean);
  const keyName = parts.pop() || chord;
  let modifiers = 0;
  for (const m of parts) { if (!MODS[m]) throw new Error(`unknown modifier ${m}`); modifiers |= MODS[m]; }
  let def = KEYS[keyName];
  if (!def && keyName.length === 1) {
    const up = keyName.toUpperCase();
    def = [up.charCodeAt(0), /[A-Z]/.test(up) ? `Key${up}` : /[0-9]/.test(up) ? `Digit${up}` : "", keyName];
  }
  if (!def) throw new Error(`unknown key ${keyName}`);
  const [vk, code, text] = def;
  const ctrlish = modifiers & (2 | 4);
  const command = ctrlish && EDIT_COMMANDS[keyName.toLowerCase()];
  const key = keyName === "Space" ? " " : keyName;
  await cdp(tabId, "Input.dispatchKeyEvent", { type: text && !ctrlish ? "keyDown" : "rawKeyDown", modifiers, key, code, windowsVirtualKeyCode: vk, ...(text && !ctrlish ? { text, unmodifiedText: text } : {}), ...(command ? { commands: [command] } : {}) });
  await cdp(tabId, "Input.dispatchKeyEvent", { type: "keyUp", modifiers, key, code, windowsVirtualKeyCode: vk });
}

async function settle(tabId) {
  await sleep(300);
  await waitLoaded(tabId, 10_000);
}

async function typeInto(tabId, objectId, { text = "", append = false, submit = false }) {
  const focused = await call(tabId, objectId, function (append) {
    const el = this.nodeType === 1 ? this : this.parentElement;
    el.scrollIntoView({ block: "center", behavior: "instant" });
    el.focus();
    if (append) {
      if (typeof el.setSelectionRange === "function") { try { const n = el.value.length; el.setSelectionRange(n, n); } catch {} }
    } else if (/^(INPUT|TEXTAREA)$/.test(el.tagName)) {
      try { el.select(); } catch { document.execCommand("selectAll"); }
    } else if (el.isContentEditable) {
      const r = document.createRange(); r.selectNodeContents(el);
      const s = getSelection(); s.removeAllRanges(); s.addRange(r);
    }
    return document.activeElement === el || el.contains(document.activeElement);
  }, [append]);
  if (!focused) throw new Error("could not focus that element (is it a field?)");
  if (text === "" && !append) await press(tabId, "Delete");
  else if (text) await cdp(tabId, "Input.insertText", { text });
  if (submit) { await press(tabId, "Enter"); await settle(tabId); }
}

// ---- debugging helpers ----------------------------------------------------------------------------

const SECRET_HEADER = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-auth-token|x-csrf-token|x-xsrf-token)$/i;
const SECRET_FIELD = /pass|token|secret|otp|pin$|cvv|card|auth/i;
const maskHeaders = (h) => (h ? Object.fromEntries(Object.entries(h).map(([k, v]) => [k, SECRET_HEADER.test(k) ? "[masked]" : v])) : undefined);
function maskBody(body) {
  if (!body) return body;
  try {
    const walk = (v) => (Array.isArray(v) ? v.map(walk) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, SECRET_FIELD.test(k) ? "[masked]" : walk(x)])) : v);
    return JSON.stringify(walk(JSON.parse(body)));
  } catch {}
  if (/^[^=&\s]+=[^&]*(&[^=&\s]+=[^&]*)*$/.test(body)) {
    return body.split("&").map((pair) => { const [k] = pair.split("="); return SECRET_FIELD.test(decodeURIComponent(k)) ? `${k}=[masked]` : pair; }).join("&");
  }
  return body;
}
const cap = (s, n) => (s && s.length > n ? `${s.slice(0, n)}… [${s.length - n} more]` : s);
const brief = (e) => ({ requestId: e.requestId, method: e.method, url: cap(e.url, 300), type: e.type, status: e.status, ms: e.ms, size: e.size, ...(e.failed ? { failed: e.errorText || true } : {}), ...(e.fromCache ? { cache: true } : {}), ...(e.redirects ? { redirects: e.redirects.length } : {}) });

// ---- the commands ---------------------------------------------------------------------------------

async function handle(cmd, a) {
  if (cmd === "tabs.list") {
    const wins = await chrome.windows.getAll({ populate: true });
    const groups = await chrome.tabGroups.query({});
    const own = (await chrome.storage.session.get("griffinWindowId")).griffinWindowId;
    return {
      current: currentTab,
      griffinWindowId: own ?? null,
      windows: wins.map((w) => ({ windowId: w.id, ...(w.id === own ? { griffin: true } : {}), focused: w.focused || undefined, incognito: w.incognito || undefined, tabs: (w.tabs || []).map((t) => ({ tabId: t.id, index: t.index, title: cap(t.title, 120), url: cap(t.url || t.pendingUrl, 200), ...(t.active ? { active: true } : {}), ...(t.groupId >= 0 ? { groupId: t.groupId } : {}), ...(attached.has(t.id) ? { controlled: true } : {}), ...(t.pinned ? { pinned: true } : {}), ...(t.status !== "complete" ? { status: t.status } : {}) })) })),
      groups: groups.map((g) => ({ groupId: g.id, title: g.title, color: g.color, windowId: g.windowId, ...(g.collapsed ? { collapsed: true } : {}) })),
    };
  }
  if (cmd === "tabs.open") {
    const url = String(a.url || "");
    if (!/^https?:\/\//i.test(url)) throw new Error("url must start with http:// or https://");
    const since = Date.now();
    let tab;
    if (a.windowId) tab = await chrome.tabs.create({ url: "about:blank", active: a.active !== false, windowId: a.windowId });
    else if (a.ownWindow === false) {
      // The owner's window: the last focused normal window that is not Griffin's.
      const own = (await chrome.storage.session.get("griffinWindowId")).griffinWindowId;
      const last = await chrome.windows.getLastFocused({ windowTypes: ["normal"] }).catch(() => null);
      const others = (await chrome.windows.getAll({ windowTypes: ["normal"] })).filter((w) => w.id !== own);
      const target = last && last.id !== own ? last : others[0];
      tab = target ? await chrome.tabs.create({ url: "about:blank", active: a.active !== false, windowId: target.id }) : (await chrome.windows.create({ url: "about:blank" })).tabs[0];
    }
    else {
      const win = await griffinWindow();
      // A fresh window's own blank tab is used instead of leaving it empty beside the new one.
      const blank = win.tabs.length === 1 && /^(about:blank|chrome:\/\/newtab\/?)$/.test(win.tabs[0].url || win.tabs[0].pendingUrl || "") ? win.tabs[0] : null;
      tab = blank || await chrome.tabs.create({ url: "about:blank", active: a.active !== false, windowId: win.id });
      if (blank && /^chrome:/.test(blank.url || blank.pendingUrl || "")) await chrome.tabs.update(blank.id, { url: "about:blank" });
    }
    currentTab = tab.id;
    if (a.group !== false) await addToGroup(tab.id).catch(() => {});
    let status = null;
    let error;
    try {
      const rec = await ensureAttached(tab.id);
      const nav = await cdp(tab.id, "Page.navigate", { url });
      error = nav.errorText;
      await waitLoaded(tab.id);
      status = rec.net.get(nav.loaderId)?.status ?? null;
    } catch (e) {
      if (/Chrome does not let/.test(e.message)) throw e;
      await chrome.tabs.update(tab.id, { url });
      await waitLoaded(tab.id);
      await ensureAttached(tab.id).catch(() => {});
    }
    return { status, ...(error ? { error } : {}), ...(await pageState(tab.id, { since, maxChars: a.maxChars })) };
  }
  if (cmd === "tabs.window") {
    const win = await griffinWindow();
    const ids = (a.tabIds || (a.tabId != null ? [a.tabId] : [])).map(Number);
    if (ids.length) {
      await chrome.tabs.move(ids, { windowId: win.id, index: -1 });
      for (const id of ids) await addToGroup(id).catch(() => {});
      const blank = win.tabs.find((t) => t.url === "about:blank" && !ids.includes(t.id));
      if (blank && win.tabs.length === 1) await chrome.tabs.remove(blank.id).catch(() => {});
      await chrome.tabs.update(ids[ids.length - 1], { active: true });
      currentTab = ids[ids.length - 1];
    }
    if (a.active !== false) await chrome.windows.update(win.id, { focused: true });
    const now = await chrome.windows.get(win.id, { populate: true });
    return { windowId: now.id, tabs: now.tabs.map((t) => ({ tabId: t.id, title: t.title, url: t.url, ...(t.active ? { active: true } : {}) })) };
  }
  if (cmd === "tabs.close") {
    const ids = (a.tabIds?.length ? a.tabIds : [a.tabId ?? (await resolveTab(a)).id]).map(Number);
    for (const id of ids) attached.delete(id);
    await chrome.tabs.remove(ids);
    return { closed: ids };
  }
  if (cmd === "tabs.group" || cmd === "tabs.ungroup" || cmd === "tabs.move") {
    const ids = (a.tabIds?.length ? a.tabIds : [(await resolveTab(a)).id]).map(Number);
    if (cmd === "tabs.ungroup") { await chrome.tabs.ungroup(ids); return { ungrouped: ids }; }
    if (cmd === "tabs.move") { const moved = await chrome.tabs.move(ids, { index: a.index ?? -1, ...(a.windowId ? { windowId: a.windowId } : {}) }); return { moved: [].concat(moved).map((t) => ({ tabId: t.id, index: t.index, windowId: t.windowId })) }; }
    const groupId = await chrome.tabs.group({ tabIds: ids, ...(a.groupId != null ? { groupId: a.groupId } : {}) });
    const patch = { ...(a.title != null ? { title: a.title } : {}), ...(a.color ? { color: a.color } : {}), ...(a.collapsed != null ? { collapsed: a.collapsed } : {}) };
    const group = Object.keys(patch).length ? await chrome.tabGroups.update(groupId, patch) : await chrome.tabGroups.get(groupId);
    return { groupId, title: group.title, color: group.color, tabIds: ids };
  }
  if (cmd === "tabs.detach") {
    const tab = await resolveTab(a);
    await detach(tab.id);
    return { detached: tab.id };
  }

  const tab = await resolveTab(a);
  const tabId = tab.id;

  if (cmd === "tabs.activate") {
    await chrome.tabs.update(tabId, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
    return pageState(tabId, { withSnapshot: false });
  }
  if (cmd === "tabs.navigate") {
    const since = Date.now();
    const rec = await ensureAttached(tabId);
    if (a.go === "back") await chrome.tabs.goBack(tabId);
    else if (a.go === "forward") await chrome.tabs.goForward(tabId);
    else if (a.go === "reload") await chrome.tabs.reload(tabId);
    else {
      if (!/^https?:\/\//i.test(String(a.url || ""))) throw new Error("url must start with http:// or https://, or give go");
      const nav = await cdp(tabId, "Page.navigate", { url: a.url });
      await waitLoaded(tabId);
      return { status: rec.net.get(nav.loaderId)?.status ?? null, ...(nav.errorText ? { error: nav.errorText } : {}), ...(await pageState(tabId, { since, maxChars: a.maxChars })) };
    }
    await waitLoaded(tabId);
    return pageState(tabId, { since, maxChars: a.maxChars });
  }

  const rec = await ensureAttached(tabId);
  const since = Date.now();
  const after = (extra = {}) => (a.snapshot === false ? pageState(tabId, { withSnapshot: false, since }).then((s) => ({ ...extra, ...s })) : pageState(tabId, { since, maxChars: a.maxChars }).then((s) => ({ ...extra, ...s })));

  switch (cmd) {
    case "page.snapshot":
      return pageState(tabId, { depth: a.depth, maxChars: a.maxChars, since: 0 });
    case "page.click": {
      const obj = a.ref ? await resolveRef(tabId, a.ref) : a.text ? await findByText(tabId, a.text) : null;
      if (!obj) throw new Error("give ref (from chrome_snapshot) or text");
      await click(tabId, obj, { button: a.button, double: a.double });
      await settle(tabId);
      return after();
    }
    case "page.hover": {
      const { x, y } = await point(tabId, await resolveRef(tabId, a.ref));
      await mouse(tabId, "mouseMoved", x, y, { button: "none" });
      await badgeVisibility(tabId, true);
      await sleep(300);
      return after();
    }
    case "page.type": {
      if (!a.ref) throw new Error("give ref of the field (from chrome_snapshot)");
      await typeInto(tabId, await resolveRef(tabId, a.ref), { text: String(a.text ?? ""), append: a.append, submit: a.submit });
      return after();
    }
    case "page.select": {
      const chosen = await call(tabId, await resolveRef(tabId, a.ref), function (values) {
        if (this.tagName !== "SELECT") throw new Error("not a <select>: click it and pick the option instead");
        const chosen = [];
        for (const o of this.options) {
          const hit = values.includes(o.value) || values.includes(o.label) || values.includes(o.textContent.trim());
          if (this.multiple) o.selected = hit;
          else if (hit && !chosen.length) o.selected = true;
          if (hit && (this.multiple || chosen.length === 0)) chosen.push(o.value);
        }
        if (!chosen.length) throw new Error("no option matches");
        this.dispatchEvent(new Event("input", { bubbles: true }));
        this.dispatchEvent(new Event("change", { bubbles: true }));
        return chosen;
      }, [(a.values || []).map(String)]);
      return after({ selected: chosen });
    }
    case "page.press": {
      if (!a.key) throw new Error("give key, e.g. Enter or Control+A");
      await press(tabId, a.key);
      await settle(tabId);
      return after();
    }
    case "page.scroll": {
      if (a.ref) await call(tabId, await resolveRef(tabId, a.ref), function () { (this.nodeType === 1 ? this : this.parentElement).scrollIntoView({ block: "center", behavior: "instant" }); });
      else {
        const { result } = await cdp(tabId, "Runtime.evaluate", { expression: "[innerWidth, innerHeight]", returnByValue: true });
        const [w, h] = result.value;
        await mouse(tabId, "mouseWheel", w / 2, h / 2, { deltaX: 0, deltaY: Number(a.dy) || h * 0.8 });
        await sleep(300);
      }
      return after();
    }
    case "page.wait": {
      const ms = Math.min(Number(a.seconds) || 15, 60) * 1000;
      if (!a.text && !a.textGone) { await sleep(ms); return after(); }
      const want = String(a.text || a.textGone);
      const until = Date.now() + ms;
      for (;;) {
        const { result } = await cdp(tabId, "Runtime.evaluate", { expression: `(document.body?.innerText || "").includes(${JSON.stringify(want)})`, returnByValue: true }).catch(() => ({ result: {} }));
        if (Boolean(result?.value) === Boolean(a.text)) break;
        if (Date.now() > until) throw new Error(`waited ${ms / 1000}s: «${want}» ${a.text ? "did not appear" : "is still there"}`);
        await sleep(300);
      }
      return after();
    }
    case "page.eval": {
      let value;
      if (a.ref) {
        value = await call(tabId, await resolveRef(tabId, a.ref), `function () { return Promise.resolve((${a.expression})(this)); }`);
      } else {
        const r = await cdp(tabId, "Runtime.evaluate", { expression: String(a.expression || ""), returnByValue: true, awaitPromise: true, userGesture: true, replMode: true });
        if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text || "script error");
        value = r.result?.value ?? (r.result?.type === "undefined" ? null : r.result?.description ?? null);
      }
      let json;
      try { json = JSON.stringify(value === undefined ? null : value); } catch { json = JSON.stringify(String(value)); }
      return { value: cap(json, 40_000), ...(await pageState(tabId, { withSnapshot: false, since })) };
    }
    case "page.screenshot": {
      await badgeVisibility(tabId, false);
      try {
        let params = { format: "png" };
        if (a.fullPage) {
          const m = await cdp(tabId, "Page.getLayoutMetrics");
          const size = m.cssContentSize || m.contentSize;
          params = { format: "png", captureBeyondViewport: true, clip: { x: 0, y: 0, width: Math.ceil(size.width), height: Math.min(Math.ceil(size.height), 16_000), scale: 1 } };
        }
        const shot = await Promise.race([cdp(tabId, "Page.captureScreenshot", params), sleep(20_000).then(() => { throw new Error("the tab gave no picture in 20s (a background tab may not paint): chrome_tabs activate it first"); })]);
        return { png: shot.data, ...(await pageState(tabId, { withSnapshot: false, since })) };
      } finally {
        await badgeVisibility(tabId, true);
      }
    }
    case "debug.console": {
      const limit = Number(a.limit) || 100;
      const items = rec.console.filter((e) => !a.errorsOnly || /error|exception|network|assert/.test(e.level)).filter((e) => !a.filter || e.text.includes(a.filter)).slice(-limit);
      if (a.clear) { rec.console = []; rec.reported = 0; }
      return { tabId, url: tab.url, recordingSince: "the moment Griffin first worked in this tab", count: items.length, console: items };
    }
    case "debug.network": {
      const limit = Number(a.limit) || 100;
      const items = [...rec.net.values()].filter((e) => !a.filter || e.url.includes(a.filter)).filter((e) => !a.errorsOnly || e.failed || e.status >= 400).slice(-limit).map(brief);
      if (a.clear) rec.net.clear();
      return { tabId, url: tab.url, count: items.length, requests: items };
    }
    case "debug.request": {
      const e = rec.net.get(String(a.requestId || ""));
      if (!e) throw new Error("no such requestId in this tab (see chrome_devtools network)");
      const out = { ...brief(e), statusText: e.statusText, mimeType: e.mimeType, remote: e.remote, protocol: e.protocol, initiator: e.initiator, redirectChain: e.redirects, requestHeaders: maskHeaders(e.requestHeaders), responseHeaders: maskHeaders(e.responseHeaders) };
      if (e.hasPostData) { let body = e.postData; if (body == null) { try { body = (await cdp(tabId, "Network.getRequestPostData", { requestId: e.requestId })).postData; } catch {} } out.postData = body == null ? "(not available any more)" : cap(maskBody(body), 8000); }
      try {
        const body = await cdp(tabId, "Network.getResponseBody", { requestId: e.requestId });
        out.body = body.base64Encoded ? `(binary, ${Math.round((body.body.length * 3) / 4)} bytes)` : cap(body.body, 20_000);
      } catch { out.body = "(not available: the page navigated since, or Chrome dropped it; reload and read it right after)"; }
      return out;
    }
    case "debug.performance": {
      await cdp(tabId, "Performance.enable").catch(() => {});
      const { metrics } = await cdp(tabId, "Performance.getMetrics");
      const nav = await cdp(tabId, "Runtime.evaluate", { expression: "JSON.stringify(performance.getEntriesByType('navigation')[0] || null)", returnByValue: true });
      return { tabId, url: tab.url, metrics: Object.fromEntries((metrics || []).map((m) => [m.name, m.value])), navigation: JSON.parse(nav.result?.value || "null") };
    }
    case "debug.dom": {
      const html = a.ref
        ? await call(tabId, await resolveRef(tabId, a.ref), function () { return this.nodeType === 1 ? this.outerHTML : this.textContent; })
        : (await cdp(tabId, "Runtime.evaluate", { expression: "document.documentElement.outerHTML", returnByValue: true })).result?.value;
      return { tabId, url: tab.url, html: cap(String(html || "").replace(new RegExp(`<div id="${BADGE_ID}"[^>]*></div>`), ""), 60_000) };
    }
    case "cdp": {
      if (!/^[A-Z][A-Za-z]+\.[a-zA-Z]+$/.test(String(a.method || ""))) throw new Error("method is like Domain.command");
      const result = await cdp(tabId, a.method, a.params || {});
      let json = JSON.stringify(result ?? null);
      return { tabId, result: json.length > 60_000 ? `${json.slice(0, 60_000)}… [truncated]` : result };
    }
    default:
      throw new Error(`unknown command ${cmd}`);
  }
}
