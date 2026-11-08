// Web Push helpers. Pure/testable pieces live here; the browser-API calls (Notification
// permission, ServiceWorkerRegistration.pushManager, fetch) stay in the component that uses them.
import { t } from "./i18n.js";

// A VAPID public key comes from the server as URL-safe base64; PushManager.subscribe wants raw
// bytes in a Uint8Array.
export function urlBase64ToUint8Array(base64) {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const base64Safe = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = typeof atob === "function" ? atob(base64Safe) : Buffer.from(base64Safe, "base64").toString("binary");
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) output[i] = raw.charCodeAt(i);
  return output;
}

// PushSubscription -> the plain JSON body the server's /api/push/subscribe expects.
export function subscriptionToJSON(subscription) {
  const json = typeof subscription.toJSON === "function" ? subscription.toJSON() : subscription;
  return {
    endpoint: json.endpoint,
    keys: {
      p256dh: json.keys?.p256dh || "",
      auth: json.keys?.auth || "",
    },
  };
}

// One place that decides whether the toggle can even be turned on, so the UI can explain why not
// instead of silently failing (e.g. no HTTPS, or Notification API missing on this browser).
// `serviceWorker` lives on navigator, not window (reading it off window made every browser look unsupported).
const browserSupport = () => (typeof window === "undefined" ? {} : { serviceWorker: navigator.serviceWorker, PushManager: window.PushManager, Notification: window.Notification, isSecureContext: window.isSecureContext });
export function pushSupportIssue({ serviceWorker, PushManager, Notification, isSecureContext } = browserSupport()) {
  // Browsers hide serviceWorker/PushManager on a plain-http address (LAN IP): say the real reason, not «unsupported».
  if (isSecureContext === false) return t("اعلان‌ها فقط روی HTTPS کار می‌کنند (نه آدرس LAN)");
  if (!serviceWorker) return t("این مرورگر از Service Worker پشتیبانی نمی‌کند");
  if (!PushManager) return t("این مرورگر از Web Push پشتیبانی نمی‌کند");
  if (!Notification) return t("این مرورگر از اعلان پشتیبانی نمی‌کند");
  if (isSecureContext === false) return t("اعلان‌ها فقط روی HTTPS کار می‌کنند (نه آدرس LAN)");
  return null;
}

// The corner card «اعلان را روشن کنید» (PushNudge.jsx): offered to everyone whose device has no
// subscription yet, not forced. «بعداً» puts it away for a week.
export const PUSH_NUDGE_LATER_KEY = "griffin.push.later";
export const PUSH_NUDGE_LATER_MS = 7 * 86_400_000;

/** Whether the card shows: push can work here, this device is not subscribed, permission was not refused, and «بعداً» is not still running. */
export function showPushNudge({ issue, permission, subscribed, laterAt, now = Date.now() }) {
  if (issue || subscribed || permission === "denied") return false;
  const at = Number(laterAt);
  return !(at > 0 && now - at < PUSH_NUDGE_LATER_MS);
}

/** Ask permission, subscribe this device and tell the server. Returns "granted" or "refused". */
export async function enablePush({ api, Notification: N = window.Notification, serviceWorker = navigator.serviceWorker }) {
  if ((await N.requestPermission()) !== "granted") return "refused";
  const { publicKey } = await api("/api/push/key");
  const registration = await serviceWorker.ready;
  const subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(publicKey) });
  await api("/api/push/subscribe", { method: "POST", body: subscriptionToJSON(subscription) });
  return "granted";
}
