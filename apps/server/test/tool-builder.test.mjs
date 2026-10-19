import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openStore } from "../src/db.mjs";
import { createToolBuilder, guardGriffinMerge, protectedTouch } from "../src/tool-builder.mjs";
process.env.GRIFFIN_SELF_REPO = "root/griffin-private"; // the repo the build chats work on

const text = (out) => JSON.parse(out.content[0].text);
const isYes = (c) => c?.answer === "بله";

function setup({ answer = "بله" } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "griffin-tb-"));
  const store = openStore(path.join(dir, "t.sqlite"));
  const sent = [];
  const runner = { send: async (chatId, msg) => sent.push({ chatId, text: msg.text }), isActive: () => false };
  const questions = [];
  const confirm = async (chatId, q) => (questions.push(q), { answer });
  const builds = [];
  const builder = createToolBuilder({
    store,
    runner,
    confirm,
    isYes,
    log: { error() {} },
    createBuildChat: async ({ title, text: t }) => {
      const chat = store.createChat({ title: `🛠 ${title}`, agent: "griffin", caller: "owner" });
      builds.push({ id: chat.id, text: t });
      return chat;
    },
  });
  const from = store.createChat({ title: "آقای بهرامی: MR 54", agent: "platform", caller: "peer:ali-bahrami" });
  return { store, builder, from, sent, questions, builds };
}

const args = { title: "gitlab_mr_changes", need: "بازبینی MR بدون دیف ممکن نیست", spec: "diff of an MR by iid, paged, read-only GitLab API" };

test("build_tool asks the owner, starts a build chat once, and reports back to the asker", async () => {
  const { store, builder, from, sent, questions, builds } = setup();
  const out = text(await builder.tool(from, { requester: "در گفتگوی «MR 54»" }).execute(args));
  assert.equal(out.started, true);
  assert.match(questions[0], /اوکیه؟/);
  assert.match(questions[0], /gitlab_mr_changes/);
  assert.equal(builds.length, 1);
  assert.match(builds[0].text, /Never touch/);
  assert.ok(builder.isBuildChat(out.chatId));
  // the same tool again joins the running build instead of a second chat
  const again = text(await builder.tool(from, { requester: "x" }).execute(args));
  assert.equal(again.already, true);
  assert.equal(builds.length, 1);
  // a build chat does not build a tool from itself
  const self = await builder.tool(store.getChat(out.chatId), { requester: "x" }).execute(args);
  assert.equal(self.isError, true);
  store.appendEvent(out.chatId, null, "run.finished", { status: "finished" });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(sent.at(-1).chatId, from.id);
  assert.match(sent.at(-1).text, /گزارش خودکار ساخت ابزار/);
});

test("a no from the owner builds nothing", async () => {
  const { builder, from, builds } = setup({ answer: "نه" });
  const out = await builder.tool(from, { requester: "x" }).execute(args);
  assert.equal(out.isError, true);
  assert.equal(builds.length, 0);
});

test("protectedTouch: the fences are off limits, the registry may only grow", () => {
  assert.match(protectedTouch([{ path: "apps/server/src/guard.mjs" }]), /guard\.mjs/);
  assert.match(protectedTouch([{ path: "x", oldPath: "deploy/capsule/compose.yaml" }]), /compose/);
  assert.equal(protectedTouch([{ path: "apps/broker/src/gitlab.mjs" }, { path: "apps/server/src/agents/registry.mjs", removed: 0, diff: "@@\n+  \"x\"," }]), null);
  assert.match(protectedTouch([{ path: "apps/server/src/agents/registry.mjs", removed: 1, diff: "-  \"y\"," }]), /حذف/);
  assert.match(protectedTouch([{ path: "apps/server/src/agents/registry.mjs", diffOmitted: true }]), /کامل/);
});

test("guardGriffinMerge refuses a fence change and asks before a build chat merges", async () => {
  let merged = 0;
  const tools = { gitlab_mr: { execute: async () => (merged += 1, { ok: true }) } };
  let files = [{ path: "apps/server/src/guard.mjs" }];
  const callBroker = async () => ({ files });
  const asked = [];
  const confirm = async (_c, q) => (asked.push(q), { answer: "بله" });
  const g = guardGriffinMerge(tools, { chatId: "c", buildChat: true, callBroker, confirm, isYes });
  const refused = await g.gitlab_mr.execute({ project: "root/griffin-private", iid: 9, action: "merge" });
  assert.equal(refused.isError, true);
  assert.equal(merged, 0);
  files = [{ path: "apps/broker/src/gitlab.mjs" }];
  await g.gitlab_mr.execute({ project: "root/griffin-private", iid: 9, action: "merge" });
  assert.equal(merged, 1);
  assert.equal(asked.length, 1);
  // other projects and views pass through untouched
  await g.gitlab_mr.execute({ project: "infra/gitops", iid: 1, action: "merge" });
  await g.gitlab_mr.execute({ project: "root/griffin-private", iid: 9, action: "view" });
  assert.equal(merged, 3);
  assert.equal(asked.length, 1);
});
