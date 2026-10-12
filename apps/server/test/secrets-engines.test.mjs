import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSecretStore } from "../src/secrets.mjs";
import { kindOf, normalizeProvider, PROVIDER_IDS, setAccounts, splitModel } from "../src/providers/ids.mjs";
import { openStore } from "../src/db.mjs";
import { createConfig } from "../src/config.mjs";
import { genv } from "../src/env.mjs";

test("secret store keeps values encrypted and lists only names", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "secrets-"));
  const box = createSecretStore({ dataDir: dir });
  box.set("engine/claude-2", "sk-ant-oat01-abcdefghijklmnop", { note: "second" });
  assert.equal(box.get("engine/claude-2"), "sk-ant-oat01-abcdefghijklmnop");
  assert.ok(!fs.readFileSync(path.join(dir, "secrets.json"), "utf8").includes("abcdefghijklmnop"));
  const listed = box.list();
  assert.deepEqual(listed.map((i) => i.name), ["engine/claude-2"]);
  assert.equal(listed[0].last4, "mnop");
  assert.ok(!JSON.stringify(listed).includes("abcdefgh"));
  assert.throws(() => box.set("bad name", "x"), /invalid/);
  assert.equal(box.delete("engine/claude-2"), true);
  assert.equal(box.get("engine/claude-2"), "");
  assert.equal(fs.statSync(path.join(dir, "secrets.key")).mode & 0o777, 0o600);
});

test("engine accounts: a second Claude account routes by its own id", () => {
  setAccounts([{ id: "claude-work" }, { id: "openai-openrouter" }, { id: "bogus" }]);
  try {
    assert.ok(PROVIDER_IDS.includes("claude-work"));
    assert.ok(!PROVIDER_IDS.includes("bogus"));
    assert.equal(kindOf("claude-work"), "claude");
    assert.equal(kindOf("openai-openrouter"), "openai");
    assert.deepEqual(splitModel("claude-work:opus"), { provider: "claude-work", model: "opus" });
    assert.equal(splitModel("claude-gone:opus"), null);
    assert.equal(normalizeProvider("claude-work"), "claude-work");
    assert.equal(normalizeProvider("nope"), "cursor");
  } finally {
    setAccounts([]);
  }
});

test("a setting changed in the UI wins over the env, and clearing it falls back", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "config-"));
  const store = openStore(path.join(dir, "t.sqlite"));
  const config = createConfig({ store });
  process.env.GRIFFIN_TITLE_MODEL = "from-env";
  try {
    assert.equal(genv("TITLE_MODEL"), "from-env");
    assert.deepEqual(config.set({ TITLE_MODEL: "from-ui" }), { restart: false });
    assert.equal(genv("TITLE_MODEL"), "from-ui");
    assert.equal(config.set({ OPS_MODE: "record" }).restart, true);
    assert.throws(() => config.set({ OPS_MODE: "loud" }), /must be one of/);
    assert.throws(() => config.set({ DATA: "/tmp" }), /unknown setting/);
    config.set({ TITLE_MODEL: "" });
    assert.equal(genv("TITLE_MODEL"), "from-env");
  } finally {
    delete process.env.GRIFFIN_TITLE_MODEL;
    config.set({ OPS_MODE: "" });
  }
});
