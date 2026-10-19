import { test } from "node:test";
import assert from "node:assert/strict";
import { engineAlerts } from "../src/host-health.js";
import { chatIdOf, feedbackPayload, recentErrors, recordError } from "../src/feedback.js";
import { groupChats } from "../src/chat-list.js";
import { layoutChats } from "../src/karsara-chat-list.js";

const NOW = Date.parse("2026-10-18T12:00:00Z");

test("the sidebar says which engine is at its limit (and until when), out of credit, or that none is usable", () => {
  assert.deepEqual(engineAlerts(null), []);
  assert.deepEqual(engineAlerts({ engines: [], usable: true }), []);
  const lines = engineAlerts({ usable: false, engines: [{ id: "claude", name: "Claude", state: "limited", until: NOW + 3600_000 }, { id: "claude-2", name: "Claude · 2", state: "credit" }] }, NOW);
  // Orange for a limit or a spent credit, red only when nothing works; the headline names no account.
  assert.deepEqual(lines.map((a) => [a.key, a.level]), [["engines:none", "danger"], ["engine:claude", "warn"], ["engine:claude-2", "warn"]]);
  assert.equal(lines[1].text, "یکی از اکانت‌های شما به سقف مصرف رسیده است");
  assert.match(lines[1].detail, /حساب Claude به سقف مصرف ۵ ساعته رسیده/);
  assert.match(lines[2].detail, /اعتبار \(Credit\) حساب Claude · 2 تمام شده/);
});

test("a feedback report carries the page, the open chat, the browser and this page's last errors", () => {
  const first = new Error("first");
  recordError(first);
  recordError(first); // the same line twice in a row is kept once
  recordError("second");
  assert.equal(recentErrors().length, 2);
  const win = { location: { hash: "#/c/abc123" }, innerWidth: 390, innerHeight: 800 };
  const body = feedbackPayload({ text: " کند است ", kind: "support", version: "index-x.js", win, nav: { userAgent: "UA" } });
  assert.deepEqual({ ...body, errors: body.errors.length }, { text: "کند است", kind: "support", version: "index-x.js", browser: "UA", viewport: "390x800", page: "#/c/abc123", chatId: "abc123", errors: 2 });
  assert.equal(chatIdOf("#/settings"), "");
});

test("grouped by repository, each repo section names its repo (for its «+»); the no-repo one does not", () => {
  const chats = [{ id: "1", repo: "griffin" }, { id: "2", repo: "" }];
  for (const sections of [groupChats(chats, "repo"), layoutChats(chats, "repo", { isUnread: () => false })]) {
    const repo = sections.find((s) => s.key === "repo:griffin");
    assert.equal(repo.repo, "griffin");
    assert.equal(sections.find((s) => s.key === "repo:").repo, undefined);
  }
});

test("«متوجه شدم» puts an alert away while its cause lasts: a re-estimated reset time is not a new alert, a load turning red is", async () => {
  const { dismissAlerts, unseenAlerts, hostAlerts } = await import("../src/host-health.js");
  const limited = (until, since) => engineAlerts({ usable: true, engines: [{ id: "claude", name: "Claude", state: "limited", until }, { id: "claude-2", name: "C2", state: "credit", since }] }, NOW);
  const seen = dismissAlerts(limited(NOW + 3600_000, NOW), []);
  assert.deepEqual(unseenAlerts(limited(NOW + 3600_000, NOW), seen), []);
  // Every test of an engine re-estimates «now + 1 h» and re-stamps the credit mark: still the same alerts (this came back every 5 minutes).
  assert.deepEqual(unseenAlerts(limited(NOW + 3600_000 + 300_000, NOW + 300_000), seen), []);
  const disk = (p) => hostAlerts({ cpu: { percent: 5 }, memory: { percent: 5 }, disk: { percent: p } });
  const seenDisk = dismissAlerts(disk(88), []);
  assert.deepEqual(unseenAlerts(disk(89), seenDisk), [], "the percent moving is the same alert");
  assert.equal(unseenAlerts(disk(98), seenDisk)[0].level, "danger");
});

test("an alert whose cause is over is forgotten, so its next occurrence shows again", async () => {
  const { dismissAlerts, unseenAlerts, hostAlerts, pruneDismissed, ENGINE_GRACE_MS } = await import("../src/host-health.js");
  const engines = (state) => ({ usable: true, engines: [{ id: "claude", name: "Claude", state, until: NOW + 3600_000 }] });
  const seen = dismissAlerts(engineAlerts(engines("limited"), NOW), []);
  const none = { usable: true, engines: [] };
  const still = pruneDismissed(seen, { engines: engines("limited"), now: NOW });
  assert.deepEqual(still.dismissed, seen, "still limited: stays dismissed");
  assert.deepEqual(pruneDismissed(seen, { engines: null, now: NOW + 9 * ENGINE_GRACE_MS }).dismissed, seen, "engines not read yet: nothing is forgotten");
  // A limit that lapses for a moment and comes back (a test of a cheaper model clears it, the next run sets it again) is one alert.
  const blip = pruneDismissed(seen, { engines: none, seen: still.seen, now: NOW + 5 * 60_000 });
  assert.deepEqual(blip.dismissed, seen, "usable for five minutes only: kept");
  assert.deepEqual(unseenAlerts(engineAlerts(engines("limited"), NOW + 6 * 60_000), blip.dismissed), [], "and back: still dismissed");
  // Usable for a long while: over, and the next limit is a new alert.
  const gone = pruneDismissed(seen, { engines: none, seen: still.seen, now: NOW + ENGINE_GRACE_MS + 1 });
  assert.deepEqual(gone.dismissed, []);
  assert.deepEqual(gone.seen, {});
  assert.equal(unseenAlerts(engineAlerts(engines("limited"), NOW), gone.dismissed).length, 1, "limited again: shown again");
  // Dismissed before the clock was kept: it starts at the first look.
  const old = pruneDismissed(seen, { engines: none, seen: {}, now: NOW });
  assert.deepEqual(old.dismissed, seen);
  // A load: forgotten only when well below its level, not on a dip of one reading.
  const host = (disk, mem = 5, cpu = 5) => ({ cpu: { percent: cpu }, memory: { percent: mem }, disk: { percent: disk } });
  const seenHost = dismissAlerts(hostAlerts(host(88, 91)), []);
  assert.deepEqual(pruneDismissed(seenHost, { host: host(84, 88) }).dismissed, seenHost, "84٪ disk / 88٪ memory are still close: kept");
  assert.deepEqual(pruneDismissed(seenHost, { host: host(60, 50) }).dismissed, [], "both well below: forgotten");
  assert.deepEqual(pruneDismissed(seenHost, { host: null }).dismissed, seenHost, "host not read yet: kept");
});
