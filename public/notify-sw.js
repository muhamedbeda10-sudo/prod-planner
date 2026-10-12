// Service worker for notifications only — no caching, no offline.
// It shows two kinds: the ones the open app raises itself (a chat message,
// the Odoo popup) and the pushes the server sends with the app closed (the
// assistant's inbox). Clicking one focuses the app's open tab — telling it
// what was clicked, or taking it to the page the push names — and with no tab
// open it opens one.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let d = {};
  try {
    d = event.data ? event.data.json() : {};
  } catch {
    d = { title: "ATC ERP", body: event.data ? event.data.text() : "" };
  }
  event.waitUntil(
    self.registration.showNotification(d.title || "ATC ERP", {
      body: d.body || "",
      tag: d.tag || undefined,
      icon: "/brand/logo-sm.png",
      badge: "/icons/icon-192.png",
      data: { url: d.url || "/inbox" },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  event.waitUntil(
    (async () => {
      const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const win = wins.find((w) => "focus" in w);
      if (win) {
        await win.focus();
        // the app's own alerts say what to open; a push names the page
        if (data.action) win.postMessage({ type: "notify-click", data });
        else if (data.url && "navigate" in win) await win.navigate(data.url).catch(() => self.clients.openWindow(data.url));
        return;
      }
      if (self.clients.openWindow) await self.clients.openWindow(data.url || "/");
    })(),
  );
});
