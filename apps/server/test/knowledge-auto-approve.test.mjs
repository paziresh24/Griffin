import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openStore } from "../src/db.mjs";
import { KNOWLEDGE_EDIT, KNOWLEDGE_WRITE, approvePendingNotes, createKnowledge, frontmatter, readAudit, reviewedRunbooks } from "../src/knowledge.mjs";
import { createChatTrust } from "../src/knowledge-trust.mjs";
import { buildRules } from "../src/prompt.mjs";
import { CONFIG_SCHEMA } from "../src/config.mjs";

const AGENT = "griffin";

function setup(autoApprove) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "griffin-kn-auto-"));
  const store = openStore(path.join(dir, "db.sqlite"));
  const root = path.join(dir, "knowledge");
  const trust = createChatTrust({ store });
  const knowledge = createKnowledge({ store, root, git: false, autoTrust: true, trust, autoApprove });
  return { store, root, knowledge };
}
const run = async (env, chatId, tool, args) => {
  const out = await env.knowledge.tool(chatId)[tool].execute(args);
  return { error: out.isError ? out.content[0].text : null, data: out.isError ? null : JSON.parse(out.content[0].text) };
};
const read = (env, file) => fs.readFileSync(path.join(env.root, "agents", AGENT, "knowledge", file), "utf8");

test("auto-approve on: a note from any chat, a colleague's too, is approved and reaches prompts", async () => {
  const env = setup(true);
  const colleague = env.store.createChat({ title: "colleague", agent: AGENT, caller: "team" });
  const { data } = await run(env, colleague.id, KNOWLEDGE_WRITE, { title: "مسیر", body: "مسیر سرویس" });
  assert.equal(data.reviewed, true);
  const file = path.basename(data.path);
  assert.equal(frontmatter(read(env, file)).get("reviewed"), "true");
  assert.equal(frontmatter(read(env, file)).get("approved_by"), "auto");
  assert.deepEqual(reviewedRunbooks(env.root, AGENT).map((n) => n.file), [file]);
});

test("auto-approve off: a note still waits for review (other installs keep the gate)", async () => {
  const env = setup(false);
  const chat = env.store.createChat({ title: "own", agent: AGENT });
  const { data } = await run(env, chat.id, KNOWLEDGE_WRITE, { title: "x", body: "y" });
  assert.equal(data.reviewed, false);
  assert.equal(reviewedRunbooks(env.root, AGENT).length, 0);
});

test("auto-approve on: an agent's edit keeps the note approved", async () => {
  const env = setup(true);
  const chat = env.store.createChat({ title: "own", agent: AGENT });
  const { data } = await run(env, chat.id, KNOWLEDGE_WRITE, { title: "a", body: "b" });
  const file = path.basename(data.path);
  const edit = await run(env, chat.id, KNOWLEDGE_EDIT, { file, body: "c" });
  assert.equal(edit.error, null);
  assert.equal(edit.data.reviewed, true);
});

test("approvePendingNotes approves every waiting note once, audited, and is a no-op after", async () => {
  const env = setup(false);
  const chat = env.store.createChat({ title: "own", agent: AGENT });
  const a = path.basename((await run(env, chat.id, KNOWLEDGE_WRITE, { title: "a", body: "b" })).data.path);
  const b = path.basename((await run(env, chat.id, KNOWLEDGE_WRITE, { title: "c", body: "d" })).data.path);
  assert.equal(approvePendingNotes(env.root, { git: false }), 2);
  for (const file of [a, b]) assert.equal(frontmatter(read(env, file)).get("reviewed"), "true");
  assert.equal(readAudit(env.root).filter((e) => e.action === "review" && e.by?.kind === "auto").length, 2);
  assert.equal(approvePendingNotes(env.root, { git: false }), 0);
  assert.match(read(env, a), /\n---\n\nمتن|\n---\n\nb/);
});

test("rules on auto-approve: write without asking; notes framed as facts, not owner-reviewed", () => {
  const rules = buildRules({ agent: "griffin", caller: "owner", tools: ["knowledge_write", "chat_list", "chat_send", "ask_owner"], autoApprove: true });
  assert.match(rules, /Knowledge is automatic on this install/);
  assert.match(rules, /call knowledge_write\nyourself/);
  assert.doesNotMatch(rules, /on yes call knowledge_write/);
  const off = buildRules({ agent: "griffin", caller: "owner", tools: ["knowledge_write", "chat_list", "chat_send", "ask_owner"] });
  assert.doesNotMatch(off, /Knowledge is automatic/);
});

test("the setting exists, is live and off by default", () => {
  const spec = CONFIG_SCHEMA.find((c) => c.key === "KNOWLEDGE_AUTO_APPROVE");
  assert.ok(spec);
  assert.equal(spec.live, true);
  assert.equal(spec.options[0], "off");
});
