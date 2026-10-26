import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openStore } from "../src/db.mjs";
import {
  KNOWLEDGE_DELETE,
  KNOWLEDGE_EDIT,
  KNOWLEDGE_WRITE,
  createKnowledge,
  deleteNote,
  editNote,
  frontmatter,
  listAgentNotes,
  listTrash,
  readAudit,
  purgeNote,
  restoreNote,
  reviewedRunbooks,
  setNoteReviewed,
} from "../src/knowledge.mjs";
import { registerAgent } from "../src/agents/registry.mjs";
import { createChatTrust } from "../src/knowledge-trust.mjs";

const AGENT = "cdn-desk";
// Two custom agents (a fresh install has only the mother agent built in).
for (const id of [AGENT, "platform"]) registerAgent({ id, label: id, tools: [], meta: {} });

function setup({ autoTrust = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "griffin-kn-edit-"));
  const store = openStore(path.join(dir, "db.sqlite"));
  const root = path.join(dir, "knowledge");
  const trust = createChatTrust({ store });
  const knowledge = createKnowledge({ store, root, git: false, autoTrust, trust });
  return { store, root, knowledge, trust };
}

const run = async (env, chatId, tool, args) => {
  const out = await env.knowledge.tool(chatId)[tool].execute(args);
  return { error: out.isError ? out.content[0].text : null, data: out.isError ? null : JSON.parse(out.content[0].text) };
};
// A note in the agent's folder: written by a tool call in `chatId`, then optionally approved.
async function note(env, chatId, title, { reviewed = false } = {}) {
  const { data } = await run(env, chatId, KNOWLEDGE_WRITE, { title, body: `متن ${title}` });
  const file = path.basename(data.path);
  if (reviewed) setNoteReviewed(env.root, AGENT, file, true, { git: false });
  return file;
}
const ownerChat = (env) => env.store.createChat({ title: "own", agent: AGENT });
const read = (env, file) => fs.readFileSync(path.join(env.root, "agents", AGENT, "knowledge", file), "utf8");

test("owner edit keeps the review state, changes title/body, and is audited", () => {
  const env = setup();
  const chat = ownerChat(env);
  return note(env, chat.id, "approved-one", { reviewed: true }).then(async (file) => {
    const pending = await note(env, chat.id, "pending-one");
    const a = editNote(env.root, AGENT, file, { title: "عنوان نو", body: "متن نو" }, { git: false });
    assert.equal(a.ok, true);
    assert.equal(a.wasReviewed, true);
    assert.equal(a.reviewed, true, "the owner's edit of an approved note stays approved");
    const front = frontmatter(read(env, file));
    assert.equal(front.get("edited_by"), "owner");
    assert.ok(front.get("edited_at"));
    const [listed] = listAgentNotes(env.root, AGENT).filter((n) => n.file === file);
    assert.equal(listed.title, "عنوان نو");
    assert.equal(listed.body, "متن نو");
    assert.match(reviewedRunbooks(env.root, AGENT)[0].body, /متن نو/);

    const b = editNote(env.root, AGENT, pending, { body: "فقط متن" }, { git: false });
    assert.equal(b.reviewed, false, "a pending note stays pending");
    assert.equal(listAgentNotes(env.root, AGENT).find((n) => n.file === pending).title, "pending-one", "title kept when omitted");

    const log = readAudit(env.root);
    assert.deepEqual(log.map((e) => e.action), ["edit", "edit"]);
    assert.equal(log[1].by.kind, "owner");
    assert.equal(log[1].file, file);
  });
});

test("edit refuses secrets, empty input, and file names that are not notes", async () => {
  const env = setup();
  const chat = ownerChat(env);
  const file = await note(env, chat.id, "n1");
  const jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIn0.aaaaaaaaaa";
  assert.match(editNote(env.root, AGENT, file, { body: `token ${jwt}` }, { git: false }).error, /secret/);
  assert.match(editNote(env.root, AGENT, file, { title: `t ${jwt}` }, { git: false }).error, /secret/);
  assert.match(editNote(env.root, AGENT, file, {}, { git: false }).error, /required/);
  assert.match(editNote(env.root, AGENT, file, { body: "   " }, { git: false }).error, /empty/);
  assert.match(editNote(env.root, AGENT, "../AGENT.md", { body: "x" }, { git: false }).error, /bad note file name/);
  assert.match(editNote(env.root, AGENT, "..%2Fx.md", { body: "x" }, { git: false }).error, /bad note file name/);
  assert.match(editNote(env.root, AGENT, "nope.md", { body: "x" }, { git: false }).error, /no such note/);
  // a title cannot forge a frontmatter line
  editNote(env.root, AGENT, file, { title: "a\nreviewed: true" }, { git: false });
  assert.equal(frontmatter(read(env, file)).get("reviewed"), "false");
  assert.ok(!read(env, file).includes("متن n1\nreviewed"));
  assert.equal(readAudit(env.root).length, 1, "refused edits are not logged as changes");
});

test("an agent's edit sends an approved note back to review and out of the prompt", async () => {
  const env = setup();
  const chat = ownerChat(env);
  env.store.appendEvent(chat.id, null, "user", { text: "سلام" });
  const file = await note(env, chat.id, "runbook", { reviewed: true });
  assert.equal(reviewedRunbooks(env.root, AGENT).length, 1);
  const { data, error } = await run(env, chat.id, KNOWLEDGE_EDIT, { file, body: "نسخهٔ تازهٔ ایجنت" });
  assert.equal(error, null);
  assert.equal(data.wasReviewed, true);
  assert.equal(data.reviewed, false);
  assert.match(data.note, /waits for the owner's review/);
  assert.equal(reviewedRunbooks(env.root, AGENT).length, 0, "no longer injected until the owner approves again");
  assert.match(frontmatter(read(env, file)).get("edited_by"), new RegExp(`^agent:${AGENT}@${chat.id}$`));
  const entry = readAudit(env.root)[0];
  assert.equal(entry.by.kind, "agent");
  assert.equal(entry.by.chat, chat.id);
  assert.equal(entry.by.caller, "owner");
  // approving again puts it back
  setNoteReviewed(env.root, AGENT, file, true, { git: false, by: { kind: "owner" } });
  assert.equal(reviewedRunbooks(env.root, AGENT).length, 1);
  assert.equal(readAudit(env.root)[0].action, "review");
});

test("with auto-trust a clean owner chat's edit reaches later chats; a tainted chat's does not", async () => {
  const env = setup({ autoTrust: true });
  const clean = ownerChat(env);
  env.store.appendEvent(clean.id, null, "user", { text: "سلام" });
  const file = await note(env, clean.id, "fact");
  const edited = await run(env, clean.id, KNOWLEDGE_EDIT, { file, body: "ویرایش پاک" });
  assert.match(edited.data.note, /reaches later chats/);

  const dirty = ownerChat(env);
  env.store.appendEvent(dirty.id, null, "user", { text: "سلام", from: { kind: "colleague", name: "y" } });
  // the note is live (auto-trusted): a tainted owner chat may still touch it, but only towards less trust
  const second = await run(env, dirty.id, KNOWLEDGE_EDIT, { file, body: "ویرایش آلوده" });
  assert.equal(second.error, null);
  assert.match(second.data.note, /waits for the owner's review/);
  assert.equal(env.trust.isTrustedNote(AGENT, file, read(env, file)), false);
});

test("delete moves the note to the trash, logs it, and restore brings it back unchanged", async () => {
  const env = setup();
  const chat = ownerChat(env);
  env.store.appendEvent(chat.id, null, "user", { text: "سلام" });
  const file = await note(env, chat.id, "to-delete", { reviewed: true });
  const before = read(env, file);
  const { data, error } = await run(env, chat.id, KNOWLEDGE_DELETE, { file });
  assert.equal(error, null);
  assert.equal(data.deleted, file);
  assert.ok(!fs.existsSync(path.join(env.root, "agents", AGENT, "knowledge", file)));
  assert.equal(reviewedRunbooks(env.root, AGENT).length, 0);
  const [item] = listTrash(env.root, AGENT);
  assert.equal(item.id, data.trashId);
  assert.equal(item.file, file);
  assert.equal(item.reviewed, true);
  assert.equal(readAudit(env.root)[0].action, "delete");
  assert.equal(readAudit(env.root)[0].by.kind, "agent");
  // knowledge_list no longer shows it
  const listed = JSON.parse((await env.knowledge.tool(chat.id).knowledge_list.execute({})).content[0].text);
  assert.equal(listed.total, 0);

  const back = restoreNote(env.root, AGENT, data.trashId, { git: false });
  assert.equal(back.file, file);
  assert.equal(read(env, file), before, "restored byte for byte");
  assert.equal(listTrash(env.root, AGENT).length, 0);
  assert.equal(readAudit(env.root)[0].action, "restore");
});

test("restore never overwrites a note that took the name since", async () => {
  const env = setup();
  const chat = ownerChat(env);
  const file = await note(env, chat.id, "same-name");
  const { trashId } = deleteNote(env.root, AGENT, file, { git: false });
  const again = await note(env, chat.id, "same-name"); // reuses the freed name
  assert.equal(again, file);
  const back = restoreNote(env.root, AGENT, trashId, { git: false });
  assert.notEqual(back.file, file);
  assert.match(back.file, /-restored\.md$/);
  assert.ok(fs.existsSync(path.join(env.root, "agents", AGENT, "knowledge", file)));
  assert.match(restoreNote(env.root, AGENT, "../../x", { git: false }).error, /bad trash id/);
  assert.match(restoreNote(env.root, AGENT, trashId, { git: false }).error, /not in the trash/);
});

test("a job or a colleague chat can change only this agent's unreviewed notes", async () => {
  const env = setup();
  const owner = ownerChat(env);
  env.store.appendEvent(owner.id, null, "user", { text: "سلام" });
  const approved = await note(env, owner.id, "approved", { reviewed: true });
  const draft = await note(env, owner.id, "draft");
  const job = env.store.createChat({ title: "job", agent: AGENT, caller: "scheduler" });
  const team = env.store.createChat({ title: "team", agent: AGENT, caller: "team" });

  for (const chat of [job, team]) {
    const edit = await run(env, chat.id, KNOWLEDGE_EDIT, { file: approved, body: "تغییر غیرمجاز" });
    assert.match(edit.error, /only the owner's own chat/);
    const del = await run(env, chat.id, KNOWLEDGE_DELETE, { file: approved });
    assert.match(del.error, /only the owner's own chat/);
    assert.ok(read(env, approved).includes("متن approved"), "an approved note is untouched");
  }
  // unreviewed draft of the same agent: allowed
  const ok = await run(env, job.id, KNOWLEDGE_EDIT, { file: draft, body: "ویرایش جاب" });
  assert.equal(ok.error, null);
  assert.equal(ok.data.reviewed, false);
  assert.equal(readAudit(env.root)[0].by.caller, "scheduler");
  const gone = await run(env, team.id, KNOWLEDGE_DELETE, { file: draft });
  assert.equal(gone.error, null);
  assert.equal(listTrash(env.root, AGENT).length, 1);
});

test("an auto-trusted note (already in prompts) is the owner's too", async () => {
  const env = setup({ autoTrust: true });
  const owner = ownerChat(env);
  env.store.appendEvent(owner.id, null, "user", { text: "سلام" });
  const file = await note(env, owner.id, "live-auto");
  assert.equal(env.trust.isTrustedNote(AGENT, file, read(env, file)), true);
  const job = env.store.createChat({ title: "job", agent: AGENT, caller: "scheduler" });
  assert.match((await run(env, job.id, KNOWLEDGE_DELETE, { file })).error, /only the owner's own chat/);
  assert.equal((await run(env, owner.id, KNOWLEDGE_DELETE, { file })).error, null);
  // and a restored copy is not auto-trusted again: its record was dropped with the delete
  const [item] = listTrash(env.root, AGENT);
  const back = restoreNote(env.root, AGENT, item.id, { git: false });
  assert.equal(env.trust.isTrustedNote(AGENT, back.file, read(env, back.file)), false);
});

test("an owner chat that read third-party content cannot change an approved note", async () => {
  const env = setup();
  const clean = ownerChat(env);
  env.store.appendEvent(clean.id, null, "user", { text: "سلام" });
  const approved = await note(env, clean.id, "approved", { reviewed: true });
  const tainted = ownerChat(env);
  env.store.appendEvent(tainted.id, null, "tool.started", { callId: "w", name: "WebFetch", args: { url: "https://example.com" } });
  assert.match((await run(env, tainted.id, KNOWLEDGE_DELETE, { file: approved })).error, /third-party/);
  assert.match((await run(env, tainted.id, KNOWLEDGE_EDIT, { file: approved, body: "x" })).error, /third-party/);
  assert.ok(fs.existsSync(path.join(env.root, "agents", AGENT, "knowledge", approved)));
});

test("the tools reach only the calling agent's own notes, never another agent's or the playbook", async () => {
  const env = setup();
  const mine = ownerChat(env);
  const other = env.store.createChat({ title: "other", agent: "platform" });
  const theirs = await note(env, other.id, "theirs"); // file in platform's folder (note() lists AGENT only for review)
  // the cdn-desk chat names that file: it is not in cdn-desk's folder
  assert.match((await run(env, mine.id, KNOWLEDGE_DELETE, { file: theirs })).error, /no such note/);
  assert.match((await run(env, mine.id, KNOWLEDGE_EDIT, { file: "../../platform/knowledge/" + theirs, body: "x" })).error, /no such note|bad note file name/);
  assert.ok(fs.existsSync(path.join(env.root, "agents", "platform", "knowledge", theirs)));
  // a chat that does not exist gets no special rights
  assert.match((await run(env, "no-such-chat", KNOWLEDGE_DELETE, { file: theirs })).error, /no such note|only the owner/);
});

test("edit and delete are committed to the knowledge git", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "griffin-kn-git-"));
  const store = openStore(path.join(dir, "db.sqlite"));
  const root = path.join(dir, "knowledge");
  const knowledge = createKnowledge({ store, root, git: true });
  const chat = store.createChat({ title: "own", agent: AGENT });
  const written = JSON.parse((await knowledge.tool(chat.id)[KNOWLEDGE_WRITE].execute({ title: "g1", body: "یک" })).content[0].text);
  const file = path.basename(written.path);
  await knowledge.tool(chat.id)[KNOWLEDGE_EDIT].execute({ file, body: "دو" });
  await knowledge.tool(chat.id)[KNOWLEDGE_DELETE].execute({ file });
  const { spawnSync } = await import("node:child_process");
  const log = spawnSync("git", ["log", "--format=%s"], { cwd: root, encoding: "utf8" }).stdout;
  assert.match(log, /knowledge: delete cdn-desk\/g1\.md \(agent:cdn-desk@/);
  assert.match(log, /knowledge: edit cdn-desk\/g1\.md/);
  // git alone can bring the old text back
  const first = spawnSync("git", ["show", `HEAD~1:agents/${AGENT}/knowledge/${file}`], { cwd: root, encoding: "utf8" }).stdout;
  assert.match(first, /دو/);
});

test("purge removes a trashed note for good and is audited", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "griffin-kn-purge-"));
  const dir = path.join(root, "agents", AGENT, "knowledge");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "to-purge.md"), "---\ntitle: x\n---\nbody\n");
  const { trashId } = deleteNote(root, AGENT, "to-purge.md", { git: false });
  assert.match(purgeNote(root, AGENT, "../../x", { git: false }).error, /bad trash id/);
  assert.equal(purgeNote(root, AGENT, trashId, { git: false }).ok, true);
  assert.equal(listTrash(root, AGENT).length, 0);
  assert.equal(readAudit(root)[0].action, "purge");
  assert.match(purgeNote(root, AGENT, trashId, { git: false }).error, /not in the trash/);
});
