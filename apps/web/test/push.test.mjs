import test from "node:test";
import assert from "node:assert/strict";
import { pushSupportIssue, subscriptionToJSON, urlBase64ToUint8Array } from "../src/push.js";

test("urlBase64ToUint8Array decodes a VAPID-style URL-safe base64 key", () => {
  // "hi" -> base64 "aGk=" -> URL-safe "aGk" (padding stripped, as a real VAPID key arrives).
  const bytes = urlBase64ToUint8Array("aGk");
  assert.deepEqual([...bytes], [104, 105]);
});

test("urlBase64ToUint8Array handles '-' and '_' (URL-safe alphabet)", () => {
  // base64 "/+8=" (bytes 0xff, 0xef) becomes "_-8" in the URL-safe alphabet.
  const bytes = urlBase64ToUint8Array("_-8");
  assert.deepEqual([...bytes], [0xff, 0xef]);
});

test("subscriptionToJSON keeps only endpoint + keys, from a PushSubscription-like object", () => {
  const subscription = {
    toJSON: () => ({ endpoint: "https://push.example/1", keys: { p256dh: "P", auth: "A" }, expirationTime: null }),
  };
  assert.deepEqual(subscriptionToJSON(subscription), {
    endpoint: "https://push.example/1",
    keys: { p256dh: "P", auth: "A" },
  });
});

test("subscriptionToJSON tolerates a subscription with no toJSON (plain object)", () => {
  const subscription = { endpoint: "https://push.example/2", keys: { p256dh: "P" } };
  assert.deepEqual(subscriptionToJSON(subscription), {
    endpoint: "https://push.example/2",
    keys: { p256dh: "P", auth: "" },
  });
});

test("pushSupportIssue names the missing piece instead of a generic failure", () => {
  assert.match(pushSupportIssue({}), /Service Worker/);
  assert.match(pushSupportIssue({ isSecureContext: false }), /HTTPS/); // plain http hides the worker: name the real cause
  assert.match(pushSupportIssue({ serviceWorker: {} }), /Web Push/);
  assert.match(pushSupportIssue({ serviceWorker: {}, PushManager: function () {} }), /اعلان/);
  assert.match(
    pushSupportIssue({ serviceWorker: {}, PushManager: function () {}, Notification: function () {}, isSecureContext: false }),
    /HTTPS/,
  );
  assert.equal(
    pushSupportIssue({ serviceWorker: {}, PushManager: function () {}, Notification: function () {}, isSecureContext: true }),
    null,
  );
});

test("showPushNudge: only where push can work, not subscribed, not refused, not snoozed", async () => {
  const { showPushNudge, PUSH_NUDGE_LATER_MS } = await import("../src/push.js");
  const base = { issue: null, permission: "default", subscribed: false, laterAt: "", now: 1_000_000_000_000 };
  assert.equal(showPushNudge(base), true);
  assert.equal(showPushNudge({ ...base, issue: "no https" }), false);
  assert.equal(showPushNudge({ ...base, subscribed: true }), false);
  assert.equal(showPushNudge({ ...base, permission: "denied" }), false);
  assert.equal(showPushNudge({ ...base, laterAt: String(base.now - 1000) }), false);
  assert.equal(showPushNudge({ ...base, laterAt: String(base.now - PUSH_NUDGE_LATER_MS - 1) }), true);
});

test("enablePush subscribes and posts, or stops when permission is refused", async () => {
  const { enablePush } = await import("../src/push.js");
  const calls = [];
  const api = async (path, opts) => (calls.push([path, opts?.method || "GET"]), path === "/api/push/key" ? { publicKey: "aGk" } : {});
  const sub = { toJSON: () => ({ endpoint: "https://push.example/1", keys: { p256dh: "P", auth: "A" } }) };
  const serviceWorker = { ready: Promise.resolve({ pushManager: { subscribe: async () => sub } }) };
  assert.equal(await enablePush({ api, Notification: { requestPermission: async () => "denied" }, serviceWorker }), "refused");
  assert.deepEqual(calls, []);
  assert.equal(await enablePush({ api, Notification: { requestPermission: async () => "granted" }, serviceWorker }), "granted");
  assert.deepEqual(calls, [["/api/push/key", "GET"], ["/api/push/subscribe", "POST"]]);
});
