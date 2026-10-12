// The sidebar's list rules (shared by both skins, merged with Griffin's owner grouping and tabs), the
// resizable width and the clipboard fallback.
import test from "node:test";
import assert from "node:assert/strict";
import { FILTERS, GROUPS, SORTS, ago, chatState, filterChats, groupChats, sortChats } from "../src/chat-list.js";
import { clampSidebarWidth, isPlainClick, loadSidebarWidth, SIDEBAR_WIDTH } from "../src/sidebar-width.js";
import { copyText } from "../src/copy.js";

const NOW = new Date("2026-10-07T12:00:00.000Z");
const chat = (id, extra = {}) => ({ id, title: id, updatedAt: "2026-10-07T10:00:00.000Z", runStatus: "finished", agent: "griffin", ...extra });
const seen = (ids) => (c) => !ids.includes(c.id); // unread unless listed
const shape = (sections) => sections.map((s) => [s.title, s.chats.map((c) => c.id)]);

test("chatState: asking the owner outranks running, then error, unread, read", () => {
  assert.equal(chatState(chat("a", { runStatus: "running" }), () => true).id, "running");
  assert.equal(chatState(chat("a", { runStatus: "running", waitingForOwner: true }), () => true).id, "ask");
  assert.equal(chatState(chat("a", { runStatus: "error" }), () => false).id, "error");
  assert.equal(chatState(chat("a"), () => true).id, "unread");
  assert.equal(chatState(chat("a"), () => false).id, "read");
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

test("ago: short relative time", () => {
  const now = NOW.getTime();
  assert.equal(ago(new Date(now - 20_000).toISOString(), now), "الان");
  assert.equal(ago(new Date(now - 5 * 60_000).toISOString(), now), "۵ دقیقه");
  assert.equal(ago(new Date(now - 3 * 3600_000).toISOString(), now), "۳ ساعت");
  assert.equal(ago(new Date(now - 4 * 86400_000).toISOString(), now), "۴ روز");
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
