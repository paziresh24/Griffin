// «#/new?ask=<text>»: a report's «جزئیات» link opens a new chat with the question in the box (ask-link.js).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { ASK_LINK_MAX, ASK_LINK_TTL_MS, catchAskLink, joinAskLink, parseAskLink, takeAskLink } from "../src/ask-link.js";

const memoryStorage = () => {
  const map = new Map();
  return { getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, String(v)), removeItem: (k) => map.delete(k), map };
};
const link = (text) => `#/new?ask=${encodeURIComponent(text)}`;

test("the link's text is read as it was written; other hashes are not ask links", () => {
  assert.equal(parseAskLink(link("چرا ۵xx هامی صبح بالا رفت؟\nجزئیات بده")), "چرا ۵xx هامی صبح بالا رفت؟\nجزئیات بده");
  assert.equal(parseAskLink("#/new?ask=a+b%2Bc"), "a b+c", "a form-encoded space and a literal plus");
  assert.equal(parseAskLink("#/new?from=telegram&ask=%D8%B3%D9%84%D8%A7%D9%85"), "سلام", "other parameters are ignored");
  assert.equal(parseAskLink("#/new/?ask=x"), "x");
  assert.equal(parseAskLink("#/new"), "", "a bare #/new is a new chat with an empty box");
  assert.equal(parseAskLink("#/new?ask=%E0%A4%A"), "�%A", "a broken escape does not throw");
  for (const hash of ["", "#/", "#/c/00000000-0000-0000-0000-000000000000", "#/settings", "#/newer?ask=x", "#/s/abc", "#new?ask=x"]) {
    assert.equal(parseAskLink(hash), null, hash);
  }
});

test("control characters go, line breaks stay; the text stops at the cap without splitting a character", () => {
  assert.equal(parseAskLink(link("  a\r\nb\u0007c\u0000 ")), "a\nbc");
  const long = parseAskLink(link("😀".repeat(ASK_LINK_MAX + 10)));
  assert.equal(Array.from(long).length, ASK_LINK_MAX);
  assert.ok(!/[\uD800-\uDBFF]$/.test(long), "no lone high surrogate at the end");
});

test("caught once, taken once; a bare link or another hash leaves nothing waiting", () => {
  const storage = memoryStorage();
  assert.equal(catchAskLink(storage, "#/c/00000000-0000-0000-0000-000000000000"), false);
  assert.equal(catchAskLink(storage, "#/new"), true, "the address still becomes #/");
  assert.equal(storage.map.size, 0);
  assert.equal(catchAskLink(storage, link("وضعیت دیتابیس؟"), 1000), true);
  assert.equal(takeAskLink(storage, 2000), "وضعیت دیتابیس؟");
  assert.equal(takeAskLink(storage, 2000), "", "a reload does not fill the box again");
  catchAskLink(storage, link("دیر"), 0);
  assert.equal(takeAskLink(storage, ASK_LINK_TTL_MS + 1), "", "a text left waiting for an hour is let go");
  assert.equal(storage.map.size, 0);
  assert.equal(catchAskLink(null, link("x")), true, "no storage: still a new chat");
  assert.equal(takeAskLink(null), "");
});

test("what was typed in the new chat's box stays below the link's text; the same link twice is not doubled", () => {
  assert.equal(joinAskLink("سؤال", ""), "سؤال");
  assert.equal(joinAskLink("سؤال", "  "), "سؤال");
  assert.equal(joinAskLink("سؤال", "نوشته"), "سؤال\n\nنوشته");
  assert.equal(joinAskLink("سؤال", "سؤال\n\nنوشته"), "سؤال\n\nنوشته");
});

test("the page catches the link before the router reads it, and only the new chat's box fills (never sends)", () => {
  const main = fs.readFileSync(new URL("../src/main.jsx", import.meta.url), "utf8");
  assert.match(main, /catchAskLink\(storage, window\.location\.hash\)/);
  assert.match(main, /history\.replaceState\([^)]*"#\/"\)/);
  assert.ok(main.indexOf("askLink();") < main.indexOf("createRoot("), "caught before the app renders");
  const thread = fs.readFileSync(new URL("../src/components/Thread.jsx", import.meta.url), "utf8");
  const fill = thread.slice(thread.indexOf("const ask = takeAskLink("), thread.indexOf("window.addEventListener(ASK_EVENT, fill)"));
  assert.ok(fill.length > 0);
  assert.match(fill, /setText\(joinAskLink\(/);
  assert.doesNotMatch(fill, /send\(|requestSubmit|\.composer\(\)\.send/, "a link never sends by itself");
});
