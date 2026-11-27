import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openStore } from "../src/db.mjs";

// Routing asks, on every pick, how many runs each subscription account is already carrying
// (index.mjs runsOnAccount). That answer MUST NOT come from routeModel — the router calls it, so
// asking the router back recurses until the stack ends. Found by the quality pass on 2026-11-25,
// after the first version had shipped it: with two live chats it was an infinite loop.
//
// The structural guard below reads the source, because the recursion only shows up through the
// whole server wiring; the behaviour tests pin the query it is built on.

const here = path.dirname(new URL(import.meta.url).pathname);
const source = fs.readFileSync(path.join(here, "..", "src", "index.mjs"), "utf8");

test("the run count never asks the router, which is what asks it", () => {
  const start = source.indexOf("const runsOnAccount = ");
  assert.ok(start > 0, "runsOnAccount must exist");
  const body = source.slice(start, source.indexOf("\n};", start) + 3);
  assert.equal(/routeModel\s*\(/.test(body), false, "runsOnAccount must not call routeModel");
  assert.equal(/accountRoom\s*\(/.test(body), false, "runsOnAccount must not call accountRoom");
  assert.match(body, /lastRunProviders/, "the count must come from the store, in one query");
});

test("one batch query instead of one statement per running chat", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "runs-"));
  const store = openStore(path.join(dir, "db.sqlite"));
  const ids = [];
  for (let i = 0; i < 6; i += 1) {
    const chat = store.createChat({ title: `c${i}` });
    ids.push(chat.id);
    store.appendEvent(chat.id, `r${i}`, "run.started", { provider: i % 2 ? "claude" : "claude-2", model: "x" });
  }
  // The last started run of a chat is the one it is on now.
  store.appendEvent(ids[0], "r0b", "run.started", { provider: "claude-5", model: "x" });

  const map = store.lastRunProviders(ids);
  assert.equal(map.size, 6);
  assert.equal(map.get(ids[0]), "claude-5", "the newest run wins");
  assert.equal(map.get(ids[1]), "claude");
  assert.equal(map.get(ids[2]), "claude-2");
  // Agreement with the single-chat query it replaces, for every chat.
  for (const id of ids) assert.equal(map.get(id), store.lastRunProvider(id));

  // An unknown or empty set is not an error and costs nothing.
  assert.equal(store.lastRunProviders([]).size, 0);
  assert.equal(store.lastRunProviders([null, undefined]).size, 0);
  assert.equal(store.lastRunProviders(["no-such-chat"]).size, 0);

  fs.rmSync(dir, { recursive: true, force: true });
});
