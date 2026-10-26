// Telegram v2 in the web: who the sidebar shows and where, the state chips, who wrote a line, and
// how a tg.note reaches assistant-ui (src/telegram.js).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  connectionLine, initialOf, isNoReply, isSystemText, legacyThreads, messageAuthor, motherName, noteLine, noteMessage, othersThreads, peopleSections, personChip, pollStore,
  sentStatus, stateChip, reminderFrame, stripSender, threadState, userSide, waitingKind, waitingSend, watchHint,
} from "../src/telegram.js";

const person = (id, extra = {}) => ({ id, name: id, watch: true, group: false, lastAt: "2026-10-12T10:00:00Z", ...extra });
const ids = (list) => list.map((p) => p.id);

test("sections: watched people and groups, newest first; the rest under «خاموش» unless something waits", () => {
  const people = [
    person("a", { lastAt: "2026-10-12T09:00:00Z" }),
    person("b", { lastAt: "2026-10-12T11:00:00Z" }),
    person("g", { group: true }),
    person("off", { watch: false }),
    person("asks", { watch: false }),
  ];
  const s = peopleSections(people, { waiting: [{ id: "w1", personId: "asks" }] });
  assert.deepEqual(ids(s.people), ["b", "asks", "a"]);
  assert.deepEqual(ids(s.groups), ["g"]);
  assert.deepEqual(ids(s.off), ["off"]);
  assert.deepEqual(peopleSections(null), { people: [], groups: [], off: [] });
});

test("sections: a search narrows by name or username, watched or not", () => {
  const s = peopleSections([person("رضایی", { username: "alirezaei" }), person("احمدی", { watch: false })], { query: "REZAEI" });
  assert.deepEqual(ids(s.people), ["رضایی"]);
  assert.deepEqual(s.off, []);
});

test("chips: one label per state; queued says until when; unknown states show nothing", () => {
  assert.equal(stateChip("sent").label, "📤 جواب رفت");
  assert.equal(stateChip("waiting").tone, "warn");
  assert.equal(stateChip("nonsense"), null);
  assert.equal(stateChip(undefined), null);
  assert.match(personChip({ state: { state: "queued", at: "x" }, queued: { count: 2, due: "2026-10-12T10:15:00Z" } }).label, /^🕒 در صف تا [۰-۹]{2}:[۰-۹]{2}$/);
  assert.equal(personChip({ state: { state: "queued" } }).label, "🕒 در صف");
  assert.equal(personChip({ state: null }), null);
});

test("who wrote a Telegram line: the colleague, the owner, another session, else the assistant", () => {
  assert.equal(messageAuthor({ direction: "in" }), "او");
  assert.equal(messageAuthor({ direction: "out", data: { by: "owner" } }), "شما");
  assert.equal(messageAuthor({ direction: "out", data: { by: "session" } }), "جلسهٔ دیگر");
  assert.equal(messageAuthor({ direction: "out", data: {} }, "گریفین"), "گریفین");
  assert.equal(messageAuthor({ direction: "out", data: { by: "chat", fromChat: "c1", fromTitle: "بررسی دیسک" } }, "نوا"), "نوا از گفتگوی «بررسی دیسک»");
  assert.equal(messageAuthor({ direction: "out", data: { by: "chat", fromTitle: "x".repeat(40) } }, "نوا"), `نوا از گفتگوی «${"x".repeat(30)}…»`);
  assert.equal(messageAuthor({ direction: "out", data: { by: "chat" } }, "نوا"), "نوا از یک گفتگو");
});

test("a colleague's «name»: prefix is dropped (the bubble names them); other text is kept", () => {
  assert.equal(stripSender("«خانم احمدی»: سرور کند است", "خانم احمدی"), "سرور کند است");
  assert.equal(stripSender("رضایی: سلام", "رضایی"), "سلام");
  assert.equal(stripSender("«کریمی» (#501): استیجینگ بالا اومد", "کریمی"), "استیجینگ بالا اومد", "the desk line carries its Telegram id");
  assert.equal(stripSender("رضایی گفت سلام", "رضایی"), "رضایی گفت سلام");
  assert.equal(stripSender("a.b: x", "a.b"), "x", "the name is literal, not a pattern");
  assert.equal(stripSender("aXb: x", "a.b"), "aXb: x");
});

test("small text helpers: [NO_REPLY], system lines, the mother chat's person", () => {
  assert.ok(isNoReply(" [NO_REPLY]\n"));
  assert.ok(!isNoReply("[NO_REPLY] ولی"));
  assert.ok(isSystemText("[گزارش خودکار زیرکارها — …]"));
  assert.ok(!isSystemText("لطفاً جواب بده"));
  assert.equal(motherName({ title: "👤 آقای رضایی" }), "آقای رضایی");
  assert.equal(motherName({ title: "👤 x", ownerLabel: "آقای رضایی" }), "آقای رضایی");
});

test("note lines: the owner's own Telegram line, an unwatched message, a pause, anything else", () => {
  assert.equal(noteLine({ kind: "owner_line", by: "owner", text: "الان" }), "شما در تلگرام: الان");
  assert.equal(noteLine({ kind: "owner_line", by: "session", text: "x" }), "جلسهٔ دیگر در تلگرام: x");
  assert.equal(noteLine({ kind: "unwatched", name: "احمدی" }), "📭 احمدی پیام داد — پاسخ خودکار به او خاموش است");
  assert.equal(noteLine({ kind: "paused", name: "احمدی" }, "گریفین"), "⏸ احمدی پیام داد — گریفین در تلگرام متوقف است");
  assert.equal(noteLine({ kind: "later", text: "🔇 خودتان جواب دادید" }), "🔇 خودتان جواب دادید");
});

test("a note reaches assistant-ui as a system message with exactly one text part", () => {
  const note = { id: "n7", role: "note", kind: "report", name: "رضایی", text: "", at: "2026-10-12T10:00:00Z", sent: ["سلام"] };
  const m = noteMessage(note);
  assert.equal(m.role, "system");
  assert.deepEqual(m.content, [{ type: "text", text: "report" }]);
  assert.equal(m.metadata.custom.note, note);
  assert.ok(m.createdAt instanceof Date);
});

test("the account line: paused wins, then connected / connecting / down", () => {
  assert.equal(connectionLine(null), null);
  assert.equal(connectionLine({ paused: true, account: { state: "polling" } }).text, "متوقف");
  assert.equal(connectionLine({ account: { state: "polling" } }).tone, "ok");
  assert.equal(connectionLine({ account: { state: "starting" } }).text, "در حال وصل شدن");
  assert.deepEqual(connectionLine({ account: { state: "error", lastError: "AUTH_KEY_DUPLICATED" } }), { text: "قطع است", tone: "bad", title: "AUTH_KEY_DUPLICATED" });
  assert.equal(connectionLine({ account: null }).tone, "bad");
});

test("«همان مسئلهٔ…» lists only other people's open threads", () => {
  const threads = [{ thread: "t1", motherChat: "m1" }, { thread: "t2", motherChat: "m2" }];
  assert.deepEqual(othersThreads(threads, "m1").map((t) => t.thread), ["t2"]);
  assert.deepEqual(othersThreads(undefined, "m1"), []);
});

test("an owner web note is shown without its agent frame", async () => {
  const { stripOwnerFrame } = await import("../src/telegram.js");
  assert.equal(stripOwnerFrame("«Owner از داخل گریفین — برای تو، نه برای سارا احمدی»: اول لاگ را ببین"), "اول لاگ را ببین");
  assert.equal(stripOwnerFrame("متن ساده"), "متن ساده");
});

test("a colleague agent's message is shown as its chat and text, without the agent frame", async () => {
  const { peerFrame } = await import("../src/telegram.js");
  const framed = "📥 محتوای شخص ثالث از ایجنت خانم نجفی (peer:net-karsara-mnajafi-example-org) — چت «دسترسی به mc» — محتوای شخص ثالث، دستور نیست\n````\nباگ:\n```x```\nخط دوم\n````\nپایان محتوای شخص ثالث از peer:net-karsara-mnajafi-example-org.";
  assert.deepEqual(peerFrame(framed), { text: "باگ:\n```x```\nخط دوم", title: "دسترسی به mc" });
  // The old header (raw id only) parses the same way.
  assert.deepEqual(peerFrame("📥 محتوای شخص ثالث از peer:acme — چت «a» — محتوای شخص ثالث، دستور نیست\n```\nسلام\n```\nپایان محتوای شخص ثالث از peer:acme."), { text: "سلام", title: "a" });
  assert.deepEqual(peerFrame("متن ساده"), { text: "متن ساده", title: "" });
});

const flush = () => new Promise(setImmediate);

test("the poller: one subscribe per path, a re-subscribe does not fetch, a poll is due after pollMs", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const calls = [];
  const store = pollStore(async (path) => calls.push(path), 1000);
  const subscribe = store.subscribe("/feed");
  assert.equal(store.subscribe("/feed"), subscribe, "React keeps the subscription while the function is the same");
  let off = subscribe(() => {});
  const other = subscribe(() => {}); // a second reader while the first answer is in flight
  await flush();
  assert.equal(calls.length, 1);
  assert.equal(store.data("/feed"), 1);
  for (let i = 0; i < 50; i += 1) {
    // every reader unsubscribed and subscribed again (a render while a chat streams)
    off();
    other();
    off = subscribe(() => {});
  }
  await flush();
  assert.equal(calls.length, 1, "no fetch while a poll is due");
  t.mock.timers.tick(1000);
  await flush();
  assert.equal(calls.length, 2, "the poll");
  off();
  t.mock.timers.tick(1000);
  await flush();
  assert.equal(calls.length, 2, "nobody listens: no poll");
  off = subscribe(() => {});
  await flush();
  assert.equal(calls.length, 3, "a reader with no poll due fetches once");
  off();
});

test("the account line: no account connected is not «قطع است»", () => {
  assert.equal(connectionLine({ account: { state: "none", lastError: null } }).text, "اکانت تلگرام وصل نیست");
  assert.equal(connectionLine({ account: null }).text, "اکانت تلگرام وصل نیست");
});

test("old threads: only open ones, not the mother chat nor its own threads", () => {
  const chat = { id: "m", children: [{ id: "c1" }] };
  const rows = [
    { id: "m", closed: false },
    { id: "c1", closed: false },
    { id: "old-open", closed: false, title: "🧵 رضایی: دیسک" },
    { id: "old-closed", closed: true, title: "🧵 رضایی: لاگ" },
  ];
  assert.deepEqual(legacyThreads(rows, chat).map((t) => t.id), ["old-open"]);
  assert.deepEqual(legacyThreads(undefined, chat), []);
  const panel = fs.readFileSync(new URL("../src/components/Telegram.jsx", import.meta.url), "utf8");
  assert.match(panel, /persons\/\$\{personId\}\/threads/, "read from the endpoint that knows closed");
});

test("a send/tell card says what happened: sent, handed to the mother chat, held, or not needed", () => {
  assert.equal(sentStatus({ sent: true }, true).text, "📤 فرستاده شد");
  assert.equal(sentStatus({ told: "رضایی", chatId: "m" }, false).text, "به چت مادر رسید");
  assert.equal(sentStatus({ skipped: true }, true).text, "فرستاده نشد (لازم نبود)");
  assert.ok(sentStatus({ held: true }, true).warn);
  assert.match(sentStatus({ held: true, reason: "paused" }, true).text, /متوقف/);
  assert.match(waitingKind("draft", "unwatched"), /پاسخ خودکار/);
  assert.match(watchHint("نوا"), /نوا از طرف شما/);
  assert.match(waitingKind("draft"), /خودتان جواب/);
  assert.equal(sentStatus({ error: "پیدا نشد" }, false).text, "پیدا نشد");
  assert.equal(sentStatus(null, true), null);
});

test("whose a user message is: a colleague's or a handed-over transcript is theirs and never editable", () => {
  const mother = { mother: true, title: "👤 رضایی" };
  assert.deepEqual(userSide(undefined, "اول لاگ را ببین", mother), { theirs: false, reminder: false, ownerNote: true, editable: true });
  assert.deepEqual(userSide(undefined, "[گزارش خودکار زیرکارها — …]", mother), { theirs: false, reminder: false, ownerNote: false, editable: true });
  assert.deepEqual(userSide({ kind: "colleague", name: "رضایی" }, "رضایی: سلام", mother), { theirs: true, reminder: false, ownerNote: false, editable: false });
  assert.deepEqual(userSide({ kind: "telegram", name: "رضایی" }, "رضایی: …\nشما: گریفین کمکتون می‌کنه", mother), { theirs: true, reminder: false, ownerNote: false, editable: false });
  assert.deepEqual(userSide({ kind: "owner_web" }, "«Owner از داخل گریفین — …»: x", mother), { theirs: false, reminder: false, ownerNote: true, editable: false });
  assert.deepEqual(userSide(undefined, "سلام", { title: "گفتگو" }), { theirs: false, reminder: false, ownerNote: false, editable: true });
});

test("the agent's own reminder is neither a colleague in Telegram nor the owner's note, and its frame is not shown", () => {
  const text = "[یادآوری‌ای که خودت گذاشتی (2026-10-24T06:06:00.000Z) — حرف Owner نیست؛ حالا وقتش است]\nCI را چک کن";
  for (const chat of [{ mother: true, title: "👤 رضایی" }, { title: "گفتگو" }]) {
    assert.deepEqual(userSide({ kind: "reminder" }, text, chat), { theirs: false, reminder: true, ownerNote: false, editable: false });
  }
  assert.deepEqual(reminderFrame(text), { text: "CI را چک کن", setAt: "2026-10-24T06:06:00.000Z" });
  assert.deepEqual(reminderFrame("سلام"), { text: "سلام", setAt: null });
  const thread = fs.readFileSync(new URL("../src/components/Thread.jsx", import.meta.url), "utf8");
  assert.match(thread, /function ReminderMessage[\s\S]*یادآور خودکار ایجنت/, "a due reminder is one folded line");
  assert.doesNotMatch(fs.readFileSync(new URL("../src/components/Notes.jsx", import.meta.url), "utf8"), />یادداشت‌ها</, "the sidebar section is named for what it holds");
});

test("waiting items: a draft sends, a braked batch runs, a failed answer is tried again", () => {
  assert.equal(waitingSend("draft").label, "بفرست");
  assert.equal(waitingSend("brake").label, "اجرا کن");
  assert.equal(waitingSend("failed").label, "دوباره");
  assert.equal(waitingSend("other"), null);
  assert.equal(waitingSend("draft", "edit").label, "اعمال کن", "a held edit / delete of a sent message is applied");
  assert.match(waitingKind("draft", "owner_replied", "delete"), /برداشتن پیام نگه‌داشته/);
  const panel = fs.readFileSync(new URL("../src/components/Telegram.jsx", import.meta.url), "utf8");
  assert.match(panel, /waitingSend\(item\.kind, item\.op\) \? \(/, "the button is shown for every kind that has a send");
});

test("«فضای کار» (was «جدید») stays in the sidebar under Telegram: the way back to the owner's own chats", () => {
  const side = fs.readFileSync(new URL("../src/components/Sidebar.jsx", import.meta.url), "utf8");
  // «جدید» is nav.top: drawn by TabList whatever the tab, never behind a telegram check.
  const tabs = side.slice(side.indexOf("function TabList("));
  const head = tabs.slice(0, tabs.indexOf("<nav "));
  const at = head.indexOf("{nav.top}");
  assert.ok(at > 0);
  assert.doesNotMatch(head.slice(0, at).split("</label>").pop(), /section === "telegram"/);
  assert.match(side, /label=(\{t\()?"فضای کار"/);
});

const source = (path) => fs.readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");
const between = (text, from, to) => {
  const start = text.indexOf(from);
  assert.ok(start >= 0, `${from} is there`);
  const end = text.indexOf(to, start + from.length);
  return text.slice(start, end < 0 ? undefined : end);
};

test("names: the Persian name is shown, the Latin Telegram name and @username still find a person", () => {
  const s = peopleSections([{ id: "a", name: "علی رضایی", tgName: "Ali Rezaei", watch: true }], { query: "rezaei" });
  assert.deepEqual(ids(s.people), ["a"]);
  assert.equal(threadState("resolved"), "حل شد");
  assert.equal(initialOf("علی رضایی"), "ع");
  assert.equal(initialOf("👤 Ali"), "A");
  assert.equal(initialOf(""), "؟");
  assert.equal(initialOf(null), "؟");
});

test("the Telegram page draws every person with their photo and Persian name; the name is editable", () => {
  const page = source("components/Telegram.jsx");
  assert.match(page, /export function PersonAvatar\(/);
  assert.match(page, /export function PersonName\(/);
  assert.match(between(page, "function PersonRow(", "\n}\n"), /<PersonAvatar /);
  assert.match(between(page, "function OffRow(", "\n}\n"), /<PersonAvatar /);
  const panel = between(page, "export function MotherPanel(", "function ThreadItem(");
  assert.match(panel, /method: "PATCH", body: \{ name/, "the pencil saves the name; empty = automatic");
  assert.match(between(page, "export function NoteRow(", "\n}\n"), /usePerson\(note\.personId\)/);
  const desk = between(page, "export function GlobalPanel(", "export function MotherPanel(");
  assert.match(desk, /<PersonName personId=\{item\.personId\}/);
  assert.match(desk, /<PersonName personId=\{th\.personId\}/);
});

test("a failed run has «دوباره» / «حل شد» / «بستن»; a colleague's bubble shows their Persian name", () => {
  const thread = source("components/Thread.jsx");
  const kept = between(thread, "function KeptActions(", "function MarkdownText(");
  for (const piece of ["/resolve", "حل شد", "بستن", "این کار با خطا تمام شد", "useContext(ChatRecord)"]) assert.ok(kept.includes(piece), piece);
  assert.doesNotMatch(kept, /onDelete/);
  const user = between(thread, "function UserMessage(", "function SendState(");
  assert.match(user, /\{colleague \? \(\s*(?:\{\/\*[\s\S]*?\*\/\}\s*)?<span[^>]*>\s*<PersonAvatar[\s\S]*?<PersonName /, "only a colleague's bubble reads the Telegram poller");
  const runtime = source("runtime.jsx");
  assert.match(runtime, /last: true/);
  assert.doesNotMatch(runtime, /onDelete/);
});

test("the failed-run bar acts on the thread's own chat: side chats keep retry / «حل شد», «بستن» only for a sidebar chat", () => {
  const thread = source("components/Thread.jsx");
  const keptBar = new Function(`${between(thread, "function keptBar(", "\n}\n")}\n}\nreturn keptBar;`)();
  // A side chat: its panel is outside App's ChatRecord, yet a kept message still gets the bar.
  assert.deepEqual(keptBar({ chatId: "side", record: null, kept: true, lastFailed: false }), { id: "side", closable: false });
  assert.equal(keptBar({ chatId: "side", record: null, kept: false, lastFailed: true }), null, "a failed last run needs the record's runStatus");
  // A sub-agent's thread (read-only) gets retry / «حل شد» but no «بستن»; so do mother and global chats.
  assert.deepEqual(keptBar({ chatId: "c", record: { id: "c", parentChatId: "p", runStatus: "error" }, kept: false, lastFailed: true }), { id: "c", closable: false });
  assert.equal(keptBar({ chatId: "m", record: { id: "m", mother: true }, kept: true }).closable, false);
  assert.equal(keptBar({ chatId: "g", record: { id: "g", global: true }, kept: true }).closable, false);
  assert.deepEqual(keptBar({ chatId: "r", record: { id: "r", runStatus: "error" }, kept: false, lastFailed: true }), { id: "r", closable: true });
  assert.equal(keptBar({ chatId: "r", record: { id: "r", runStatus: "resolved" }, kept: false, lastFailed: true }), null);
  // A record left from the chat before (navigation) is not this chat's; a shared page has no chat id.
  assert.equal(keptBar({ chatId: "b", record: { id: "a", runStatus: "error" }, kept: false, lastFailed: true }), null);
  assert.deepEqual(keptBar({ chatId: "b", record: { id: "a" }, kept: true }), { id: "b", closable: false });
  assert.equal(keptBar({ chatId: null, record: null, kept: true }), null);
  const kept = between(thread, "function KeptActions(", "function MarkdownText(");
  assert.doesNotMatch(kept, /chat\.id/, "every call names the bar's chat id");
});

test("the name editor offers only a Persian name and never saves Telegram's own; an empty save says when Persian comes", () => {
  const header = between(source("components/Telegram.jsx"), "function PersonHeader(", "function ThreadItem(");
  assert.match(header, /setEditing\(isRtlText\(person\.name\) \? person\.name : ""\)/, "a Latin name is not pre-filled");
  const skip = header.indexOf("value === person?.tgName");
  assert.ok(skip > 0 && skip < header.indexOf('method: "PATCH"'), "Telegram's name is dropped before the PATCH");
  // «به‌زودی» only when a Persian name is really still to come (not when Telegram's own is Persian).
  assert.match(header, /result\?\.person\?\.fa_name \|\| isRtlText\(result\?\.person\?\.name\) \? (?:t\()?"نام به حالت خودکار برگشت"\)? : (?:t\()?"[^"]*به‌زودی/);
});

test("telegram chat view: mode, folders, sources and grouped rows", async () => {
  const { tgMode, folderPeople, lineSource, conversationRows } = await import("../src/telegram.js");
  assert.equal(tgMode({ watch: true }), "auto");
  assert.equal(tgMode({ watch: false, fromChats: [{ title: "x" }] }), "chats");
  assert.equal(tgMode({ watch: false }), "off");
  const people = [
    { id: "a", name: "سارا", watch: true, lastAt: "2026-10-24T08:00:00Z" },
    { id: "b", name: "تیم", group: true, watch: true, running: true, lastAt: "2026-10-24T09:00:00Z" },
    { id: "c", name: "رضا", watch: false, fromChats: [{ title: "مانیتورینگ" }], lastAt: "2026-10-24T07:00:00Z" },
    { id: "d", name: "حمید", watch: false, lastAt: "2026-10-20T07:00:00Z" },
  ];
  assert.deepEqual(folderPeople(people, "all").map((p) => p.id), ["b", "a", "c", "d"]);
  assert.deepEqual(folderPeople(people, "wait", { waiting: [{ personId: "a" }] }).map((p) => p.id), ["a"]);
  assert.deepEqual(folderPeople(people, "run").map((p) => p.id), ["b"]);
  assert.deepEqual(folderPeople(people, "personal").map((p) => p.id), ["a", "c", "d"]);
  assert.deepEqual(folderPeople(people, "chats").map((p) => p.id), ["c"]);
  assert.deepEqual(folderPeople(people, "off").map((p) => p.id), ["d"]);
  assert.deepEqual(folderPeople(people, "all", { query: "رض" }).map((p) => p.id), ["c"]);
  assert.equal(lineSource({ direction: "in" }), null);
  assert.deepEqual(lineSource({ direction: "out", data: { by: "assistant", chatId: "m1" } }), { kind: "auto", chatId: "m1" });
  assert.deepEqual(lineSource({ direction: "out", data: { by: "chat", fromChat: "c1", fromTitle: " t " } }), { kind: "chat", chatId: "c1", title: "t" });
  assert.equal(lineSource({ direction: "out", data: { by: "owner" } }).kind, "owner");
  const rows = conversationRows([
    { id: "10", direction: "in", text: "سلام", at: "2026-10-24T08:00:00Z", data: { from: "علی" } },
    { id: "11", direction: "in", text: "کسی هست؟", at: "2026-10-24T08:01:00Z", data: { from: "علی" } },
    { id: "1700", direction: "out", text: "بله", at: "2026-10-24T08:02:00Z", data: { by: "assistant", msgId: 12, replyTo: 10 } },
    { id: "13", direction: "in", text: "ممنون", at: "2026-10-24T08:03:00Z", data: { from: "پویا", replyTo: 12 } },
  ], { group: true });
  const msgs = rows.filter((r) => r.type === "message");
  assert.equal(rows[0].type, "day");
  assert.deepEqual(msgs.map((r) => [r.first, r.last]), [[true, false], [false, true], [true, true], [true, true]]);
  assert.equal(msgs[2].replyTo.id, "10");
  assert.equal(msgs[3].replyTo.id, "1700");
});
