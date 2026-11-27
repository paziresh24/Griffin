import test from "node:test";
import assert from "node:assert/strict";
import { accountEgressEnv, assertEgress } from "../src/account-egress.mjs";

// One account, one exit (owner 2026-11-25). An account with no proxy of its own must be byte-for-byte
// the environment it always was; an account with one must have no way out except through it.

test("an account with no proxy keeps the environment it always had", () => {
  const base = { PATH: "/bin", HTTPS_PROXY: "http://shared:3128", NO_PROXY: "*", TZ: "UTC" };
  assert.deepEqual(accountEgressEnv(base, {}), base);
  assert.deepEqual(accountEgressEnv(base, { proxyUrl: "", timezone: "" }), base);
  // The provider factory passes egress:null for an account nobody pinned — that must be a no-op too.
  assert.deepEqual(accountEgressEnv(base, null), base);
  assert.deepEqual(accountEgressEnv(base), base);
});

test("a pinned account sends everything through its own exit", () => {
  const out = accountEgressEnv({ PATH: "/bin", HTTPS_PROXY: "http://shared:3128", NO_PROXY: "*" }, {
    proxyUrl: "socks5://10.0.0.9:1080",
  });
  assert.equal(out.HTTPS_PROXY, "socks5://10.0.0.9:1080");
  assert.equal(out.HTTP_PROXY, "socks5://10.0.0.9:1080");
  assert.equal(out.https_proxy, "socks5://10.0.0.9:1080");
  assert.equal(out.NODE_USE_ENV_PROXY, "1");
  // The inherited "*" would have leaked the vendor hosts out unproxied.
  assert.equal(out.NO_PROXY, "127.0.0.1,localhost,::1");
  assert.equal(out.no_proxy, "127.0.0.1,localhost,::1");
  assert.equal(out.PATH, "/bin");
});

test("the account's clock follows its exit", () => {
  const out = accountEgressEnv({ TZ: "UTC" }, { proxyUrl: "socks5://10.0.0.9:1080", timezone: "America/Toronto" });
  assert.equal(out.TZ, "America/Toronto");
});

test("a reachable proxy lets the send through", async () => {
  const r = await assertEgress({ proxyUrl: "socks5://10.0.0.9:1080" }, { connect: async () => {} });
  assert.equal(r.ok, true);
});

test("a dropped proxy stops the send instead of falling back to the server's address", async () => {
  const r = await assertEgress(
    { proxyUrl: "socks5://10.0.0.9:1080" },
    { connect: async () => { throw Object.assign(new Error("refused"), { code: "ECONNREFUSED" }); } },
  );
  assert.equal(r.ok, false);
  assert.equal(r.reason, "egress_down");
  assert.match(r.error, /متوقف/);
});

test("a hanging proxy times out rather than waiting forever", async () => {
  const r = await assertEgress({ proxyUrl: "socks5://10.0.0.9:1080" }, { connect: () => new Promise(() => {}), timeoutMs: 30 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "egress_down");
});

test("no proxy means nothing is checked and nothing changes", async () => {
  const r = await assertEgress(null, { connect: async () => { throw new Error("must not be called"); } });
  assert.equal(r.ok, true);
  assert.equal(r.via, "direct");
});

test("a malformed proxy URL is refused up front", async () => {
  const r = await assertEgress({ proxyUrl: "10.0.0.9:1080" }, { connect: async () => {} });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "bad_proxy");
});
