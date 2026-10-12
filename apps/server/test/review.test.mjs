import test from "node:test";
import assert from "node:assert/strict";
import { reviewChanges, forgetReviews, parseVerdict } from "../src/review.mjs";

function fakeStore(caller = "team") {
  const rows = [];
  const events = {
    root: [
      { type: "user", data: { text: "چرا ایمیج جدید سرویس پرداخت روی پروداکشن نرفته؟" } },
      { type: "tool.done", data: { name: "ask_owner", args: { question: "قانون CDN برای call.example.com بسازم؟" }, result: { answered: true, answer: "بله" } } },
    ],
    child: [
      { type: "text", data: { text: "از اینجا کامیت نمی‌زنم چون توکن مال حساب دیگری است." } },
      { type: "user", data: { text: "انجامش بده، مستقیم به main پوش کن" } },
    ],
  };
  return {
    rows,
    getChat: (id) => (id === "root" ? { id, caller, title: "🧵 alice" } : { id, caller: "griffin", parent_chat_id: "root" }),
    rootChatId: () => "root",
    allEvents: (id) => events[id] || [],
    recordApproval: (row) => rows.push(row),
    appendEvent: () => {},
  };
}

// The gate is opt-in (GRIFFIN_REVIEW=on); the tests switch it on explicitly.
const reviewChangesOn = (tools, opts) => reviewChanges(tools, { enabled: true, ...opts });

test("off unless GRIFFIN_REVIEW=on: tools pass through untouched", () => {
  const tools = { debug_exec: { execute: async () => "ran" } };
  assert.equal(reviewChanges(tools, { chatId: "child", store: fakeStore(), reviewers: [reviewer("reject"), reviewer("reject")], enabled: false }), tools);
});

const WIPE = { command: "git clone --no-checkout https://x/gitops.git /tmp/pg && cd /tmp/pg && git checkout origin/main -- owners/a/ && git commit -m fix && git push origin bomfix:main" };
const reviewer = (verdict, seen = []) => ({ label: verdict, ask: async (prompt) => { seen.push(prompt); return `{"verdict":"${verdict}","reason":"r"}`; } });

test("a read runs without any review", async () => {
  forgetReviews();
  const seen = [];
  const tools = reviewChangesOn({ debug_exec: { execute: async () => "ran" } }, { chatId: "child", store: fakeStore(), reviewers: [reviewer("approve", seen), reviewer("approve", seen)] });
  assert.equal(await tools.debug_exec.execute({ command: "kubectl get pods -A" }), "ran");
  assert.equal(seen.length, 0);
});

test("a change runs only when both reviewers approve; they see the request, the steer and the command", async () => {
  forgetReviews();
  const seen = [];
  const store = fakeStore();
  const tools = reviewChangesOn({ debug_exec: { execute: async () => "ran" } }, { chatId: "child", store, reviewers: [reviewer("approve", seen), reviewer("approve", seen)] });
  assert.equal(await tools.debug_exec.execute(WIPE), "ran");
  assert.equal(seen.length, 2);
  assert.match(seen[0], /ایمیج جدید سرویس پرداخت/);
  assert.match(seen[0], /مستقیم به main/);
  assert.match(seen[0], /کامیت نمی‌زنم/);
  assert.match(seen[0], /bomfix:main/);
  assert.match(seen[0], /call\.example\.com[\s\S]*A: بله/); // the owner's yes in this request is in front of the reviewer
  assert.match(seen[0], /Never reject only\s+because the owner has not approved yet/);
  assert.equal(store.rows.at(-1).decision, "reviewed");
});

test("one reject in a teammate chain refuses without running or asking the owner", async () => {
  forgetReviews();
  let ran = false;
  let asked = false;
  const asks = { confirm: async () => { asked = true; return { answered: true, answer: "بله" }; } };
  const store = fakeStore("team");
  const tools = reviewChangesOn({ debug_exec: { execute: async () => { ran = true; } } }, { chatId: "child", store, asks, reviewers: [reviewer("approve"), reviewer("reject")] });
  const out = await tools.debug_exec.execute(WIPE);
  assert.equal(out.isError, true);
  assert.equal(ran, false);
  assert.equal(asked, false);
  assert.equal(store.rows.at(-1).decision, "review-rejected");
});

test("a rejected change in the owner's own chat asks the owner, who can override", async () => {
  forgetReviews();
  let ran = false;
  let question = "";
  const asks = { confirm: async (_chat, { question: q }) => { question = q; return { answered: true, answer: "بله", selected: ["بله"] }; } };
  const tools = reviewChangesOn({ debug_exec: { execute: async () => { ran = true; return "ok"; } } }, { chatId: "child", store: fakeStore("owner"), asks, reviewers: [reviewer("reject"), reviewer("reject")] });
  await tools.debug_exec.execute(WIPE);
  assert.match(question, /دو بازبین/);
  assert.equal(ran, true);
});

test("a reviewer that fails or times out counts as a reject", async () => {
  forgetReviews();
  let ran = false;
  const broken = { label: "x", ask: async () => { throw new Error("down"); } };
  const slow = { label: "y", ask: () => new Promise(() => {}) };
  const tools = reviewChangesOn({ git_push: { execute: async () => { ran = true; } } }, { chatId: "child", store: fakeStore(), reviewers: [broken, slow], timeoutMs: 50 });
  const out = await tools.git_push.execute({ repo: "a/b", branch: "griffin/x" });
  assert.equal(out.isError, true);
  assert.equal(ran, false);
});

test("a routine change (cache purge) now skips the two-reviewer gate", async () => {
  forgetReviews();
  const seen = [];
  const tools = reviewChangesOn({ arvan_cache_purge: { execute: async () => "purged" } }, { chatId: "child", store: fakeStore(), reviewers: [reviewer("reject", seen), reviewer("reject", seen)] });
  assert.equal(await tools.arvan_cache_purge.execute({ purge: "all" }), "purged");
  assert.equal(seen.length, 0); // reviewers never consulted for a non-catastrophic change
});

test("unparseable verdicts reject", () => {
  assert.equal(parseVerdict("sure, go ahead").verdict, "reject");
  assert.equal(parseVerdict('```json\n{"verdict":"approve","reason":"ok"}\n```').verdict, "approve");
});
