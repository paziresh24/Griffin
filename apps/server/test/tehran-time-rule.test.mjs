// Owner 2026-10-24: no UTC clock time anywhere a person reads. Every agent, every caller, gets the rule.
import test from "node:test";
import assert from "node:assert/strict";
import { buildRules } from "../src/prompt.mjs";

test("every agent's rules say times are written in the person's local time, never UTC", () => {
  for (const caller of ["owner", "team"]) {
    const text = buildRules({ agent: "griffin", caller });
    assert.match(text, /in their local time, never UTC/, caller);
    assert.match(text, /convert before you write/, caller);
  }
});
