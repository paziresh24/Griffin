import test from "node:test";
import assert from "node:assert/strict";
import {
  changesTotals, clipLines, durationText, failureText, groupJobsByStage, jobsSummary, mrOutcome, projectName, refLabel,
  roleName, secondsBetween, shellOutput, shellPlace, shortSha, statusInfo, tailLines,
} from "../src/tool-views.js";

test("statusInfo gives a Persian word and a tone", () => {
  assert.deepEqual(statusInfo("merged"), { label: "ادغام شد", tone: "ok" });
  assert.deepEqual(statusInfo("failed"), { label: "شکست", tone: "bad" });
  assert.deepEqual(statusInfo("ci_must_pass"), { label: "منتظر سبز شدن CI", tone: "warn" });
  assert.deepEqual(statusInfo("some_new_status"), { label: "some new status", tone: "muted" });
  assert.equal(statusInfo(""), null);
  assert.equal(statusInfo(undefined), null);
});

test("failureText and durationText read like people talk", () => {
  assert.equal(failureText("job_execution_timeout"), "زمان اجرا تمام شد (تایم‌اوت)");
  assert.equal(failureText(null), "");
  assert.equal(durationText(4), "۴ ثانیه");
  assert.equal(durationText(129.7), "۲ دقیقه و ۱۰ ثانیه");
  assert.equal(durationText(120), "۲ دقیقه");
  assert.equal(durationText(3700), "۱ ساعت و ۱ دقیقه");
  assert.equal(durationText(null), "");
  assert.equal(secondsBetween("2026-10-20T07:00:00Z", "2026-10-20T07:02:00Z"), 120);
  assert.equal(secondsBetween("x", "y"), null);
});

test("refLabel, shortSha, projectName", () => {
  assert.equal(refLabel("refs/merge-requests/147/head"), "MR !147");
  assert.equal(refLabel("refs/heads/main"), "main");
  assert.equal(refLabel("main"), "main");
  assert.equal(shortSha("96c3e9f3fbb8b126"), "96c3e9f3");
  assert.equal(projectName("root/griffin-private"), "griffin-private");
  assert.equal(projectName(null), "");
});

test("shellPlace says where the command ran", () => {
  assert.equal(shellPlace("debug_exec", {}, {}), "سندباکس");
  assert.equal(shellPlace("debug_exec", { host: "capsule" }), "کپسول");
  assert.equal(shellPlace("ssh_exec", { host: "10.0.0.5" }, { user: "griffin" }), "griffin@10.0.0.5");
  assert.equal(shellPlace("kube_exec", { cluster: "east", namespace: "ns", pod: "p-1" }), "پاد p-1 (ns) · east");
  assert.equal(shellPlace("mikrotik_exec", { router: "north" }), "میکروتیک north");
  assert.equal(shellPlace("Bash", {}), "ترمینال");
});

test("shellOutput splits stdout and stderr for every tool shape", () => {
  assert.deepEqual(shellOutput({ stdout: "a", stderr: "b" }), { stdout: "a", stderr: "b" });
  assert.deepEqual(shellOutput({ output: "kube" }), { stdout: "kube", stderr: "" });
  assert.deepEqual(shellOutput("plain"), { stdout: "plain", stderr: "" });
  assert.deepEqual(shellOutput(undefined), { stdout: "", stderr: "" });
});

test("clipLines and tailLines keep the right end and count what is hidden", () => {
  const text = Array.from({ length: 30 }, (_, i) => `l${i + 1}`).join("\n");
  const head = clipLines(text, 5);
  assert.equal(head.shown, "l1\nl2\nl3\nl4\nl5");
  assert.equal(head.hidden, 25);
  assert.equal(head.total, 30);
  const tail = tailLines(text, 3);
  assert.equal(tail.shown, "l28\nl29\nl30");
  assert.equal(tail.hidden, 27);
  assert.deepEqual(clipLines("a\nb", 14), { shown: "a\nb", hidden: 0, total: 2 });
});

test("groupJobsByStage puts the stage that ran first first", () => {
  // the API lists the newest job first: build jobs have the highest ids
  const jobs = [
    { id: 131875, name: "build: [broker]", stage: "build", status: "created" },
    { id: 131874, name: "build: [app]", stage: "build", status: "created" },
    { id: 131873, name: "changelog", stage: "test", status: "success" },
    { id: 131872, name: "test:others", stage: "test", status: "success" },
  ];
  const stages = groupJobsByStage(jobs);
  assert.deepEqual(stages.map((s) => s.stage), ["test", "build"]);
  assert.deepEqual(stages[0].jobs.map((j) => j.name), ["test:others", "changelog"]);
});

test("jobsSummary counts by status, failures first", () => {
  const jobs = [{ status: "success" }, { status: "success" }, { status: "failed" }, { status: "skipped" }];
  assert.equal(jobsSummary(jobs), "۴ کار: ۱ شکست · ۲ موفق · ۱ رد شد");
  assert.equal(jobsSummary([]), "");
});

test("changesTotals and roleName", () => {
  assert.deepEqual(changesTotals([{ added: 3, removed: 1 }, { added: 2 }, {}]), { files: 3, added: 5, removed: 1 });
  assert.equal(roleName(30), "Developer");
  assert.equal(roleName(20), "Reporter");
});

test("mrOutcome tells what merge and ready came to", () => {
  assert.deepEqual(mrOutcome({ action: "merge" }, { merged: true }), { text: "ادغام شد", tone: "ok" });
  assert.deepEqual(mrOutcome({ action: "merge" }, { merged: false }), { text: "ادغام نشد", tone: "bad" });
  assert.deepEqual(mrOutcome({ action: "ready" }, { draft: false }), { text: "از حالت پیش‌نویس درآمد", tone: "ok" });
  assert.equal(mrOutcome({}, {}), null);
});
