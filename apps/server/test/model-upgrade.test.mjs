import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openStore } from "../src/db.mjs";
import { createRunner } from "../src/runner.mjs";
import { UPGRADE_TOOL, createUpgrades, upgradeNote, upgradeTool } from "../src/model-upgrade.mjs";
import { finalText, foldEvents, lastRun } from "@griffin/timeline";

const until = async (check, ms = 2000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("timeout");
};
const parse = (result) => JSON.parse(result.content[0].text);

test("upgrades: only a chat with a target moves, once per run, and starts light again after it", async () => {
  const upgrades = createUpgrades({ target: (id) => (id === "c1" ? { model: "opus", effort: null } : null) });
  assert.match(upgrades.request("c2", "x").error, /no stronger model/);
  assert.equal(upgrades.take("c2"), null);
  assert.deepEqual(upgrades.request("c1", "  needs a cluster check  "), { accepted: true, model: "opus" });
  const up = upgrades.take("c1");
  assert.equal(up.model, "opus");
  assert.equal(up.reason, "needs a cluster check");
  assert.equal(upgrades.take("c1"), null, "taken once");
  assert.ok(upgrades.isUpgraded("c1"));
  assert.match(upgrades.request("c1", "again").error, /already on the stronger model/);
  upgrades.end("c1");
  assert.equal(upgrades.isUpgraded("c1"), false);
  assert.ok(upgrades.request("c1", "next message").accepted);
});

test("upgrade_model tool: a reason is required; the answer tells the light model to stop", async () => {
  const upgrades = createUpgrades({ target: () => ({ model: "opus" }) });
  const tool = upgradeTool(upgrades, "c1");
  const empty = await tool.execute({ reason: " " });
  assert.equal(empty.isError, true);
  const ok = parse(await tool.execute({ reason: "diagnosis" }));
  assert.equal(ok.accepted, true);
  assert.match(ok.next, /End your turn now/);
  assert.match(upgradeNote("diagnosis"), /دلیل: diagnosis/);
});

function setup({ ask = true, lightText = "" } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "griffin-upgrade-"));
  const store = openStore(path.join(dir, "db.sqlite"));
  const sends = [];
  const upgrades = createUpgrades({ target: () => ({ model: "opus", effort: "high" }) });
  let chatId = null;
  const agent = {
    agentId: "agent-1",
    async send(message, options) {
      const leg = sends.length;
      sends.push({ message, model: options.model?.id || null, effort: options.effort || null });
      return {
        id: `sdk-${leg}`,
        supports: () => true,
        async cancel() {},
        async wait() {
          if (leg === 0 && ask) {
            await options.onDelta?.({ update: { type: "tool-call-started", callId: "u1", toolCall: { type: UPGRADE_TOOL, args: { reason: "r" } } } });
            await upgradeTool(upgrades, chatId).execute({ reason: "needs digging" });
            await options.onDelta?.({ update: { type: "tool-call-completed", callId: "u1", toolCall: { type: UPGRADE_TOOL, result: { status: "success", value: {} } } } });
            if (lightText) await options.onDelta?.({ update: { type: "text-delta", text: lightText } });
            return { status: "finished" };
          }
          await options.onDelta?.({ update: { type: "text-delta", text: leg === 0 ? "light answer" : "strong answer" } });
          return { status: "finished" };
        },
      };
    },
    close() {},
  };
  const sdk = { create: async () => agent, resume: async () => agent };
  const runner = createRunner({ store, sdk, agentOptions: async () => ({}), runLabel: () => ({ provider: "claude", model: "haiku" }), upgrades, log: { error() {} } });
  const chat = store.createChat({ title: "t" });
  chatId = chat.id;
  return { store, runner, chat, sends, upgrades };
}

test("runner: an upgrade asked on the light model goes on in the same run on the stronger one", async () => {
  const { store, runner, chat, sends, upgrades } = setup({ lightText: "یک لحظه" });
  const { runId } = await runner.send(chat.id, { text: "سرور کند است، ببین چرا" });
  await until(() => store.eventsAfter(chat.id).some((e) => e.type === "run.finished" && e.runId === runId));
  assert.equal(sends.length, 2);
  assert.equal(sends[0].model, "haiku");
  assert.equal(sends[1].model, "opus");
  assert.equal(sends[1].effort, "high");
  assert.match(String(sends[1].message), /ارتقای مدل/);
  const events = store.eventsAfter(chat.id);
  assert.equal(events.filter((e) => e.type === "run.started").length, 1, "one run");
  assert.equal(events.filter((e) => e.type === "run.finished").length, 1, "one run.finished for its readers");
  assert.equal(events.find((e) => e.type === "run.finished").data.status, "finished");
  // What the light model wrote after asking is not the answer.
  const run = lastRun(foldEvents(events).messages);
  assert.equal(finalText(run), "strong answer");
  assert.equal(upgrades.isUpgraded(chat.id), false, "the next message starts light");
});

test("runner: no upgrade asked = one engine send, as before", async () => {
  const { store, runner, chat, sends } = setup({ ask: false });
  const { runId } = await runner.send(chat.id, { text: "سلام" });
  await until(() => store.eventsAfter(chat.id).some((e) => e.type === "run.finished" && e.runId === runId));
  assert.equal(sends.length, 1);
  assert.equal(finalText(lastRun(foldEvents(store.eventsAfter(chat.id)).messages)), "light answer");
});
