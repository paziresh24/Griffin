import test from "node:test";
import assert from "node:assert/strict";
import { createToolBudget } from "../src/budget.mjs";

const tool = (name) => ({
  description: name,
  inputSchema: {},
  async execute(args) {
    return { content: [{ type: "text", text: JSON.stringify({ name, ok: true, args: args ?? {} }) }] };
  },
});

test("identical calls are refused after the identical limit; different args keep working", async () => {
  const budget = createToolBudget({ limit: 20, identicalLimit: 3 });
  const wrapped = budget.wrap({ kube_get: tool("kube_get") });
  for (let i = 0; i < 3; i += 1) {
    const r = await wrapped.kube_get.execute({ cluster: "prod", kind: "pods" });
    assert.equal(r.isError, undefined);
  }
  const dup = await wrapped.kube_get.execute({ cluster: "prod", kind: "pods" });
  assert.equal(dup.isError, true);
  assert.match(dup.content[0].text, /عیناً/);
  // same tool, different args → still allowed
  const other = await wrapped.kube_get.execute({ cluster: "edge", kind: "pods" });
  assert.equal(other.isError, undefined);
});

test("per-tool budget wall stops a loop and tells the model to decide", async () => {
  const budget = createToolBudget({ limit: 5, identicalLimit: 99 });
  const wrapped = budget.wrap({ incident_update: tool("incident_update") });
  for (let i = 0; i < 5; i += 1) {
    const r = await wrapped.incident_update.execute({ n: i });
    assert.equal(r.isError, undefined);
  }
  const blocked = await wrapped.incident_update.execute({ n: 99 });
  assert.equal(blocked.isError, true);
  assert.match(blocked.content[0].text, /سقف ابزار/);
  assert.match(blocked.content[0].text, /جمع‌بندی/);
});

test("counters reset when a new run starts", async () => {
  const budget = createToolBudget({ limit: 3, identicalLimit: 2 });
  const wrapped = budget.wrap({ ask_agent: tool("ask_agent") });
  await wrapped.ask_agent.execute({ agent: "a", request: "1" });
  await wrapped.ask_agent.execute({ agent: "a", request: "1" });
  const blocked = await wrapped.ask_agent.execute({ agent: "a", request: "1" });
  assert.equal(blocked.isError, true);
  budget.noteEvent({ type: "run.started" });
  const fresh = await wrapped.ask_agent.execute({ agent: "a", request: "1" });
  assert.equal(fresh.isError, undefined);
});

test("non-tool entries pass through untouched", () => {
  const budget = createToolBudget();
  const wrapped = budget.wrap({ odd: null, plain: { description: "x" } });
  assert.equal(wrapped.odd, null);
  assert.equal(wrapped.plain.description, "x");
});
