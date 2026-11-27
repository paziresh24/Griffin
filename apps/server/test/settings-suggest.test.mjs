// «بپرس» and settings_suggest (settings-suggest.mjs): a person's own words → at most three settings,
// held to the catalogue, never applied here. The eight complaints below are real ones; the model answers
// are what Claude Sonnet gave for them on 2026-11-23 with this prompt.
import test from "node:test";
import assert from "node:assert/strict";
import { CONFIG_SCHEMA } from "../src/config.mjs";
import { settingsCatalog } from "../../web/src/settings-catalog.js";
import { resolvePrefs } from "../../web/src/ui-flags.js";
import { PICKS_MAX, RATE_MAX, catalogNow, createSettingsSuggest, describePick, parsePicks, settingsSuggestTools, suggestPrompt } from "../src/settings-suggest.mjs";

const rows = (values = {}) => CONFIG_SCHEMA.map((c) => ({ key: c.key, value: values[c.key] || "", effective: values[c.key] || "" }));
const entries = (values = {}) => settingsCatalog({ rows: rows(values), prefs: resolvePrefs(null, "griffin") });

const REAL = [
  ["اینتر رو میزنم پیامم نصفه کاره ارسال میشه", '{"picks":[{"id":"set:ENTER_KEY","value":"shiftEnter","why":"با این گزینه اینتر فقط خط بعد می‌رود و پیام نصفه فرستاده نمی‌شود."}],"none":""}', [["set:ENTER_KEY", true]]],
  ["این همه مراحل کار که ایجنت نشون میده اعصابمو خورد کرده، فقط جوابو میخوام", '{"picks":[{"id":"choice:work","value":"fold","why":"مراحل کار ایجنت به یک خط بسته جمع می‌شود."}],"none":""}', [["choice:work", true]]],
  ["ربات تلگرام رو کجا وصل کنم؟", '{"picks":[{"id":"tab:connections","value":"","why":"ربات‌ها و حساب تلگرام را همین‌جا وصل می‌کنید."}],"none":""}', [["tab:connections", false]]],
  ["وقتی سقف claude پر میشه کار وایمیسه و باید دوباره بگم ادامه بده", '{"picks":[{"id":"set:AUTO_CONTINUE","value":"on","why":"گفتگوی نیمه‌تمام خودش ادامه پیدا می‌کند."},{"id":"set:PLAN_FALLBACK","value":"auto","why":"گفتگو خودش به موتور بعدی می‌رود."}],"none":""}', [["set:AUTO_CONTINUE", false], ["set:PLAN_FALLBACK", false]]],
  ["میخوام تم سایت مثل پذیرش۲۴ ساده و تخت باشه", '{"picks":[{"id":"choice:look","value":"karsara","why":"پالت پذیرش۲۴، تخت و ساده."}],"none":""}', [["choice:look", true]]],
  ["بکاپ ها رو میخوام بفرستم یه جای دیگه بیرون سرور", '{"picks":[{"id":"set:BACKUP_S3_URL","value":"","why":"آدرس باکت خودتان را می‌دهید تا بکاپ بیرون از سرور هم برود."}],"none":""}', [["set:BACKUP_S3_URL", false]]],
  ["ساعت ها رو به صورت مثلا ۵ دقیقه پیش ببینم", '{"picks":[{"id":"flag:timeAgo","value":"on","why":"زمان‌ها به شکل «۵ دقیقه پیش» نشان داده می‌شوند."}],"none":""}', [["flag:timeAgo", true]]],
  ["قیمت دلار امروز چنده", '{"picks":[],"none":"در تنظیمات گریفین چیزی دربارهٔ قیمت دلار نیست."}', []],
];

test("the real complaints land on the right setting, and only the safe ones get one click", async () => {
  for (const [query, answer, expected] of REAL) {
    const suggest = createSettingsSuggest({ catalog: () => entries(), ask: async () => answer });
    const out = await suggest(query);
    assert.deepEqual(out.suggestions.map((s) => [s.id, s.oneClick]), expected, query);
    if (!expected.length) assert.ok(out.none, "says nothing fits");
    for (const s of out.suggestions) {
      assert.ok(s.title && s.where && s.section && s.why, s.id);
      // Already the way they want it (AUTO_CONTINUE is on by default): no button, and the card says so.
      if (!s.oneClick && s.kind !== "place") assert.ok(s.noClick, `${s.id} says why there is no button`);
    }
  }
});

test("the model's answer is held to the catalogue", () => {
  const list = entries();
  const text = 'Sure! {"picks":[{"id":"set:NOPE","value":"on"},{"id":"set:ENTER_KEY","value":"شیفت+اینتر","why":"x"},{"id":"set:ENTER_KEY","value":"enter"},{"id":"set:SIDE_CHAT","value":"maybe"},{"id":"set:GIT_EMAIL","value":"a@b.c"},{"id":"flag:timeAgo","value":"on"}],"none":""} done';
  const { picks } = parsePicks(text, list);
  assert.equal(picks.length, PICKS_MAX);
  assert.deepEqual(picks.map((p) => [p.id, p.value]), [["set:ENTER_KEY", "shiftEnter"], ["set:SIDE_CHAT", null], ["set:GIT_EMAIL", null]]);
  assert.equal(parsePicks("no json here", list).unreadable, true);
  // A value it does not take is a «go to the row», never a guess.
  const side = describePick(picks[1], list);
  assert.equal(side.oneClick, false);
  assert.equal(side.valueLabel, "");
});

test("the prompt never carries a free value (an address, an email), only whether it is set", () => {
  const prompt = suggestPrompt("ایمیل کامیت", entries({ GIT_EMAIL: "secret.person@example.com", BACKUP_S3_URL: "https://s3.internal/bucket" }));
  assert.ok(!prompt.includes("secret.person@example.com"));
  assert.ok(!prompt.includes("s3.internal"));
  assert.match(prompt, /set:GIT_EMAIL .*now: set/);
  assert.ok(prompt.trimEnd().endsWith(">>>"), "their words come last, fenced");
});

test("an empty question, too many in a row, and the same question twice", async () => {
  let calls = 0;
  let clock = 0;
  const suggest = createSettingsSuggest({ catalog: () => entries(), ask: async () => (calls += 1, REAL[0][1]), now: () => clock });
  await assert.rejects(suggest(" "), (e) => e.status === 400);
  await suggest("اینتر");
  await suggest("  اینتر ");
  assert.equal(calls, 1, "the same words are answered from the cache");
  for (let i = 0; i < RATE_MAX - 1; i += 1) await suggest(`سؤال ${i}`);
  await assert.rejects(suggest("یکی دیگر"), (e) => e.status === 429);
  clock += 11 * 60_000;
  await suggest("یکی دیگر");
});

test("a cached answer is described with today's values", async () => {
  let values = {};
  const suggest = createSettingsSuggest({ catalog: () => entries(values), ask: async () => REAL[0][1] });
  assert.equal((await suggest("اینتر")).suggestions[0].oneClick, true);
  values = { ENTER_KEY: "shiftEnter" };
  const again = (await suggest("اینتر")).suggestions[0];
  assert.equal(again.oneClick, false);
  assert.equal(again.currentLabel, "شیفت+اینتر");
});

test("settings_suggest shows a card and changes nothing", async () => {
  const config = { view: () => rows(), set: () => assert.fail("a suggestion never sets a setting") };
  const store = { getKv: () => null };
  const suggest = createSettingsSuggest({ catalog: () => catalogNow({ config, store }), ask: async () => REAL[1][1] });
  const tool = settingsSuggestTools(suggest).settings_suggest;
  const out = JSON.parse((await tool.execute({ need: REAL[1][0] })).content[0].text);
  assert.equal(out.suggestions[0].id, "choice:work");
  assert.match(out.note, /nothing was changed/);
  const bad = await tool.execute({ need: "" });
  assert.equal(bad.isError, true);
});
