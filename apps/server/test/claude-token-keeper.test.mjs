import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTokenKeeper, tokenExpiry, LOCK_NAME } from "../src/claude-token-keeper.mjs";

function account(expiresAt) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "griffin-keeper-"));
  fs.writeFileSync(path.join(dir, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "x", refreshToken: "y", expiresAt } }));
  return dir;
}
const setExpiry = (dir, at) => fs.writeFileSync(path.join(dir, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "x2", refreshToken: "y2", expiresAt: at } }));

test("a lock a dead process left is removed; a live one (touched lately) stays", async () => {
  const t = Date.now();
  const dir = account(t + 3 * 3600_000);
  try {
    const lock = path.join(dir, LOCK_NAME);
    fs.mkdirSync(lock);
    const keeper = createTokenKeeper({ dirs: () => [dir], renew: async () => assert.fail("not due"), now: () => t });
    fs.utimesSync(lock, new Date(t - 10_000), new Date(t - 10_000));
    await keeper.tick();
    assert.ok(fs.existsSync(lock), "touched 10 s ago: its holder is alive");
    fs.utimesSync(lock, new Date(t - 60_000), new Date(t - 60_000));
    await keeper.tick();
    assert.equal(fs.existsSync(lock), false, "untouched for a minute: removed");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a token about to run out (or already out) is renewed once; a fresh one is left alone", async () => {
  let t = 1_000_000_000_000;
  const soon = account(t + 2 * 60_000);
  const fresh = account(t + 3 * 3600_000);
  const renewed = [];
  try {
    const keeper = createTokenKeeper({
      dirs: () => [soon, fresh],
      renew: async (dir) => {
        renewed.push(dir);
        setExpiry(dir, t + 8 * 3600_000);
      },
      now: () => t,
    });
    const done = await keeper.tick();
    assert.deepEqual(renewed, [soon]);
    assert.equal(done.find((d) => d.dir === soon).renewed, true);
    await keeper.tick();
    assert.deepEqual(renewed, [soon], "renewed: not again");
    assert.equal(tokenExpiry(soon), t + 8 * 3600_000);
  } finally {
    for (const d of [soon, fresh]) fs.rmSync(d, { recursive: true, force: true });
  }
});

test("a renewal that does not move the expiry waits ten minutes before the next try", async () => {
  let t = 1_000_000_000_000;
  const dir = account(t - 60_000);
  let calls = 0;
  try {
    const keeper = createTokenKeeper({ dirs: () => [dir], renew: async () => { calls += 1; throw new Error("refused"); }, now: () => t });
    await keeper.tick();
    t += 30_000;
    await keeper.tick();
    assert.equal(calls, 1);
    t += 10 * 60_000;
    await keeper.tick();
    assert.equal(calls, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("no folder, no credentials: nothing to do", async () => {
  const keeper = createTokenKeeper({ dirs: () => ["/nonexistent/griffin-keeper"], renew: async () => assert.fail("nothing to renew") });
  assert.deepEqual(await keeper.tick(), []);
});
