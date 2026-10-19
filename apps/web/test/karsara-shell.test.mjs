// The Karsara skin's shell: relative times in Persian digits, the Telegram inbox row, one list with
// job runs and the peers' chats folded, and counted group headers.
import test from "node:test";
import assert from "node:assert/strict";
import { agoPhrase, connectionRows, inboxRow, shortAgo } from "../src/karsara-shell.js";

const NOW = Date.parse("2026-10-15T12:00:00.000Z");
const min = (n) => new Date(NOW - n * 60_000).toISOString();

test("shortAgo: Karsara's «۵ دقیقه», not a clock time", () => {
  assert.equal(shortAgo(min(0), NOW), "الان");
  assert.equal(shortAgo(min(5), NOW), "۵ دقیقه");
  assert.equal(shortAgo(min(16 * 60), NOW), "۱۶ ساعت");
  assert.equal(shortAgo(min(3 * 24 * 60), NOW), "۳ روز");
  assert.equal(shortAgo(min(65 * 24 * 60), NOW), "۲ ماه");
  // SQLite's UTC form, and a stamp in seconds
  assert.equal(shortAgo("2026-10-15 11:55:00", NOW), "۵ دقیقه");
  assert.equal(shortAgo((NOW - 10 * 60_000) / 1000, NOW), "۱۰ دقیقه");
  assert.equal(shortAgo(null, NOW), "");
  assert.equal(shortAgo("not a date", NOW), "");
  assert.doesNotMatch(shortAgo(min(7), NOW), /[0-9]/, "no Latin digits");
});

test("agoPhrase: a stamp on its own reads «… پیش», never raw ISO", () => {
  assert.equal(agoPhrase(min(5), NOW), "۵ دقیقه پیش");
  assert.equal(agoPhrase(min(0), NOW), "الان");
  assert.equal(agoPhrase("2026-10-08T15:10:18.567Z", NOW), "۷ روز پیش");
});

test("inboxRow: only in inbox mode with a chat, badge in Persian digits", () => {
  assert.equal(inboxRow(null), null);
  assert.equal(inboxRow({ mode: "assistant", chatId: "c1", pending: 3 }), null);
  assert.equal(inboxRow({ mode: "inbox", chatId: null }), null);
  assert.deepEqual(inboxRow({ mode: "inbox", chatId: "c1", pending: 0 }), { chatId: "c1", title: "Telegram inbox", badge: null });
  assert.equal(inboxRow({ mode: "inbox", chatId: "c1", pending: 12 }).badge, "۱۲");
  assert.equal(inboxRow({ mode: "inbox", chatId: "c1", pending: 250 }).badge, "99+");
});

test("connectionRows: Karsara's «وضعیت اتصال‌ها» checklist from fast reads", () => {
  assert.deepEqual(connectionRows(), []);
  const rows = connectionRows({
    setup: { needsEngine: false },
    integrations: [
      { id: "tg", kind: "telegram_account", name: "سارا", enabled: true, status: { state: "connected" } },
      { id: "bot", kind: "telegram_bot", name: "b", enabled: true, status: { state: "error" } },
      { id: "bale", kind: "bale_bot", name: "", enabled: false },
    ],
    inbox: { mode: "inbox", chatId: "c" },
    mcp: { servers: [{ name: "a" }, { name: "b" }] },
  });
  assert.deepEqual(rows.map((r) => [r.id, r.level]), [
    ["engine", "ok"],
    ["integration:tg", "ok"],
    ["integration:bot", "warn"],
    ["integration:bale", "off"],
    ["inbox", "ok"],
    ["mcp", "ok"],
  ]);
  assert.equal(rows[1].subtitle, "وصل است · سارا");
  assert.equal(rows[5].subtitle, "۲ سرور ثبت شده");
  const missing = connectionRows({ setup: { needsEngine: true }, inbox: { mode: "assistant" } });
  assert.deepEqual(missing.map((r) => [r.id, r.level, r.action?.href]), [["engine", "warn", "#/setup/engine"]]);
});

test("Karsara skin's new chat page: centred blurb, setup card and composer, nothing under it (as Karsara)", async () => {
  const { readFileSync } = await import("node:fs");
  const thread = readFileSync(new URL("../src/components/Thread.jsx", import.meta.url), "utf8");
  const body = thread.slice(thread.indexOf("function ThreadBody("), thread.indexOf("function WelcomeHero("));
  assert.match(body, /const docked = showHero && !compact && homeBoard;/, "never docked with the board off (the Karsara preset)");
  const hero = thread.slice(thread.indexOf("function WelcomeHero("), thread.indexOf("const fadeUp ="));
  const karsara = hero.slice(hero.indexOf("if (!homeBoard) {"), hero.indexOf("// One tree whether"));
  const order = ["meta.blurb || meta.label", "<SetupCard />", "{composer}"].map((x) => karsara.indexOf(x));
  assert.ok(order.every((i) => i > 0), "blurb, setup card and composer are all there");
  assert.deepEqual([...order].sort((a, b) => a - b), order, "in Karsara's order");
  assert.doesNotMatch(karsara, /FoldedBoard/, "Karsara has no board on its new-chat page");
  assert.doesNotMatch(karsara, /board \? null : <h2/, "the blurb shows even when the board has items");
});

test("Karsara skin wiring: one list stays on screen for a job or peer chat; Settings opens on «وضعیت»", async () => {
  const { readFileSync } = await import("node:fs");
  const read = (f) => readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");
  const sidebar = read("components/Sidebar.jsx");
  assert.match(sidebar, /flags\.oneList && \(activeSource === "job" \|\| activeSource === "peer"\) \? "manual" : activeSource/);
  assert.match(sidebar, /const inboxChat = inboxOn && section === "manual" && !showArchived \? inboxRow/, "the inbox row only above the owner's own list");
  assert.match(sidebar, /timeAgo \? shortAgo\(/, "rows show «۵ دقیقه» with «زمان به‌صورت «… پیش»»");
  const settings = read("components/Settings.jsx");
  const readSection = settings.slice(settings.indexOf("const readSection ="), settings.indexOf("export function SettingsPage"));
  assert.match(readSection, /const first = karsara \? "status" : "health";/);
  assert.match(readSection, /if \(karsara\) localStorage\.removeItem\("griffin\.settings\.section"\);/, "an asked-for section is taken once");
  assert.match(settings, /\{ id: "status",[^\n]*karsaraOnly: true \}/, "«وضعیت» is a Karsara-skin tab only");
});
