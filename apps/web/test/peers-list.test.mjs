import test from "node:test";
import assert from "node:assert/strict";
import { activeClients, lastSeen, openAgents, peerList } from "../src/peers-list.js";

const u = (label, enabled, uses, extra = {}) => ({ id: label, label, enabled, clients: uses.map((at, i) => ({ id: i, last_used_at: at })), quotas: [], ...extra });

test("the list puts the most recently active first, never-seen last, and folds the switched-off away", () => {
  const users = [u("old", true, ["2026-10-01T00:00:00Z"]), u("never", true, []), u("new", true, ["2026-10-02T00:00:00Z", "2026-10-18T09:00:00Z"]), u("off", false, ["2026-10-18T10:00:00Z"])];
  const { on, off } = peerList(users);
  assert.deepEqual(on.map((x) => x.label), ["new", "old", "never"]);
  assert.deepEqual(off.map((x) => x.label), ["off"]);
  assert.equal(lastSeen(users[2]), "2026-10-18T09:00:00Z");
});

test("search matches the name or the id, case-insensitive", () => {
  const users = [u("آقای رستمی", true, [], { id: "ali-rostami" }), u("نوا", true, [], { id: "bob-tehrani" })];
  assert.deepEqual(peerList(users, "رستمی").on.map((x) => x.id), ["ali-rostami"]);
  assert.deepEqual(peerList(users, "TEHRANI").on.map((x) => x.id), ["bob-tehrani"]);
});

test("a revoked or expired token is not an active device; an agent without tools is closed", () => {
  const user = { clients: [{ id: 1 }, { id: 2, revoked_at: "x" }, { id: 3, expires_at: "2000-01-01T00:00:00Z" }], quotas: [{ tools: ["a"] }, { tools: [] }, {}] };
  assert.equal(activeClients(user).length, 1);
  assert.equal(openAgents(user), 1);
});

test("a row's letter skips «آقای»/«خانم», and a task title drops the colleague's own name", async () => {
  const { initial, taskTitle } = await import("../src/peers-list.js");
  assert.equal(initial("آقای رستمی"), "ر");
  assert.equal(initial("خانم کریمی"), "ک");
  assert.equal(initial("نوا (بهروز تهرانی)"), "ن");
  assert.equal(taskTitle("نورا کریمی: سلام، یک کار", "نورا کریمی"), "سلام، یک کار");
  assert.equal(taskTitle("گزارش روزانه", "نورا کریمی"), "گزارش روزانه");
});
