import crypto from "node:crypto";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { Readable } from "node:stream";

// Live previews of apps (owner 2026-10-19: «این کد رو برام پریویو کن»): an agent starts a dev server
// or a static server in the sandbox (a disposable box with no credentials), and the owner sees the
// running page in the chat. The sandbox's ports are not published anywhere, so Griffin itself is the
// only way in: /p/<token>/… is proxied to <sandbox address>:<port>.
//
// Who may open a preview: whoever holds its token (24 random characters, in the URL; the card gets it
// from the owner-only /api/previews). The preview runs somebody's code, so it must never share an
// origin with the app:
//   * PREVIEW_HOST set (a second host name that reaches this same server, e.g. the old public name):
//     previews are served only on that host — a separate origin, so the page keeps its cookies,
//     storage and service workers — and root-relative URLs (/assets/x.js, fetch("/api")) are routed by
//     the page's Referer or by a routing cookie, which is what dev servers need.
//   * not set: previews live under /p/<token>/ on the app's own host, and every response carries
//     `Content-Security-Policy: sandbox` (no allow-same-origin): the page gets an opaque origin, so it
//     cannot touch the app's session or API. Pages with root-relative URLs do not work in this mode.
//
// The sandbox runs the processes (debug_exec on host "sandbox", through the broker); `exec` is
// injected, so a test can stand in for it.

const KV_KEY = "previews";
const PORT_LOW = 41000;
const PORT_HIGH = 41999;
const MAX_LIVE = 6;
const IDLE_MS = 2 * 3600_000;
const KEEP_STOPPED_MS = 24 * 3600_000;
const TOKEN_RE = /^[A-Za-z0-9_-]{20,64}$/;
const ROUTE_COOKIE = "gp_t";
const PREVIEW_DIR = "/root/.previews";
const DEFAULT_COMMAND = 'python3 -m http.server "$PORT" --bind 0.0.0.0';
// A command may start in these places only: a chat's worktree, the sandbox's own home and /tmp.
const DIR_ROOTS = ["/workspace/repos/_wt", "/root", "/tmp"];
const HOP = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade"]);
const NO_BODY = new Set([101, 204, 205, 304]);
const SANDBOX_CSP = "sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads allow-pointer-lock";
// The app's own sign-in cookies never go to a page that runs somebody's code.
const PRIVATE_COOKIES = new Set(["karsara_session", ROUTE_COOKIE]);

const shq = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
const b64 = (text) => Buffer.from(String(text), "utf8").toString("base64");
const rid = () => crypto.randomBytes(4).toString("hex");
const textOf = (value) => String(value ?? "");

export function cleanDir(given, { base = null } = {}) {
  const raw = textOf(given).trim();
  if (!raw && !base) throw new Error("this chat has no repo worktree: give dir (a path under /workspace/repos/_wt, /root or /tmp)");
  const resolved = path.posix.resolve(base || "/", raw || ".");
  // A relative folder is the worktree's own: «..» does not reach another chat's tree.
  if (base && raw && !raw.startsWith("/") && resolved !== base && !resolved.startsWith(`${base}/`)) throw new Error("a relative dir must stay inside this chat's worktree");
  if (!DIR_ROOTS.some((root) => resolved === root || resolved.startsWith(`${root}/`))) {
    throw new Error(`dir must be under ${DIR_ROOTS.join(", ")}`);
  }
  return resolved;
}

// What a Location header should say once the page sits under /p/<token>: the dev server answers as
// if it were at localhost:<port>/, so both its absolute self-links and its root-relative ones move.
export function rewriteLocation(location, { prefix, port }) {
  const value = textOf(location);
  const own = /^https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::(\d+))?(\/.*)?$/i.exec(value);
  if (own && (!own[1] || Number(own[1]) === port)) return `${prefix}${own[2] || "/"}`;
  if (value.startsWith("/") && !value.startsWith("//")) return `${prefix}${value}`;
  return value;
}

// frame-ancestors from the dev server would stop the app from showing its own preview.
function withoutFrameAncestors(csp) {
  return textOf(csp)
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part && !/^frame-ancestors\b/i.test(part))
    .join("; ");
}

function cookiesOf(header) {
  const out = new Map();
  for (const part of textOf(header).split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
  }
  return out;
}

// The name the browser asked for: the CDN's forwarded host, else Host, else the request URL's own.
function hostOf(headers, url = "") {
  const get = (name) => (typeof headers.get === "function" ? headers.get(name) : headers[name]);
  let fromUrl = "";
  try { fromUrl = url ? new URL(url, "http://x").host : ""; } catch { /* no usable url */ }
  return textOf(get("x-forwarded-host") || get("host") || fromUrl).split(",")[0].trim().split(":")[0].toLowerCase();
}

const lastLines = (text, n) => textOf(text).split("\n").slice(-n).join("\n").trim();

export function createPreviews({
  store,
  exec,
  enabled = () => true,
  previewHost = () => "",
  publicUrl = () => "",
  sandboxAddr = () => process.env.GRIFFIN_SANDBOX_ADDR || "",
  worktreeOf = (chatId) => store.getChat?.(chatId)?.worktree_path || null,
  now = Date.now,
  idleMs = IDLE_MS,
  maxLive = MAX_LIVE,
  log = (...args) => console.log("[preview]", ...args),
}) {
  /** @type {Map<string, object>} */
  const records = new Map();
  for (const rec of Object.values(store.getKv(KV_KEY) || {})) if (rec?.id && rec?.token) records.set(rec.id, rec);
  let addrCache = null;
  let reaper = null;

  const save = () => store.setKv(KV_KEY, Object.fromEntries(records));
  const byToken = (token) => (TOKEN_RE.test(textOf(token)) ? [...records.values()].find((r) => r.token === token) || null : null);
  const live = () => [...records.values()].filter((r) => r.status === "starting" || r.status === "running");
  // PREVIEW_HOST: empty = previews live under /p/<token>/ on the app's own host, sandboxed;
  // "preview.example.com" = one separate host (/p/<token>/, plus Referer and cookie routing for
  // root-relative URLs); "*.preview.example.com" = a host per preview, https://<token>.preview.example.com/
  // (nothing to route, and every preview is an origin of its own: the best isolation).
  const hostSetting = () => {
    const value = textOf(previewHost()).trim().toLowerCase();
    if (value.startsWith("*.")) return { kind: "wildcard", host: value.slice(2) };
    return value ? { kind: "fixed", host: value } : { kind: "none", host: "" };
  };
  const mode = () => (hostSetting().kind === "none" ? "path" : "host");

  const urlOf = (rec) => {
    const { kind, host } = hostSetting();
    if (kind === "none") return `/p/${rec.token}/`;
    const scheme = /^http:\/\//i.test(textOf(publicUrl())) ? "http" : "https";
    return kind === "wildcard" ? `${scheme}://${rec.token}.${host}/` : `${scheme}://${host}/p/${rec.token}/`;
  };

  // The sandbox's address as the app sees it: its bridge IP, unless the install names one.
  async function address() {
    const forced = textOf(sandboxAddr()).trim();
    if (forced) return forced;
    if (addrCache) return addrCache;
    const { stdout } = await exec("hostname -i; exit 0");
    const ip = textOf(stdout).split(/\s+/).find((word) => net.isIPv4(word));
    if (!ip) throw new Error("could not find the sandbox's address");
    addrCache = ip;
    return ip;
  }

  function pickPort() {
    const used = new Set([...records.values()].filter((r) => r.status !== "stopped" && r.status !== "failed").map((r) => r.port));
    for (let i = 0; i < 200; i += 1) {
      const port = PORT_LOW + crypto.randomInt(PORT_HIGH - PORT_LOW + 1);
      if (!used.has(port)) return port;
    }
    throw new Error("no free preview port");
  }

  const startScript = ({ id, dir, port, command, waitSec }) => `
ID=${id}; P=${port}
mkdir -p ${PREVIEW_DIR}
DIR=$(printf %s ${shq(b64(dir))} | base64 -d)
CMD=$(printf %s ${shq(b64(command))} | base64 -d)
if nc -z 127.0.0.1 $P 2>/dev/null; then echo BUSY; exit 0; fi
cd "$DIR" 2>/dev/null || { echo NOCD; exit 0; }
LOG=${PREVIEW_DIR}/$ID.log
: > "$LOG"
PATH="${PREVIEW_DIR}/bin:$PATH" PORT=$P HOST=0.0.0.0 BROWSER=none setsid nohup sh -c "$CMD" > "$LOG" 2>&1 < /dev/null &
PID=$!
echo $PID > ${PREVIEW_DIR}/$ID.pid
echo "PID $PID"
i=0; MAX=${Math.max(1, Math.round(waitSec * 2))}
while [ $i -lt $MAX ]; do
  if nc -z 127.0.0.1 $P 2>/dev/null; then echo READY; break; fi
  kill -0 $PID 2>/dev/null || { echo DEAD; break; }
  sleep 0.5; i=$((i+1))
done
[ $i -ge $MAX ] && echo TIMEOUT
echo ---LOG
tail -n 40 "$LOG"
exit 0
`;

  const stopScript = (pid) => `
P=${Number(pid)}
kill -TERM -- -$P 2>/dev/null || kill -TERM $P 2>/dev/null
i=0; while [ $i -lt 10 ] && kill -0 $P 2>/dev/null; do sleep 0.3; i=$((i+1)); done
kill -0 $P 2>/dev/null && { kill -KILL -- -$P 2>/dev/null || kill -KILL $P 2>/dev/null; }
exit 0
`;

  // Runs rec's command and waits for its port. Updates rec in place; returns { outcome, logTail }.
  async function launch(rec, { waitSec }) {
    const out = textOf((await exec(startScript({ id: rec.id, dir: rec.dir, port: rec.port, command: rec.command, waitSec }))).stdout);
    if (/^NOCD$/m.test(out)) return { outcome: "nocd", logTail: "" };
    if (/^BUSY$/m.test(out)) return { outcome: "busy", logTail: "" };
    const pid = Number(/^PID (\d+)$/m.exec(out)?.[1]);
    const logTail = out.split(/^---LOG$/m)[1]?.trim() || "";
    if (pid) rec.pid = pid;
    const outcome = /^READY$/m.test(out) ? "ready" : /^DEAD$/m.test(out) ? "dead" : "slow";
    rec.status = outcome === "ready" ? "running" : outcome === "dead" ? "failed" : "starting";
    rec.reason = outcome === "dead" ? "the command exited before it listened" : null;
    if (outcome === "dead") rec.stoppedAt = now();
    return { outcome, logTail };
  }

  const view = (rec, { withUrl = true } = {}) => ({
    id: rec.id,
    chatId: rec.chatId,
    title: rec.title,
    status: rec.status,
    reason: rec.reason || null,
    port: rec.port,
    dir: rec.dir,
    command: rec.command,
    createdAt: rec.createdAt,
    lastSeenAt: rec.lastSeenAt,
    ...(withUrl && (rec.status === "running" || rec.status === "starting") ? { url: urlOf(rec), mode: mode() } : {}),
  });

  async function start({ chatId, command, dir, title, port, waitSec = 25 }) {
    if (live().length >= maxLive) {
      throw new Error(`${live().length} previews are running (the limit is ${maxLive}); stop one first: ${live().map((r) => `${r.id} «${r.title}»`).join(", ")}`);
    }
    const cwd = cleanDir(dir, { base: worktreeOf(chatId) });
    const cmd = textOf(command).trim() || DEFAULT_COMMAND;
    if (cmd.length > 4000) throw new Error("command is longer than 4000 characters; put it in a script file");
    const wanted = port == null ? null : Number(port);
    if (wanted != null && (!Number.isInteger(wanted) || wanted < PORT_LOW || wanted > PORT_HIGH)) throw new Error(`port must be ${PORT_LOW}–${PORT_HIGH} (or leave it out: $PORT is given to the command)`);
    const rec = {
      id: rid(),
      token: crypto.randomBytes(16).toString("hex"), // lowercase: it may become a host name label
      chatId: chatId || null,
      title: textOf(title).trim().slice(0, 80) || path.posix.basename(cwd) || "preview",
      dir: cwd,
      command: cmd,
      port: wanted || pickPort(),
      pid: null,
      status: "starting",
      reason: null,
      createdAt: now(),
      lastSeenAt: now(),
      stoppedAt: null,
    };
    let result;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      result = await launch(rec, { waitSec });
      if (result.outcome !== "busy" || wanted) break;
      rec.port = pickPort();
    }
    if (result.outcome === "nocd") throw new Error(`${cwd} does not exist in the sandbox`);
    if (result.outcome === "busy") throw new Error(`port ${rec.port} is already in use in the sandbox`);
    records.set(rec.id, rec);
    save();
    log(`start ${rec.id} port ${rec.port} ${result.outcome} dir ${rec.dir}`);
    return { rec, outcome: result.outcome, logTail: result.logTail };
  }

  async function killProcess(rec) {
    if (rec.pid) await exec(stopScript(rec.pid)).catch((error) => log(`stop ${rec.id}: ${error.message}`));
  }

  async function stop(id, reason = "stopped by the owner") {
    const rec = records.get(id);
    if (!rec) throw new Error("no such preview");
    if (rec.status === "running" || rec.status === "starting") await killProcess(rec);
    rec.status = "stopped";
    rec.reason = reason;
    rec.stoppedAt = now();
    save();
    log(`stop ${rec.id} (${reason})`);
    return rec;
  }

  async function restart(id, { waitSec = 25 } = {}) {
    const rec = records.get(id);
    if (!rec) throw new Error("no such preview");
    await killProcess(rec);
    rec.status = "starting";
    rec.reason = null;
    rec.stoppedAt = null;
    rec.lastSeenAt = now();
    const result = await launch(rec, { waitSec });
    if (result.outcome === "busy") {
      rec.status = "failed";
      rec.reason = `port ${rec.port} is still in use`;
    }
    save();
    return { rec, outcome: result.outcome, logTail: result.logTail };
  }

  async function logs(id, lines = 80) {
    const rec = records.get(id);
    if (!rec) throw new Error("no such preview");
    const n = Math.min(Math.max(Number(lines) || 80, 1), 400);
    const { stdout } = await exec(`tail -n ${n} ${PREVIEW_DIR}/${rec.id}.log 2>/dev/null; exit 0`);
    return textOf(stdout);
  }

  // Once a minute: forget processes that are gone, stop idle previews, drop old stopped records.
  async function tick() {
    const running = live().filter((r) => r.pid);
    if (running.length) {
      const probe = running.map((r) => Number(r.pid)).filter(Boolean).join(" ");
      const out = await exec(`for p in ${probe}; do kill -0 $p 2>/dev/null && echo $p; done; exit 0`).catch(() => null);
      if (out) {
        const alive = new Set(textOf(out.stdout).split(/\s+/).filter(Boolean).map(Number));
        for (const rec of running) {
          if (alive.has(Number(rec.pid))) continue;
          rec.status = "stopped";
          rec.reason = "the process is gone (the sandbox restarted, or the command exited)";
          rec.stoppedAt = now();
        }
      }
    }
    for (const rec of live()) if (now() - rec.lastSeenAt > idleMs) await stop(rec.id, "no one looked at it for 2 hours");
    for (const [id, rec] of records) {
      if ((rec.status === "stopped" || rec.status === "failed") && now() - (rec.stoppedAt || rec.createdAt) > KEEP_STOPPED_MS) {
        records.delete(id);
        exec(`rm -f ${PREVIEW_DIR}/${id}.log ${PREVIEW_DIR}/${id}.pid; exit 0`).catch(() => {});
      }
    }
    save();
  }

  function startReaper(everyMs = 60_000) {
    if (reaper) return;
    reaper = setInterval(() => tick().catch((error) => log(`tick: ${error.message}`)), everyMs);
    reaper.unref?.();
  }

  const touch = (rec) => {
    if (now() - rec.lastSeenAt > 30_000) rec.lastSeenAt = now();
  };

  // ---- the proxy ------------------------------------------------------------------------------

  // Which preview a request is for: /p/<token>/… always; on the preview host also the token in the
  // page's Referer or in the routing cookie (root-relative URLs). null = not a preview request.
  function route(method, rawUrl, headers) {
    const url = new URL(rawUrl, "http://x");
    const get = (name) => (typeof headers.get === "function" ? headers.get(name) : headers[name]);
    const host = hostOf(headers, rawUrl);
    const { kind, host: specialHost } = hostSetting();
    const m = /^\/p\/([A-Za-z0-9_-]{20,64})(\/.*)?$/.exec(url.pathname);
    if (kind === "wildcard") {
      if (!host.endsWith(`.${specialHost}`)) return m ? { status: 404, text: "پیش‌نمایش‌ها روی نشانی ویژهٔ خودشان باز می‌شوند." } : null;
      const rec = byToken(host.slice(0, -(specialHost.length + 1)));
      if (!rec) return { status: 404, text: "این پیش‌نمایش وجود ندارد یا بسته شده است." };
      return { rec, path: `${url.pathname}${url.search}`, prefix: "", via: "host" };
    }
    if (kind === "fixed" && host !== specialHost) {
      // Previews open on their own host only: on the app's own host this path is not served.
      return m ? { status: 404, text: `پیش‌نمایش‌ها فقط روی ${specialHost} باز می‌شوند.` } : null;
    }
    if (m) {
      const rec = byToken(m[1]);
      if (!rec) return { status: 404, text: "این پیش‌نمایش وجود ندارد یا بسته شده است." };
      if (!m[2]) return { redirect: `/p/${m[1]}/${url.search}` };
      return { rec, path: `${m[2]}${url.search}`, prefix: `/p/${m[1]}`, via: "path" };
    }
    if (kind !== "fixed") return null;
    const refMatch = /\/p\/([A-Za-z0-9_-]{20,64})(?:\/|$|\?|#)/.exec(textOf(get("referer")));
    const cookie = cookiesOf(get("cookie")).get(ROUTE_COOKIE);
    const rec = byToken(refMatch?.[1]) || byToken(cookie);
    if (!rec) return null;
    return { rec, path: `${url.pathname}${url.search}`, prefix: `/p/${rec.token}`, via: refMatch ? "referer" : "cookie" };
  }

  const failure = (status, text, { retry = false } = {}) =>
    new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><body dir="rtl" style="font:15px system-ui;padding:2rem;color:#444"><p>${text.replace(/</g, "&lt;")}</p>${retry ? "<script>setTimeout(()=>location.reload(),3000)</script>" : ""}`, {
      status,
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex", ...(mode() === "path" ? { "content-security-policy": SANDBOX_CSP } : {}) },
    });

  function upstreamHeaders(request, { rec, via, prefix, host }) {
    const out = {};
    for (const [key, value] of request.headers) {
      const k = key.toLowerCase();
      if (HOP.has(k) || ["host", "cookie", "content-length"].includes(k)) continue;
      out[k] = value;
    }
    const cookie = request.headers.get("cookie");
    if (cookie) {
      const kept = cookie.split(";").map((p) => p.trim()).filter((p) => p && !PRIVATE_COOKIES.has(p.split("=")[0].trim()));
      if (kept.length) out.cookie = kept.join("; ");
    }
    const length = request.headers.get("content-length");
    if (length && request.method !== "GET" && request.method !== "HEAD") out["content-length"] = length;
    // Dev servers refuse hosts they do not know (Vite's allowedHosts): localhost is always known.
    out.host = `localhost:${rec.port}`;
    out["x-forwarded-host"] = host;
    out["x-forwarded-proto"] = request.headers.get("x-forwarded-proto") || (new URL(request.url).protocol === "https:" ? "https" : "http");
    if (via === "path") out["x-forwarded-prefix"] = prefix;
    return out;
  }

  function responseHeaders(res, { rec, prefix, via, secure }) {
    const headers = new Headers();
    for (let i = 0; i < res.rawHeaders.length; i += 2) {
      const key = res.rawHeaders[i];
      const k = key.toLowerCase();
      const value = res.rawHeaders[i + 1];
      if (HOP.has(k) || ["cache-control", "etag", "last-modified", "expires", "x-frame-options", "cdn-cache-control", "surrogate-control"].includes(k)) continue;
      if (k === "location") headers.append(key, rewriteLocation(value, { prefix, port: rec.port }));
      else if (k === "content-security-policy" || k === "content-security-policy-report-only") {
        const cleaned = withoutFrameAncestors(value);
        if (cleaned) headers.append(key, cleaned);
      } else if (k === "set-cookie") headers.append(key, value.replace(/;\s*domain=[^;]*/i, ""));
      else headers.append(key, value);
    }
    headers.set("cache-control", "no-store");
    headers.set("cdn-cache-control", "no-store");
    headers.set("x-robots-tag", "noindex, nofollow");
    if (mode() === "path") headers.append("content-security-policy", SANDBOX_CSP);
    // Remember which preview this browser is on, for the requests that carry no token (a single-page
    // app that moved to /dashboard with pushState sends a Referer without it).
    else if (via === "path") headers.append("set-cookie", `${ROUTE_COOKIE}=${rec.token}; Path=/; HttpOnly; SameSite=None; Partitioned${secure ? "; Secure" : ""}`);
    return headers;
  }

  // The preview host runs other people's code, so whatever a page there asks for that is not its own
  // preview must not reach the app: its session cookie may still sit in the browser from the time this
  // name was the app's (the cookie is host-bound), and a same-origin request from the page would carry
  // it. Left open on that host: the compatibility endpoints that never use the cookie (MCP, peer API,
  // public hooks, healthz) and plain page GETs (they get the old-name redirect).
  function guardHost(request) {
    const { kind, host: specialHost } = hostSetting();
    if (kind !== "fixed" || hostOf(request.headers, request.url) !== specialHost) return null;
    const p = new URL(request.url).pathname;
    const open = /^\/(mcp|peer\/|healthz)/.test(p) || p.startsWith("/api/public/") || (["GET", "HEAD"].includes(request.method) && !p.startsWith("/api/"));
    return open ? null : failure(404, "این آدرس فقط برای پیش‌نمایش است.");
  }

  // The proxy as a fetch handler: Request in, Response out (null = not mine, carry on).
  async function handle(request) {
    if (!enabled()) return null;
    const found = route(request.method, request.url, request.headers);
    if (!found) return guardHost(request);
    if (found.redirect) return new Response(null, { status: 308, headers: { location: found.redirect, "cache-control": "no-store" } });
    if (found.status) return failure(found.status, found.text);
    const { rec } = found;
    if (rec.status !== "running" && rec.status !== "starting") return failure(410, `این پیش‌نمایش (${rec.title}) متوقف شده است${rec.reason ? `: ${rec.reason}` : ""}.`);
    touch(rec);
    let addr;
    try {
      addr = await address();
    } catch (error) {
      return failure(502, `سندباکس در دسترس نیست: ${error.message}`);
    }
    const host = hostOf(request.headers, request.url);
    const secure = (request.headers.get("x-forwarded-proto") || new URL(request.url).protocol.replace(":", "")) === "https";
    return new Promise((resolve) => {
      const upstream = http.request({
        method: request.method,
        path: found.path,
        headers: upstreamHeaders(request, { ...found, host }),
        // No agent: a custom connection is the one way to be sure NODE_USE_ENV_PROXY (set for the
        // app's outbound traffic) does not send a request for the sandbox through the VPN proxy.
        createConnection: () => net.connect({ host: addr, port: rec.port }),
      });
      const abort = () => upstream.destroy();
      request.signal?.addEventListener("abort", abort, { once: true });
      upstream.setTimeout(10 * 60_000, () => upstream.destroy(new Error("idle")));
      upstream.on("response", (res) => {
        if (rec.status === "starting") rec.status = "running";
        const headers = responseHeaders(res, { rec, prefix: found.prefix, via: found.via, secure });
        const body = request.method === "HEAD" || NO_BODY.has(res.statusCode) ? null : Readable.toWeb(res);
        if (!body) res.resume();
        resolve(new Response(body, { status: res.statusCode, headers }));
      });
      upstream.on("error", (error) => {
        addrCache = null; // the sandbox may have been recreated with another address
        resolve(failure(502, `برنامهٔ پیش‌نمایش جواب نمی‌دهد (${error.code || error.message}). یا هنوز بالا نیامده یا متوقف شده؛ چند ثانیه بعد دوباره امتحان کنید.`, { retry: rec.status === "starting" }));
      });
      if (request.method === "GET" || request.method === "HEAD" || !request.body) upstream.end();
      else Readable.fromWeb(request.body).on("error", () => upstream.destroy()).pipe(upstream);
    });
  }

  // WebSocket (HMR, live reload, socket.io): the same routing, then bytes both ways. Returns true
  // when the request was a preview's.
  function handleUpgrade(req, socket, head) {
    if (!enabled()) return false;
    const found = route(req.method, req.url, req.headers);
    if (!found) return false;
    if (found.redirect || found.status || (found.rec.status !== "running" && found.rec.status !== "starting")) {
      socket.end("HTTP/1.1 404 Not Found\r\nconnection: close\r\n\r\n");
      return true;
    }
    const { rec } = found;
    touch(rec);
    address().then(
      (addr) => {
        const up = net.connect({ host: addr, port: rec.port }, () => {
          const headers = { ...req.headers, host: `localhost:${rec.port}`, "x-forwarded-host": hostOf(req.headers) };
          // The dev server checks the origin like it checks the host.
          if (headers.origin) headers.origin = `http://localhost:${rec.port}`;
          delete headers.cookie;
          const lines = Object.entries(headers).map(([k, v]) => `${k}: ${v}`);
          up.write(`${req.method} ${found.path} HTTP/1.1\r\n${lines.join("\r\n")}\r\n\r\n`);
          if (head?.length) up.write(head);
          socket.pipe(up);
          up.pipe(socket);
        });
        const close = () => { up.destroy(); socket.destroy(); };
        up.on("error", close);
        socket.on("error", close);
        up.on("close", () => socket.destroy());
        socket.on("close", () => up.destroy());
      },
      () => socket.destroy(),
    );
    return true;
  }

  // ---- tools for the agent --------------------------------------------------------------------

  const text = (value, isError = false) => ({ ...(isError ? { isError: true } : {}), content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }] });

  function tools(chatId) {
    const mine = () => [...records.values()].filter((r) => r.chatId === chatId).sort((a, b) => b.createdAt - a.createdAt);
    const owned = (id) => {
      const rec = records.get(textOf(id));
      if (!rec) throw new Error("no such preview (preview_list shows them)");
      return rec;
    };
    const agentView = (rec) => ({ ...view(rec, { withUrl: false }), localUrl: `http://127.0.0.1:${rec.port}` });
    return {
      preview_start: {
        description:
          "Run an app in the sandbox and show it to the owner as a live preview in the chat. `command` runs in `dir` (default: this chat's worktree) and must listen on 0.0.0.0:$PORT — $PORT is given to it (Vite: `npm run dev -- --host 0.0.0.0 --port $PORT`; Next: `npx next dev -H 0.0.0.0 -p $PORT`; Flask: `flask run --host 0.0.0.0 --port $PORT`). Without `command`, the folder is served as static files. Install dependencies first with debug_exec (host sandbox; node is there, npm may need `apk add npm`). The owner sees the page in a card with reload, device sizes, logs and stop; you do not get the owner's link: to look at the app yourself use curl on `localUrl` from debug_exec. Root-relative URLs (/assets/x.js) only work when the install has a preview host; otherwise build with relative paths (Vite `--base ./`). A preview stops after 2 hours without a look. On failure you get the last log lines.",
        inputSchema: {
          type: "object",
          properties: {
            command: { type: "string", description: "shell command that listens on 0.0.0.0:$PORT; empty = serve the folder as static files" },
            dir: { type: "string", description: "folder to run in (absolute, or relative to the worktree); default the chat's worktree" },
            title: { type: "string", description: "short name shown on the card" },
            waitSec: { type: "integer", minimum: 1, maximum: 90, description: "how long to wait for the port to open (default 25)" },
          },
          additionalProperties: false,
        },
        async execute(args) {
          try {
            const { rec, outcome, logTail } = await start({ chatId, command: args?.command, dir: args?.dir, title: args?.title, waitSec: Math.min(Number(args?.waitSec) || 25, 90) });
            if (outcome === "dead") return text({ ...agentView(rec), error: "the command exited before it listened", log: logTail }, true);
            return text({
              ...agentView(rec),
              ...(outcome === "slow" ? { note: `the port did not open in ${args?.waitSec || 25}s; the app may still be starting — look at preview_logs` } : {}),
              log: lastLines(logTail, 12),
              shown: "the owner sees it in the card under this call",
            });
          } catch (error) {
            return text({ error: error.message }, true);
          }
        },
      },
      preview_restart: {
        description: "Restart a preview's command (after changing files that the dev server does not pick up by itself). The owner's card keeps showing the same page.",
        inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
        async execute(args) {
          try {
            const { rec, outcome, logTail } = await restart(owned(args?.id).id);
            return text({ ...agentView(rec), outcome, log: lastLines(logTail, 12) }, outcome === "dead");
          } catch (error) {
            return text({ error: error.message }, true);
          }
        },
      },
      preview_stop: {
        description: "Stop a preview and free its port.",
        inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
        async execute(args) {
          try {
            return text(agentView(await stop(owned(args?.id).id, "stopped by the agent")));
          } catch (error) {
            return text({ error: error.message }, true);
          }
        },
      },
      preview_list: {
        description: "This chat's previews (running and recently stopped) with their ids, status and ports.",
        inputSchema: { type: "object", properties: { all: { type: "boolean", description: "every chat's previews, not only this one" } }, additionalProperties: false },
        async execute(args) {
          const list = args?.all ? [...records.values()].sort((a, b) => b.createdAt - a.createdAt) : mine();
          return text({ previews: list.map(agentView) });
        },
      },
      preview_logs: {
        description: "The last lines of a preview's output (stdout and stderr of its command).",
        inputSchema: { type: "object", properties: { id: { type: "string" }, lines: { type: "integer", minimum: 1, maximum: 400 } }, required: ["id"], additionalProperties: false },
        async execute(args) {
          try {
            return text({ id: owned(args?.id).id, log: await logs(args.id, args?.lines) });
          } catch (error) {
            return text({ error: error.message }, true);
          }
        },
      },
    };
  }

  return {
    start, stop, restart, logs, tick, startReaper, tools, handle, handleUpgrade, route, urlOf, mode,
    get: (id) => records.get(id) || null,
    view,
    list: ({ chatId = null } = {}) => [...records.values()].filter((r) => !chatId || r.chatId === chatId).sort((a, b) => b.createdAt - a.createdAt),
    touch,
    stopAll: async (reason = "shutdown") => { for (const rec of live()) await stop(rec.id, reason); },
  };
}

export const PREVIEW_TOOL_NAMES = ["preview_start", "preview_restart", "preview_stop", "preview_list", "preview_logs"];
