import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openStore } from "../src/db.mjs";
import { createKnowledge, findSecrets, KNOWLEDGE_WRITE } from "../src/knowledge.mjs";
import { seedExampleAgents } from "./fixture-agents.mjs";

test("findSecrets catches JWT and private key markers", () => {
  assert.equal(findSecrets("hello"), false);
  assert.equal(
    findSecrets("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"),
    true,
  );
  assert.equal(findSecrets("-----BEGIN RSA PRIVATE KEY-----\nMII\n-----END RSA PRIVATE KEY-----"), true);
});

test("knowledge_write refuses secrets, writes markdown with provenance, lists notes", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "griffin-know-"));
  const store = openStore(path.join(dir, "db.sqlite"));
  seedExampleAgents(store);
  const root = path.join(dir, "knowledge");
  const knowledge = createKnowledge({ store, root, git: false });
  const chat = store.createChat({ title: "t", agent: "arvan-ban" });
  const tools = knowledge.tool(chat.id);

  const refused = await tools[KNOWLEDGE_WRITE].execute({
    title: "bad",
    body: "token eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIn0.aaaaaaaaaa",
  });
  assert.equal(refused.isError, true);

  const ok = await tools[KNOWLEDGE_WRITE].execute({
    title: "پاک‌سازی کش",
    body: "برای دامنهٔ X از arvan_cache_purge با scope=all استفاده شد.",
    ttlHours: 24,
  });
  assert.equal(ok.isError, undefined);
  const saved = JSON.parse(ok.content[0].text);
  assert.equal(saved.agent, "arvan-ban");
  assert.equal(saved.reviewed, false);
  assert.ok(fs.existsSync(path.join(root, saved.path)));
  assert.ok(fs.existsSync(path.join(root, "agents", "directory.md")));

  const listed = JSON.parse((await tools.knowledge_list.execute({})).content[0].text);
  assert.equal(listed.total, 1);
  assert.match(listed.notes[0].title, /پاک/);

  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("reviewed notes are injected into rules; unreviewed and expired are not", async () => {
  const { installRules } = await import("../src/prompt.mjs");
  const { listAgentNotes, reviewedRunbooks, setNoteReviewed } = await import("../src/knowledge.mjs");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "griffin-kn-"));
  const ws = path.join(dir, "ws");
  const root = path.join(dir, "kn");
  const agentDir = path.join(root, "agents", "platform", "knowledge");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(ws, { recursive: true });
  const front = (extra) => `---\ntitle: "مسیر سامانهٔ قدیمی"\n${extra}at: 2026-09-20\n---\n`;
  fs.writeFileSync(path.join(agentDir, "legacy-erp-route.md"), `${front("reviewed: false\n")}مارکر-تأییدنشده-۹۹`);
  fs.writeFileSync(path.join(agentDir, "old-note.md"), `${front("reviewed: true\nexpires: 2020-01-01\n")}منقضی`);
  fs.writeFileSync(path.join(agentDir, "fresh-note.md"), `${front("reviewed: true\n")}مسیر تأییدشده`);

  // only the reviewed, unexpired note is listed as runbook
  const runbooks = reviewedRunbooks(root, "platform");
  assert.equal(runbooks.length, 1);
  assert.match(runbooks[0].body, /مسیر تأییدشده/);

  // and it lands in the rules file, the unreviewed one does not
  const file = installRules(ws, { agent: "platform", knowledgeRoot: root });
  const text = fs.readFileSync(file, "utf8");
  assert.match(text, /Reviewed knowledge/);
  assert.match(text, /مسیر تأییدشده/);
  assert.ok(!text.includes("مارکر-تأییدنشده-۹۹"));

  // review gate flips the flag and the note then qualifies
  assert.equal(setNoteReviewed(root, "platform", "legacy-erp-route.md", true), true);
  const notes = listAgentNotes(root, "platform");
  const erpNote = notes.find((n) => n.file === "legacy-erp-route.md");
  assert.equal(erpNote.reviewed, true);
  assert.ok(reviewedRunbooks(root, "platform").some((n) => n.file === "legacy-erp-route.md"));
  assert.equal(setNoteReviewed(root, "platform", "missing-file.md", true), false);

  fs.rmSync(dir, { recursive: true, force: true });
});
