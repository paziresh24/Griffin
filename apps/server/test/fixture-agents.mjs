import fs from "node:fs";
import path from "node:path";
import { importAgent } from "../src/agents/import.mjs";

// A fresh install has exactly one agent. Every test that needs a second one brings it, the same
// way a user would: by importing a profile. Loading the shipped examples also keeps them honest.
const EXAMPLES = path.resolve(import.meta.dirname, "../../../examples/agents");

export function exampleAgent(file) {
  return JSON.parse(fs.readFileSync(path.join(EXAMPLES, file), "utf8"));
}

/** platform + the two CDN agents, as an install with infrastructure tools would have them. */
export function seedExampleAgents(store) {
  const agents = {};
  for (const file of ["platform.json", "cdn-arvan.json", "cdn-nsin.json", "researcher.json"]) {
    const profile = importAgent(store, exampleAgent(file));
    agents[profile.id] = profile;
  }
  return agents;
}

/** A minimal extra agent for tests that only need "some other agent to exist". */
export function addAgent(store, id, overrides = {}) {
  return importAgent(store, { id, label: id, ...overrides });
}
