// Service worker: Web Push only (no offline caching — the app is always fetched fresh).
// `push` shows a notification with the chat title and a short line; `notificationclick` opens
// the chat if no tab has it, or focuses the tab that already does.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { title: "Griffin", body: event.data ? event.data.text() : "" };
  }
  const title = payload.title || "Griffin";
  const url = payload.url || "/";
  event.waitUntil(
    self.registration.showNotification(title, {
      body: payload.body || "",
      icon: "/icon.svg",
      badge: "/icon.svg",
      dir: "auto",
      tag: url, // a second push for the same chat replaces the first instead of stacking
      data: { url },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data?.url || "/";
  event.waitUntil(
    (async () => {
      const clientsList = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const target = clientsList.find((c) => {
        try {
          return new URL(c.url).hash === new URL(url, c.url).hash;
        } catch {
          return false;
        }
      }) || clientsList[0];
      if (target) {
        await target.focus();
        if ("navigate" in target) await target.navigate(url).catch(() => {});
        target.postMessage({ type: "griffin:navigate", url });
        return;
      }
      await self.clients.openWindow(url);
    })(),
  );
});
