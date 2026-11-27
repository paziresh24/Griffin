import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openStore } from "../src/db.mjs";

// The account-health card (index.mjs riskOf / noteRisk). Found by the quality pass 2026-11-25:
// `setKv` stores JSON itself, so the first version's JSON.stringify round-trip read back as a STRING
// and JSON.parse threw on it — every counter would have shown zero, silently.
//
// These tests drive the same contract through a real store: an object goes in, an object comes out,
// a legacy string row is still readable, and the 14-day window is honoured.

const EMPTY = { count: 0, at: 0 };
const parseStoredKv = (v) => {
  if (v == null) return null;
  if (typeof v !== "string") return v;
  try {
    return JSON.parse(v);
  } catch {
    return null;
  }
};

function withStore(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "risk-"));
  const store = openStore(path.join(dir, "db.sqlite"));
  try {
    return fn(store);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const read = (store, id) => (name) => {
  const v = parseStoredKv(store.getKv(`risk:${id}:${name}`));
  return v && typeof v === "object" ? v : EMPTY;
};
const since = () => Date.now() - 14 * 86_400_000;
const recent = (r) => (r.at && r.at >= since() ? r.count : 0);

test("a counter written as an object reads back as an object, not a zero", () => {
  withStore((store) => {
    // What noteRisk does: setKv takes the object as-is.
    store.setKv("risk:a:cap", { count: 3, at: Date.now() });
    const got = read(store, "a")("cap");
    assert.equal(got.count, 3, "a double-encoded value would come back as a string here");
    assert.equal(recent(got), 3);
  });
});

test("a legacy row written as a JSON string is still counted", () => {
  withStore((store) => {
    const at = Date.now() - 86_400_000;
    store.setKv("risk:b:cap", JSON.stringify({ count: 9, at }));
    const got = read(store, "b")("cap");
    assert.equal(got.count, 9);
    assert.equal(recent(got), 9);
  });
});

test("a signal older than the window stops counting", () => {
  withStore((store) => {
    store.setKv("risk:c:cap", { count: 5, at: Date.now() - 30 * 86_400_000 });
    assert.equal(recent(read(store, "c")("cap")), 0, "an old cap hit is not a current risk");
  });
});

test("a missing or corrupt counter is zero, never a crash", () => {
  withStore((store) => {
    assert.deepEqual(read(store, "d")("cap"), EMPTY);
    store.setKv("risk:d:cap", "not-json");
    assert.deepEqual(read(store, "d")("cap"), EMPTY);
    store.setKv("risk:d:cap", 42);
    assert.deepEqual(read(store, "d")("cap"), EMPTY, "a non-object is not a counter");
  });
});

test("bumping a counter adds to it and never loses the earlier count", () => {
  withStore((store) => {
    const bump = (id, name) => {
      const key = `risk:${id}:${name}`;
      let cur = parseStoredKv(store.getKv(key)) || EMPTY;
      if (!cur || typeof cur !== "object") cur = EMPTY;
      store.setKv(key, { count: (Number(cur.count) || 0) + 1, at: Date.now() });
    };
    bump("e", "cap");
    bump("e", "cap");
    bump("e", "cap");
    assert.equal(read(store, "e")("cap").count, 3, "repeated cap hits are what the card warns about");
  });
});
