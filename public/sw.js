// Service Worker для PWA и уведомлений
const CACHE_NAME = "simple-chat-v1";
const urlsToCache = [
  "/",
  "/index.html",
  "/style.css",
  "/client.js",
  "/manifest.json",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(urlsToCache))
  );
});

self.addEventListener("fetch", (event) => {
  event.respondWith(
    caches
      .match(event.request)
      .then((response) => response || fetch(event.request))
  );
});

self.addEventListener("push", (event) => {
  const data = event.data.json();

  const options = {
    body: data.body || "Новое сообщение",
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    vibrate: [200, 100, 200],
    data: {
      url: data.url || "/",
    },
    actions: [
      {
        action: "open",
        title: "Открыть чат",
      },
      {
        action: "close",
        title: "Закрыть",
      },
    ],
  };

  event.waitUntil(
    self.registration.showNotification(data.title || "Чат", options)
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  if (event.action === "open") {
    event.waitUntil(clients.openWindow(event.notification.data.url));
  }
});

self.addEventListener("sync", (event) => {
  if (event.tag === "sync-messages") {
    event.waitUntil(syncMessages());
  }
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (cacheName !== CACHE_NAME) {
            return caches.delete(cacheName);
          }
        })
      );
    })
  );
});
