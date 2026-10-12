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
export function pushSupportIssue({ serviceWorker, PushManager, Notification, isSecureContext } = typeof window !== "undefined" ? window : {}) {
  if (!serviceWorker) return t("این مرورگر از Service Worker پشتیبانی نمی‌کند");
  if (!PushManager) return t("این مرورگر از Web Push پشتیبانی نمی‌کند");
  if (!Notification) return t("این مرورگر از اعلان پشتیبانی نمی‌کند");
  if (isSecureContext === false) return t("اعلان‌ها فقط روی HTTPS کار می‌کنند (نه آدرس LAN)");
  return null;
}
