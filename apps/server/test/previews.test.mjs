import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cleanDir, createPreviews, localExec, previewRunsLocal, rewriteLocation } from "../src/previews.mjs";

// A kv-only store and an exec that plays the sandbox's shell: it answers the start script the way the
// real one does (PID, READY, the log), the probe of live pids, and `hostname -i`.
function setup({ upstreamPort = 41111, previewHost = "", publicUrl = "https://app.example.com", script = null, ...extra } = {}) {
  const kv = new Map();
  const store = {
    getKv: (key) => (kv.has(key) ? JSON.parse(kv.get(key)) : null),
    setKv: (key, value) => kv.set(key, JSON.stringify(value)),
    getChat: (id) => (id === "c1" ? { id, worktree_path: "/workspace/repos/_wt/demo-1234" } : null),
  };
  const calls = [];
  const alive = new Set();
  const exec = async (command) => {
    calls.push(command);
    if (script) {
      const out = script(command);
      if (out !== undefined) return { stdout: out };
    }
    if (/^hostname -i/.test(command)) return { stdout: "172.19.0.2 \n" };
    if (command.includes("setsid nohup")) {
      alive.add(4242);
      return { stdout: "PID 4242\nREADY\n---LOG\nlistening\n" };
    }
    if (command.includes("kill -0 $p")) return { stdout: [...alive].join("\n") };
    return { stdout: "" };
  };
  let clock = 1_000_000;
  const previews = createPreviews({ store, exec, previewHost: () => previewHost, publicUrl: () => publicUrl, sandboxAddr: () => "127.0.0.1", now: () => clock, log: () => {}, ...extra });
  return { previews, store, calls, alive, kv, tick: (ms) => { clock += ms; } };
}

const listen = (handler) =>
  new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });

test("dirs: relative to the worktree, absolute only under the allowed roots", () => {
  const base = "/workspace/repos/_wt/demo-1234";
  assert.equal(cleanDir("", { base }), base);
  assert.equal(cleanDir("web", { base }), `${base}/web`);
  assert.equal(cleanDir("/root/site", { base }), "/root/site");
  assert.equal(cleanDir("/tmp", {}), "/tmp");
  assert.throws(() => cleanDir("../other", { base }), /inside this chat/, "another chat's tree is not this one's to run");
  assert.throws(() => cleanDir("/etc", { base }), /must be under/);
  assert.throws(() => cleanDir("/workspace/repos/platform-gitops", { base }), /must be under/, "the read-only clones are not a place to run things");
  assert.throws(() => cleanDir("", {}), /no repo worktree/);
});

test("a host install: worktrees outside /workspace are allowed when index passes their root", async () => {
  const roots = ["/home/ubuntu/git-repos-griffin/_wt", "/root", "/tmp"];
  const base = "/home/ubuntu/git-repos-griffin/_wt/demo-1234";
  assert.equal(cleanDir("", { base, roots }), base);
  assert.equal(cleanDir("web", { base, roots }), `${base}/web`);
  assert.throws(() => cleanDir("", { base }), /must be under/, "the default roots alone refuse a host worktree");
  assert.throws(() => cleanDir("/home/ubuntu/git-repos-griffin/griffin", { base, roots }), /must be under/, "the clones beside _wt stay out");
  const s = setup({ dirRoots: roots, worktreeOf: () => base });
  const out = await s.previews.tools("c1").preview_start.execute({ title: "host" });
  assert.equal(out.isError, undefined);
  assert.equal(JSON.parse(out.content[0].text).dir, base);
});

test("no broker on this install: preview_start says so instead of ENOENT", async () => {
  const s = setup({
    script: () => {
      const error = new Error("connect ENOENT /run/griffin/broker.sock");
      error.code = "ENOENT";
      throw error;
    },
  });
  const out = await s.previews.tools("c1").preview_start.execute({ title: "x" });
  assert.equal(out.isError, true);
  assert.match(out.content[0].text, /no broker/);
});

test("Location from a dev server moves under the preview prefix", () => {
  const ctx = { prefix: "/p/TOKEN", port: 41111 };
  assert.equal(rewriteLocation("/login", ctx), "/p/TOKEN/login");
  assert.equal(rewriteLocation("http://localhost:41111/a?b=1", ctx), "/p/TOKEN/a?b=1");
  assert.equal(rewriteLocation("http://127.0.0.1:41111", ctx), "/p/TOKEN/");
  assert.equal(rewriteLocation("https://example.com/x", ctx), "https://example.com/x");
  assert.equal(rewriteLocation("//cdn.example.com/x", ctx), "//cdn.example.com/x");
  assert.equal(rewriteLocation("http://localhost:3000/x", ctx), "http://localhost:3000/x", "another port is not this app");
});

test("preview_start runs the command in the chat's worktree and reports no link", async () => {
  const s = setup();
  const tools = s.previews.tools("c1");
  const out = await tools.preview_start.execute({ command: "npm run dev -- --port $PORT", title: "Vite app" });
  assert.equal(out.isError, undefined);
  const body = JSON.parse(out.content[0].text);
  assert.equal(body.status, "running");
  assert.equal(body.dir, "/workspace/repos/_wt/demo-1234");
  assert.match(body.localUrl, /^http:\/\/127\.0\.0\.1:41\d\d\d$/);
  assert.ok(body.port >= 41000 && body.port <= 41999);
  assert.doesNotMatch(out.content[0].text, /\/p\//, "the token link goes to the owner's card only");
  const script = s.calls.find((c) => c.includes("setsid nohup"));
  assert.match(script, /base64 -d/);
  assert.ok(script.includes(Buffer.from("npm run dev -- --port $PORT").toString("base64")), "the command travels base64, never quoted into the script");
  assert.deepEqual((await tools.preview_list.execute({})).content[0].text.includes(body.id), true);
});

test("a command that dies before it listens is an error with the log", async () => {
  const s = setup({ script: (c) => (c.includes("setsid nohup") ? "PID 7\nDEAD\n---LOG\nError: Cannot find module 'vite'\n" : undefined) });
  const out = await s.previews.tools("c1").preview_start.execute({ command: "vite" });
  assert.equal(out.isError, true);
  const body = JSON.parse(out.content[0].text);
  assert.match(body.log, /Cannot find module/);
  assert.equal(body.status, "failed");
});

test("a port that stays closed leaves it starting, with a note", async () => {
  const s = setup({ script: (c) => (c.includes("setsid nohup") ? "PID 9\nTIMEOUT\n---LOG\ncompiling…\n" : undefined) });
  const out = await s.previews.tools("c1").preview_start.execute({ command: "slow", waitSec: 3 });
  const body = JSON.parse(out.content[0].text);
  assert.equal(body.status, "starting");
  assert.match(body.note, /preview_logs/);
});

test("the limit on live previews, and stopping frees a slot", async () => {
  const s = setup({ maxLive: 2 });
  const tools = s.previews.tools("c1");
  const a = JSON.parse((await tools.preview_start.execute({})).content[0].text);
  await tools.preview_start.execute({});
  const third = await tools.preview_start.execute({});
  assert.equal(third.isError, true);
  assert.match(third.content[0].text, /stop one first/);
  await tools.preview_stop.execute({ id: a.id });
  assert.ok(s.calls.some((c) => c.includes("kill -TERM")));
  assert.equal((await tools.preview_start.execute({})).isError, undefined);
});

test("the proxy: prefix stripped, cookie and headers cleaned, redirect and csp rewritten", async () => {
  const seen = [];
  const up = await listen((req, res) => {
    seen.push({ url: req.url, headers: req.headers });
    if (req.url === "/old") {
      res.writeHead(302, { location: "/new" });
      return res.end();
    }
    res.writeHead(200, { "content-type": "text/html", "cache-control": "max-age=999", "x-frame-options": "DENY", "content-security-policy": "default-src 'self'; frame-ancestors 'none'", "set-cookie": ["a=1; Domain=example.com; Path=/", "b=2"] });
    res.end("<h1>hi</h1>");
  });
  try {
    const s = setup({ script: (c) => (c.includes("setsid nohup") ? "PID 5\nREADY\n---LOG\n\n" : undefined) });
    const { rec } = await s.previews.start({ chatId: "c1", command: "x" });
    // The fake upstream listens on an ephemeral port; point the record at it.
    rec.port = up.port;
    const base = `https://app.example.com/p/${rec.token}`;

    const res = await s.previews.handle(new Request(`${base}/a/b?x=1`, { headers: { cookie: "karsara_session=SECRET; keep=1", "x-forwarded-proto": "https", authorization: "Bearer own" } }));
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "<h1>hi</h1>");
    assert.equal(seen[0].url, "/a/b?x=1");
    assert.equal(seen[0].headers.cookie, "keep=1", "the app's session never reaches the page's code");
    assert.equal(seen[0].headers.host, `localhost:${up.port}`);
    assert.equal(seen[0].headers["x-forwarded-prefix"], `/p/${rec.token}`);
    assert.equal(seen[0].headers.authorization, "Bearer own");
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.equal(res.headers.get("x-frame-options"), null);
    assert.match(res.headers.get("content-security-policy"), /default-src 'self'/);
    assert.doesNotMatch(res.headers.get("content-security-policy").split(",")[0], /frame-ancestors/);
    assert.match(res.headers.get("content-security-policy"), /sandbox allow-scripts/, "no preview host: the page is sandboxed");
    assert.doesNotMatch(res.headers.get("content-security-policy"), /allow-same-origin/);
    const cookies = res.headers.getSetCookie();
    assert.deepEqual(cookies, ["a=1; Path=/", "b=2"], "Domain dropped; no routing cookie in path mode");

    const moved = await s.previews.handle(new Request(`${base}/old`));
    assert.equal(moved.status, 302);
    assert.equal(moved.headers.get("location"), `/p/${rec.token}/new`);

    const bare = await s.previews.handle(new Request(base));
    assert.equal(bare.status, 308);
    assert.equal(bare.headers.get("location"), `/p/${rec.token}/`);

    assert.equal(await s.previews.handle(new Request("https://app.example.com/api/chats")), null, "not a preview request: carry on");
    const unknown = await s.previews.handle(new Request("https://app.example.com/p/AAAAAAAAAAAAAAAAAAAAAAAA/"));
    assert.equal(unknown.status, 404);
  } finally {
    up.server.close();
  }
});

test("a body is forwarded to the app", async () => {
  let got = "";
  const up = await listen((req, res) => {
    req.on("data", (d) => (got += d));
    req.on("end", () => res.end("ok"));
  });
  try {
    const s = setup();
    const { rec } = await s.previews.start({ chatId: "c1" });
    rec.port = up.port;
    const res = await s.previews.handle(new Request(`https://app.example.com/p/${rec.token}/api`, { method: "POST", body: JSON.stringify({ a: 1 }), headers: { "content-type": "application/json" }, duplex: "half" }));
    assert.equal(await res.text(), "ok");
    assert.equal(got, '{"a":1}');
  } finally {
    up.server.close();
  }
});

test("a dead app is a 502 page that retries while it is starting", async () => {
  const s = setup({ script: (c) => (c.includes("setsid nohup") ? "PID 5\nTIMEOUT\n---LOG\n\n" : undefined) });
  const { rec } = await s.previews.start({ chatId: "c1" });
  rec.port = 1; // nothing listens there
  const res = await s.previews.handle(new Request(`https://app.example.com/p/${rec.token}/`));
  assert.equal(res.status, 502);
  assert.match(await res.text(), /location\.reload/);
});

test("a stopped preview answers 410", async () => {
  const s = setup();
  const { rec } = await s.previews.start({ chatId: "c1" });
  await s.previews.stop(rec.id);
  const res = await s.previews.handle(new Request(`https://app.example.com/p/${rec.token}/`));
  assert.equal(res.status, 410);
});

test("preview host: own origin, no sandbox, routed by prefix, referer and cookie; the app stays out of reach", async () => {
  const seen = [];
  const up = await listen((req, res) => {
    seen.push(req.url);
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("up");
  });
  try {
    const s = setup({ previewHost: "prev.example.com" });
    const { rec } = await s.previews.start({ chatId: "c1" });
    rec.port = up.port;
    const open = `https://prev.example.com/p/${rec.token}/`;
    assert.equal(s.previews.view(rec).url, open);
    assert.equal(s.previews.view(rec).mode, "host");

    const entry = await s.previews.handle(new Request(open));
    assert.equal(entry.status, 200);
    assert.doesNotMatch(entry.headers.get("content-security-policy") || "", /sandbox/);
    assert.match(entry.headers.getSetCookie().join(";"), new RegExp(`gp_t=${rec.token}.*SameSite=None.*Partitioned.*Secure`));

    // /assets/app.js has no prefix: the page's Referer, or else the routing cookie, finds the preview.
    const byReferer = await s.previews.handle(new Request("https://prev.example.com/assets/app.js", { headers: { referer: open } }));
    assert.equal(byReferer.status, 200);
    const byCookie = await s.previews.handle(new Request("https://prev.example.com/dashboard", { headers: { cookie: `gp_t=${rec.token}` } }));
    assert.equal(byCookie.status, 200);
    assert.deepEqual(seen, ["/", "/assets/app.js", "/dashboard"]);

    // On the app's own host a preview path is refused (it would run unsandboxed next to the session).
    const wrongHost = await s.previews.handle(new Request(`https://app.example.com/p/${rec.token}/`));
    assert.equal(wrongHost.status, 404);

    // Unrouted on the preview host: only what never uses the app's cookie stays open.
    const api = await s.previews.handle(new Request("https://prev.example.com/api/chats", { headers: { cookie: "karsara_session=stale" } }));
    assert.equal(api.status, 404);
    const post = await s.previews.handle(new Request("https://prev.example.com/anything", { method: "POST", body: "x" }));
    assert.equal(post.status, 404);
    for (const request of [
      new Request("https://prev.example.com/mcp", { method: "POST", body: "{}" }),
      new Request("https://prev.example.com/api/public/integrations/x/webhook", { method: "POST", body: "{}" }),
      new Request("https://prev.example.com/", { method: "GET" }),
      new Request("https://prev.example.com/healthz"),
    ]) assert.equal(await s.previews.handle(request), null, `${request.method} ${new URL(request.url).pathname} stays open`);
  } finally {
    up.server.close();
  }
});

test("a websocket handshake is tunnelled to the app", async () => {
  const up = net.createServer((socket) => {
    socket.once("data", (chunk) => {
      const head = chunk.toString();
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\nx-saw: ${/^host: localhost:\d+/im.test(head) ? "host" : "?"}-${/cookie/i.test(head) ? "cookie" : "nocookie"}\r\n\r\n`);
      socket.on("data", (d) => socket.write(`echo:${d}`));
    });
  });
  await new Promise((resolve) => up.listen(0, "127.0.0.1", resolve));
  const front = http.createServer();
  try {
    const s = setup();
    const { rec } = await s.previews.start({ chatId: "c1" });
    rec.port = up.address().port;
    front.on("upgrade", (req, socket, head) => { if (!s.previews.handleUpgrade(req, socket, head)) socket.destroy(); });
    await new Promise((resolve) => front.listen(0, "127.0.0.1", resolve));
    const client = net.connect(front.address().port, "127.0.0.1");
    const chunks = [];
    client.on("data", (d) => chunks.push(d));
    client.write(`GET /p/${rec.token}/hmr HTTP/1.1\r\nhost: app.example.com\r\nupgrade: websocket\r\nconnection: Upgrade\r\ncookie: karsara_session=S\r\nsec-websocket-key: x\r\n\r\n`);
    await new Promise((resolve) => setTimeout(resolve, 150));
    client.write("ping");
    await new Promise((resolve) => setTimeout(resolve, 150));
    const all = Buffer.concat(chunks).toString();
    assert.match(all, /101 Switching Protocols/);
    assert.match(all, /x-saw: host-nocookie/, "host is the app's, the session cookie is not forwarded");
    assert.match(all, /echo:ping/);
    client.destroy();
  } finally {
    front.close();
    up.close();
  }
});

test("tick: a process that is gone, an idle preview, an old stopped record", async () => {
  const s = setup({ idleMs: 3600_000 });
  const a = (await s.previews.start({ chatId: "c1" })).rec;
  s.alive.clear(); // the sandbox restarted
  await s.previews.tick();
  assert.equal(s.previews.get(a.id).status, "stopped");
  assert.match(s.previews.get(a.id).reason, /gone/);

  const b = (await s.previews.start({ chatId: "c1" })).rec;
  s.tick(3600_001);
  await s.previews.tick();
  assert.equal(s.previews.get(b.id).status, "stopped");
  assert.match(s.previews.get(b.id).reason, /2 hours/);

  s.tick(25 * 3600_000);
  await s.previews.tick();
  assert.equal(s.previews.get(a.id), null, "old stopped records are forgotten");
});

test("records survive a restart of the app", async () => {
  const s = setup();
  const { rec } = await s.previews.start({ chatId: "c1", title: "kept" });
  const again = createPreviews({ store: s.store, exec: async () => ({ stdout: "" }), sandboxAddr: () => "127.0.0.1", log: () => {} });
  assert.equal(again.get(rec.id)?.title, "kept");
  assert.equal(again.get(rec.id)?.token, rec.token);
});

test("a host per preview: the token is the first label, nothing to route", async () => {
  const seen = [];
  const up = await listen((req, res) => {
    seen.push(req.url);
    if (req.url === "/old") {
      res.writeHead(302, { location: "/new" });
      return res.end();
    }
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("up");
  });
  try {
    const s = setup({ previewHost: "*.pv.example.com" });
    const { rec } = await s.previews.start({ chatId: "c1" });
    rec.port = up.port;
    assert.match(rec.token, /^[a-f0-9]{32}$/, "a token is a valid, case-free host name label");
    assert.equal(s.previews.view(rec).url, `https://${rec.token}.pv.example.com/`);
    assert.equal(s.previews.view(rec).mode, "host");

    const res = await s.previews.handle(new Request(`https://${rec.token}.pv.example.com/assets/app.js?v=1`));
    assert.equal(res.status, 200);
    assert.doesNotMatch(res.headers.get("content-security-policy") || "", /sandbox/, "its own origin: no sandbox");
    assert.deepEqual(res.headers.getSetCookie(), [], "no routing cookie: the host says which preview");
    assert.deepEqual(seen, ["/assets/app.js?v=1"]);
    const moved = await s.previews.handle(new Request(`https://${rec.token}.pv.example.com/old`));
    assert.equal(moved.headers.get("location"), "/new", "no prefix to add");

    assert.equal((await s.previews.handle(new Request("https://ffffffffffffffffffffffffffffffff.pv.example.com/"))).status, 404);
    assert.equal(await s.previews.handle(new Request("https://app.example.com/api/chats")), null, "the app's host is not touched");
    assert.equal((await s.previews.handle(new Request(`https://app.example.com/p/${rec.token}/`))).status, 404);
  } finally {
    up.server.close();
  }
});

test("runner: a host install with no sandbox runs previews on the machine itself", () => {
  const none = () => false;
  assert.equal(previewRunsLocal({ env: {}, exists: none }), true, "no container, no sandbox key: local");
  assert.equal(previewRunsLocal({ env: {}, exists: (f) => f === "/.dockerenv" }), false, "in a container: the sandbox");
  assert.equal(previewRunsLocal({ env: {}, exists: (f) => f === "/sandbox-keys/client" }), false, "the sandbox key is there");
  assert.equal(previewRunsLocal({ env: { GRIFFIN_SANDBOX_KEY: "/k" }, exists: (f) => f === "/k" }), false, "its own key path");
  assert.equal(previewRunsLocal({ env: { GRIFFIN_SANDBOX_HOST: "10.0.0.5" }, exists: none }), false, "a remote sandbox");
  assert.equal(previewRunsLocal({ setting: "sandbox", env: {}, exists: none }), false);
  assert.equal(previewRunsLocal({ setting: "local", env: {}, exists: () => true }), true);
});

const hasTools = ["nc", "python3"].every((bin) => (process.env.PATH || "").split(":").some((dir) => dir && fs.existsSync(path.join(dir, bin))));
test("runner: local start, look and stop of a real static server", { skip: !hasTools && "needs nc and python3" }, async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pv-local-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  fs.writeFileSync(path.join(tmp, "index.html"), "<h1>hi</h1>");
  const kv = new Map();
  const store = { getKv: (k) => (kv.has(k) ? JSON.parse(kv.get(k)) : null), setKv: (k, v) => kv.set(k, JSON.stringify(v)), getChat: () => null };
  const previews = createPreviews({
    store,
    exec: (command) => localExec(command, { env: { ...process.env, SECRET_TOKEN: "x" } }),
    local: true,
    sandboxAddr: () => "127.0.0.1",
    previewDir: path.join(tmp, ".previews"),
    dirRoots: [tmp],
    log: () => {},
  });
  const { rec, outcome } = await previews.start({ chatId: "c1", dir: tmp, command: 'env > env.txt; exec python3 -m http.server "$PORT" --bind 127.0.0.1', waitSec: 15 });
  try {
    assert.equal(outcome, "ready");
    const res = await previews.handle(new Request(`https://nova.example.com/p/${rec.token}/`));
    assert.equal(res.status, 200);
    assert.match(await res.text(), /<h1>hi<\/h1>/);
    assert.doesNotMatch(fs.readFileSync(path.join(tmp, "env.txt"), "utf8"), /SECRET_TOKEN/, "the app's env does not reach the preview");
    await assert.rejects(previews.start({ chatId: "c1", dir: path.join(tmp, "nope") }), /does not exist on this machine/);
  } finally {
    await previews.stop(rec.id);
  }
  assert.equal(previews.get(rec.id).status, "stopped");
});
