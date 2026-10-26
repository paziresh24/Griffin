import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { genv } from "./env.mjs";
import { fromThisMachine } from "./listen.mjs";
import { VpnError, reasonOf as vpnReason } from "./vpn.mjs";

// What a new user still has to set up for full use, each read from the real state on this server
// (owner, 2026-10-14), plus the in-app step that sets it up:
// - GitLab: a git credential for the GitLab host that GitLab itself accepts (GET /api/v4/user).
//   The step does what deploy/self/gitlab-login does: check the token, `git credential approve`
//   with the store helper, git user.name/email from the account.
// - VPN: whether Telegram opens directly, whether ~/griffin/vpn.txt holds a link and whether
//   Telegram opens through it. The step validates a link exactly as install.sh does
//   (link2config.py + `xray run -test`), writes vpn.txt (0600) and starts vpn-run.sh.
// - Speech to text: whether a key is set (secrets "stt" or STT_API_KEY; sttReady from index.mjs).
// - Company data: the user's own Infisical sign-in (the CLI's browser login; its page shows the
//   token for manual paste when no CLI listens). Kept in Griffin's secret store (setup/*); only `vault-run`
//   on this machine, with the owner token, gets it back (localVaultRoute).
// No response or log line here carries a token, a link or a secret value.
// Ported from Karsara (2026-10-17). The VPN step is the self-install's (deploy/self): once Telegram opens
// through the link, the running server takes the same proxy as Settings' /api/setup/proxy would.

export const GITLAB_HOST = process.env.GRIFFIN_SETUP_GITLAB_HOST || "gitlab.example.com";
export const VAULT_BASE = process.env.GRIFFIN_SETUP_VAULT_URL || "https://secrets.example.com";
export const VAULT_SLOT = "infisical_token";
const VAULT_META_SLOT = "infisical_user";
// What install.sh writes when a VPN link is given; the same lines when one is given in the app.
export const PROXY_ENV = {
  CURSOR_PROXY: "http://127.0.0.1:18118",
  HTTPS_PROXY: "http://127.0.0.1:18118",
  HTTP_PROXY: "http://127.0.0.1:18118",
  NO_PROXY: "localhost,127.0.0.1,::1,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16",
  GRIFFIN_TELEGRAM_SOCKS: "socks5://127.0.0.1:11080",
};
const LINK = /^(vless|vmess|trojan|ss|socks5?|https?):\/\/\S+$/i;
const JWT = /^eyJ[\w-]+\.[\w-]+\.[\w-]+$/;
// A settled answer is asked again after ten minutes (the setup poller asks every minute while
// something is open); one that could not be asked, after a minute.
const SETTLED_MS = 10 * 60_000;
const RETRY_MS = 60_000;
const VPN_MS = 2 * 60_000;

export class SetupError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

// One command: never a shell, a time limit, stdin given; resolves with its exit code and output.
export function runCommand(cmd, args, { input = "", env = process.env, timeoutMs = 20_000 } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { env, stdio: ["pipe", "pipe", "pipe"] });
    } catch (error) {
      resolve({ code: 127, stdout: "", stderr: String(error?.message || error) });
      return;
    }
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: 127, stdout, stderr: String(error?.message || error) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

const sha = (text) => crypto.createHash("sha256").update(String(text)).digest("hex");

// The Infisical page's manual-paste token is base64 of {JTWToken, email, privateKey}; a bare JWT
// is taken too. Anything else: null.
export function decodeVaultPaste(text) {
  const value = String(text || "").replace(/\s+/g, "");
  if (JWT.test(value)) return value;
  try {
    const token = JSON.parse(Buffer.from(value, "base64").toString("utf8"))?.JTWToken;
    return typeof token === "string" && JWT.test(token) ? token : null;
  } catch {
    return null;
  }
}

function jwtExpiry(token) {
  try {
    const exp = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"))?.exp;
    return Number.isFinite(exp) ? exp * 1000 : null;
  } catch {
    return null;
  }
}

// griffin.env: replace the line or append it, keeping everything else (install.sh's envset).
function envSet(file, vars) {
  const before = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const lines = before.split("\n");
  if (lines.at(-1) === "") lines.pop();
  for (const [key, value] of Object.entries(vars)) {
    const at = lines.findIndex((line) => line.startsWith(`${key}=`));
    if (at >= 0) lines[at] = `${key}=${value}`;
    else lines.push(`${key}=${value}`);
  }
  if (`${lines.join("\n")}\n` === before) return;
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${lines.join("\n")}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/**
 * home: the self-install folder (GRIFFIN_HOME: vpn/, vpn.txt, griffin.env), or null when this
 * server was not installed that way (then the VPN is not offered).
 * applyProxy(vars): the running server takes the VPN's proxy (index.mjs), so no restart is needed.
 * keyStore: getInternal/setInternal/removeInternal (secretSlots below over Griffin's secret store).
 */
export function createSetupChecks({
  keyStore,
  home = null,
  gitlabHost = GITLAB_HOST,
  vaultBase = VAULT_BASE,
  fetchFn = globalThis.fetch,
  env = process.env,
  run = runCommand,
  applyProxy = () => {},
  sttReady = () => false,
  now = () => Date.now(),
  vpn = null,
}) {
  const cache = new Map();
  async function cached(key, ttl, compute) {
    const hit = cache.get(key);
    if (hit && now() - hit.at < hit.ttl) return hit.value;
    const value = await compute();
    cache.set(key, { at: now(), ttl: typeof ttl === "function" ? ttl(value) : ttl, value });
    return value;
  }
  const settled = (value) => (value.state === "unknown" ? RETRY_MS : SETTLED_MS);
  const uid = String(process.getuid?.() ?? "");
  const gitEnv = { ...env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "", SSH_ASKPASS: "" };
  const git = (args, input) => run("git", args, { input, env: gitEnv });

  // ---- GitLab ----
  async function gitlabUser(token) {
    try {
      const ask = (headers) => fetchFn(`https://${gitlabHost}/api/v4/user`, { headers, signal: AbortSignal.timeout(15_000) });
      let res = await ask({ "PRIVATE-TOKEN": token });
      // An OAuth token (git-credential-manager, glab) is refused in PRIVATE-TOKEN but taken as Bearer.
      if (res.status === 401) res = await ask({ Authorization: `Bearer ${token}` });
      if (res.status === 401 || res.status === 403) return { state: "broken" };
      if (!res.ok) return { state: "unknown" };
      const me = await res.json();
      return { state: "ok", user: String(me?.username || ""), email: String(me?.email || "") };
    } catch {
      return { state: "unknown" };
    }
  }
  async function storedGitlabToken() {
    const r = await git(["credential", "fill"], `protocol=https\nhost=${gitlabHost}\n\n`);
    if (r.code !== 0) return null;
    return r.stdout.match(/^password=(.+)$/m)?.[1] || null;
  }
  async function gitlabStatus() {
    const token = await storedGitlabToken();
    if (!token) return { state: "missing" };
    const found = await cached(`gitlab:${sha(token)}`, settled, () => gitlabUser(token));
    return found.state === "ok" ? { state: "ok", user: found.user } : { state: found.state };
  }
  async function connectGitlab(raw) {
    const token = String(raw || "").trim();
    if (!token || token.length > 512 || /\s/.test(token)) throw new SetupError("توکن درست نیست.");
    const me = await gitlabUser(token);
    if (me.state === "broken") throw new SetupError("GitLab این توکن را نپذیرفت.");
    if (me.state !== "ok" || !me.user) throw new SetupError("GitLab جواب نداد؛ کمی بعد دوباره امتحان کنید.", 502);
    const config = async (key) => (await git(["config", "--global", key])).stdout.trim();
    // As gitlab-login: the store helper when none is set. A memory-only helper (cache) alone would
    // lose the token within minutes, so this host gets the store helper next to it.
    const helpers = (await git(["config", "--global", "--get-all", "credential.helper"])).stdout.split("\n").map((h) => h.trim()).filter(Boolean);
    if (!helpers.length) await git(["config", "--global", "credential.helper", "store"]);
    else if (helpers.every((h) => /^cache\b/.test(h))) await git(["config", "--global", `credential.https://${gitlabHost}.helper`, "store"]);
    const saved = await git(["credential", "approve"], `protocol=https\nhost=${gitlabHost}\nusername=${me.user}\npassword=${token}\n\n`);
    if (saved.code !== 0) throw new SetupError("git نتوانست توکن را نگه دارد.", 500);
    if (!(await config("user.name"))) await git(["config", "--global", "user.name", me.user]);
    if (!(await config("user.email")) && me.email) await git(["config", "--global", "user.email", me.email]);
    cache.set(`gitlab:${sha(token)}`, { at: now(), ttl: SETTLED_MS, value: me });
    return gitlabStatus();
  }

  // ---- VPN ----
  const kitDir = home ? path.join(home, "vpn") : null;
  const hasKit = () => Boolean(kitDir) && ["link2config.py", "vpn-run.sh", "xray"].every((f) => fs.existsSync(path.join(kitDir, f)));
  const linkFile = () => path.join(home, "vpn.txt");
  const configured = () => {
    try {
      return fs.statSync(linkFile()).size > 0;
    } catch {
      return false;
    }
  };
  // Any HTTP answer means the road is open (vpn-check.sh's test); 000 means it is not.
  const answered = (r) => r.code === 0 && /^\d{3}$/.test(r.stdout.trim()) && r.stdout.trim() !== "000";
  const curl = (args) => run("curl", ["-s", "-o", "/dev/null", "-w", "%{http_code}", "-m", "8", ...args], { env, timeoutMs: 12_000 });
  const telegramDirect = () =>
    cached("vpn:direct", (v) => (v === null ? RETRY_MS : SETTLED_MS), async () => {
      const r = await curl(["--noproxy", "*", "https://api.telegram.org/"]);
      return r.code === 127 ? null : answered(r);
    });
  async function vpnWorking() {
    try {
      if (fs.readFileSync(path.join(kitDir, "last-error.txt"), "utf8").trim()) return false;
    } catch {
      /* no error file yet */
    }
    const xray = await run("pgrep", ["-u", uid, "-f", `${kitDir}/xray run -config`], { env });
    if (xray.code !== 0) return false;
    return answered(await curl(["--socks5-hostname", "127.0.0.1:11080", "https://api.telegram.org/"]));
  }
  async function vpnStatus() {
    // No self-install kit: the built-in VPN (vpn.mjs) runs Xray itself — docker capsules, cron installs.
    if (!hasKit() && vpn) {
      const s = await cached("vpn:builtin", VPN_MS, () => vpn.status());
      if (s.working && process.env.HTTPS_PROXY !== PROXY_ENV.HTTPS_PROXY) applyProxy({ ...PROXY_ENV });
      return { kit: true, builtin: true, configured: s.configured, working: s.working, claude: s.claude, telegram: s.telegram, direct: null };
    }
    if (!hasKit()) return { kit: false, configured: false, working: null, direct: null };
    const direct = await telegramDirect();
    const isSet = configured();
    // A link changed outside the app (nano vpn.txt) is checked again at once.
    let stamp = 0;
    try {
      stamp = fs.statSync(linkFile()).mtimeMs;
    } catch {
      /* no link */
    }
    if (cache.get("vpn:working")?.stamp !== stamp) cache.delete("vpn:working");
    const working = isSet ? await cached("vpn:working", VPN_MS, vpnWorking) : null;
    if (cache.has("vpn:working")) cache.get("vpn:working").stamp = stamp;
    // A link that came up later (or was set by hand) is taken by the server here.
    if (working) useProxy();
    return { kit: true, configured: isSet, working, direct };
  }
  // A fixed reason, never the tools' own words: they print decoded parts of the link (a vmess or
  // ss link is base64, so its id or password would not even look like the pasted text).
  const reasonOf = (output) => (/unsupported link type/.test(output) ? "این نوع لینک پشتیبانی نمی‌شود" : /link2config|Traceback|Error|error/.test(output) ? "لینک ناقص است یا سرورش آن را رد می‌کند" : "");
  let applying = false;
  // The built-in VPN's own list (vpn.mjs): every server added so far and how each did.
  const builtin = () => (!hasKit() && vpn ? vpn : null);
  const vpnFail = (error, suffix = "") => {
    // A refused route names the entry (the owner's own typing, not a secret).
    const entry = error?.entry ? ` «${error.entry}»` : "";
    throw new SetupError(error instanceof VpnError ? `${vpnReason(error)}${entry}${suffix}` : "انجام نشد؛ کمی بعد دوباره امتحان کنید.", error?.message === "busy" ? 409 : error?.message === "unknown" ? 404 : 400);
  };
  async function vpnList() {
    const v = builtin();
    if (!v) return { builtin: false, servers: [] };
    return v.list();
  }
  async function vpnRecheck({ rewrite = true } = {}) {
    const v = builtin();
    if (!v) throw new SetupError("VPN داخلی روی این سرور نیست.", 409);
    try {
      const out = await v.recheck({ rewrite });
      cache.delete("vpn:builtin");
      if (out.working && process.env.HTTPS_PROXY !== PROXY_ENV.HTTPS_PROXY) applyProxy({ ...PROXY_ENV });
      return out;
    } catch (error) {
      return vpnFail(error);
    }
  }
  async function vpnRemoveServer(id) {
    const v = builtin();
    if (!v) throw new SetupError("VPN داخلی روی این سرور نیست.", 409);
    try {
      const out = await v.removeServer(String(id || ""));
      cache.delete("vpn:builtin");
      return out;
    } catch (error) {
      return vpnFail(error);
    }
  }
  async function vpnSetEnabled(ids, enabled) {
    const v = builtin();
    if (!v) throw new SetupError("VPN داخلی روی این سرور نیست.", 409);
    try {
      const out = await v.setEnabled(ids, enabled === true);
      cache.delete("vpn:builtin");
      return out;
    } catch (error) {
      return vpnFail(error);
    }
  }
  async function vpnRules(rules) {
    const v = builtin();
    if (!v) throw new SetupError("VPN داخلی روی این سرور نیست.", 409);
    try {
      const out = await v.setRules(rules);
      cache.delete("vpn:builtin");
      return out;
    } catch (error) {
      return vpnFail(error, " چیزی عوض نشد.");
    }
  }
  async function vpnClear() {
    const v = builtin();
    if (!v) throw new SetupError("VPN داخلی روی این سرور نیست.", 409);
    await v.remove();
    cache.delete("vpn:builtin");
    return v.list();
  }
  async function connectVpn(raw, { replace = false } = {}) {
    if (!hasKit() && vpn) {
      let r;
      try {
        r = await vpn.apply(raw, { replace });
      } catch (error) {
        return vpnFail(error, " چیزی عوض نشد.");
      }
      cache.set("vpn:builtin", { at: now(), ttl: VPN_MS, value: { configured: true, ...r } });
      if (r.working && process.env.HTTPS_PROXY !== PROXY_ENV.HTTPS_PROXY) applyProxy({ ...PROXY_ENV });
      return { kit: true, builtin: true, configured: true, working: r.working, claude: r.claude, telegram: r.telegram, servers: r.servers, total: r.total, added: r.added, addedLive: r.addedLive, direct: null };
    }
    if (!hasKit()) throw new SetupError("ابزار VPN روی این سرور نصب نیست.", 409);
    if (applying) throw new SetupError("یک لینک دیگر همین حالا در حال بررسی است.", 409);
    applying = true;
    try {
      return await applyLink(raw);
    } finally {
      applying = false;
    }
  }
  // The proxy lines go into griffin.env and the running server only once the VPN works, so a link
  // that parses but does not connect never cuts a server that reached Claude directly.
  function useProxy() {
    const envFile = path.join(home, "griffin.env");
    if (fs.existsSync(envFile)) envSet(envFile, PROXY_ENV);
    if (Object.entries(PROXY_ENV).some(([k, v]) => process.env[k] !== v)) applyProxy({ ...PROXY_ENV });
  }
  async function applyLink(raw) {
    const link = String(raw || "").trim();
    if (!LINK.test(link) || link.length > 4096) throw new SetupError("فقط یک لینک بدهید: vless:// یا vmess:// یا trojan:// یا ss:// یا http:// یا socks5://");
    const stage = fs.mkdtempSync(path.join(home, ".vpn-"));
    try {
      fs.writeFileSync(path.join(stage, "vpn.txt"), `${link}\n`, { mode: 0o600 });
      const made = await run("python3", [path.join(kitDir, "link2config.py"), path.join(stage, "vpn.txt"), path.join(stage, "vpn.json")], { env });
      const tested = made.code === 0 ? await run(path.join(kitDir, "xray"), ["run", "-test", "-config", path.join(stage, "vpn.json")], { env }) : made;
      if (tested.code !== 0) {
        const reason = reasonOf(`${tested.stdout}\n${tested.stderr}`);
        throw new SetupError(`این لینک قابل استفاده نیست${reason ? ` (${reason})` : ""}. چیزی عوض نشد.`);
      }
      // As install.sh's apply_link: the link, then its config, a clean error file, a fresh Xray.
      fs.renameSync(path.join(stage, "vpn.txt"), linkFile());
      fs.chmodSync(linkFile(), 0o600);
      fs.renameSync(path.join(stage, "vpn.json"), path.join(kitDir, "config.json"));
      fs.writeFileSync(path.join(kitDir, "last-error.txt"), "");
      fs.rmSync(path.join(kitDir, ".failed"), { force: true });
    } finally {
      fs.rmSync(stage, { recursive: true, force: true });
    }
    await run("pkill", ["-u", uid, "-f", `${kitDir}/xray run -config`], { env });
    await run("bash", [path.join(kitDir, "vpn-run.sh")], { env });
    // Xray takes a moment to come up: a few tries before saying it does not work.
    let working = false;
    for (let i = 0; i < 3 && !working; i++) {
      if (i) await new Promise((resolve) => setTimeout(resolve, 2_000));
      working = await vpnWorking();
    }
    cache.set("vpn:working", { at: now(), ttl: VPN_MS, value: working, stamp: fs.statSync(linkFile()).mtimeMs });
    // The server and every chat after this one reach Claude and Telegram through it.
    if (working) useProxy();
    return { kit: true, configured: true, working, direct: await telegramDirect() };
  }

  // ---- Company data (Infisical) ----
  async function vaultUser(token) {
    try {
      const res = await fetchFn(`${vaultBase}/api/v2/users/me`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) });
      if (res.status === 401 || res.status === 403) return { state: "broken" };
      if (!res.ok) return { state: "unknown" };
      const body = await res.json();
      return { state: "ok", email: String(body?.user?.email || "") };
    } catch {
      return { state: "unknown" };
    }
  }
  const vaultMeta = () => {
    try {
      return JSON.parse(keyStore.getInternal(VAULT_META_SLOT) || "{}");
    } catch {
      return {};
    }
  };
  async function vaultStatus() {
    const token = keyStore.getInternal(VAULT_SLOT);
    if (!token) return { state: "missing" };
    const expiresAt = jwtExpiry(token);
    if (expiresAt && expiresAt <= now()) return { state: "broken", expired: true };
    const found = await cached(`vault:${sha(token)}`, settled, () => vaultUser(token));
    const email = found.email || vaultMeta().email || null;
    return { state: found.state, ...(email ? { email } : {}), ...(expiresAt ? { expiresAt: new Date(expiresAt).toISOString() } : {}) };
  }
  async function connectVault(raw) {
    const token = decodeVaultPaste(raw);
    if (!token) throw new SetupError("این متن توکنِ ورود Infisical نیست؛ همان متنی را که صفحه بعد از ورود نشان می‌دهد کامل بچسبانید.");
    const expiresAt = jwtExpiry(token);
    if (expiresAt && expiresAt <= now()) throw new SetupError("این توکن منقضی شده؛ دوباره وارد شوید.");
    const me = await vaultUser(token);
    if (me.state === "broken") throw new SetupError("Infisical این توکن را نپذیرفت؛ دوباره وارد شوید.");
    if (me.state !== "ok") throw new SetupError("Infisical جواب نداد؛ کمی بعد دوباره امتحان کنید.", 502);
    keyStore.setInternal(VAULT_SLOT, token);
    if (me.email) keyStore.setInternal(VAULT_META_SLOT, JSON.stringify({ email: me.email }));
    cache.set(`vault:${sha(token)}`, { at: now(), ttl: SETTLED_MS, value: me });
    return vaultStatus();
  }
  function disconnectVault() {
    keyStore.removeInternal(VAULT_SLOT);
    keyStore.removeInternal(VAULT_META_SLOT);
  }
  // For localVaultRoute only.
  function vaultToken() {
    const token = keyStore.getInternal(VAULT_SLOT);
    if (!token) return null;
    const expiresAt = jwtExpiry(token);
    return { token, base: vaultBase, expired: Boolean(expiresAt && expiresAt <= now()) };
  }

  async function status() {
    const [gitlab, vpn, vault] = await Promise.all([gitlabStatus(), vpnStatus(), vaultStatus()]);
    return { gitlab, vpn, stt: { state: sttReady() ? "ok" : "missing" }, vault };
  }

  return { status, connectGitlab, connectVpn, vpnList, vpnRecheck, vpnRemoveServer, vpnSetEnabled, vpnRules, vpnClear, connectVault, disconnectVault, vaultToken };
}

export function setupRoutes(api, { checks }) {
  const fail = (c, error) => (error instanceof SetupError ? c.json({ error: error.message }, error.status) : c.json({ error: "انجام نشد؛ کمی بعد دوباره امتحان کنید." }, 500));
  const body = async (c) => c.req.json().catch(() => ({}));
  const step = (fn) => async (c) => {
    try {
      return c.json(await fn(await body(c)));
    } catch (error) {
      return fail(c, error);
    }
  };
  api.get("/api/setup/status", async (c) => c.json(await checks.status()));
  api.post("/api/setup/gitlab", step(async (b) => ({ gitlab: await checks.connectGitlab(b.token) })));
  api.post("/api/setup/vpn", step(async (b) => ({ vpn: await checks.connectVpn(b.link, { replace: b.replace === true }) })));
  // The built-in VPN's servers: what was added, which ones work, test again, remove.
  api.get("/api/setup/vpn", step(async () => ({ vpn: await checks.vpnList() })));
  api.post("/api/setup/vpn/recheck", step(async (b) => ({ vpn: await checks.vpnRecheck({ rewrite: b.rewrite !== false }) })));
  api.put("/api/setup/vpn/rules", step(async (b) => ({ vpn: await checks.vpnRules({ direct: b.direct, proxied: b.proxied }) })));
  // Turn one or several servers on/off: {ids: [...], enabled: true|false}.
  api.put("/api/setup/vpn/servers/enabled", step(async (b) => ({ vpn: await checks.vpnSetEnabled(Array.isArray(b.ids) ? b.ids.slice(0, 64) : [], b.enabled) })));
  api.delete("/api/setup/vpn/servers/:id", async (c) => {
    try {
      return c.json({ vpn: await checks.vpnRemoveServer(c.req.param("id")) });
    } catch (error) {
      return fail(c, error);
    }
  });
  api.delete("/api/setup/vpn", async (c) => {
    try {
      return c.json({ vpn: await checks.vpnClear() });
    } catch (error) {
      return fail(c, error);
    }
  });
  api.post("/api/setup/vault", step(async (b) => ({ vault: await checks.connectVault(b.token) })));
  api.delete("/api/setup/vault", (c) => {
    checks.disconnectVault();
    return c.json({ vault: { state: "missing" } });
  });
}

// `vault-run` on this machine gets the Infisical token here: the caller must be this machine (a
// loopback peer, or the server's own address), must not come through a proxy, and must show the
// owner token from the data folder. Outside /api/*, so no browser cookie ever opens it.
export function localVaultRoute(app, { checks, ownerTokenFile }) {
  app.get("/local/v1/vault-token", (c) => {
    c.header("cache-control", "no-store");
    if (!fromThisMachine(c)) return c.json({ error: "local only" }, 403);
    let owner = "";
    try {
      owner = fs.readFileSync(ownerTokenFile, "utf8").trim();
    } catch {
      return c.json({ error: "no owner token" }, 503);
    }
    const given = String(c.req.header("authorization") || "").replace(/^Bearer\s+/i, "");
    if (!owner || !given || !crypto.timingSafeEqual(Buffer.from(sha(given), "hex"), Buffer.from(sha(owner), "hex"))) return c.json({ error: "unauthorized" }, 401);
    const found = checks.vaultToken();
    if (!found) return c.json({ error: "not connected" }, 404);
    if (found.expired) return c.json({ error: "expired" }, 401);
    return c.json({ token: found.token, base: found.base });
  });
}

// Griffin's secret store (secrets.mjs: get/set/delete) under setup/<slot>, as the key box the checks use.
export function secretSlots(secrets) {
  const name = (slot) => `setup/${slot}`;
  return {
    getInternal: (slot) => secrets.get(name(slot)) || null,
    setInternal: (slot, value) => secrets.set(name(slot), value, { note: `setup checklist: ${slot}` }),
    removeInternal: (slot) => secrets.delete(name(slot)),
  };
}

// The self-install folder: GRIFFIN_HOME (install.sh writes it), else the data folder's parent when the
// VPN kit sits there (an install.sh run before GRIFFIN_HOME was written), else none.
export function selfHome(dataDir, env = process.env) {
  const set = genv("HOME", "", env);
  if (set) return set;
  const parent = path.dirname(path.resolve(dataDir));
  return fs.existsSync(path.join(parent, "vpn", "link2config.py")) ? parent : null;
}

// One call from index.mjs: the checklist routes and the loopback vault route.
export function setupChecksRoutes(api, { secrets, dataDir, applyProxy, sttReady, vpn = null, env = process.env }) {
  const checks = createSetupChecks({ keyStore: secretSlots(secrets), home: selfHome(dataDir, env), applyProxy, sttReady, vpn, env });
  setupRoutes(api, { checks });
  localVaultRoute(api, { checks, ownerTokenFile: path.join(dataDir, "owner.token") });
  return checks;
}
