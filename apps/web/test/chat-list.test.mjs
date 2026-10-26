// The sidebar's list rules (shared by both skins, merged with Griffin's owner grouping and tabs), the
// resizable width and the clipboard fallback.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { FILTERS, GROUPS, SORTS, ago, chatState, filterChats, groupChats, reminderLabel, sortChats } from "../src/chat-list.js";
import { clampSidebarWidth, isPlainClick, isSidebarToggle, loadSidebarHidden, loadSidebarWidth, SIDEBAR_WIDTH } from "../src/sidebar-width.js";
import { copyText } from "../src/copy.js";

const NOW = new Date("2026-10-07T12:00:00.000Z");
const chat = (id, extra = {}) => ({ id, title: id, updatedAt: "2026-10-07T10:00:00.000Z", runStatus: "finished", agent: "griffin", ...extra });
const seen = (ids) => (c) => !ids.includes(c.id); // unread unless listed
const shape = (sections) => sections.map((s) => [s.title, s.chats.map((c) => c.id)]);

test("chatState: asking the owner outranks running, then unread, read, error", () => {
  assert.equal(chatState(chat("a", { runStatus: "running" }), () => true).id, "running");
  // A background task it waits on (a watcher) wakes it again: still at work.
  assert.equal(chatState(chat("a", { runStatus: "finished", backgroundTasks: 1 }), () => false).id, "running");
  assert.equal(chatState(chat("a", { runStatus: "running", waitingForOwner: true }), () => true).id, "ask");
  assert.equal(chatState(chat("a", { runStatus: "error" }), () => false).id, "error");
  assert.equal(chatState(chat("a"), () => true).id, "unread");
  assert.equal(chatState(chat("a"), () => false).id, "read");
});

test("chatState: a kept message is a failure, not a question; a running subtask or a plan-limit wait is still work", () => {
  assert.equal(chatState(chat("a", { kept: ["k1"] }), () => false).id, "error");
  assert.equal(chatState(chat("a", { kept: ["k1"] }), () => false).failed, true);
  assert.equal(chatState(chat("a", { kept: [] }), () => false).id, "read");
  assert.equal(chatState(chat("a", { children: [{ id: "c", runStatus: "running" }] }), () => false).id, "running");
  assert.equal(chatState(chat("a", { children: [{ id: "c", runStatus: "finished" }] }), () => false).id, "read");
  assert.equal(chatState(chat("a", { limitResumeAt: Date.now() + 60_000 }), () => false).id, "running");
  // The plan limit kept the message: it goes again by itself at the reset, so it is work, not his.
  assert.equal(chatState(chat("a", { runStatus: "error", kept: ["k1"], limitResumeAt: Date.now() + 60_000 }), () => true).id, "running");
  assert.equal(chatState(chat("a", { kept: ["k1"], limitResumeAt: Date.now() + 60_000, waitingForOwner: true }), () => false).id, "ask");
  assert.equal(chatState(chat("a", { runStatus: "running", waitingForOwner: true, children: [{ id: "c", runStatus: "running" }] }), () => false).id, "ask");
});

test("filters: unread, ask, running, error, pinned; the open chat stays", () => {
  const list = [chat("u"), chat("r"), chat("run", { runStatus: "running" }), chat("ask", { waitingForOwner: true }), chat("pin", { pinned: true })];
  const isUnread = seen(["r", "pin", "ask", "run"]);
  const ids = (filter, opts) => filterChats(list, filter, isUnread, opts).map((c) => c.id);
  assert.deepEqual(ids("all"), ["u", "r", "run", "ask", "pin"]);
  assert.deepEqual(ids("unread"), ["u"]);
  assert.deepEqual(ids("ask"), ["ask"]);
  assert.deepEqual(ids("running"), ["run"]);
  assert.deepEqual(ids("pinned"), ["pin"]);
  assert.deepEqual(ids("unread", { keepId: "r" }), ["u", "r"]);
  assert.ok(!FILTERS.some((f) => f.id === "background"), "Claude-only background tasks are left out");
});

test("sorts: unread first keeps newest-first inside each half", () => {
  const list = [chat("old-unread", { updatedAt: "2026-10-01T00:00:00.000Z" }), chat("new-read"), chat("new-unread", { updatedAt: "2026-10-07T11:00:00.000Z" })];
  assert.deepEqual(sortChats(list, "unread", seen(["new-read"])).map((c) => c.id), ["new-unread", "old-unread", "new-read"]);
  assert.deepEqual(sortChats(list, "updated", seen([])).map((c) => c.id), ["new-unread", "new-read", "old-unread"]);
  assert.ok(SORTS.some((s) => s.id === "unread"));
});

test("groups: none puts running first, then pinned, then the rest", () => {
  const list = [chat("a"), chat("p", { pinned: true }), chat("r1", { runStatus: "running" }), chat("r2", { runStatus: "running", pinned: true })];
  assert.deepEqual(shape(groupChats(list, "none")), [["در حال اجرا (۲)", ["r1", "r2"]], ["سنجاق‌شده", ["p"]], [null, ["a"]]]);
});

test("groups: state, date, repo, owner and the owner's own groups", () => {
  const list = [
    chat("read"),
    chat("unread"),
    chat("ask", { waitingForOwner: true }),
    chat("run", { runStatus: "running" }),
    chat("yesterday", { updatedAt: "2026-10-06T08:00:00.000Z", repo: "griffin" }),
    chat("old", { updatedAt: "2026-09-01T08:00:00.000Z", repo: "griffin" }),
  ];
  const isUnread = seen(["read", "yesterday", "old", "ask"]);
  const opts = { isUnread, now: NOW, timeZone: "Asia/Tehran" };
  assert.deepEqual(shape(groupChats(list, "state", opts)), [
    ["منتظر پاسخ شما", ["ask"]],
    ["در حال کار", ["run"]],
    ["خوانده‌نشده", ["unread"]],
    ["خوانده‌شده", ["read", "yesterday", "old"]],
  ]);
  assert.deepEqual(shape(groupChats(list, "date", opts)), [["امروز", ["read", "unread", "ask", "run"]], ["دیروز", ["yesterday"]], ["قدیمی‌تر", ["old"]]]);
  assert.deepEqual(groupChats(list, "repo", opts).map((s) => s.title), ["griffin", "بدون مخزن"]);
  const owned = groupChats([chat("x", { ownerKey: "k", ownerLabel: "آقای احمدی" }), chat("y")], "owner", { scope: "telegram" });
  assert.deepEqual(owned.map((s) => [s.key, s.title, s.collapsible]), [["telegram:k", "آقای احمدی", true], ["telegram:none", "بدون صاحب", true]]);
  const custom = groupChats([chat("g", { groupId: "g1" }), chat("n")], "custom", { groups: [{ id: "g1", name: "سرچ" }] });
  assert.deepEqual(shape(custom), [["سرچ", ["g"]], ["بدون گروه", ["n"]]]);
  for (const id of ["none", "custom", "owner", "state", "read", "date", "agent", "repo", "model"]) assert.ok(GROUPS.some((g) => g.id === id), id);
});

test("errors never lead: a failure sinks last seen or not (keeping its unread dot), a resolved one is read", () => {
  const no = () => false;
  assert.deepEqual(chatState({ runStatus: "error" }, no), { id: "error", label: "خطادار", unread: false, failed: true });
  const unseen = chatState({ runStatus: "error" }, () => true);
  assert.equal(unseen.id, "error");
  assert.equal(unseen.unread, true);
  assert.equal(unseen.failed, true);
  const resolved = chatState({ runStatus: "resolved" }, no);
  assert.equal(resolved.id, "read");
  assert.equal(resolved.failed, false);

  const list = [
    chat("err-seen", { runStatus: "error" }),
    chat("read"),
    chat("err-new", { runStatus: "error" }),
    chat("resolved", { runStatus: "resolved" }),
    chat("unread"),
    chat("run", { runStatus: "running" }),
    chat("ask", { waitingForOwner: true }),
    chat("kid-runs", { children: [{ id: "k", runStatus: "running" }] }),
    chat("limit", { limitResumeAt: Date.now() + 60_000 }),
  ];
  const isUnread = (c) => ["err-new", "unread"].includes(c.id);
  assert.deepEqual(filterChats(list, "error", isUnread).map((c) => c.id), ["err-seen", "err-new"]);
  assert.deepEqual(shape(groupChats(list, "state", { isUnread })), [
    ["منتظر پاسخ شما", ["ask"]],
    ["در حال کار", ["run", "kid-runs", "limit"]],
    ["خوانده‌نشده", ["unread"]],
    ["خوانده‌شده", ["read", "resolved"]],
    ["خطادار", ["err-seen", "err-new"]],
  ]);
  const stamped = list.map((c, i) => ({ ...c, updatedAt: new Date(Date.parse("2026-10-07T10:00:00.000Z") - i * 60_000).toISOString() }));
  assert.deepEqual(sortChats(stamped, "state", isUnread).map((c) => c.id), ["ask", "run", "kid-runs", "limit", "unread", "read", "resolved", "err-seen", "err-new"]);
  assert.ok(SORTS.some((s) => s.id === "state"));
  assert.ok(!SORTS.some((s) => s.id === "running"));

  const none = groupChats([chat("a"), chat("kept", { runStatus: "error", kept: ["k"] }), chat("kid", { children: [{ id: "k", runStatus: "running" }] })], "none");
  assert.deepEqual(shape(none), [["در حال اجرا", ["kid"]], [null, ["a", "kept"]]]);

  // SQLite («2026-10-07 11:00:00», UTC) and ISO stamps compare as times, not strings.
  const mixed = [chat("iso", { updatedAt: "2026-10-07T10:00:00.000Z" }), chat("sqlite", { updatedAt: "2026-10-07 11:00:00" })];
  assert.deepEqual(sortChats(mixed, "updated", no).map((c) => c.id), ["sqlite", "iso"]);
});

test("a failed run with a kept message, or an unseen failure, never leads any view", () => {
  // The review's case: an error with a kept message from 08:00 beside a finished chat from 11:00.
  const err = chat("err", { runStatus: "error", kept: ["k1"], updatedAt: "2026-10-07T08:00:00.000Z" });
  const ok = chat("ok", { updatedAt: "2026-10-07T11:00:00.000Z" });
  const no = () => false;
  assert.equal(chatState(err, no).id, "error", "not «منتظر پاسخ شما»");
  for (const sort of ["updated", "state", "unread", "title"]) {
    assert.deepEqual(shape(groupChats(sortChats([err, ok], sort, no), "none", { isUnread: no })), [[null, ["ok", "err"]]], sort);
  }
  assert.deepEqual(sortChats([err, ok], "state", no).map((c) => c.id), ["ok", "err"]);
  assert.deepEqual(shape(groupChats([err, ok], "state", { isUnread: no })), [["خوانده‌شده", ["ok"]], ["خطادار", ["err"]]]);
  assert.deepEqual(filterChats([err, ok], "ask", no), []);
  assert.deepEqual(filterChats([err, ok], "error", no).map((c) => c.id), ["err"]);

  // Two failures he has not opened and one finished chat he has read: the read one still leads.
  const err2 = chat("err2", { runStatus: "error", updatedAt: "2026-10-07T11:30:00.000Z" });
  const newErr = (c) => c.id.startsWith("err");
  assert.deepEqual(shape(groupChats([err2, err, ok], "state", { isUnread: newErr })), [["خوانده‌شده", ["ok"]], ["خطادار", ["err2", "err"]]]);
  assert.deepEqual(sortChats([err2, err, ok], "state", newErr).map((c) => c.id), ["ok", "err2", "err"]);
  assert.deepEqual(shape(groupChats([err2, ok], "none", { isUnread: newErr })), [[null, ["ok", "err2"]]]);
  assert.equal(chatState(err2, newErr).unread, true, "the unread dot stays");

  // A pinned failure stays pinned, after the pinned chats that are fine.
  const pinErr = chat("pin-err", { runStatus: "error", pinned: true, updatedAt: "2026-10-07T11:59:00.000Z" });
  const pin = chat("pin", { pinned: true });
  assert.deepEqual(shape(groupChats([pinErr, pin, ok], "none", { isUnread: no })), [["سنجاق‌شده", ["pin", "pin-err"]], [null, ["ok"]]]);
});

test("ago: a row's time is a clock, not «۵ دقیقه» (exact time is the tooltip)", () => {
  const now = new Date(2026, 9, 13, 14, 30).getTime();
  const at = (d, h, m) => new Date(2026, 9, d, h, m).toISOString();
  const clock = (h, m) => new Date(2026, 9, 13, h, m).toLocaleTimeString("fa-IR", { hour: "2-digit", minute: "2-digit", hour12: false });
  assert.equal(ago(at(13, 14, 27), now), clock(14, 27));
  assert.equal(ago(at(12, 9, 5), now), `دیروز ${clock(9, 5)}`);
  assert.match(ago(at(1, 8, 0), now), new RegExp(`^\\S+ \\S+ ${clock(8, 0)}$`), "this year: day, month, clock");
  assert.doesNotMatch(ago(at(13, 14, 27), now), /پیش|دقیقه/);
  assert.equal(ago("nonsense", now), "");
});

test("sidebar width: clamped, half the window at most, the skin's start width when nothing is saved", () => {
  assert.equal(clampSidebarWidth(100), SIDEBAR_WIDTH.min);
  assert.equal(clampSidebarWidth(900), SIDEBAR_WIDTH.max);
  assert.equal(clampSidebarWidth(500, 800), 400);
  assert.equal(clampSidebarWidth("x", 800, 288), 288);
  assert.equal(loadSidebarWidth(null, 1600, SIDEBAR_WIDTH.karsara), 288);
  assert.equal(loadSidebarWidth({ getItem: () => "333" }, 1600), 333);
  assert.equal(isPlainClick({ button: 0 }), true);
  assert.equal(isPlainClick({ button: 1 }), false);
  assert.equal(isPlainClick({ button: 0, ctrlKey: true }), false);
});

test("Ctrl/⌘+B hides the sidebar on any layout; the choice survives blocked storage", () => {
  assert.equal(isSidebarToggle({ key: "b", ctrlKey: true }), true);
  assert.equal(isSidebarToggle({ key: "B", metaKey: true }), true);
  assert.equal(isSidebarToggle({ key: "ذ", code: "KeyB", ctrlKey: true }), true, "Persian layout: the physical key");
  assert.equal(isSidebarToggle({ key: "x", code: "KeyB", ctrlKey: true }), false, "Dvorak: Ctrl+X stays Cut");
  assert.equal(isSidebarToggle({ key: "b" }), false);
  assert.equal(isSidebarToggle({ key: "b", ctrlKey: true, repeat: true }), false);
  assert.equal(isSidebarToggle({ key: "b", ctrlKey: true, shiftKey: true }), false);
  assert.equal(loadSidebarHidden({ getItem: () => "1" }), true);
  assert.equal(loadSidebarHidden({ getItem: () => { throw new Error("blocked"); } }), false);
});

test("copyText falls back to a textarea when there is no clipboard API (plain HTTP)", async () => {
  const removed = [];
  const saved = { navigator: globalThis.navigator, document: globalThis.document };
  Object.defineProperty(globalThis, "navigator", { value: {}, configurable: true });
  globalThis.document = {
    createElement: () => ({ setAttribute() {}, style: {}, select() {}, remove() { removed.push(this.value); } }),
    body: { appendChild() {} },
    execCommand: (cmd) => cmd === "copy",
  };
  try {
    assert.equal(await copyText("سلام"), true);
    assert.deepEqual(removed, ["سلام"]);
    assert.equal(await copyText(""), false);
  } finally {
    Object.defineProperty(globalThis, "navigator", { value: saved.navigator, configurable: true });
    if (saved.document === undefined) delete globalThis.document;
    else globalThis.document = saved.document;
  }
});

test("sidebar search: a chat matches by title or by the server's message hits", async () => {
  const { searchChats } = await import("../src/chat-list.js");
  const list = [{ id: "a", title: "کلاستر" }, { id: "b", title: "بی‌عنوان" }, { id: "c", title: "دیگر" }];
  assert.deepEqual(searchChats(list, "کلاس").map((c) => c.id), ["a"]);
  assert.deepEqual(searchChats(list, "سرور", new Set(["b"])).map((c) => c.id), ["b"]);
  assert.deepEqual(searchChats(list, "  ").map((c) => c.id), ["a", "b", "c"]);
});

test("by repo (like Claude Desktop's folders), pinned chats stay on top", () => {
  const list = [{ id: "a", repo: "infra-repo" }, { id: "p", repo: "infra-repo", pinned: true }, { id: "b" }];
  assert.deepEqual(groupChats(list, "repo").map((s) => [s.title, s.chats.map((c) => c.id)]), [["سنجاق‌شده", ["p"]], ["infra-repo", ["a"]], ["بدون مخزن", ["b"]]]);
});

// Colleagues' agents' chats have no owner key; grouped by owner they all sat in «بدون صاحب» (owner 2026-10-20).
test("by owner: each colleague's agent gets its own section, named by the server's label", () => {
  const chats = [
    { id: "a", caller: "peer:sara-jafari", peerLabel: "آیدا جعفری", updatedAt: "2026-10-20T10:00:00Z" },
    { id: "b", caller: "peer:net-karsara-kazemi-example-org", peerLabel: "یارا (علیرضا کاظمی)", updatedAt: "2026-10-20T09:00:00Z" },
    { id: "c", caller: "peer:sara-jafari", peerLabel: "آیدا جعفری", updatedAt: "2026-10-20T08:00:00Z" },
    { id: "d", caller: "team", ownerKey: "person:7", ownerLabel: "آقای کریمی" },
    { id: "e", caller: "owner" },
  ];
  const sections = groupChats(chats, "owner", { scope: "peer" });
  assert.deepEqual(sections.map((s) => [s.title, s.chats.map((c) => c.id)]), [
    ["آیدا جعفری", ["a", "c"]],
    ["یارا (علیرضا کاظمی)", ["b"]],
    ["آقای کریمی", ["d"]],
    ["بدون صاحب", ["e"]],
  ]);
});

test("a chat with a reminder still to run gets a clock in both sidebars, like the question mark", () => {
  assert.match(reminderLabel(new Date().toISOString()), /^یادآور فعال · /);
  assert.equal(reminderLabel(null), "یادآور فعال");
  for (const file of ["Sidebar.jsx", "SidebarOneList.jsx"]) {
    const src = fs.readFileSync(new URL(`../src/components/${file}`, import.meta.url), "utf8");
    assert.match(src, /chat\.reminderAt \? [\s\S]{0,120}<BellRing /, file);
  }
});
