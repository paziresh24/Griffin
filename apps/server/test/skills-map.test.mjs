import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildSkills } from "../src/skills-map.mjs";
import { projectSlug } from "../src/shared-memory.mjs";

test("skills = role, repos and the names of what it knows; never a note's body", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sk-"));
  const repos = path.join(root, "repos");
  fs.mkdirSync(path.join(repos, "shop-backend"), { recursive: true });
  fs.mkdirSync(path.join(repos, "_wt"), { recursive: true });
  const kn = path.join(root, "knowledge", "agents", "griffin", "knowledge");
  fs.mkdirSync(kn, { recursive: true });
  fs.writeFileSync(path.join(kn, "a.md"), "---\ntitle: \"نقشهٔ فروشگاه\"\nreviewed: true\n---\nSECRET BODY");
  const conf = path.join(root, "claude");
  const mem = path.join(conf, "projects", projectSlug(path.join(repos, "shop-backend")), "memory");
  fs.mkdirSync(mem, { recursive: true });
  fs.writeFileSync(path.join(mem, "shop-notifications-key.md"), "x");
  const sk = buildSkills({ store: { getKv: () => ({ text: "بک‌اند فروشگاه" }) }, owner: { role: "backend dev" }, reposRoot: repos, knowledgeRoot: path.join(root, "knowledge"), agentId: "griffin", configDir: conf });
  assert.deepEqual(sk.repos, ["shop-backend"]);
  assert.deepEqual(sk.knows, ["نقشهٔ فروشگاه", "shop-notifications-key"]);
  assert.equal(sk.summary, "بک‌اند فروشگاه");
  assert.ok(!JSON.stringify(sk).includes("SECRET"));
  fs.rmSync(root, { recursive: true, force: true });
});
