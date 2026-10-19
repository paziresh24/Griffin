import test from "node:test";
import assert from "node:assert/strict";
import { groupLabel, groupNow, groupWork } from "../src/work-groups.js";

const tool = (name, args = {}) => ({ type: "tool", name, args });
const text = (t) => ({ type: "text", text: t });
const line = (name) => (name === "Bash" ? "دستور" : null);

test("narration stays as text; the steps between two narrations fold into one group", () => {
  const segs = groupWork([{ type: "reasoning", text: "a" }, tool("Bash"), tool("Bash"), text("نصب شد"), tool("Bash"), text("   "), tool("kube_get"), text("تمام")]);
  assert.deepEqual(segs.map((s) => s.kind), ["steps", "text", "steps", "text"]);
  assert.equal(segs[0].parts.length, 3);
  assert.equal(segs[2].parts.length, 2); // a blank narration does not cut the group
});

test("a group is labelled by what it did: one tool by its line, shell calls counted, a mix by its first", () => {
  assert.equal(groupLabel([tool("Bash")], line), "دستور");
  assert.equal(groupLabel([tool("Bash"), tool("debug_exec"), tool("Bash")], line), "۳ دستور اجرا شد");
  assert.equal(groupLabel([tool("kube_get"), tool("Bash")], line), "kube_get و ۱ مورد دیگر");
  assert.equal(groupLabel([{ type: "reasoning", text: "x" }], line), "فکر کردن");
});

test("a running group shows its newest step", () => {
  assert.equal(groupNow([tool("kube_get"), tool("Bash")], line), "دستور");
  assert.equal(groupNow([tool("Bash"), { type: "reasoning" }], line), "در حال فکر کردن…");
  assert.equal(groupNow([tool("mystery")], line), "در حال اجرای یک ابزار…");
});
