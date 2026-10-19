// The sandbox address is a setting; with only the key set it is the compose one (127.0.0.1:2222).
import test from "node:test";
import assert from "node:assert/strict";

const tools = await import("../src/tools.mjs");

test("sandbox: opt-in by key; 127.0.0.1:2222 without other settings, like the compose default", () => {
  assert.equal(typeof tools.sandboxHost, "function", "the sandbox address is configurable");
  assert.equal(tools.sandboxHost({}), null, "no key, no sandbox");
  assert.deepEqual(tools.sandboxHost({ GRIFFIN_SANDBOX_KEY: "/sandbox-keys/client" }), { host: "127.0.0.1", port: 2222, user: "root", keyFile: "/sandbox-keys/client", loopback: true });
  assert.deepEqual(tools.sandboxHost({ GRIFFIN_SANDBOX_KEY: "/k", GRIFFIN_SANDBOX_ADDR: "127.0.0.1:2422" }).port, 2422);
});

test("sandbox: GRIFFIN_SANDBOX_HOST/PORT move it; host-key checking is skipped only on loopback", () => {
  const local = tools.sandboxHost({ GRIFFIN_SANDBOX_PORT: "2322", GRIFFIN_SANDBOX_KEY: "/home/u/.griffin/sandbox/client" });
  assert.equal(local.port, 2322);
  assert.equal(local.keyFile, "/home/u/.griffin/sandbox/client");
  assert.equal(local.loopback, true);
  const remote = tools.sandboxHost({ GRIFFIN_SANDBOX_HOST: "192.0.2.99", GRIFFIN_SANDBOX_KEY: "/k" });
  assert.equal(remote.host, "192.0.2.99");
  assert.equal(remote.loopback, undefined, "a non-loopback sandbox keeps host-key checking");
  assert.equal(remote.tofu, true);
});
