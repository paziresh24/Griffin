// «نقشهٔ کلیک‌ها» on the page (src/clicks.js): a click is named by the control's own label and never by
// what was written; dead, disabled and rage clicks; the screen cell.
import test from "node:test";
import assert from "node:assert/strict";
import { areaOf, cellOf, cleanLabel, createTally, describeClick, routeOf } from "../src/clicks.js";

// A tiny element: tag, attributes, text, classes, a parent; closest() walks up by tag, attribute or class.
function el(tag, { attrs = {}, text = "", classes = [], parent = null, disabled = false } = {}) {
  const node = { nodeType: 1, tagName: tag.toUpperCase(), parentElement: parent, textContent: text, classList: classes, disabled, getAttribute: (k) => (k in attrs ? attrs[k] : null) };
  const matches = (n, sel) =>
    sel.split(",").some((part) => {
      const s = part.trim();
      const tagOnly = /^[a-z]+$/i.test(s) && n.tagName.toLowerCase() === s;
      const cls = s.startsWith(".") && n.classList.includes(s.slice(1));
      const role = /^\[role="?([a-z]+)"?\]$/.exec(s);
      const tagAttr = /^([a-z]+)\[([a-z-]+)\]$/.exec(s);
      const attr = /^\[([a-z-]+)\]$/.exec(s);
      return tagOnly || cls || (role && attrs === undefined) || (role && n.getAttribute("role") === role[1]) || (tagAttr && n.tagName.toLowerCase() === tagAttr[1] && n.getAttribute(tagAttr[2]) != null) || (attr && n.getAttribute(attr[1]) != null);
    });
  node.closest = (sel) => {
    for (let n = node; n; n = n.parentElement) if (matches(n, sel)) return n;
    return null;
  };
  return node;
}

test("the page is a kind, never an id", () => {
  assert.equal(routeOf(""), "home");
  assert.equal(routeOf("#/"), "home");
  assert.equal(routeOf("#/c/0b1d2c3e-aaaa-bbbb-cccc-1234567890ab"), "chat");
  assert.equal(routeOf("#/settings", "tokens"), "settings:tokens");
  assert.equal(routeOf("#/telegram/0b1d2c3e-aaaa-bbbb-cccc-1234567890ab"), "telegram");
  assert.equal(routeOf("#/m/helpdesk/helpdesk"), "m:helpdesk");
});

test("a label keeps the control's own words: no title, name, number or chat after them", () => {
  assert.equal(cleanLabel({ aria: "گفتگوی جدید در «پروژهٔ محرمانه»" }), "گفتگوی جدید در");
  assert.equal(cleanLabel({ aria: "نوشتن پیشنهاد در کادر: متن خصوصی کاربر" }), "نوشتن پیشنهاد در کادر");
  assert.equal(cleanLabel({ aria: "مصرف: ۴۲٪ از پنجرهٔ زمینه" }), "مصرف");
  assert.equal(cleanLabel({ title: "۳ مورد منتظر شما" }), "# مورد منتظر شما");
  assert.equal(cleanLabel({ href: "#/c/0b1d2c3e-aaaa-bbbb-cccc-1234567890ab", text: "عنوان یک گفتگوی شخصی" }), "گفتگو در فهرست");
  assert.equal(cleanLabel({ text: "ذخیره" }), "ذخیره");
  assert.equal(cleanLabel({ text: "یک متن بلند که از یک پیشنهاد یا پیام آمده است" }), "", "long button text is not kept");
  assert.equal(cleanLabel({ tag: "input", type: "text", placeholder: "جستجوی ایجنت…" }), "input:text جستجوی ایجنت…");
  assert.equal(cleanLabel({ track: "sidebar.feedback", aria: "x" }), "sidebar.feedback");
});

test("a click is named by its control and placed by its part of the screen", () => {
  const aside = el("aside");
  const btn = el("button", { attrs: { "aria-label": "ارسال بازخورد یا گزارش مشکل" }, parent: aside });
  const icon = el("svg", { parent: btn });
  assert.deepEqual(describeClick(icon, { hash: "#/" }), { route: "home", area: "sidebar", kind: "click", key: "ارسال بازخورد یا گزارش مشکل" });
  const off = el("button", { attrs: { title: "ارسال" }, disabled: true, parent: el("div", { classes: ["g-composer"] }) });
  assert.equal(describeClick(off, { hash: "#/c/x" }).kind, "disabled");
  assert.equal(describeClick(off, { hash: "#/c/x" }).area, "composer");
});

test("a click on nothing that reacts is dead; a click in written text is not counted at all", () => {
  const logo = el("img", { attrs: { alt: "گریفین" }, parent: el("div", { classes: ["g-header-logo"] }) });
  assert.deepEqual(describeClick(logo, { hash: "#/" }), { route: "home", area: "page", kind: "dead", key: "تصویر گریفین" });
  const card = el("span", { parent: el("div", { classes: ["g-board"] }) });
  assert.equal(describeClick(card, { hash: "#/" }).key, "g-board");
  const words = el("p", { parent: el("div", { attrs: { "data-message": "" } }) });
  assert.equal(describeClick(words, { hash: "#/c/x" }), null);
  assert.equal(areaOf(() => false), "page");
});

test("the screen is a 10×10 grid; a narrow window is marked", () => {
  assert.equal(cellOf(0, 0, 1200, 800), "0,0");
  assert.equal(cellOf(1199, 799, 1200, 800), "9,9");
  assert.equal(cellOf(195, 400, 390, 844), "5,4,m");
  assert.equal(cellOf(10, 10, 0, 0), null);
});

test("three quick clicks on one control are one rage, counted once", () => {
  let t = 0;
  const tally = createTally({ now: () => t });
  const row = { route: "home", area: "page", kind: "dead", key: "g-board" };
  for (let i = 0; i < 4; i += 1) {
    tally.add(row);
    t += 200;
  }
  const rows = tally.take();
  assert.equal(rows.find((r) => r.kind === "dead").n, 4);
  assert.equal(rows.find((r) => r.kind === "rage").n, 1);
  assert.equal(tally.size(), 0);
});
