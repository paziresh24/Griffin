import test from "node:test";
import assert from "node:assert/strict";
import { todoList } from "../src/todos.js";

test("todoList: an array, a JSON string of one, and nothing else", () => {
  const steps = [{ content: "a", status: "pending" }];
  assert.deepEqual(todoList(steps), steps);
  // 2026-10-30: a disabled TodoWrite got its list as a string and the chat page crashed on .filter.
  assert.deepEqual(todoList(JSON.stringify(steps)), steps);
  for (const bad of [undefined, null, "", "not json", "{}", { todos: steps }, 3, [null, "x"]]) assert.deepEqual(todoList(bad), []);
});
