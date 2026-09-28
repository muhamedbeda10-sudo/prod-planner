// Service worker for system notifications only — no caching, no offline.
// Clicking a notification focuses the app's open tab and tells it what was
// clicked (open this chat / the Odoo popup); with no tab open it opens one.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  event.waitUntil(
    (async () => {
      const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const win = wins.find((w) => "focus" in w);
      if (win) {
        await win.focus();
        win.postMessage({ type: "notify-click", data });
        return;
      }
      if (self.clients.openWindow) await self.clients.openWindow(data.url || "/");
    })(),
  );
});
