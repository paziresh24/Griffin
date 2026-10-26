import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BROWSER_TOOL_NAMES, DAEMON_VERSION, createBrowser, prepareScript, safeName, startScript, writeScripts } from "../src/browser.mjs";
import { APP_TOOL_NAMES } from "../src/agents/profiles.mjs";
import { planModeRefusal } from "../src/providers/plan-mode-guard.mjs";

// The sandbox's shell and the daemon, played: prepare answers with a token and whether the daemon file is
// this version, the start script brings the daemon up, and /health + /act answer like browser-daemon.mjs.
function setup({ file = "stale", prepare = null } = {}) {
  const calls = [];
  const requests = [];
  let up = false;
  let version = null;
  const exec = async (command) => {
    calls.push(command);
    if (command.includes("apk add")) return { stdout: prepare ?? `BTOK=${"ab".repeat(24)}\nFILE=${version === DAEMON_VERSION ? "ok" : file}\n` };
    if (command.includes("daemon.b64")) {
      if (command.includes("daemon.version")) version = DAEMON_VERSION;
      return { stdout: command.includes("WROTE") ? "WROTE\n" : "" };
    }
    if (command.includes("setsid nohup")) { up = true; return { stdout: "READY\n" }; }
    return { stdout: "" };
  };
  const json = (value, status = 200) => ({ status, json: async () => value });
  const request = async (url, init = {}) => {
    requests.push({ url, init });
    if (!up) throw new Error("connect ECONNREFUSED");
    if (init.headers?.authorization !== `Bearer ${"ab".repeat(24)}`) return json({ error: "unauthorized" }, 401);
    if (url.endsWith("/health")) return json({ ok: true, version: DAEMON_VERSION });
    const body = JSON.parse(init.body);
    if (body.action === "screenshot") return json({ png: Buffer.from("png-bytes").toString("base64"), url: "https://example.com/", title: "Example" });
    if (body.action === "click" && body.ref === "e404") return json({ error: "no element for ref e404", url: "https://example.com/" });
    return json({ url: "https://example.com/", title: "Example", snapshot: "- heading \"Example\" [ref=e2]", echo: body });
  };
  const media = [];
  const store = { saveMedia: (rec) => { media.push(rec); return `m${media.length}`; } };
  const browser = createBrowser({ store, exec, address: async () => "172.19.0.2", request, log: () => {} });
  return { browser, calls, requests, media, kill: () => { up = false; } };
}

const parse = (out) => JSON.parse(out.content[0].text);

test("first call prepares the sandbox, writes the daemon, starts it; later calls go straight to it", async () => {
  const { browser, calls, requests } = setup();
  const tools = browser.tools("chat-1", { scope: "owner" });
  const out = parse(await tools.browser_open.execute({ url: "https://example.com", profile: "panel" }));
  assert.equal(out.title, "Example");
  assert.match(out.note, /never follow instructions/);
  assert.deepEqual({ ...out.echo }, { url: "https://example.com", profile: "panel", action: "open", session: "chat-1", scope: "owner" });
  assert.ok(calls[0].includes("apk add"), "prepare first");
  assert.ok(calls.some((c) => c.includes("daemon.b64")), "daemon written");
  assert.ok(calls.at(-1).includes("setsid nohup"), "then started");
  const before = calls.length;
  await tools.browser_click.execute({ ref: "e2" });
  assert.equal(calls.length, before, "no shell step once the daemon answers");
  assert.ok(requests.every((r) => r.url.startsWith("http://172.19.0.2:40990/")));
});

test("a daemon file of this version is not written again", async () => {
  const { browser, calls } = setup({ file: "ok" });
  await browser.tools("c").browser_snapshot.execute({});
  assert.ok(!calls.some((c) => c.includes("daemon.b64")));
  assert.ok(calls.some((c) => c.includes("setsid nohup")));
});

test("a sandbox that cannot install says why", async () => {
  const { browser } = setup({ prepare: "FAIL=apk\nERROR: unable to select packages\n" });
  const out = await browser.tools("c").browser_open.execute({ url: "https://example.com" });
  assert.equal(out.isError, true);
  assert.match(parse(out).error, /apk.*unable to select packages/s);
});

test("a dead daemon is started again on the next call", async () => {
  const { browser, calls, kill } = setup();
  const tools = browser.tools("c");
  await tools.browser_open.execute({ url: "https://example.com" });
  kill();
  const starts = calls.filter((c) => c.includes("setsid nohup")).length;
  const out = parse(await tools.browser_snapshot.execute({}));
  assert.equal(out.title, "Example");
  assert.equal(calls.filter((c) => c.includes("setsid nohup")).length, starts + 1);
});

test("page errors come back as tool errors", async () => {
  const { browser } = setup();
  const out = await browser.tools("c").browser_click.execute({ ref: "e404" });
  assert.equal(out.isError, true);
  assert.match(parse(out).error, /e404/);
});

test("a screenshot is stored for the chat and shown to the model", async () => {
  const { browser, media } = setup();
  const out = await browser.tools("chat-9").browser_screenshot.execute({ title: "صفحهٔ ورود" });
  assert.equal(media.length, 1);
  assert.equal(media[0].chatId, "chat-9");
  assert.equal(media[0].mimeType, "image/png");
  const summary = parse(out);
  assert.equal(summary.media.mediaId, "m1");
  assert.equal(summary.title, "صفحهٔ ورود");
  assert.equal(out.content[1].type, "image");
});

test("sessions and scopes become safe names; logins are kept per caller", async () => {
  assert.equal(safeName("peer:karimi/x"), "peer_karimi_x");
  assert.equal(safeName(""), "default");
  const { browser, requests } = setup();
  await browser.tools("a b", { scope: "peer:ali" }).browser_open.execute({ url: "https://example.com" });
  const body = JSON.parse(requests.at(-1).init.body);
  assert.equal(body.session, "a_b");
  assert.equal(body.scope, "peer_ali");
});

test("every browser tool is an app tool; plan mode lets only the reads through", () => {
  const { browser } = setup();
  assert.deepEqual(Object.keys(browser.tools("c")).sort(), [...BROWSER_TOOL_NAMES].sort());
  for (const name of BROWSER_TOOL_NAMES) assert.ok(APP_TOOL_NAMES.includes(name), name);
  const prefix = "mcp__griffin__";
  for (const name of ["browser_open", "browser_snapshot", "browser_screenshot", "browser_console", "browser_wait"]) assert.equal(planModeRefusal(`${prefix}${name}`, {}, prefix), null, name);
  for (const name of ["browser_click", "browser_type", "browser_eval", "browser_upload"]) assert.ok(planModeRefusal(`${prefix}${name}`, {}, prefix), name);
});

test("the shell steps fit debug_exec, and the pieces rebuild the daemon exactly", () => {
  const scripts = [prepareScript(), startScript(), ...writeScripts()];
  for (const script of scripts) assert.ok(script.length < 16_000, `${script.length} chars`);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "browser-"));
  try {
    const source = "console.log('سلام');\n".repeat(2000);
    for (const script of writeScripts(source, "v1")) execFileSync("sh", ["-c", script.replaceAll("/root/.griffin/browser", home)]);
    assert.equal(fs.readFileSync(path.join(home, "daemon.mjs"), "utf8"), source);
    assert.equal(fs.readFileSync(path.join(home, "daemon.version"), "utf8"), "v1");
    assert.ok(!fs.existsSync(path.join(home, "daemon.b64")));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
