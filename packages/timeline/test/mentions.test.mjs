import { test } from "node:test";
import assert from "node:assert/strict";
import { chatMentionTitles, filterMentionables, findMentions, insertMention, mentionHandle, mentionNote, mentionQuery } from "../src/index.mjs";

const agents = [
  { id: "karsara-kazemi-example-org", name: "یارا", owner: "علیرضا کاظمی" },
  { id: "karsara-sharifi-example-org", name: "دستیار راوی", owner: "آناهیتا شریفی" },
  { id: "griffin-rezaei-example-org", name: "گریفین", owner: "علی رضایی" },
  { id: "griffin-x-example-org", name: "گریفین", owner: "علی ایکس" },
];

test("handle: spaces become «_», twins get the owner's last name", () => {
  assert.equal(mentionHandle(agents[0], agents), "یارا");
  assert.equal(mentionHandle(agents[1], agents), "دستیار_راوی");
  assert.equal(mentionHandle(agents[2], agents), "گریفین_رضایی");
  assert.equal(mentionHandle(agents[3], agents), "گریفین_ایکس");
});

test("query: only an «@» at a word start, up to the caret", () => {
  assert.deepEqual(mentionQuery("سلام @یا"), { start: 5, query: "یا" });
  assert.deepEqual(mentionQuery("@"), { start: 0, query: "" });
  assert.equal(mentionQuery("mail@host"), null);
  assert.equal(mentionQuery("@یارا بپرس"), null);
  assert.deepEqual(mentionQuery("@یارا بپرس", 3), { start: 0, query: "یا" });
});

test("filter: name starts first, owner matches too", () => {
  assert.deepEqual(filterMentionables(agents, "یا").map((a) => a.id), ["karsara-kazemi-example-org", "karsara-sharifi-example-org"]);
  assert.deepEqual(filterMentionables(agents, "شریفی").map((a) => a.id), ["karsara-sharifi-example-org"]);
  assert.equal(filterMentionables(agents, "").length, 4);
});

test("insert: replaces the typed query and the rest of that word", () => {
  assert.deepEqual(insertMention("از @یا بپرس", 6, agents[0], agents), { text: "از @یارا بپرس", caret: 9 });
  assert.deepEqual(insertMention("@دس", 3, agents[1], agents), { text: "@دستیار_راوی ", caret: 13 });
});

test("find: whole handles only, punctuation ends a handle", () => {
  const found = findMentions("@یارا و @گریفین_رضایی، لطفاً بررسی کنید. ایمیل a@یارا", agents);
  assert.deepEqual(found.map((a) => a.id), ["karsara-kazemi-example-org", "griffin-rezaei-example-org"]);
  assert.deepEqual(findMentions("@یاراها", agents), []);
  assert.deepEqual(findMentions("@دستیار_راوی؟", agents).map((a) => a.id), ["karsara-sharifi-example-org"]);
});

test("note: names the network ids for network_ask; empty without tags", () => {
  assert.equal(mentionNote([]), "");
  const note = mentionNote([agents[0]], agents);
  assert.match(note, /network_ask \{agent: "karsara-kazemi-example-org"\}/);
  assert.match(note, /@یارا/);
});

const own = [{ kind: "agent", id: "platform", name: "پلتفرم‌بان", domain: "پلتفرم پلتفرم" }];
const chats = [
  { kind: "chat", id: "c1", name: "بررسی «دیسک» نود node-3" },
  { kind: "chat", id: "c2", name: "مرج MR ۱۲۳" },
];

test("chats: handle is the title in «», found by @«title», titles read back for the server", () => {
  assert.equal(mentionHandle(chats[0]), "«بررسی دیسک نود node-3»");
  assert.deepEqual(insertMention("ببین @نود", 9, chats[0], chats), { text: "ببین @«بررسی دیسک نود node-3» ", caret: 30 });
  const text = "طبق @«بررسی دیسک نود node-3»، و @«مرج MR ۱۲۳» را هم ببین";
  assert.deepEqual(findMentions(text, chats).map((c) => c.id), ["c1", "c2"]);
  assert.deepEqual(chatMentionTitles(text), ["بررسی دیسک نود node-3", "مرج MR ۱۲۳"]);
  assert.deepEqual(filterMentionables(chats, "node").map((c) => c.id), ["c1"]);
  assert.equal(mentionQuery("@«بررسی دیسک"), null);
});

test("own agents: found by label, filtered by id/domain; a network twin of the same name gets its owner's name", () => {
  const twin = { id: "net-platform", name: "پلتفرم‌بان", owner: "علی ایکس" };
  const all = [...own, twin];
  assert.equal(mentionHandle(own[0], all), "پلتفرم‌بان");
  assert.equal(mentionHandle(twin, all), "پلتفرم‌بان_ایکس");
  assert.deepEqual(filterMentionables(all, "platform").map((a) => a.id), ["platform"]);
  assert.deepEqual(findMentions("@پلتفرم‌بان لطفاً", all).map((a) => a.id), ["platform"]);
});

test("note: one block per kind, with the tool to use", () => {
  const note = mentionNote([own[0], agents[0], chats[1]], [...own, ...agents, ...chats]);
  assert.match(note, /delegate \{agent: "platform"\}/);
  assert.match(note, /network_ask \{agent: "karsara-kazemi-example-org"\}/);
  assert.match(note, /chatId "c2"/);
  assert.match(note, /chat_read/);
  assert.doesNotMatch(mentionNote([chats[0]]), /network_ask|delegate/);
});

test("spans: «@» tags cut out of the text, the rest kept as is", async () => {
  const { mentionSpans } = await import("../src/index.mjs");
  const spans = mentionSpans("@پلتفرم‌بان ببین و به @«دیسک نود node-3» بگو، ایمیل a@b.c نه");
  assert.deepEqual(spans.filter((s) => s.tag).map((s) => s.text), ["@پلتفرم‌بان", "@«دیسک نود node-3»"]);
  assert.equal(spans.map((s) => s.text).join(""), "@پلتفرم‌بان ببین و به @«دیسک نود node-3» بگو، ایمیل a@b.c نه");
  assert.deepEqual(mentionSpans("بدون تگ"), [{ text: "بدون تگ", tag: false }]);
  assert.deepEqual(mentionSpans(""), [{ text: "", tag: false }]);
  // Known handles only: a half-typed word is not a chip, an open «» is not either.
  assert.deepEqual(mentionSpans("@so و @یارا، @«باز", ["یارا"]).filter((s) => s.tag).map((s) => s.text), ["@یارا"]);
});
