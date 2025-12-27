// public/sw.js

console.log("🛠️ Service Worker загружен");

// Кэшируем основные файлы для оффлайн-работы
const CACHE_NAME = "chat-cache-v1";
const FILES_TO_CACHE = [
  "/",
  "/index.html",
  "/style.css",
  "/manifest.json",
  // chat.js будет загружаться отдельно
];

// Установка Service Worker
self.addEventListener("install", (event) => {
  console.log("🛠️ Service Worker: Установка");

  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => {
        console.log("🛠️ Кэширую файлы");
        return cache.addAll(FILES_TO_CACHE);
      })
      .then(() => {
        console.log("🛠️ Пропускаю ожидание");
        return self.skipWaiting();
      })
  );
});
self.addEventListener("backgroundfetchsuccess", (event) => {
  console.log("✅ Background Fetch успешен");

  // Показываем уведомление о новых сообщениях
  event.waitUntil(
    self.registration.showNotification("💬 Чат", {
      body: "Получены новые сообщения",
      icon: "/icon-192.png",
      tag: "background-fetch",
    })
  );
});

// Активация Service Worker
self.addEventListener("activate", (event) => {
  console.log("🛠️ Service Worker: Активация");

  event.waitUntil(
    caches
      .keys()
      .then((cacheNames) => {
        return Promise.all(
          cacheNames.map((cacheName) => {
            if (cacheName !== CACHE_NAME) {
              console.log(`🛠️ Удаляю старый кэш: ${cacheName}`);
              return caches.delete(cacheName);
            }
          })
        );
      })
      .then(() => {
        console.log("🛠️ Service Worker активирован");
        return self.clients.claim();
      })
  );
});

// Перехват сетевых запросов
self.addEventListener("fetch", (event) => {
  // Игнорируем WebSocket и динамические запросы
  if (
    event.request.url.startsWith("ws://") ||
    event.request.url.startsWith("wss://") ||
    event.request.url.includes("/api/")
  ) {
    return;
  }

  event.respondWith(
    caches.match(event.request).then((response) => {
      // Если файл есть в кэше, возвращаем его
      if (response) {
        return response;
      }

      // Иначе загружаем из сети
      return fetch(event.request);
    })
  );
});

// Получение push-уведомлений
self.addEventListener("push", (event) => {
  console.log("📨 Получено push-уведомление:", event);

  if (!event.data) return;

  const data = event.data.json();
  console.log("📨 Данные уведомления:", data);

  const options = {
    body: data.body || "Новое сообщение в чате",
    icon: data.icon || "/icon-192.png",
    badge: "/badge-72.png",
    vibrate: [200, 100, 200],
    data: {
      url: data.url || "/",
      username: data.username,
      messageId: data.messageId,
    },
    actions: [
      { action: "open", title: "📱 Открыть чат" },
      { action: "dismiss", title: "❌ Закрыть" },
    ],
    tag: "chat-message",
    renotify: true,
    requireInteraction: false,
  };

  event.waitUntil(
    self.registration.showNotification(data.title || "💬 Чат", options)
  );
});

// Обработка кликов по уведомлению
self.addEventListener("notificationclick", (event) => {
  console.log("👆 Клик по уведомлению:", event.notification.tag);

  event.notification.close();

  if (event.action === "open" || event.action === "") {
    // Фокусируем/открываем окно чата
    event.waitUntil(
      clients
        .matchAll({
          type: "window",
          includeUncontrolled: true,
        })
        .then((windowClients) => {
          // Ищем уже открытое окно
          for (const client of windowClients) {
            if (client.url.includes("/") && "focus" in client) {
              console.log("📱 Фокусирую существующее окно");
              return client.focus();
            }
          }

          // Открываем новое окно
          if (clients.openWindow) {
            console.log("📱 Открываю новое окно");
            return clients.openWindow("/");
          }
        })
    );
  }
});

// Фоновая синхронизация (для iOS)
self.addEventListener("sync", (event) => {
  console.log("🔄 Фоновая синхронизация:", event.tag);

  if (event.tag === "check-messages") {
    event.waitUntil(checkForNewMessages());
  }
});

// Проверка новых сообщений в фоне
async function checkForNewMessages() {
  console.log("🔍 Проверяю новые сообщения в фоне...");

  try {
    // Получаем время последнего сообщения из IndexedDB
    const lastCheck = await getLastCheckTime();

    // Здесь будет запрос к серверу через API
    // Пока просто показываем уведомление
    self.registration.showNotification("💬 Чат", {
      body: "Проверены новые сообщения",
      icon: "/icon-192.png",
      tag: "background-sync",
    });

    // Обновляем время последней проверки
    await updateLastCheckTime(Date.now());
  } catch (error) {
    console.error("❌ Ошибка фоновой синхронизации:", error);
  }
}

// Храним время последней проверки в IndexedDB
async function getLastCheckTime() {
  return new Promise((resolve) => {
    const request = indexedDB.open("chatDB", 1);

    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains("sync")) {
        db.createObjectStore("sync", { keyPath: "id" });
      }
    };

    request.onsuccess = (event) => {
      const db = event.target.result;
      const transaction = db.transaction("sync", "readonly");
      const store = transaction.objectStore("sync");
      const getRequest = store.get("lastCheck");

      getRequest.onsuccess = () => {
        resolve(getRequest.result ? getRequest.result.value : 0);
      };

      getRequest.onerror = () => resolve(0);
    };

    request.onerror = () => resolve(0);
  });
}

async function updateLastCheckTime(time) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("chatDB", 1);

    request.onsuccess = (event) => {
      const db = event.target.result;
      const transaction = db.transaction("sync", "readwrite");
      const store = transaction.objectStore("sync");
      const putRequest = store.put({ id: "lastCheck", value: time });

      putRequest.onsuccess = () => resolve();
      putRequest.onerror = () => reject();
    };

    request.onerror = () => reject();
  });
}

// Периодическая фоновая синхронизация (раз в 15 минут)
self.addEventListener("periodicsync", (event) => {
  if (event.tag === "chat-periodic-sync") {
    console.log("🔄 Периодическая фоновая синхронизация");
    event.waitUntil(checkForNewMessages());
  }
});
