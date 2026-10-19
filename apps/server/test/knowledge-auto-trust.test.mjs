import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openStore } from "../src/db.mjs";
import { createKnowledge, KNOWLEDGE_LIST, KNOWLEDGE_WRITE, setNoteReviewed } from "../src/knowledge.mjs";
import { createChatTrust } from "../src/knowledge-trust.mjs";
import { buildRules } from "../src/prompt.mjs";

// Auto-trust for notes from clean chats: behind GRIFFIN_KNOWLEDGE_AUTO_TRUST, off by
// default. A chat is clean when the owner started it and nothing in it carried someone else's words.

const AGENT = "griffin";

function setup({ autoTrust = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "griffin-autotrust-"));
  const store = openStore(path.join(dir, "db.sqlite"));
  const root = path.join(dir, "knowledge");
  const trust = createChatTrust({ store });
  const isCleanChat = (chatId) => trust.isCleanChat(chatId);
  const knowledge = createKnowledge({ store, root, git: false, autoTrust, trust });
  return { store, root, knowledge, isCleanChat, trust };
}

// The way a run writes a note: the provider logs the tool call, then the tool runs.
async function writeNote({ store, knowledge }, chatId, title, body) {
  store.appendEvent(chatId, null, "tool.started", { callId: `c-${title}`, name: KNOWLEDGE_WRITE, args: { title, body } });
  const out = await knowledge.tool(chatId)[KNOWLEDGE_WRITE].execute({ title, body });
  assert.equal(out.isError, undefined, out.content?.[0]?.text);
  return JSON.parse(out.content[0].text);
}

const rules = (env, extra = {}) => buildRules({ agent: AGENT, caller: "owner", knowledgeRoot: env.root, autoTrust: true, isTrustedNote: env.trust.isTrustedNote, ...extra });
const listed = async (env, chatId) => JSON.parse((await env.knowledge.tool(chatId)[KNOWLEDGE_LIST].execute({})).content[0].text);

test("flag off: an unreviewed note from a clean chat stays out of the prompt (unchanged behaviour)", async () => {
  const env = setup({ autoTrust: false });
  const chat = env.store.createChat({ title: "own", agent: AGENT });
  env.store.appendEvent(chat.id, null, "user", { text: "کش را پاک کن" });
  await writeNote(env, chat.id, "clean-fact", "BODY-CLEAN-OFF");
  assert.doesNotMatch(buildRules({ agent: AGENT, caller: "owner", knowledgeRoot: env.root }), /BODY-CLEAN-OFF/);
  const list = await listed(env, chat.id);
  assert.equal(list.notes.length, 1, "with the flag off knowledge_list lists every note as before");
  assert.equal(list.unlisted, undefined);
});

test("flag on: a note from the owner's clean chat reaches later owner chats, labelled as auto-trusted", async () => {
  const env = setup();
  const chat = env.store.createChat({ title: "own", agent: AGENT });
  env.store.appendEvent(chat.id, null, "user", { text: "کش را پاک کن" });
  env.store.appendEvent(chat.id, null, "tool.started", { callId: "r1", name: "todo_write", args: {} });
  await writeNote(env, chat.id, "clean-fact", "BODY-CLEAN-ON");
  const out = rules(env);
  assert.match(out, /auto-trusted/);
  assert.match(out, /BODY-CLEAN-ON/);
  // A colleague's thread or a job keeps owner-reviewed notes only.
  assert.doesNotMatch(rules(env, { caller: "team" }), /BODY-CLEAN-ON/);
  assert.doesNotMatch(rules(env, { caller: "scheduler" }), /BODY-CLEAN-ON/);
  const list = await listed(env, chat.id);
  assert.deepEqual(list.notes.map((n) => n.title), ["clean-fact"]);
  assert.equal(list.unlisted, 0);
});

test("flag on: a chat that held a colleague's message, a web fetch or a public URL is not trusted", async () => {
  const env = setup();
  const cases = [
    ["peer", (id) => env.store.appendEvent(id, null, "user", { text: "سلام", from: { kind: "peer", name: "x" } })],
    ["colleague", (id) => env.store.appendEvent(id, null, "user", { text: "سلام", from: { kind: "colleague", name: "y" } })],
    ["inbox-head", (id) => env.store.appendEvent(id, null, "user", { text: "📥 پیام" })],
    ["marked", (id) => env.store.appendEvent(id, null, "user", { text: "این محتوای شخص ثالث است" })],
    ["read-any-path", (id) => env.store.appendEvent(id, null, "tool.started", { callId: "r", name: "Read", args: { file_path: "/workspace/knowledge/agents/x/knowledge/n.md" } })],
    ["handover", (id) => env.store.appendEvent(id, null, "user", { text: "[همان درخواست‌کننده از مسیر تلگرام — پیام تازه]\n\nسلام" })],
    ["web", (id) => env.store.appendEvent(id, null, "tool.started", { callId: "w", name: "WebFetch", args: { url: "https://example.com" } })],
    ["telegram", (id) => env.store.appendEvent(id, null, "tool.started", { callId: "t", name: "telegram_read", args: {} })],
    // A repo's files, or a workspace file shown to the model, can carry anyone's words.
    ["repo-read", (id) => env.store.appendEvent(id, null, "tool.started", { callId: "rr", name: "repo_read", args: { repo: "r", path: "README.md" } })],
    ["repo-search", (id) => env.store.appendEvent(id, null, "tool.started", { callId: "rs", name: "repo_search", args: { repo: "r", pattern: "x" } })],
    ["repo-list", (id) => env.store.appendEvent(id, null, "tool.started", { callId: "rl", name: "repo_list", args: { repo: "r" } })],
    // jobs_update answers with the job's prompt and its last run's summary, like jobs_list.
    ["jobs-update", (id) => env.store.appendEvent(id, null, "tool.started", { callId: "ju", name: "jobs_update", args: { id: "j1", enabled: true } })],
    ["media-path", (id) => env.store.appendEvent(id, null, "tool.started", { callId: "mp", name: "show_media", args: { path: "/workspace/notes.txt" } })],
    ["media-path-late", (id) => {
      env.store.appendEvent(id, null, "tool.started", { callId: "mq", name: "show_media", args: {} });
      env.store.appendEvent(id, null, "tool.done", { callId: "mq", name: "show_media", args: { path: "a.md" } });
    }],
    ["unnamed", (id) => env.store.appendEvent(id, null, "tool.started", { callId: "u", name: "", args: {} })],
    // openai-style: the arguments arrive on a later event.
    ["media-url", (id) => {
      env.store.appendEvent(id, null, "tool.started", { callId: "m", name: "show_media", args: {} });
      env.store.appendEvent(id, null, "tool.done", { callId: "m", name: "show_media", args: { url: "https://example.com/a.png" } });
    }],
  ];
  const stillClean = [];
  for (const [name, taint] of cases) {
    const chat = env.store.createChat({ title: name, agent: AGENT });
    env.store.appendEvent(chat.id, null, "user", { text: "شروع" });
    taint(chat.id);
    await writeNote(env, chat.id, `tainted-${name}`, `BODY-TAINT-${name}`);
    if (env.isCleanChat(chat.id)) stillClean.push(name);
  }
  // Every case that slipped through is named, not only the first.
  assert.deepEqual(stillClean, []);
  const out = rules(env);
  for (const [name] of cases) assert.doesNotMatch(out, new RegExp(`BODY-TAINT-${name}`), name);
  const own = env.store.createChat({ title: "own", agent: AGENT });
  const list = await listed(env, own.id);
  assert.equal(list.notes.length, 0, "titles of untrusted notes are not listed");
  assert.equal(list.unlisted, cases.length);
  const file = fs.readdirSync(path.join(env.root, "agents", AGENT, "knowledge"))[0];
  const read = await env.knowledge.tool(own.id)[KNOWLEDGE_LIST].execute({ file });
  assert.equal(read.isError, true, "an untrusted note's body is not served either");
  // The owner's review still lets it in.
  assert.equal(setNoteReviewed(env.root, AGENT, file, true, { git: false }), true);
  assert.equal((await env.knowledge.tool(own.id)[KNOWLEDGE_LIST].execute({ file })).isError, undefined);
});

test("flag on: taint after the note was written does not withdraw it; taint before does", async () => {
  const env = setup();
  const chat = env.store.createChat({ title: "own", agent: AGENT });
  env.store.appendEvent(chat.id, null, "user", { text: "شروع" });
  await writeNote(env, chat.id, "before-taint", "BODY-BEFORE");
  env.store.appendEvent(chat.id, null, "tool.started", { callId: "w", name: "WebFetch", args: {} });
  await writeNote(env, chat.id, "after-taint", "BODY-AFTER");
  const out = rules(env);
  assert.match(out, /BODY-BEFORE/);
  assert.doesNotMatch(out, /BODY-AFTER/);
});

test("flag on: chats the owner did not start, or that came from an untrusted chat, are not trusted", async () => {
  const env = setup();
  const { store } = env;
  const team = store.createChat({ title: "team", agent: AGENT, caller: "team" });
  const peer = store.createChat({ title: "peer", agent: AGENT, caller: "peer:ali" });
  const job = store.createChat({ title: "job", agent: AGENT, jobId: "j1", caller: "scheduler" });
  const person = store.createChat({ title: "person", agent: AGENT, personId: "p1" });
  for (const chat of [team, peer, job, person]) assert.equal(env.isCleanChat(chat.id), false, chat.title);

  const tainted = store.createChat({ title: "tainted", agent: AGENT });
  store.appendEvent(tainted.id, null, "tool.started", { callId: "w", name: "WebSearch", args: {} });
  const child = store.createChat({ title: "child", agent: AGENT, parentChatId: tainted.id });
  assert.equal(env.isCleanChat(child.id), false, "a child of a tainted chat");
  const side = store.createChat({ title: "side", agent: AGENT, sideOf: tainted.id });
  assert.equal(env.isCleanChat(side.id), false, "a side chat of a tainted chat");

  const fromTainted = store.createSuggestion({ fromChatId: tainted.id, title: "s", prompt: "p" });
  const started = store.createChat({ title: "from-suggestion", agent: AGENT });
  store.settleSuggestion(fromTainted.id, "started", started.id);
  assert.equal(env.isCleanChat(started.id), false, "started from a tainted chat's suggestion");

  const clean = store.createChat({ title: "clean", agent: AGENT });
  const fromClean = store.createSuggestion({ fromChatId: clean.id, title: "s2", prompt: "p" });
  const ok = store.createChat({ title: "from-clean", agent: AGENT });
  store.settleSuggestion(fromClean.id, "started", ok.id);
  assert.equal(env.isCleanChat(ok.id), true, "started from a clean chat's suggestion");
  assert.equal(env.isCleanChat(null), false);
  assert.equal(env.isCleanChat("missing"), false);
});

test("flag on: a note file edited or made by hand after knowledge_write is not trusted", async () => {
  const env = setup();
  const chat = env.store.createChat({ title: "own", agent: AGENT });
  env.store.appendEvent(chat.id, null, "user", { text: "شروع" });
  const saved = await writeNote(env, chat.id, "real", "BODY-REAL");
  const dir = path.join(env.root, "agents", AGENT, "knowledge");
  assert.match(rules(env), /BODY-REAL/);
  // Another chat's Write/Edit rewrites the body, keeping the frontmatter.
  const file = path.join(env.root, saved.path);
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("BODY-REAL", "BODY-EDITED"));
  assert.doesNotMatch(rules(env), /BODY-EDITED/);
  // A hand-made file that names the clean chat.
  fs.writeFileSync(path.join(dir, "forged.md"), `---\ntitle: "forged"\nagent: ${AGENT}\nchat: ${chat.id}\nchat_event: 1\nat: ${new Date().toISOString()}\nreviewed: false\n---\n\nBODY-FORGED\n`);
  assert.doesNotMatch(rules(env), /BODY-FORGED/);
  assert.deepEqual((await listed(env, chat.id)).notes, []);
});

test("flag on: a fork of a tainted chat is not clean; colleagues' chats get no auto-trusted notes", async () => {
  const env = setup();
  const { store } = env;
  const tainted = store.createChat({ title: "tainted", agent: AGENT });
  store.appendEvent(tainted.id, null, "tool.started", { callId: "w", name: "WebFetch", args: {} });
  const fork = store.createChat({ title: "fork", agent: AGENT });
  store.setKv(`fork-of:${fork.id}`, tainted.id);
  store.appendEvent(fork.id, null, "user", { text: "ادامه" });
  assert.equal(env.isCleanChat(fork.id), false);
  // A colleague's Telegram chat runs with caller "owner" and a person id.
  const colleague = store.createChat({ title: "colleague", agent: AGENT, personId: "p1" });
  const sideOfColleague = store.createChat({ title: "side", agent: AGENT, sideOf: colleague.id });
  assert.equal(env.trust.ownerRooted(colleague.id), false);
  assert.equal(env.trust.ownerRooted(sideOfColleague.id), false);
  const own = store.createChat({ title: "own", agent: AGENT });
  assert.equal(env.trust.ownerRooted(own.id), true);
});
