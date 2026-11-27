// A setting offered from how the owner works (settings-nudges.mjs): plain signals of the last week in the
// owner's own chats, at most one card a week, never one click for a careful setting, quiet after «بعداً».
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openStore } from "../src/db.mjs";
import { CONFIG_SCHEMA } from "../src/config.mjs";
import { settingsCatalog } from "../../web/src/settings-catalog.js";
import { resolvePrefs } from "../../web/src/ui-flags.js";
import { GAP_DAYS, QUIET_DAYS, countSignals, createSettingsNudges, pickNudge } from "../src/settings-nudges.mjs";

const DAY = 86_400_000;
const NOW = Date.parse("2026-11-23T10:00:00Z");
const entries = (values = {}) => settingsCatalog({ rows: CONFIG_SCHEMA.map((c) => ({ key: c.key, value: values[c.key] || "", effective: values[c.key] || "" })), prefs: resolvePrefs(null, "griffin") });

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nudge-"));
  const store = openStore(path.join(dir, "t.sqlite"));
  const insert = store.db.prepare("INSERT INTO events (chat_id, run_id, type, data, at) VALUES (?, ?, ?, ?, ?)");
  const add = (chatId, type, data, at, runId = null) => insert.run(chatId, runId, type, JSON.stringify(data), new Date(at).toISOString());
  return { store, add, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test("signals count the owner's own chats of the last week only", () => {
  const { store, add, done } = fixture();
  const mine = store.createChat({ title: "mine" });
  const theirs = store.createChat({ title: "theirs", caller: "telegram:42" });
  const isOwnChat = (chat) => chat?.caller === "owner";
  // An old week: none of it counts.
  for (let i = 0; i < 6; i += 1) add(mine.id, "run.phase", { phase: "limited" }, NOW - 9 * DAY + i, `old${i}`);
  // This week: three limited runs (one twice), two quick seconds, one queued message, one reminder.
  for (const run of ["r1", "r2", "r3", "r3"]) add(mine.id, "run.phase", { phase: "limited" }, NOW - DAY, run);
  add(mine.id, "user", { text: "اول" }, NOW - 2 * DAY);
  add(mine.id, "user", { text: "بقیه‌اش" }, NOW - 2 * DAY + 5_000);
  add(mine.id, "user", { text: "و این", intent: "queue" }, NOW - 2 * DAY + 12_000);
  add(mine.id, "user", { text: "یادآور", intent: "queue", from: { kind: "reminder" } }, NOW - 2 * DAY + 14_000);
  add(mine.id, "user", { text: "فردا" }, NOW - DAY);
  // A colleague's chat: never counted.
  for (const run of ["t1", "t2", "t3", "t4"]) add(theirs.id, "run.phase", { phase: "limited" }, NOW - DAY, run);
  add(theirs.id, "user", { text: "a", intent: "queue" }, NOW - DAY);
  assert.deepEqual(countSignals({ store, isOwnChat, now: NOW }), { limit: 3, double: 2, queued: 1 });
  done();
});

test("a card only when the signal is over its bar, one click may do it, and it is not already that way", () => {
  const state = { shown: null, quiet: {} };
  assert.equal(pickNudge({ counts: { limit: 2 }, entries: entries({ AUTO_CONTINUE: "off" }), state, now: NOW }), null);
  const card = pickNudge({ counts: { limit: 3 }, entries: entries({ AUTO_CONTINUE: "off" }), state, now: NOW });
  assert.equal(card.id, "set:AUTO_CONTINUE");
  assert.equal(card.value, "on");
  assert.match(card.why, /۳|3/);
  // Already on (the default): nothing to offer.
  assert.equal(pickNudge({ counts: { limit: 9 }, entries: entries(), state, now: NOW }), null);
  // «پیام وسط کار» hangs on Claude Code کامل (careful): with that off there is no one-click card.
  assert.equal(pickNudge({ counts: { queued: 9 }, entries: entries({ CLAUDE_CODE: "off", CLAUDE_STEER: "off" }), state, now: NOW }), null);
  assert.equal(pickNudge({ counts: { double: 6 }, entries: entries(), state, now: NOW }).id, "set:ENTER_KEY");
});

test("at most one a week, and «بعداً» keeps that one quiet for two months", () => {
  const { store, add, done } = fixture();
  const chat = store.createChat({ title: "mine" });
  for (const run of ["r1", "r2", "r3"]) add(chat.id, "run.phase", { phase: "limited" }, NOW - DAY, run);
  let clock = NOW;
  let on = true;
  const nudges = createSettingsNudges({ store, catalog: () => entries({ AUTO_CONTINUE: "off" }), isOwnChat: () => true, enabled: () => on, now: () => clock });
  assert.equal(nudges.current(), null);
  assert.equal(nudges.refresh().id, "set:AUTO_CONTINUE");
  assert.equal(nudges.current().rule, "limit");
  clock += DAY;
  assert.equal(nudges.refresh(), null, "a week has not passed");
  assert.equal(nudges.close("limit", "later"), true);
  assert.equal(nudges.current(), null);
  clock = NOW + (GAP_DAYS + 1) * DAY;
  for (const run of ["s1", "s2", "s3"]) add(chat.id, "run.phase", { phase: "limited" }, clock - DAY, run);
  assert.equal(nudges.refresh(), null, "put off: quiet");
  clock = NOW + (QUIET_DAYS + 1) * DAY;
  for (const run of ["u1", "u2", "u3"]) add(chat.id, "run.phase", { phase: "limited" }, clock - DAY, run);
  assert.equal(nudges.refresh().rule, "limit");
  on = false;
  assert.equal(nudges.current(), null, "SETTINGS_NUDGES off: nothing shows");
  done();
});
