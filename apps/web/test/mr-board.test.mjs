import test from "node:test";
import assert from "node:assert/strict";
import { board, card, headline, pipelineSign, projectName } from "../../../modules/mr-explainer/web/view.js";

const row = (over) => ({ id: "g/p!1", iid: 1, project: "root/griffin-private", title: "Draft: کار", author: "ali", category: "ready", reason: "بدون مانع", pipeline: "پایپ‌لاین سبز", pipelineStatus: "success", labels: "ui، bug", reviewers: "", changesCount: "3", comments: 2, sourceBranch: "a", targetBranch: "main", ...over });

test("a card says where an MR stands, in words", () => {
  const c = card(row());
  assert.equal(c.title, "کار");
  assert.equal(c.ref, "!1");
  assert.equal(c.project, "griffin-private");
  assert.deepEqual(c.labels, ["ui", "bug"]);
  assert.deepEqual(c.facts, ["۳ فایل", "۲ نظر"]);
  assert.equal(c.pipeline.tone, "ok");
  assert.equal(card(row({ category: "nonsense" })).shelf, "waiting");
});

test("the board counts every shelf before one is picked, and filters by author and search", () => {
  const rows = [row(), row({ id: "2", iid: 2, category: "attention", author: "sara", title: "fix pipeline" }), row({ id: "3", iid: 3, category: "attention", author: "ali" })];
  const all = board(rows);
  assert.equal(all.counts.attention, 2);
  assert.equal(all.shelves[0].key, "attention");
  const picked = board(rows, { shelf: "ready" });
  assert.equal(picked.counts.attention, 2);
  assert.deepEqual(picked.shelves.map((s) => s.key), ["ready"]);
  assert.equal(board(rows, { author: "sara" }).total, 1);
  assert.equal(board(rows, { search: "pipeline" }).total, 1);
  assert.deepEqual(all.authors, [{ name: "ali", n: 2 }, { name: "sara", n: 1 }]);
});

test("the headline names what wants the owner, else says nothing does", () => {
  assert.equal(headline({ attention: 2, ready: 1 }, 5), "۲ مورد به رسیدگی نیاز دارد و ۱ مورد آمادهٔ مرج است.");
  assert.match(headline({}, 3), /چیزی منتظر شما نیست/);
  assert.equal(headline({}, 0), "");
  assert.equal(pipelineSign(""), null);
  assert.equal(pipelineSign("failed").tone, "bad");
  assert.equal(projectName("a/b/c"), "c");
});
