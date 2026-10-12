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
