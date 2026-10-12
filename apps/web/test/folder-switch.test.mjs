import test from "node:test";
import assert from "node:assert/strict";
import { FOLDER_BUSY, folderSwitchError, folderSwitchLines } from "../src/folder-switch.js";

test("folder switch dialog says what stays behind and what comes back", () => {
  const dirty = folderSwitchLines({ from: "a", to: "b", parked: "/wt/x-in-a", changed: 3, unpushed: true, returning: true, busy: false });
  assert.ok(dirty.some((l) => l.includes("۳ فایل")));
  assert.ok(dirty.some((l) => l.includes("push")));
  assert.ok(dirty.some((l) => l.includes("برمی‌گردد")));
  const empty = folderSwitchLines({ from: "a", to: "b", parked: null, changed: 0, busy: true });
  assert.ok(empty.some((l) => l.includes("کاری روی دیسک نمانده")));
  assert.equal(empty.at(-1), FOLDER_BUSY);
  assert.equal(folderSwitchError({ status: 409 }), FOLDER_BUSY);
  assert.match(folderSwitchError({ status: 500, message: "x" }), /x$/);
});
