// 2026-11-16: a colleague's chain delegated a DNS create to Arvan-Ban, the owner said yes to full
// access, and the sub-chat's next turn still ran the session (tools + «بپرس» guard) built before it —
// refused 11 s after «granted». The runner's cached session must follow the root's grant.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openStore } from "../src/db.mjs";
import { createRunner } from "../src/runner.mjs";
import { createClaudeProvider } from "../src/providers/claude.mjs";
import { grantFullAccess, endFullAccess, fullAccessLive } from "../src/colleague-access.mjs";

function fakeClaude() {
  const queryImpl = ({ prompt, options }) =>
    (async function* () {
      if (typeof prompt !== "string") for await (const _ of prompt) break;
      yield { type: "system", subtype: "init", session_id: options.sessionId || options.resume, mcp_servers: [] };
      yield { type: "result", subtype: "success", is_error: false, result: "ok", session_id: options.sessionId || options.resume };
    })();
  return { queryImpl };
}

async function turn(store, runner, chatId, text) {
  const before = store.eventsAfter(chatId).filter((e) => e.type === "run.finished").length;
  await runner.send(chatId, { text });
  for (let i = 0; i < 600; i += 1) {
    if (store.eventsAfter(chatId).filter((e) => e.type === "run.finished").length > before) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("turn did not finish");
}

test("a sub-chat of a colleague chain gets a new session (new tools) once the owner grants, and again when it ends", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "griffin-grant-"));
  const store = openStore(path.join(dir, "db.sqlite"));
  const sdk = { ...createClaudeProvider({ apiKey: "sk-ant-api-test", ...fakeClaude() }), kind: "claude" };
  let built = 0;
  const runner = createRunner({
    store,
    sdk,
    agentOptions: async () => ((built += 1), { cwd: dir, fileAccess: { read: [dir], write: [dir], deny: [] } }),
    log: { error() {}, info() {}, warn() {} },
  });
  const root = store.createChat({ title: "👤 همکار", mode: "ask", caller: "team" });
  const child = store.createChat({ title: "← آیریس: رکورد DNS", mode: "agent", caller: "griffin", parentChatId: root.id });
  assert.equal(store.getChat(child.id).parent_chat_id, root.id, "fixture: the sub-chat hangs under the colleague's chat");

  await turn(store, runner, child.id, "بساز");
  assert.equal(built, 1);
  await turn(store, runner, child.id, "ادامه");
  assert.equal(built, 1, "nothing changed: the cached session is reused");

  grantFullAccess(store, root.id, { why: "رکورد DNS" });
  assert.equal(fullAccessLive(store, root.id), true);
  await turn(store, runner, child.id, "[دسترسی کامل] ادامه بده");
  assert.equal(built, 2, "the owner's yes rebuilds the sub-chat's session (its tools and guard)");

  endFullAccess(store, root.id);
  await turn(store, runner, child.id, "باز هم");
  assert.equal(built, 3, "the grant's end rebuilds it back to «بپرس»");
});

test("fullAccessLive is a plain read: an expired grant or a root off «بدون پرسیدن» is not live", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "griffin-grant-"));
  const store = openStore(path.join(dir, "db.sqlite"));
  const root = store.createChat({ title: "👤 همکار", mode: "ask", caller: "team" });
  assert.equal(fullAccessLive(store, root.id), false);
  grantFullAccess(store, root.id, { hours: 1, now: Date.now() - 2 * 3_600_000 });
  assert.equal(fullAccessLive(store, root.id), false, "expired");
  grantFullAccess(store, root.id, { hours: 1 });
  store.updateChat(root.id, { mode: "ask" });
  assert.equal(fullAccessLive(store, root.id), false, "root moved back to «بپرس»");
});
