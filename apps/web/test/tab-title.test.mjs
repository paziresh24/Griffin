import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { BRAND } from "../src/brand.js";
import { tabTitle } from "../src/tab-title.js";

const b = () => BRAND.name;

test("an open chat names the tab after the chat; a blank title reads as a new chat", () => {
  assert.equal(tabTitle({ chatId: "c1", chat: { title: "عنوان" } }), `عنوان · ${b()}`);
  assert.equal(tabTitle({ chatId: "c1", chat: { title: "  " } }), `گفتگوی جدید · ${b()}`);
  assert.equal(tabTitle({ chatId: "c1", chat: null }), b(), "not loaded yet: the brand alone");
  assert.equal(tabTitle({}), `گفتگوی جدید · ${b()}`);
});

test("pages and a settings section name the tab; a page wins over a chat id", () => {
  assert.equal(tabTitle({ page: "incidents" }), `حادثه‌ها · ${b()}`);
  assert.equal(tabTitle({ page: "peers" }), `ایجنت‌های همکاران · ${b()}`);
  assert.equal(tabTitle({ page: "settings", section: "نام شما" }), `نام شما · تنظیمات · ${b()}`);
  assert.equal(tabTitle({ page: "jobs", chatId: "c1", chat: { title: "x" } }), `جاب‌ها · ${b()}`);
});

test("the brand is the persona's name, read when the title is made", () => {
  const before = BRAND.name;
  BRAND.name = "نام تازه";
  try {
    assert.equal(tabTitle({ page: "telegram" }), "تلگرام · نام تازه");
  } finally {
    BRAND.name = before;
  }
});

test("a running chat lights the dot in front", () => {
  assert.equal(tabTitle({ chatId: "c1", chat: { title: "الف" }, running: true }), `● الف · ${b()}`);
});

test("what waits for the owner is counted in front, before the running dot", () => {
  assert.equal(tabTitle({ chatId: "c1", chat: { title: "الف" }, needs: 2 }), `(۲) الف · ${b()}`);
  assert.equal(tabTitle({ chatId: "c1", chat: { title: "الف" }, needs: 2, running: true }), `(۲) ● الف · ${b()}`);
  assert.equal(tabTitle({ chatId: "c1", chat: { title: "الف" }, needs: 0 }), `الف · ${b()}`);
});

test("App sets the tab from tabTitle and settings reports its section", () => {
  const app = fs.readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
  assert.match(app, /document\.title = tabTitle\(/);
  assert.match(app, /<SettingsPage onBack=\{[^}]*\} onSection=\{setSettingsSection\} \/>/);
});
