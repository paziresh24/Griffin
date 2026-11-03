import test from "node:test";
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { createKube } from "../src/kube.mjs";
import { createTools } from "../src/tools.mjs";
import { TEST_SITE } from "./fixture-site.mjs";

// kube_exec as griffin-owner (2026-10-29): only when the server says so (asOwner: true), only over
// the emergency SSH path, by pointing kubectl at the node's second kubeconfig.
const vault = { item: async () => "token-x" };
// The owner kubeconfig is part of the cluster's emergency entry, so only an install that sets it has the path.
const clusters = { prod: { api: "https://k8s.test", emergency: { host: "203.0.113.10", port: 22, user: "griffin", kubectl: "kubectl", ownerKubeconfig: "/home/griffin/.kube/owner" } } };
function setup() {
  const sshCalls = [];
  const sshRun = async (target, command) => {
    sshCalls.push(command);
    return { stdout: gzipSync("ok\n"), stderr: "" };
  };
  const kube = createKube({ vault, clusters, sshRun, fetchImpl: async () => new Response("{}", { status: 404 }) });
  return { tools: createTools({ site: TEST_SITE, kube, vault, sshRun }), sshCalls };
}
const call = { cluster: "prod", namespace: "infisical", pod: "infisical-1", command: "echo ok" };

test("asOwner: true runs kubectl with the owner kubeconfig on the node", async () => {
  const { tools, sshCalls } = setup();
  await tools.kube_exec.execute({ ...call, asOwner: true });
  assert.equal(sshCalls[0], `kubectl '--kubeconfig' '/home/griffin/.kube/owner' 'exec' '-n' 'infisical' 'infisical-1' '--' 'sh' '-c' 'echo ok' | gzip -c`);
});

test("without asOwner, or with anything but true, it stays the restricted identity", async () => {
  for (const asOwner of [undefined, false, "true", 1, {}]) {
    const { tools, sshCalls } = setup();
    await tools.kube_exec.execute({ ...call, ...(asOwner === undefined ? {} : { asOwner }) });
    assert.doesNotMatch(sshCalls[0], /--kubeconfig/, `asOwner=${JSON.stringify(asOwner)}`);
  }
});
