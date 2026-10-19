import test from "node:test";
import assert from "node:assert/strict";
import { pollMs, runningFor, taskKind, visibleTasks } from "../src/tasks-peek.js";

test("background tasks: oldest first, a stopped one hidden at once", () => {
  const tasks = [{ id: "b", startedAt: 20 }, { id: "a", startedAt: 10 }, { id: "c", startedAt: 30 }, null];
  assert.deepEqual(visibleTasks(tasks, new Set(["c"])).map((t) => t.id), ["a", "b"]);
  assert.deepEqual(visibleTasks(undefined), []);
});

test("background tasks: how long each has run, what kind it is, how often to ask", () => {
  assert.equal(runningFor(0, 45_000), "۴۵ ثانیه");
  assert.equal(runningFor(0, 3 * 60_000 + 5_000), "۳ دقیقه");
  assert.equal(runningFor(0, 2 * 3_600_000), "۲ ساعت");
  assert.equal(taskKind("local_bash"), "ترمینال");
  assert.equal(taskKind("local_agent"), "ایجنت");
  assert.equal(taskKind(null), "کار");
  assert.ok(pollMs(1) < pollMs(0));
});

test("ended tasks with an output stay ten minutes, labelled by how they ended", async () => {
  const { endedLabel, recentEnded } = await import("../src/tasks-peek.js");
  const now = 1_000_000_000;
  const ended = [{ id: "a", endedAt: now - 60_000 }, { id: "b", endedAt: now - 11 * 60_000 }, { endedAt: now }];
  assert.deepEqual(recentEnded(ended, now).map((t) => t.id), ["a"]);
  assert.deepEqual(recentEnded(undefined, now), []);
  assert.equal(endedLabel("failed"), "شکست خورد");
  assert.equal(endedLabel(undefined), "تمام شد");
});

test("a task with no description is named by its kind, never by the bare id; sub-agents running now are picked out", async () => {
  const { taskTitle, runningChildren } = await import("../src/tasks-peek.js");
  assert.equal(taskTitle({ id: "bed7m8cnd", type: "monitor_mcp" }), "پایش · bed7m8cnd");
  assert.equal(taskTitle({ id: "x", description: "  sleep 5 " }), "sleep 5");
  assert.equal(taskKind("local_workflow"), "گردش‌کار");
  assert.deepEqual(runningChildren([{ id: "a", runStatus: "running" }, { id: "b", runStatus: "idle" }, null]).map((c) => c.id), ["a"]);
  assert.deepEqual(runningChildren(undefined), []);
});
