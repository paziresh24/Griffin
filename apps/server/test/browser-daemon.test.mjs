import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The daemon itself, against a played Playwright: each context's options are written to a log, so the test
// sees exactly what the daemon asked Chromium for.
const FAKE_PW = `
import fs from "node:fs";
const log = (entry) => fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify(entry) + "\\n");
const page = (ua) => ({
  on() {}, async goto() { return { status: () => (/HeadlessChrome/.test(ua) ? 410 : 200) }; },
  async waitForLoadState() {}, url: () => "https://console.example/login", async title() { return "login"; },
  async ariaSnapshot() { return "- heading"; }, async evaluate() { return ua; }, async close() {},
});
const RAW = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/124.0.0.0 Safari/537.36";
export const chromium = {
  async launch() {
    return {
      isConnected: () => true, on() {}, version: () => "124.0.6367.207",
      async newContext(options) {
        log({ newContext: options });
        const handlers = {};
        const ctx = {
          setDefaultTimeout() {}, setDefaultNavigationTimeout() {},
          on(event, fn) { handlers[event] = fn; },
          async newPage() { const p = page(options.userAgent || RAW); handlers.page?.(p); return p; },
          async storageState({ path }) { fs.writeFileSync(path, "{}"); },
          async close() {},
        };
        return ctx;
      },
    };
  },
};
`;

async function daemon(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "browser-daemon-"));
  fs.writeFileSync(path.join(home, "pw.mjs"), FAKE_PW);
  const log = path.join(home, "log.jsonl");
  const port = 41000 + Math.floor(Math.random() * 2000);
  const child = spawn(process.execPath, [new URL("../src/browser-daemon.mjs", import.meta.url).pathname], {
    env: { ...process.env, PORT: String(port), TOKEN: "t", BROWSER_HOME: home, PW_MODULE: path.join(home, "pw.mjs"), FAKE_LOG: log },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise((resolve, reject) => {
    child.stdout.on("data", (d) => /browser daemon/.test(d) && resolve());
    child.on("exit", (code) => reject(new Error(`daemon exited ${code}`)));
  });
  t.after(() => { child.kill(); fs.rmSync(home, { recursive: true, force: true }); });
  const act = async (body) => {
    const res = await fetch(`http://127.0.0.1:${port}/act`, { method: "POST", headers: { authorization: "Bearer t" }, body: JSON.stringify(body) });
    return res.json();
  };
  const contexts = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l).newContext) : []);
  return { act, contexts, home };
}

const CHROME = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

test("by default the context gets the desktop Chrome UA, without «HeadlessChrome»", async (t) => {
  const { act, contexts } = await daemon(t);
  const out = await act({ session: "c1", action: "open", url: "https://console.example/login" });
  assert.equal(out.status, 200);
  assert.equal(contexts()[0].userAgent, "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36");
  assert.doesNotMatch(out.userAgent, /Headless/);
});

test("userAgent sets the context's UA, stays for later calls and is saved with the profile", async (t) => {
  const { act, contexts, home } = await daemon(t);
  const out = await act({ session: "c1", action: "open", url: "https://console.example/login", profile: "kavenegar", userAgent: CHROME });
  assert.equal(out.status, 200);
  assert.equal(out.userAgent, CHROME);
  await act({ session: "c1", action: "snapshot" });
  await act({ session: "c1", action: "open", url: "https://console.example/next" });
  assert.equal(contexts().length, 1, "same context for the later calls");
  assert.equal(fs.readFileSync(path.join(home, "profiles/default/kavenegar.ua"), "utf8"), CHROME);
  assert.deepEqual((await act({ session: "x", action: "profiles" })).profiles, ["kavenegar"]);
  // Another chat that opens the same profile gets its UA without naming it.
  const again = await act({ session: "c2", action: "open", url: "https://console.example/login", profile: "kavenegar" });
  assert.equal(again.userAgent, CHROME);
  assert.equal(contexts()[1].userAgent, CHROME);
});

test("a different userAgent reopens the context with the same profile; a bad one is refused", async (t) => {
  const { act, contexts } = await daemon(t);
  await act({ session: "c1", action: "open", url: "https://console.example/login", profile: "p" });
  const out = await act({ session: "c1", action: "open", url: "https://console.example/login", userAgent: CHROME });
  assert.equal(out.profile, "p");
  assert.equal(contexts().length, 2);
  assert.equal(contexts()[1].userAgent, CHROME);
  assert.match((await act({ session: "c1", action: "open", url: "https://x", userAgent: "a\nb" })).error, /printable ASCII/);
});
