import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { foldEvents } from "@griffin/timeline";
import { createApp } from "../src/app.mjs";
import { openStore } from "../src/db.mjs";
import { createChatTools, promptSha, PROMPT_MAX, SUGGEST_MAX_OPEN, SUGGEST_MAX_PER_CHAT, withOwnerNote } from "../src/chat-tools.mjs";

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "griffin-chattools-"));
  const store = openStore(path.join(dir, "db.sqlite"));
  const sent = [];
  const runner = { isActive: () => false, activeCount: () => 0, send: async (chatId, input) => (sent.push({ chatId, ...input }), { delivered: "run" }) };
  const isValidRepo = (repo) => ["infra-repo", "app-repo"].includes(repo);
  const app = createApp({ store, runner, isValidRepo });
  return { store, app, sent, isValidRepo };
}
const post = (app, url, body) => app.request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const json = (result) => JSON.parse(result.content[0].text);
const suggestion = { title: "رفع README", tldr: "نشان قدیمی است", prompt: "README.md را به‌روز کن" };

test("chat_suggest stores a suggestion and a card event; nothing runs", async () => {
  const { store, sent, isValidRepo } = setup();
  const chat = store.createChat({ title: "اصلی", model: "openai:glm-5.3" });
  store.updateChat(chat.id, { repo: "app-repo" });
  const tools = createChatTools({ store, chatId: chat.id, isValidRepo });
  const { id } = json(await tools.chat_suggest.execute(suggestion));
  const row = store.getSuggestion(id);
  assert.equal(row.status, "open");
  assert.equal(row.repo, "app-repo", "this chat's repo by default");
  assert.equal(row.model, "openai:glm-5.3", "this chat's model by default");
  assert.equal(sent.length, 0);
  const parts = foldEvents([{ id: 0, runId: "r", type: "run.started", data: {} }, ...store.eventsAfter(chat.id)]).messages[0].parts;
  assert.deepEqual(parts, [{ type: "suggestion", id, title: suggestion.title, tldr: suggestion.tldr, status: "open" }]);

  const other = json(await tools.chat_suggest.execute({ ...suggestion, provider: "claude", model: "haiku", repo: "infra-repo" }));
  assert.equal(store.getSuggestion(other.id).model, "claude:haiku");
  assert.equal(store.getSuggestion(other.id).repo, "infra-repo");
  assert.ok((await tools.chat_suggest.execute({ ...suggestion, repo: "../etc" })).isError);
  const long = await tools.chat_suggest.execute({ ...suggestion, prompt: "x".repeat(PROMPT_MAX + 1) });
  assert.ok(long.isError && /limit/.test(json(long).error), "a long prompt is refused, never cut");
});

test("suggestions are bounded per chat and overall", async () => {
  const { store } = setup();
  const a = store.createChat({ title: "a" });
  const toolsA = createChatTools({ store, chatId: a.id });
  for (let i = 0; i < SUGGEST_MAX_PER_CHAT; i += 1) assert.ok(!(await toolsA.chat_suggest.execute(suggestion)).isError);
  const full = await toolsA.chat_suggest.execute(suggestion);
  assert.ok(full.isError && /chat_dismiss_suggestion/.test(json(full).error));
  // Withdrawing one makes room again; another chat's suggestion cannot be withdrawn from here.
  const b = store.createChat({ title: "b" });
  const toolsB = createChatTools({ store, chatId: b.id });
  const mine = store.listSuggestions({ status: "open" })[0].id;
  assert.ok((await toolsB.chat_dismiss_suggestion.execute({ id: mine })).isError);
  assert.deepEqual(json(await toolsA.chat_dismiss_suggestion.execute({ id: mine })), { id: mine, status: "dismissed" });
  assert.ok(!(await toolsA.chat_suggest.execute(suggestion)).isError);
  // Overall wall.
  for (let i = store.listSuggestions({ status: "open" }).length; i < SUGGEST_MAX_OPEN; i += 1) {
    store.createSuggestion({ fromChatId: `x${i}`, title: "t", prompt: "p" });
  }
  assert.ok((await toolsB.chat_suggest.execute(suggestion)).isError);
});

test("chat_chapter appends a chapter part to the running answer", async () => {
  const { store } = setup();
  const chat = store.createChat({ title: "c" });
  const tools = createChatTools({ store, chatId: chat.id });
  assert.ok((await tools.chat_chapter.execute({ title: " " })).isError);
  await tools.chat_chapter.execute({ title: "پیاده‌سازی", summary: "تغییر کد" });
  const events = [{ id: 0, runId: "r", type: "run.started", data: {} }, ...store.eventsAfter(chat.id)];
  assert.deepEqual(foldEvents(events).messages[0].parts, [{ type: "chapter", title: "پیاده‌سازی", summary: "تغییر کد" }]);
});

test("start runs exactly the prompt the owner was shown, once, with the card's model and note", async () => {
  const { store, app, sent } = setup();
  const from = store.createChat({ title: "منبع" });
  const row = store.createSuggestion({ fromChatId: from.id, title: "کار تازه", tldr: "x", prompt: "متن پرامپت", repo: "app-repo", model: "openai:glm-5.3" });
  const url = `/api/suggestions/${row.id}/start`;
  assert.equal((await post(app, url, {})).status, 400, "promptSha is required");
  assert.equal((await post(app, url, { promptSha: promptSha("متن دیگر") })).status, 409, "another prompt cannot run");

  const listed = (await (await app.request("/api/suggestions?status=open")).json()).suggestions;
  assert.deepEqual(listed.map((s) => [s.id, s.prompt, s.promptSha]), [[row.id, "متن پرامپت", promptSha("متن پرامپت")]]);

  const res = await post(app, url, { promptSha: listed[0].promptSha, model: "claude:haiku", note: "عجله نکن", notePosition: "before" });
  assert.equal(res.status, 201);
  const { chat, suggestion: settled } = await res.json();
  assert.equal(settled.status, "started");
  assert.equal(settled.startedChatId, chat.id);
  const created = store.getChat(chat.id);
  assert.equal(created.model, "claude:haiku");
  assert.equal(created.provider, "claude");
  assert.equal(created.repo, "app-repo");
  assert.deepEqual(sent.map((s) => [s.chatId, s.text]), [[chat.id, "تذکر مالک: عجله نکن\n\nمتن پرامپت"]]);
  assert.equal((await post(app, url, { promptSha: listed[0].promptSha })).status, 409, "a second start starts nothing");
  // The suggesting chat's card follows.
  assert.deepEqual(store.eventsAfter(from.id).at(-1).data, { id: row.id, status: "started" });
});

test("start keeps the suggested model when the card was not changed; «خودکار» clears it", async () => {
  const { store, app } = setup();
  const one = store.createSuggestion({ title: "a", prompt: "p", model: "openai:glm-5.3" });
  const a = (await (await post(app, `/api/suggestions/${one.id}/start`, { promptSha: promptSha("p") })).json()).chat;
  assert.equal(store.getChat(a.id).model, "openai:glm-5.3");
  const two = store.createSuggestion({ title: "b", prompt: "p", model: "openai:glm-5.3" });
  const b = (await (await post(app, `/api/suggestions/${two.id}/start`, { promptSha: promptSha("p"), model: "" })).json()).chat;
  assert.notEqual(store.getChat(b.id).model, "openai:glm-5.3");
});

test("dismiss settles once; a deleted source chat leaves the suggestion standing", async () => {
  const { store, app } = setup();
  const from = store.createChat({ title: "منبع" });
  const row = store.createSuggestion({ fromChatId: from.id, title: "t", prompt: "p" });
  const res = await post(app, `/api/suggestions/${row.id}/dismiss`, {});
  assert.equal((await res.json()).suggestion.status, "dismissed");
  assert.equal((await post(app, `/api/suggestions/${row.id}/start`, { promptSha: promptSha("p") })).status, 409);
  const kept = store.createSuggestion({ fromChatId: from.id, title: "t2", prompt: "p" });
  store.deleteChat(from.id);
  assert.equal(store.getSuggestion(kept.id).from_chat_id, null);
  assert.equal(withOwnerNote("p", "  ", "after"), "p");
  assert.equal(withOwnerNote("p", "n", "after"), "p\n\nتذکر مالک: n");
});

test("migration gives the chat tools to agents the owner talks to, not to all-platform or caller rows", () => {
  const { store } = setup();
  store.seedAgentProfiles();
  // An agent from before the migration: talks to the owner, has no chat tools; plus an all-platform one.
  store.upsertAgentProfile({ id: "writer", label: "writer", tools: ["ask_owner", "visualize"], meta: { callers: { scheduler: { tools: ["visualize"] } } } });
  store.upsertAgentProfile({ id: "ops", label: "ops", tools: ["ask_owner"], meta: { allPlatform: true } });
  store.setKv("migr:chat-tools", "");
  store.seedAgentProfiles();
  const writer = store.getAgentProfile("writer");
  assert.ok(["chat_suggest", "chat_chapter"].every((n) => writer.tools.includes(n)));
  assert.ok(!store.getAgentProfile("ops").tools.includes("chat_suggest"), "all-platform rows are left alone");
  for (const quota of Object.values(writer.meta.callers || {})) {
    if (Array.isArray(quota.tools)) assert.ok(!quota.tools.includes("chat_suggest"));
  }
});

test("chat_suggest refuses a provider without a model and a model the account cannot run", async () => {
  const { store } = setup();
  const chat = store.createChat({ title: "a" });
  const seen = [];
  const checkModel = async (account, model) => {
    seen.push([account, model]);
    return account === "claude" && model !== "haiku" ? `engine account "claude" does not list model "${model}"; valid ids: opus, sonnet, haiku` : null;
  };
  const tools = createChatTools({ store, chatId: chat.id, checkModel });
  const bare = await tools.chat_suggest.execute({ ...suggestion, provider: "claude" });
  assert.ok(bare.isError && /without a model/.test(json(bare).error));
  const wrong = await tools.chat_suggest.execute({ ...suggestion, provider: "claude", model: "claude-opus-4[1m]" });
  assert.ok(wrong.isError && /valid ids/.test(json(wrong).error));
  assert.ok(!(await tools.chat_suggest.execute({ ...suggestion, provider: "claude", model: "haiku" })).isError);
  assert.ok(!(await tools.chat_suggest.execute({ ...suggestion, model: "glm-5.3" })).isError);
  assert.deepEqual(seen.at(-1), [null, "glm-5.3"], "a bare model is checked on the chat's own engine");
  assert.ok(!(await tools.chat_suggest.execute(suggestion)).isError, "no model named: no check");
  assert.equal(seen.length, 3);
});

test("GET /api/chats/:id carries usage by model; a rewind may not cut back past a folder switch", async () => {
  const { store, app } = setup();
  const chat = store.createChat({ title: "a" });
  const user = store.appendEvent(chat.id, null, "user", { text: "سلام" });
  const runId = store.startRun(chat.id);
  store.appendEvent(chat.id, runId, "run.started", { model: "glm-5.3" });
  store.appendEvent(chat.id, runId, "usage", { inputTokens: 90, outputTokens: 10 });
  store.appendEvent(chat.id, runId, "run.finished", { status: "finished" });
  const got = await (await app.request(`/api/chats/${chat.id}`)).json();
  assert.deepEqual(got.chat.usage, { total: 100, byModel: [{ model: "glm-5.3", tokens: 100 }] });
  assert.equal(got.chat.waitingForOwner, false);

  const note = store.appendEvent(chat.id, null, "note", { text: "moved" });
  store.setKv(`repomove:${chat.id}`, { from: "a", to: "b", noteId: note.id });
  assert.equal((await post(app, `/api/chats/${chat.id}/rewind`, { eventId: user.id })).status, 409);
  const later = store.appendEvent(chat.id, null, "user", { text: "بعد" });
  assert.equal((await post(app, `/api/chats/${chat.id}/rewind`, { eventId: later.id })).status, 200);
});

test("GET /api/chats/:id/context: the last run's prompt tokens over the window", async () => {
  const { store, app } = setup();
  const chat = store.createChat({ title: "a" });
  assert.equal((await (await app.request(`/api/chats/${chat.id}/context`)).json()).available, false);
  const runId = store.startRun(chat.id);
  store.appendEvent(chat.id, runId, "run.started", { model: "sonnet" });
  store.appendEvent(chat.id, runId, "usage", { inputTokens: 50_000, outputTokens: 10 });
  store.appendEvent(chat.id, runId, "run.finished", { status: "finished" });
  const got = await (await app.request(`/api/chats/${chat.id}/context`)).json();
  assert.deepEqual(got, { available: true, used: 50_000, window: 200_000, percent: 25, model: "sonnet" });
});

test("GET /api/chats/:id/context: a 1M model's gauge is over its own 1M window", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "griffin-chattools-"));
  const store = openStore(path.join(dir, "db.sqlite"));
  const runner = { isActive: () => false, activeCount: () => 0, contextUsage: () => ({ totalTokens: 150_000, rawMaxTokens: 1_000_000, model: "claude-sonnet-5-5" }) };
  const app = createApp({ store, runner, isValidRepo: () => true });
  const chat = store.createChat({ title: "a" });
  const got = await (await app.request(`/api/chats/${chat.id}/context`)).json();
  assert.equal(got.window, 1_000_000);
  assert.equal(got.percent, 15);
});
