// Which commit this server was built from, for /healthz (the fleet drift report reads it from each
// public hostname). Source order: apps/server/BUILD_COMMIT stamped at build time (deploy/fleet
// updater, deploy/self/build-bundle.sh) -> `git rev-parse HEAD` of the checkout -> null (unknown;
// the field is then left out). Read once at boot.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SHA = /^[0-9a-f]{7,40}$/;
const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

export function readBuildCommit({ root = DEFAULT_ROOT, env = process.env, gitCeiling = path.dirname(path.resolve(root)) } = {}) {
  // gitCeiling: git looks no higher than the app root, so a copied app inside some other repo
  // never answers with that repo's HEAD.
  try {
    const stamped = fs.readFileSync(path.join(root, "apps/server/BUILD_COMMIT"), "utf8").trim().toLowerCase();
    if (SHA.test(stamped)) return stamped.slice(0, 12);
  } catch { /* no stamp */ }
  try {
    const gitEnv = gitCeiling ? { ...env, GIT_CEILING_DIRECTORIES: gitCeiling } : env;
    const head = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root, env: gitEnv, encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (/^[0-9a-f]{40}$/.test(head)) return head.slice(0, 12);
  } catch { /* not a checkout, or no git */ }
  return null;
}

// What changed, newest first ([{ commit, at, text }]): apps/server/CHANGELOG.json, written by the
// auto-updater from the commits it gates (deploy/capsule/autoupdate). None in a checkout: [].
export function readChangelog({ root = DEFAULT_ROOT } = {}) {
  try {
    const list = JSON.parse(fs.readFileSync(path.join(root, "apps/server/CHANGELOG.json"), "utf8"));
    return Array.isArray(list) ? list.filter((e) => e && typeof e.text === "string" && SHA.test(String(e.commit || ""))) : [];
  } catch {
    return [];
  }
}
