import test from "node:test";
import assert from "node:assert/strict";
import { ALERTMANAGER_PATH, createAlertTools, normalizeAlert } from "../src/alerts.mjs";

const raw = {
  fingerprint: "abc",
  labels: { alertname: "SeaweedOwnerBucketHuge", severity: "critical", namespace: "storage", bucket: "salireza-sadr", pod: "x-1", source_cluster: "dr" },
  annotations: { summary: "Owner S3 bucket salireza-sadr over 200Gi" },
  startsAt: "2026-09-18T00:00:00Z",
  status: { state: "active" },
};

test("normalizes the labels that identify what is broken", () => {
  const a = normalizeAlert(raw, "dr");
  assert.equal(a.alertname, "SeaweedOwnerBucketHuge");
  assert.equal(a.cluster, "dr");
  assert.equal(a.labels.bucket, "salireza-sadr");
  assert.equal(a.summary, "Owner S3 bucket salireza-sadr over 200Gi");
});

test("target_cluster wins over the cluster that saw it", () => {
  const a = normalizeAlert({ labels: { alertname: "PublicAppEndpointDown", target_cluster: "edge", source_cluster: "prod" } }, "prod");
  assert.equal(a.cluster, "edge");
  assert.equal(a.seenFrom, "prod");
});

test("reads through the service proxy, falls back to kubectl get --raw, and reports a dead cluster", async () => {
  const calls = [];
  const kube = {
    publicRequest: async (cluster, path) => {
      calls.push(["api", cluster, path]);
      if (cluster === "dr") throw new Error("http_302");
      return { body: [raw] };
    },
    emergency: async (cluster, args) => {
      calls.push(["ssh", cluster, args.join(" ")]);
      if (cluster === "edge") throw new Error("down");
      return JSON.stringify([raw]);
    },
    withFallback: async (cluster, { viaApi, viaSsh }) => {
      try {
        return { value: await viaApi(), source: "public-api" };
      } catch {
        try {
          return { value: await viaSsh(), source: "emergency-ssh" };
        } catch (error) {
          throw Object.assign(new Error(`all paths failed for ${cluster}`), { attempts: [{ error: error.message }] });
        }
      }
    },
  };
  kube.publicRequest = ((orig) => async (c, p) => (c === "edge" ? Promise.reject(new Error("timeout")) : orig(c, p)))(kube.publicRequest);
  const { alerts_active } = createAlertTools({ kube, clusters: ["prod", "edge", "dr"] });
  const out = await alerts_active.execute({});
  assert.equal(out.clusters.prod.source, "public-api");
  assert.equal(out.clusters.dr.source, "emergency-ssh");
  assert.equal(out.clusters.edge.ok, false);
  assert.equal(out.alerts.length, 2);
  assert.ok(calls.some(([, , p]) => String(p).startsWith(ALERTMANAGER_PATH) && String(p).includes("silenced=false")));
});
