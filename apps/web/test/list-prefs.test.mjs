// The list's sort, direction and filter live on the server (list-prefs.js), so a new device shows the same list.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { settleChoice } from "../src/list-prefs.js";

const valid = (v) => ["updated", "title", "unread"].includes(v);

test("settle: the server's value wins; a server with none takes this browser's choice", () => {
  assert.deepEqual(settleChoice({ server: "title", local: "unread", initial: "updated", valid }), { value: "title", push: false });
  assert.deepEqual(settleChoice({ server: undefined, local: "unread", initial: "updated", valid }), { value: "unread", push: true });
  assert.deepEqual(settleChoice({ server: undefined, local: "updated", initial: "updated", valid }), { value: "updated", push: false });
  assert.deepEqual(settleChoice({ server: "gone", local: "bogus", initial: "updated", valid }), { value: "updated", push: false });
});

test("both lists keep their sort (and the Karsara list its direction and filter) through the server", () => {
  const side = fs.readFileSync(new URL("../src/components/Sidebar.jsx", import.meta.url), "utf8");
  const one = fs.readFileSync(new URL("../src/components/SidebarOneList.jsx", import.meta.url), "utf8");
  assert.match(side, /useListChoice\("sort", "griffin\.sidebar\.sort"/);
  for (const field of ["sort", "reverse", "filter"]) assert.match(one, new RegExp(`useListChoice\\("${field}", "kc-list-${field}"`));
});
