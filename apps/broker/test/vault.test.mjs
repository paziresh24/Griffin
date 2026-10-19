import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createVault } from "../src/vault.mjs";

test("renew posts renew-self with the machine token and returns the ttl", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "vault-"));
  const tokenAge = path.join(dir, "t.age");
  const identity = path.join(dir, "id");
  writeFileSync(tokenAge, "x");
  writeFileSync(identity, "x");
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, json: async () => ({ auth: { lease_duration: 2764800 } }) };
  };
  // A fake age binary: "decrypting" always yields tok-1.
  const vault = createVault({ url: "http://bao", tokenAge, identity, ageBin: path.join(dir, "fake-age"), fetchImpl });
  writeFileSync(path.join(dir, "fake-age"), "#!/bin/sh\necho tok-1\n", { mode: 0o755 });
  assert.equal(await vault.renew(), 2764800);
  assert.equal(calls[0].url, "http://bao/v1/auth/token/renew-self");
  assert.equal(calls[0].init.headers["X-Vault-Token"], "tok-1");
  assert.equal(vault.state().ok, true);
  assert.equal(vault.state().ttlHours, 768);
  assert.equal(await createVault({ url: "", fetchImpl }).renew(), null);
});

test("a refused read or renewal marks the vault unhealthy; a good renewal clears it", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "vault-"));
  const tokenAge = path.join(dir, "t.age");
  const identity = path.join(dir, "id");
  writeFileSync(tokenAge, "x");
  writeFileSync(identity, "x");
  writeFileSync(path.join(dir, "fake-age"), "#!/bin/sh\necho tok-1\n", { mode: 0o755 });
  let reply = { ok: false, status: 403, json: async () => ({}) };
  const vault = createVault({ url: "http://bao", tokenAge, identity, ageBin: path.join(dir, "fake-age"), fetchImpl: async () => reply });
  await assert.rejects(vault.item("gitlab__token"), /http_403/);
  assert.equal(vault.state().ok, false);
  await assert.rejects(vault.renew(), /renew http_403/);
  assert.match(vault.state().error, /renew refused/);
  reply = { ok: true, status: 200, json: async () => ({ auth: { lease_duration: 3600 } }) };
  await vault.renew();
  assert.match(vault.state().error, /not periodic/);
  reply = { ok: true, status: 200, json: async () => ({ auth: { lease_duration: 2764800 } }) };
  await vault.renew();
  assert.deepEqual([vault.state().ok, vault.state().error], [true, null]);
});
