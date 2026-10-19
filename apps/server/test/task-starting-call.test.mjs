import test from "node:test";
import assert from "node:assert/strict";
import { withStartingCall } from "../src/app.mjs";

// A live background task has no output file yet: its row opens on the call that started it.
const store = (rows) => ({ db: { prepare: () => ({ all: () => rows.map((data) => ({ data: JSON.stringify(data) })) }) } });

test("a live task gets the masked command of the tool call that started it", () => {
  const rows = [
    { callId: "toolu_2", name: "Bash", args: { command: "sleep 30 && echo done" } },
    { callId: "toolu_1", name: "Monitor", args: { description: "watch the queue", command: "tail -f /tmp/q" } },
  ];
  const out = withStartingCall(store(rows), "c1", [{ id: "b1", toolUseId: "toolu_1" }, { id: "b2", toolUseId: "toolu_2" }, { id: "b3", toolUseId: null }, { id: "b4", toolUseId: "toolu_9" }]);
  assert.equal(out[0].detail, "tail -f /tmp/q");
  assert.equal(out[1].detail, "sleep 30 && echo done");
  assert.equal(out[2].detail, undefined);
  assert.equal(out[3].detail, undefined);
});

test("no events, or a store that fails: the tasks come back as they were", () => {
  const tasks = [{ id: "b1", toolUseId: "toolu_1" }];
  assert.deepEqual(withStartingCall(store([]), "c1", tasks), tasks);
  const broken = { db: { prepare: () => { throw new Error("locked"); } } };
  assert.deepEqual(withStartingCall(broken, "c1", tasks), tasks);
});
