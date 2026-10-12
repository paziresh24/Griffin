import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openStore } from "../src/db.mjs";
import { classifyEngineError, createDoctor } from "../src/doctor.mjs";

test("engine errors are classified by cause", () => {
  assert.equal(classifyEngineError({ status: 401, text: "invalid x-api-key" }), "bad_key");
  assert.equal(classifyEngineError({ status: 403, text: "Cursor is not available in your region" }), "region");
  assert.equal(classifyEngineError({ status: 403, text: "Request not allowed" }), "forbidden");
  assert.equal(classifyEngineError({ status: 402, text: "insufficient credits" }), "quota");
  assert.equal(classifyEngineError({ status: 429, text: "Rate limit reached for requests" }), "busy");
  assert.equal(classifyEngineError({ network: true, text: "ENOTFOUND" }), "network");
  assert.equal(classifyEngineError({ status: 404, text: "model not found" }), "model");
});

test("an agent on a rejected engine moves to one that answers, and back once it heals", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-"));
  const store = openStore(path.join(dir, "t.sqlite"));
  const agent = store.listAgentProfiles()[0];
  store.updateAgentProfile(agent.id, { provider: "claude" });
  const keys = { claude: "sk-ant-api-bad", openai: "sk-good", cursor: "" };
  let claudeOk = false;
  const fetchImpl = async (url) => {
    if (String(url).includes("anthropic")) return claudeOk ? new Response("{}", { status: 200 }) : new Response("invalid x-api-key", { status: 401 });
    return new Response("{}", { status: 200 });
  };
  const doctor = createDoctor({
    store,
    runner: { cancel: async () => {} },
    providers: { cursor: { listModels: async () => [] }, openai: { defaultModel: "m" } },
    providerKey: (id) => keys[id],
    providerConfig: () => ({}),
    engineIds: ["cursor", "claude", "openai"],
    dataDir: dir,
    fetchImpl,
  });
  const first = await doctor.heal();
  assert.equal(first.engines.find((e) => e.id === "claude").cause, "bad_key");
  assert.equal(store.getAgentProfile(agent.id).provider, "openai");
  assert.ok(first.applied.some((line) => line.startsWith(`agent ${agent.id}:`)));

  claudeOk = true;
  await doctor.heal();
  assert.equal(store.getAgentProfile(agent.id).provider, "claude");
});
