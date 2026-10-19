// Routes and store behaviour the Karsara skin's web and colleagues' scripts rely on:
// list prefs on the server, «undelivered», live MCP status, a task's output tail, one suggestion,
// per-run counters, the rewind preview and choices, a read-only side chat, the inbox by sender.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { createApp } from "../src/app.mjs";
import { openStore } from "../src/db.mjs";
import { listPrefsRoutes } from "../src/list-prefs.mjs";
import { DM_MODES, inboxPeople, inboxPerson, inboxRoutes } from "../src/telegram-inbox.mjs";
import { restrictForReadOnlySide, sideIsReadOnly } from "../src/chat-tools.mjs";
const FAKE_GH = ["ghp", "abcdefghijklmnopqrstuvwxyz0123456789"].join("_"); // built at run time: a token-shaped literal trips push protection

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "griffin-kport-"));
const json = (app, url, body, method = "POST") => app.request(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

function setup(extra = {}) {
  const store = openStore(path.join(tmp(), "db.sqlite"));
  const runner = { isActive: () => false, activeCount: () => 0, send: async () => ({ delivered: "run" }), ...extra };
  return { store, runner, app: createApp({ store, runner }) };
}

test("list prefs: one grouping per sidebar section, kept on the server; Karsara's plain body sets the main list", async () => {
  const store = openStore(path.join(tmp(), "db.sqlite"));
  const app = new Hono();
  listPrefsRoutes(app, { store });
  assert.deepEqual(await (await app.request("/api/list-prefs")).json(), { groupBy: null, sections: {} });
  assert.equal((await json(app, "/api/list-prefs", { groupBy: "date" }, "PUT")).status, 200);
  await json(app, "/api/list-prefs", { groupBy: "owner", section: "telegram" }, "PUT");
  assert.deepEqual(await (await app.request("/api/list-prefs")).json(), { groupBy: "date", sections: { manual: "date", telegram: "owner" } });
  assert.equal((await json(app, "/api/list-prefs", { groupBy: "nope" }, "PUT")).status, 400);
  assert.equal((await json(app, "/api/list-prefs", { groupBy: "date", section: "../x" }, "PUT")).status, 400);
  store.setKv("list-prefs", { groupBy: "repo" }); // a Karsara install's stored value
  assert.equal((await (await app.request("/api/list-prefs")).json()).groupBy, "repo");
});

test("undelivered is Karsara's name for a kept message: owner only, a sane id, not while running", async () => {
  const dropped = [];
  let active = false;
  const { store, app } = setup({ isActive: () => active, dropKept: (chatId, id) => (dropped.push(id), id === "k1") });
  const chat = store.createChat({ title: "t" });
  const del = (id, c = chat) => app.request(`/api/chats/${c.id}/undelivered/${id}`, { method: "DELETE" });
  assert.equal((await del("bad id!")).status, 400);
  assert.equal((await del("k2")).status, 404);
  const ok = await del("k1");
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { ok: true, pendingUndelivered: 0 });
  active = true;
  assert.equal((await del("k1")).status, 409);
  const team = store.createChat({ title: "x", caller: "team" });
  assert.equal((await del("k1", team)).status, 403);
  const listed = (await (await app.request(`/api/chats/${chat.id}`)).json()).chat || {};
  assert.deepEqual(listed.undeliveredIds, []);
});

test("MCP status shows only name, state, scope and tool count — never the server's config", async () => {
  let open = false;
  const controls = [];
  const { store, app } = setup({
    latestSessionChat: () => (open ? chatId : null),
    mcpStatus: async () => (open ? [{ name: "gh", status: "failed", scope: "user", error: `auth failed token=${FAKE_GH}`, config: { headers: { Authorization: "Bearer x" } }, tools: [{}, {}] }] : null),
    mcpControl: async (id, action, name, enabled) => (controls.push([action, name, enabled]), open),
  });
  const chatId = store.createChat({ title: "t" }).id;
  const none = await (await app.request("/api/mcp")).json();
  assert.equal(none.available, false);
  assert.match(none.reason, /Claude Code/);
  assert.equal((await json(app, "/api/mcp", { action: "reconnect", name: "gh" })).status, 409);
  open = true;
  const view = await (await app.request("/api/mcp")).json();
  assert.equal(view.chatId, chatId);
  assert.deepEqual(Object.keys(view.servers[0]).sort(), ["error", "name", "scope", "serverName", "status", "tools"]);
  assert.equal(view.servers[0].tools, 2);
  assert.doesNotMatch(view.servers[0].error, /ghp_abcdefghij/);
  assert.equal((await json(app, `/api/chats/${chatId}/mcp`, { action: "delete", name: "gh" })).status, 400);
  assert.equal((await json(app, `/api/chats/${chatId}/mcp`, { action: "toggle", name: "gh" })).status, 400, "toggle needs enabled");
  assert.equal((await json(app, `/api/chats/${chatId}/mcp`, { action: "toggle", name: "gh", enabled: false })).status, 200);
  assert.deepEqual(controls.at(-1), ["toggle", "gh", false]);
});

test("a task's output: the tail of the file the runner named for that task, masked; nothing else", async () => {
  const file = path.join(tmp(), "out.log");
  fs.writeFileSync(file, `${"x".repeat(70 * 1024)}\nend password=hunter2-hunter2\n`);
  const { store, app } = setup({ taskOutputFile: (chatId, taskId) => (taskId === "t1" ? file : null) });
  const chat = store.createChat({ title: "t" });
  const res = await app.request(`/api/chats/${chat.id}/tasks/t1/output`);
  const body = await res.json();
  assert.equal(body.truncated, true);
  assert.ok(body.text.length <= 64 * 1024);
  assert.match(body.text, /end password=/);
  assert.doesNotMatch(body.text, /hunter2-hunter2/);
  assert.equal((await app.request(`/api/chats/${chat.id}/tasks/t2/output`)).status, 404);
});

test("one suggestion by id", async () => {
  const { store, app } = setup();
  const row = store.createSuggestion({ title: "چت", prompt: "p" });
  assert.equal((await (await app.request(`/api/suggestions/${row.id}`)).json()).suggestion.title, "چت");
  assert.equal((await app.request("/api/suggestions/nope")).status, 404);
});

test("a run row counts its tokens and turns, keeps its model and whether it showed anything", () => {
  const store = openStore(path.join(tmp(), "db.sqlite"));
  const chat = store.createChat({ title: "t" });
  const runId = store.startRun(chat.id);
  const row = () => ({ ...store.db.prepare("SELECT model, tokens, turns, shown FROM runs WHERE id = ?").get(runId) });
  assert.deepEqual(row(), { model: null, tokens: 0, turns: 0, shown: 0 });
  store.appendEvent(chat.id, runId, "run.started", { model: "opus" });
  store.appendEvent(chat.id, runId, "usage", { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100 });
  store.appendEvent(chat.id, runId, "usage", { prompt_tokens: 50, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 40 } });
  store.appendEvent(chat.id, runId, "note", { text: "x" });
  assert.equal(row().shown, 0, "a note is not an answer");
  store.appendEvent(chat.id, runId, "text", { text: "سلام" });
  assert.deepEqual(row(), { model: "opus", tokens: 172, turns: 2, shown: 1 });
});

test("rewind: a dry run previews the files; files or conversation can be taken back alone", async () => {
  const calls = [];
  const { store, app } = setup({ rewindFiles: async (chat, eventId, opts = {}) => (calls.push(opts.dryRun ? "preview" : "files"), opts.dryRun ? { canRewind: true, changed: 2, insertions: 3, deletions: 1 } : { restored: 2 }) });
  const chat = store.createChat({ title: "t" });
  const user = store.appendEvent(chat.id, null, "user", { text: "a" });
  store.appendEvent(chat.id, null, "text", { text: "b" });
  const preview = await (await json(app, `/api/chats/${chat.id}/rewind`, { eventId: user.id, dryRun: true })).json();
  assert.deepEqual(preview, { files: { canRewind: true, changed: 2, insertions: 3, deletions: 1 }, conversation: { canRewind: true } });
  assert.equal(store.eventsAfter(chat.id).length, 2, "a preview changes nothing");
  const filesOnly = await (await json(app, `/api/chats/${chat.id}/rewind`, { eventId: user.id, conversation: false })).json();
  assert.deepEqual(filesOnly.files, { restored: 2 });
  assert.equal(store.eventsAfter(chat.id).length, 2, "the conversation stays");
  assert.equal((await json(app, `/api/chats/${chat.id}/rewind`, { eventId: user.id, conversation: false, files: false })).status, 400);
  await json(app, `/api/chats/${chat.id}/rewind`, { eventId: user.id, files: false });
  assert.equal(store.eventsAfter(chat.id).length, 0);
  assert.deepEqual(calls, ["preview", "files"]);
});

test("editing a message the agent is still working on stops that turn first, then resends", async () => {
  let active = true;
  const steps = [];
  const { store, app } = setup({
    isActive: () => active,
    cancel: async () => (steps.push("cancel"), setTimeout(() => (active = false), 50), { status: "cancelling" }),
    send: async (chatId, input) => (steps.push(`send:${input.text}`), { delivered: "run" }),
  });
  const chat = store.createChat({ title: "t" });
  const user = store.appendEvent(chat.id, null, "user", { text: "a" });
  store.appendEvent(chat.id, null, "text", { text: "نیمه‌کاره" });
  const preview = await json(app, `/api/chats/${chat.id}/rewind`, { eventId: user.id, dryRun: true });
  assert.equal(preview.status, 200);
  assert.deepEqual(steps, [], "a preview stops nothing");
  const res = await json(app, `/api/chats/${chat.id}/rewind`, { eventId: user.id, text: "b", files: false });
  assert.equal(res.status, 202);
  assert.deepEqual(steps, ["cancel", "send:b"]);
  assert.equal(store.eventsAfter(chat.id).length, 0, "the old turn is cut before the resend");
});

test("a side chat started with edits off only reads and asks", async () => {
  const { store, app } = setup();
  const parent = store.createChat({ title: "p" });
  const res = await json(app, `/api/chats/${parent.id}/side`, { text: "فقط ببین", allowEdits: false });
  const { chat } = await res.json();
  assert.equal(chat.allowEdits, false);
  assert.equal(sideIsReadOnly(store, store.getChat(chat.id)), true);
  const open = (await (await json(app, `/api/chats/${parent.id}/side`, { text: "درست کن" })).json()).chat;
  assert.equal(open.allowEdits, true);
  assert.equal(sideIsReadOnly(store, parent), false, "a main chat is never read-only");
  assert.deepEqual(Object.keys(restrictForReadOnlySide({ repo_write: {}, repo_read: {}, ask_owner: {}, telegram_send: {} })).sort(), ["ask_owner", "repo_read"]);
});

test("the Telegram inbox by sender, and Karsara's on / off as the TELEGRAM_DM_MODE switch", async () => {
  const store = openStore(path.join(tmp(), "db.sqlite"));
  const inboxChat = store.createChat({ title: "inbox" });
  const a = store.addInboxItem({ peerId: "7", text: "سلام\nمتن", meta: { name: "علی" } });
  store.addInboxItem({ peerId: "9", text: "دیگری", meta: { name: "رضا" } });
  const b = store.addInboxItem({ peerId: "7", text: "دوم", meta: { name: "علی", routedTo: [inboxChat.id] } });
  store.setInboxItem(a, "delivered", "2026-10-17T10:00:00.000Z");
  const s = store.createSuggestion({ fromChatId: inboxChat.id, title: "موضوع تازه", prompt: "p" });
  store.db.prepare("UPDATE suggestions SET created_at = ? WHERE id = ?").run("2026-10-17T10:00:05.000Z", s.id);
  store.setInboxItem(a, "done", "2026-10-17T10:00:10.000Z");
  const people = inboxPeople(store);
  assert.deepEqual(people.map((p) => [p.peerId, p.name, p.count, p.open]), [["7", "علی", 2, 1], ["9", "رضا", 1, 1]]);
  const person = inboxPerson(store, "7", { inboxChatId: inboxChat.id });
  assert.equal(person.total, 2);
  assert.deepEqual(person.items[0].suggested.map((x) => x.title), ["موضوع تازه"]);
  assert.deepEqual(person.items[1].routed, [{ chatId: inboxChat.id, title: "inbox" }]);
  assert.equal(b, person.items[1].id);
  assert.equal(inboxPerson(store, "404"), null);

  const modes = [];
  const app = new Hono();
  const inbox = { status: () => ({ mode: modes.at(-1) || DM_MODES[0] }), people: () => inboxPeople(store), person: (id) => inboxPerson(store, id) };
  inboxRoutes(app, inbox, { store, setMode: (m) => modes.push(m) });
  assert.equal((await (await app.request("/api/inbox/people")).json()).people.length, 2);
  assert.equal((await app.request("/api/inbox/people/404")).status, 404);
  assert.equal((await (await app.request("/api/inbox/enable", { method: "POST" })).json()).mode, "inbox");
  assert.equal(store.getKv("tg-inbox").decided, true);
  await app.request("/api/inbox/disable", { method: "POST" });
  assert.deepEqual(modes, ["inbox", DM_MODES[0]]);
});

test("an MCP sign-in or form question becomes the owner's card; no ask means declined", async () => {
  const { answerElicitation, ELICIT_DONE, ELICIT_CANCEL } = await import("../src/providers/claude.mjs");
  const asked = [];
  const answer = (pick) => async (args) => (asked.push(args), { answered: true, selected: [pick] });
  assert.deepEqual(await answerElicitation({ serverName: "gh", mode: "url", url: "https://gh.example/login" }, answer(ELICIT_DONE)), { action: "accept" });
  assert.equal(asked[0].link, "https://gh.example/login");
  assert.doesNotMatch(asked[0].question, /gh\.example/, "the link rides on the card, not in the text Telegram gets");
  assert.deepEqual(await answerElicitation({ serverName: "gh", mode: "url", url: "https://x" }, answer(ELICIT_CANCEL)), { action: "cancel" });
  const form = { serverName: "db", mode: "form", requestedSchema: { properties: { port: { type: "integer", title: "پورت" }, ok: { type: "boolean" } }, required: ["port"] } };
  const answers = ["۵۴۳۲", "بله"];
  assert.deepEqual(await answerElicitation(form, async () => ({ answered: true, selected: [answers.shift()] })), { action: "accept", content: { port: 5432, ok: true } });
  assert.deepEqual(await answerElicitation(form, null), { action: "decline" });

  const { createAsks } = await import("../src/asks.mjs");
  const store = openStore(path.join(tmp(), "db.sqlite"));
  const chat = store.createChat({ title: "t" });
  const asks = createAsks({ store, log: { log() {} } });
  const pending = asks.elicit(chat.id, { question: "ورود؟", link: "https://gh.example/login", options: [{ label: ELICIT_DONE }] });
  const card = store.eventsAfter(chat.id).find((e) => e.type === "tool.started");
  assert.equal(card.data.args.link, "https://gh.example/login", "its own card in the chat, with the link");
  asks.answer(chat.id, { answered: true, answer: ELICIT_DONE, selected: [ELICIT_DONE] }, { by: "owner", askId: card.data.args.askId });
  assert.equal((await pending).answered, true);
  assert.ok(store.eventsAfter(chat.id).some((e) => e.type === "tool.done" && e.data.callId === card.data.callId));
});
