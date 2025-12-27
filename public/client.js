class SimpleChat {
  constructor() {
    // Автоматическое определение адреса WebSocket
    this.WS_SERVER = this.getWebSocketUrl();

    // Состояние
    this.username = "";
    this.socket = null;
    this.isConnected = false;
    this.messages = [];
    this.autoLoginAttempted = false;
    this.pendingMessages = new Map();
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 5;

    // Для iPhone уведомлений
    this.isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
    this.isPWA = window.matchMedia("(display-mode: standalone)").matches;
    this.isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
    this.isTabActive = true;
    this.unreadCount = 0;
    this.originalTitle = document.title;

    // Новые свойства для оффлайн-работы
    this.offlineMessages = [];
    this.unsentMessages = [];
    this.userStatus = "offline";
    this.lastActivity = Date.now();
    this.heartbeatInterval = null;
    this.reconnectTimeout = null;
    this.isBackground = false;
    this.isReconnecting = false;
    this.messageQueue = [];
    this.isProcessingQueue = false;
    this.sessionId = null;

    // Для Service Worker
    this.serviceWorkerRegistration = null;
    this.backgroundSyncSupported = false;

    // Элементы DOM
    this.loginScreen = document.getElementById("login-screen");
    this.chatScreen = document.getElementById("chat-screen");
    this.usernameInput = document.getElementById("username");
    this.loginBtn = document.getElementById("login-btn");
    this.messagesContainer = document.getElementById("messages-container");
    this.messageInput = document.getElementById("message-input");
    this.sendBtn = document.getElementById("send-btn");
    this.backBtn = document.getElementById("back-btn");
    this.clearBtn = document.getElementById("clear-btn");
    this.onlineCount = document.getElementById("online-count");
    this.connectionStatus = document.getElementById("connection-status");
    this.emptyState = document.getElementById("empty-state");

    // Новые элементы DOM для статусов (если есть)
    this.usersList = document.getElementById("users-list");
    this.userStatusIndicator = document.getElementById("user-status");

    this.init();
  }

  getWebSocketUrl() {
    if (
      window.location.hostname === "localhost" ||
      window.location.hostname === "127.0.0.1"
    ) {
      return "ws://localhost:3000";
    }

    const wsProtocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    return `${wsProtocol}//${window.location.host}`;
  }

  init() {
    this.setupEventListeners();
    this.loadFromStorage();
    this.loadOfflineData();
    this.checkAutoLogin();
    this.setupIOSFeatures();
    this.setupActivityTracking();
    this.setupVisibilityHandlers();
    this.setupServiceWorker();
  }

  setupEventListeners() {
    // Вход
    this.loginBtn.addEventListener("click", () => this.login());
    this.usernameInput.addEventListener("keypress", (e) => {
      if (e.key === "Enter") this.login();
    });

    // Отправка сообщений
    this.sendBtn.addEventListener("click", () => this.sendMessage());
    this.messageInput.addEventListener("keypress", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        this.sendMessage();
      }
    });
    this.messageInput.addEventListener("input", () => {
      this.sendBtn.disabled = !this.messageInput.value.trim();
    });

    // Навигация
    this.backBtn.addEventListener("click", () => this.goBack());
    this.clearBtn.addEventListener("click", () => this.clearChat());

    // Сохранение состояния
    window.addEventListener("beforeunload", () => {
      this.saveToStorage();
      this.saveOfflineData();
    });

    // Восстановление соединения
    document.addEventListener("visibilitychange", () => {
      this.handleVisibilityChange();
    });

    // Focus/blur для отслеживания активности вкладки
    window.addEventListener("focus", () => {
      this.isTabActive = true;
      this.resetUnreadCount();
    });

    window.addEventListener("blur", () => {
      this.isTabActive = false;
    });
  }

  setupIOSFeatures() {
    console.log("📱 Устройство:", this.isIOS ? "iPhone/iPad" : "Не iOS");
    console.log("🌐 Браузер:", this.isSafari ? "Safari" : "Другой");
    console.log(
      "📲 PWA режим:",
      this.isPWA ? "Да (добавлен на домашний экран)" : "Нет"
    );

    // Для iOS Safari: инициализируем звук уведомления
    this.setupNotificationSound();

    // Для iOS: запрашиваем разрешение на уведомления после первого клика
    this.setupIOSNotificationPermission();
  }

  setupNotificationSound() {
    // Создаем звуковой элемент для уведомлений
    this.notificationSound = new Audio();
    this.notificationSound.preload = "auto";

    // Используем простой бип-звук через data URL
    const beepSound =
      "data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=";
    this.notificationSound.src = beepSound;
  }

  setupIOSNotificationPermission() {
    if (!this.isIOS) return;

    // На iOS Safari запрашиваем разрешение при первом клике пользователя
    const requestPermission = () => {
      if ("Notification" in window && Notification.permission === "default") {
        // На iOS Safari запрашиваем только если в PWA режиме
        if (this.isPWA) {
          Notification.requestPermission().then((permission) => {
            console.log("Разрешение на уведомления:", permission);
          });
        }
      }
      document.removeEventListener("click", requestPermission);
    };

    document.addEventListener("click", requestPermission, { once: true });
  }

  setupActivityTracking() {
    // Отслеживаем активность пользователя
    const updateActivity = () => {
      this.lastActivity = Date.now();

      // Если мы away, возвращаемся в online
      if (this.userStatus === "away" && this.isConnected) {
        this.updateUserStatus("online");
      }
    };

    // Слушаем события активности
    document.addEventListener("mousemove", updateActivity);
    document.addEventListener("keydown", updateActivity);
    document.addEventListener("click", updateActivity);
    document.addEventListener("touchstart", updateActivity);

    // Heartbeat каждые 20 секунд
    this.heartbeatInterval = setInterval(() => {
      if (this.isConnected && this.isLoggedIn()) {
        this.sendHeartbeat();
      }
    }, 20000);

    // Проверяем активность каждую минуту
    setInterval(() => {
      if (this.isLoggedIn() && !this.isBackground) {
        const inactiveTime = Date.now() - this.lastActivity;

        if (inactiveTime > 30000 && this.userStatus === "online") {
          this.updateUserStatus("away");
        }
      }
    }, 60000);
  }

  setupVisibilityHandlers() {
    // Следим за видимостью страницы
    document.addEventListener("visibilitychange", () => {
      this.isBackground = document.hidden;

      if (this.isBackground) {
        // Приложение свернуто
        console.log("📱 Приложение ушло в фон");
        this.onAppBackground();
      } else {
        // Приложение снова активно
        console.log("📱 Приложение на переднем плане");
        this.onAppForeground();
      }
    });

    // Слушаем события страницы
    window.addEventListener("pagehide", () => this.onAppBackground());
    window.addEventListener("pageshow", () => this.onAppForeground());
  }

  setupServiceWorker() {
    if ("serviceWorker" in navigator) {
      console.log("🛠️ Регистрирую Service Worker...");

      navigator.serviceWorker
        .register("/sw.js")
        .then((registration) => {
          this.serviceWorkerRegistration = registration;
          console.log("✅ Service Worker зарегистрирован");

          // Проверяем поддержку фоновой синхронизации
          if ("sync" in registration) {
            this.backgroundSyncSupported = true;
            console.log("✅ Фоновая синхронизация (one-time) поддерживается");
          }
        })
        .catch((error) => {
          console.error("❌ Ошибка регистрации Service Worker:", error);
        });
    }
  }

  handleVisibilityChange() {
    if (document.visibilityState === "visible") {
      this.isTabActive = true;
      this.resetUnreadCount();

      if (!this.isConnected && this.isLoggedIn()) {
        this.connectWebSocket();
      }
    } else {
      this.isTabActive = false;
    }
  }

  onAppBackground() {
    this.isBackground = true;
    console.log("📱 Приложение ушло в фон");

    // Сохраняем неотправленные сообщения
    this.savePendingMessages();

    // Регистрируем фоновую синхронизацию если поддерживается
    if (this.backgroundSyncSupported && this.serviceWorkerRegistration) {
      this.registerBackgroundSync();
    }

    // Heartbeat реже в фоне
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = setInterval(() => {
        if (this.isConnected && this.isLoggedIn()) {
          this.sendHeartbeat();
        } else {
          // Пытаемся переподключиться в фоне
          this.connectWebSocket();
        }
      }, 60000); // Каждую минуту в фоне
    }

    // Обновляем статус
    if (this.isLoggedIn()) {
      this.updateUserStatus("away");
    }
  }

  onAppForeground() {
    this.isBackground = false;
    console.log("📱 Приложение на переднем плане");

    // Восстанавливаем обычную частоту heartbeat
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = setInterval(() => {
        if (this.isConnected && this.isLoggedIn()) {
          this.sendHeartbeat();
        }
      }, 20000); // Каждые 20 секунд на переднем плане
    }

    // Обновляем активность
    this.lastActivity = Date.now();

    if (this.isLoggedIn()) {
      this.updateUserStatus("online");

      // Если соединение потеряно, пытаемся переподключиться
      if (!this.isConnected) {
        this.connectWebSocket();
      }
    }

    // Показываем сохраненные уведомления
    this.showSavedNotifications();
  }

  registerBackgroundSync() {
    if (
      this.serviceWorkerRegistration &&
      "sync" in this.serviceWorkerRegistration
    ) {
      this.serviceWorkerRegistration.sync
        .register("check-messages")
        .then(() => {
          console.log("🔄 Background Sync зарегистрирован");
        })
        .catch((err) => {
          console.log("❌ Background Sync не поддерживается:", err);
        });
    }
  }

  // iPhone-специфичные уведомления
  showIOSNotification(title, body) {
    if (!this.isIOS) return;

    // 1. Обновляем заголовок вкладки с количеством непрочитанных
    this.unreadCount++;
    this.updateTabTitle();

    // 2. Вибрация (если поддерживается)
    if (navigator.vibrate) {
      navigator.vibrate([200, 100, 200]);
    }

    // 3. Звуковое уведомление (если не в беззвучном режиме)
    if (!this.isTabActive) {
      this.playNotificationSound();
    }

    // 4. Показываем браузерное уведомление (если разрешено и не в PWA режиме)
    if (
      "Notification" in window &&
      Notification.permission === "granted" &&
      !this.isPWA
    ) {
      this.showBrowserNotification(title, body);
    }

    // 5. Для PWA режима обновляем бейдж иконки
    if (this.isPWA && navigator.setAppBadge) {
      navigator.setAppBadge(this.unreadCount).catch(console.error);
    }

    // 6. Сохраняем уведомление
    this.saveNotification(title, body);
  }

  saveNotification(title, body) {
    // Сохраняем уведомление в localStorage
    const notifications = JSON.parse(
      localStorage.getItem("chat_notifications") || "[]"
    );
    notifications.push({
      title,
      body,
      timestamp: Date.now(),
      read: false,
    });

    // Храним только последние 20 уведомлений
    if (notifications.length > 20) {
      notifications.splice(0, notifications.length - 20);
    }

    localStorage.setItem("chat_notifications", JSON.stringify(notifications));
  }

  showSavedNotifications() {
    // Показываем все непрочитанные уведомления при возвращении
    if (!this.isTabActive) return;

    const notifications = JSON.parse(
      localStorage.getItem("chat_notifications") || "[]"
    );
    const unread = notifications.filter((n) => !n.read);

    if (unread.length > 0) {
      // Показываем сводное уведомление
      this.showBrowserNotification(
        "💬 Чат",
        `У вас ${unread.length} непрочитанных сообщений`
      );

      // Помечаем как прочитанные
      notifications.forEach((n) => (n.read = true));
      localStorage.setItem("chat_notifications", JSON.stringify(notifications));

      this.resetUnreadCount();
    }
  }

  updateTabTitle() {
    if (this.unreadCount > 0) {
      document.title = `(${this.unreadCount}) ${this.originalTitle}`;
    } else {
      document.title = this.originalTitle;
    }
  }

  resetUnreadCount() {
    this.unreadCount = 0;
    this.updateTabTitle();

    // Сбрасываем бейдж в PWA
    if (this.isPWA && navigator.clearAppBadge) {
      navigator.clearAppBadge().catch(console.error);
    }
  }

  playNotificationSound() {
    if (this.notificationSound) {
      this.notificationSound.currentTime = 0;
      this.notificationSound.play().catch((e) => {
        // На iOS авто-воспроизведение может быть ограничено
        console.log("Не удалось воспроизвести звук:", e.message);
      });
    }
  }

  showBrowserNotification(title, body) {
    if (!("Notification" in window) || Notification.permission !== "granted") {
      return;
    }

    const notification = new Notification(title, {
      body: body,
      icon: "/favicon.ico",
      tag: "chat-notification",
      requireInteraction: false,
      silent: true, // На iOS звук управляется системой
    });

    notification.onclick = () => {
      window.focus();
      notification.close();
    };

    setTimeout(() => notification.close(), 5000);
  }

  loadFromStorage() {
    try {
      const savedState = localStorage.getItem("chat_state");
      if (savedState) {
        const state = JSON.parse(savedState);

        if (state.username) {
          this.usernameInput.value = state.username;
        }

        if (state.messages && Array.isArray(state.messages)) {
          this.messages = state.messages.map((msg) => ({
            ...msg,
            pending: false,
          }));
        }
      }
    } catch (error) {
      console.error("Ошибка загрузки из localStorage:", error);
    }
  }

  saveToStorage() {
    try {
      const nonPendingMessages = this.messages
        .filter((msg) => !msg.pending)
        .slice(-50);

      const state = {
        username: this.username,
        messages: nonPendingMessages,
        timestamp: Date.now(),
      };

      localStorage.setItem("chat_state", JSON.stringify(state));
    } catch (error) {
      console.error("Ошибка сохранения в localStorage:", error);
    }
  }

  // НОВЫЙ МЕТОД для сохранения неотправленных сообщений
  savePendingMessages() {
    // Сохраняем неотправленные сообщения в localStorage
    if (this.unsentMessages && this.unsentMessages.length > 0) {
      try {
        localStorage.setItem(
          "chat_unsent_messages",
          JSON.stringify(this.unsentMessages)
        );
        console.log(
          `💾 Сохранено ${this.unsentMessages.length} неотправленных сообщений`
        );
      } catch (e) {
        console.error("❌ Ошибка сохранения неотправленных сообщений:", e);
      }
    }

    // Также сохраняем оффлайн-сообщения
    this.saveOfflineData();
  }

  loadOfflineData() {
    // Загружаем оффлайн-сообщения
    try {
      const saved = localStorage.getItem("chat_offline_messages");
      if (saved) {
        this.offlineMessages = JSON.parse(saved);
        console.log(
          `📂 Загружено ${this.offlineMessages.length} оффлайн-сообщений`
        );
      }
    } catch (e) {
      console.error("❌ Ошибка загрузки оффлайн-сообщений:", e);
    }

    // Загружаем неотправленные сообщения
    try {
      const saved = localStorage.getItem("chat_unsent_messages");
      if (saved) {
        this.unsentMessages = JSON.parse(saved);
        console.log(
          `📂 Загружено ${this.unsentMessages.length} неотправленных сообщений`
        );

        // Восстанавливаем неотправленные сообщения в чат
        this.unsentMessages.forEach((item) => {
          // Проверяем, нет ли уже такого сообщения в чате
          const exists = this.messages.some(
            (msg) => msg.id === item.message.id
          );
          if (!exists && item.localMessage) {
            // Добавляем в чат как pending
            item.localMessage.pending = true;
            item.localMessage.failed = false;
            item.localMessage.attempts = item.localMessage.attempts || 0;
            this.messages.push(item.localMessage);
          }
        });

        // Перерисовываем чат
        if (this.unsentMessages.length > 0) {
          setTimeout(() => this.renderMessages(), 100);
        }
      }
    } catch (e) {
      console.error("❌ Ошибка загрузки неотправленных сообщений:", e);
    }
  }

  saveOfflineData() {
    // Сохраняем оффлайн-сообщения
    try {
      localStorage.setItem(
        "chat_offline_messages",
        JSON.stringify(this.offlineMessages.slice(-100))
      ); // Последние 100
    } catch (e) {
      console.error("❌ Ошибка сохранения оффлайн-сообщений:", e);
    }

    // Сохраняем неотправленные сообщения
    try {
      localStorage.setItem(
        "chat_unsent_messages",
        JSON.stringify(this.unsentMessages)
      );
    } catch (e) {
      console.error("❌ Ошибка сохранения неотправленных сообщений:", e);
    }
  }

  clearStorage() {
    localStorage.removeItem("chat_state");
    localStorage.removeItem("chat_username");
  }

  isLoggedIn() {
    return !!this.username && this.username.trim().length > 0;
  }

  checkAutoLogin() {
    const savedUsername = localStorage.getItem("chat_username");
    const savedState = localStorage.getItem("chat_state");

    if (savedUsername && savedState && !this.autoLoginAttempted) {
      try {
        const state = JSON.parse(savedState);
        const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;

        if (state.timestamp && state.timestamp > twoHoursAgo) {
          this.autoLoginAttempted = true;

          setTimeout(() => {
            this.username = savedUsername;
            this.loginScreen.classList.remove("active");
            this.chatScreen.classList.add("active");
            this.connectWebSocket();
          }, 300);

          return;
        }
      } catch (error) {
        console.error("Ошибка авто-входа:", error);
      }
    }

    setTimeout(() => {
      this.usernameInput.focus();
    }, 300);
  }

  login() {
    const username = this.usernameInput.value.trim();

    if (!username) {
      this.showNotification("Введите имя");
      this.usernameInput.focus();
      return;
    }

    if (username.length < 2) {
      this.showNotification("Имя должно быть минимум 2 символа");
      return;
    }

    if (username.length > 20) {
      this.showNotification("Имя должно быть не более 20 символов");
      return;
    }

    this.username = username;
    localStorage.setItem("chat_username", username);
    this.saveToStorage();

    this.loginScreen.classList.remove("active");
    this.chatScreen.classList.add("active");
    this.connectWebSocket();

    setTimeout(() => {
      this.messageInput.focus();
    }, 300);
  }

  // ИСПРАВЛЕННЫЙ МЕТОД connectWebSocket - решает проблему "Still in CONNECTING state"
  connectWebSocket() {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      console.log("✅ WebSocket уже открыт");
      return;
    }

    // Если сокет в состоянии CONNECTING, не создаем новый
    if (this.socket && this.socket.readyState === WebSocket.CONNECTING) {
      console.log("⏳ WebSocket уже подключается, ждем...");
      return;
    }

    // Закрываем старый сокет если есть
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }

    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.showNotification("Не удалось подключиться. Проверьте интернет.");
      return;
    }

    this.updateConnectionStatus("Подключение...");

    try {
      this.socket = new WebSocket(this.WS_SERVER);
      console.log(
        "🔌 Создан новый WebSocket, состояние:",
        this.socket.readyState
      );

      // Даем WebSocket время на установление соединения
      setTimeout(() => {
        this.setupWebSocketHandlers();
      }, 100);
    } catch (error) {
      console.error("❌ Ошибка подключения:", error);
      this.showNotification("Ошибка подключения к серверу");
    }
  }

  setupWebSocketHandlers() {
    if (!this.socket) return;

    this.socket.onopen = () => {
      console.log("✅ WebSocket onopen, состояние:", this.socket.readyState);

      // ДАЕМ ВРЕМЯ WebSocket ПОЛНОСТЬЮ ОТКРЫТЬСЯ - это решает проблему "Still in CONNECTING state"
      setTimeout(() => {
        if (this.socket && this.socket.readyState === WebSocket.OPEN) {
          this.isConnected = true;
          this.reconnectAttempts = 0;
          this.updateConnectionStatus("В сети");

          // Отправляем join сообщение
          this.sendJoinMessage();

          // Пытаемся отправить все неотправленные сообщения
          this.resendUnsentMessages();

          // Показываем оффлайн-сообщения
          this.showOfflineMessages();

          if (this.messages.length > 0) {
            this.renderMessages();
          }

          this.showNotification("Подключено к чату");
        } else {
          console.warn("⚠️ WebSocket не открыт после onopen");
        }
      }, 200); // Увеличиваем задержку
    };

    this.socket.onmessage = (event) => {
      console.log("📨 Получено сообщение от сервера:", event.data);
      try {
        const data = JSON.parse(event.data);
        console.log("📨 Парсинг сообщения типа:", data.type);
        this.handleWebSocketMessage(data);
        this.saveToStorage();
      } catch (error) {
        console.error(
          "Ошибка парсинга сообщения:",
          error,
          "Данные:",
          event.data
        );
      }
    };

    this.socket.onclose = (event) => {
      console.log(
        "🔌 WebSocket закрыт, код:",
        event.code,
        "причина:",
        event.reason
      );

      this.isConnected = false;
      this.reconnectAttempts++;

      if (event.code === 1006) {
        this.updateConnectionStatus("Переподключение...");
      } else {
        this.updateConnectionStatus("Отключено");
      }

      // Пытаемся переподключиться
      if (this.isLoggedIn() && !this.isReconnecting) {
        this.scheduleReconnect();
      }
    };

    this.socket.onerror = (error) => {
      console.error("❌ WebSocket ошибка:", error);
      this.updateConnectionStatus("Ошибка подключения");
    };
  }
  sendJoinMessage() {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      const joinMessage = {
        type: "join",
        username: this.username,
        timestamp: Date.now(),
        device: this.getDeviceInfo(),
        sessionId: this.sessionId || this.generateSessionId(),
      };

      try {
        this.socket.send(JSON.stringify(joinMessage));
        console.log("👋 Отправлен join для пользователя:", this.username);
      } catch (error) {
        console.error("❌ Ошибка отправки join:", error);
        // Пытаемся снова через 2 секунды
        setTimeout(() => this.sendJoinMessage(), 2000);
      }
    } else {
      console.warn("⚠️ WebSocket не готов для отправки join");
      // Пытаемся снова через 1 секунду
      setTimeout(() => this.sendJoinMessage(), 1000);
    }
  }
  resendUnsentMessages() {
    if (!this.unsentMessages || this.unsentMessages.length === 0) {
      return;
    }

    console.log(
      `📤 Пытаюсь повторно отправить ${this.unsentMessages.length} неотправленных сообщений`
    );

    // Отправляем каждое сообщение с задержкой
    this.unsentMessages.forEach((item, index) => {
      setTimeout(() => {
        if (
          this.isConnected &&
          this.socket &&
          this.socket.readyState === WebSocket.OPEN
        ) {
          // Находим соответствующее локальное сообщение
          const localMessage = this.messages.find(
            (msg) => msg.id === item.message.id
          );
          if (localMessage && localMessage.pending) {
            // Сбрасываем счетчик попыток
            localMessage.attempts = 0;
            // Пытаемся отправить снова
            this.attemptToSend(item.message, localMessage);
          }
        }
      }, index * 500); // Задержка 500мс между сообщениями
    });
  }

  // Безопасная отправка сообщений с очередью
  safeSend(message) {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      try {
        this.socket.send(JSON.stringify(message));
        console.log("📤 Отправлено:", message.type);
        return true;
      } catch (error) {
        console.error("❌ Ошибка отправки сообщения:", error);
        // Добавляем в очередь при ошибке
        this.messageQueue.push(message);
        this.processMessageQueue();
        return false;
      }
    } else {
      // Добавляем в очередь
      this.messageQueue.push(message);
      console.log(
        "📦 Сообщение добавлено в очередь, размер очереди:",
        this.messageQueue.length
      );

      // Запускаем обработку очереди если не запущена
      if (!this.isProcessingQueue) {
        this.processMessageQueue();
      }

      return false;
    }
  }

  // Обработка очереди сообщений
  processMessageQueue() {
    if (this.messageQueue.length === 0) {
      this.isProcessingQueue = false;
      return;
    }

    this.isProcessingQueue = true;

    const processNext = () => {
      if (this.messageQueue.length === 0) {
        this.isProcessingQueue = false;
        return;
      }

      if (this.socket && this.socket.readyState === WebSocket.OPEN) {
        const message = this.messageQueue.shift();

        try {
          this.socket.send(JSON.stringify(message));
          console.log("📤 Отправлено из очереди:", message.type);
        } catch (error) {
          console.error("❌ Ошибка отправки из очереди:", error);
          // Возвращаем сообщение в начало очереди
          this.messageQueue.unshift(message);
        }

        // Обрабатываем следующее сообщение
        setTimeout(processNext, 50);
      } else {
        // WebSocket не готов, ждем
        console.log("⏳ WebSocket не готов, ждем...");
        setTimeout(() => {
          if (this.socket && this.socket.readyState === WebSocket.OPEN) {
            processNext();
          } else {
            // Если через 5 секунд все еще не готов, останавливаем
            setTimeout(() => this.processMessageQueue(), 5000);
          }
        }, 1000);
      }
    };

    processNext();
  }

  scheduleReconnect() {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
    }

    this.isReconnecting = true;

    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
    console.log(
      `🔄 Переподключение через ${delay}ms (попытка ${this.reconnectAttempts})`
    );

    this.reconnectTimeout = setTimeout(() => {
      this.isReconnecting = false;
      this.connectWebSocket();
    }, delay);
  }

  generateSessionId() {
    this.sessionId =
      Date.now().toString(36) + Math.random().toString(36).substr(2, 9);
    return this.sessionId;
  }

  getDeviceInfo() {
    const userAgent = navigator.userAgent;
    let device = "desktop";

    if (/iPhone|iPad|iPod/.test(userAgent)) device = "ios";
    else if (/Android/.test(userAgent)) device = "android";
    else if (/Windows/.test(userAgent)) device = "windows";
    else if (/Mac/.test(userAgent)) device = "mac";

    return {
      device: device,
      isPWA: this.isPWA,
      isSafari: this.isSafari,
      userAgent: userAgent.substring(0, 100),
    };
  }

  sendPendingMessages() {
    if (this.unsentMessages.length > 0 && this.isConnected) {
      console.log(
        `📤 Отправляю ${this.unsentMessages.length} ожидающих сообщений`
      );

      this.unsentMessages.forEach((item) => {
        this.pendingMessages.set(item.message.id, item.localId);
        this.safeSend(item.message);
      });

      this.unsentMessages = [];
      this.saveOfflineData();
    }
  }

  showOfflineMessages() {
    if (this.offlineMessages.length > 0) {
      console.log(
        `📨 Показываю ${this.offlineMessages.length} оффлайн-сообщений`
      );

      // Сортируем по времени
      this.offlineMessages.sort((a, b) => a.timestamp - b.timestamp);

      // Добавляем в чат
      this.offlineMessages.forEach((msg) => {
        if (!this.messages.some((m) => m.id === msg.id)) {
          this.messages.push({
            ...msg,
            isOwn: msg.username === this.username,
            pending: false,
            offline: true,
          });
        }
      });

      // Очищаем оффлайн-сообщения
      this.offlineMessages = [];
      this.saveOfflineData();

      // Перерисовываем чат
      this.renderMessages();
    }
  }

  handleWebSocketMessage(data) {
    switch (data.type) {
      case "history":
        this.mergeMessagesWithHistory(data.messages || []);
        break;

      case "message":
        this.handleNewMessage(data);
        break;

      case "user_joined":
        this.showNotification(`${data.username} присоединился`);
        this.updateOnlineCount(data.onlineCount);
        break;

      case "user_left":
        this.showNotification(`${data.username} вышел`);
        this.updateOnlineCount(data.onlineCount);
        break;

      case "online_count":
        this.updateOnlineCount(data.count);
        break;

      case "clear_chat":
        this.messages = [];
        this.pendingMessages.clear();
        this.renderMessages();
        this.saveToStorage();
        this.showNotification("Чат очищен");
        break;

      case "error":
        this.showNotification(`Ошибка: ${data.message}`);
        if (data.message.includes("уже в чате")) {
          setTimeout(() => this.goBack(), 2000);
        }
        break;

      case "user_status":
        this.handleUserStatus(data);
        break;

      case "users_list":
        this.handleUsersList(data);
        break;

      case "heartbeat_ack":
        // Подтверждение heartbeat получено
        console.log("💓 Heartbeat подтвержден");
        break;
    }
  }

  handleUserStatus(data) {
    // Обновляем статус пользователя
    if (data.username === this.username) {
      this.userStatus = data.status;
    }
  }

  handleUsersList(data) {
    // Пока просто логируем
    console.log("👥 Получен список пользователей:", data.users);
  }

  updateUserStatus(status) {
    if (this.userStatus !== status && this.username) {
      this.userStatus = status;

      // Отправляем на сервер через safeSend
      this.safeSend({
        type: "user_status",
        status: status,
        username: this.username,
        timestamp: Date.now(),
      });

      console.log(`🔄 Статус изменен: ${status}`);
    }
  }

  getStatusText(status) {
    const statusTexts = {
      online: "В сети",
      away: "Отошел",
      offline: "Не в сети",
    };
    return statusTexts[status] || status;
  }

  sendHeartbeat() {
    const heartbeat = {
      type: "heartbeat",
      timestamp: Date.now(),
      username: this.username,
    };

    this.safeSend(heartbeat);
  }

  mergeMessagesWithHistory(serverMessages) {
    // Создаем Set для быстрой проверки ID сообщений
    const existingMessageIds = new Set(this.messages.map((msg) => msg.id));

    // Добавляем только новые сообщения
    serverMessages.forEach((serverMsg) => {
      if (!existingMessageIds.has(serverMsg.id)) {
        this.messages.push({
          ...serverMsg,
          isOwn: serverMsg.username === this.username,
          pending: false,
        });
      }
    });

    // Сортируем по времени
    this.messages.sort((a, b) => a.timestamp - b.timestamp);

    // Ограничиваем количество сообщений
    if (this.messages.length > 200) {
      this.messages = this.messages.slice(-200);
    }

    this.renderMessages();
  }

  renderMessages() {
    this.messagesContainer.innerHTML = "";

    if (this.messages.length === 0) {
      this.emptyState.style.display = "block";
      return;
    }

    this.emptyState.style.display = "none";

    this.messages.forEach((message) => {
      this.renderMessage(message);
    });

    this.scrollToBottom();
  }

  renderMessage(message) {
    const messageElement = document.createElement("div");
    messageElement.className = `message ${message.isOwn ? "sent" : "received"}`;

    if (message.pending) {
      messageElement.classList.add("pending");
    }

    if (message.failed) {
      messageElement.classList.add("failed");
    }

    if (message.offline) {
      messageElement.classList.add("offline");
    }

    const time = new Date(message.timestamp).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });

    let statusIcon = "";
    if (message.pending) {
      statusIcon = `<span class="pending-indicator">
      <i class="fas fa-clock"></i>
      ${message.statusText || "Отправка..."}
    </span>`;
    } else if (message.failed) {
      statusIcon =
        '<span class="failed-indicator"><i class="fas fa-exclamation-circle"></i> Не отправлено</span>';
    } else if (message.offline) {
      statusIcon =
        '<span class="offline-indicator"><i class="fas fa-wifi-slash"></i></span>';
    }

    messageElement.innerHTML = `
    <div class="message-content">
      ${this.escapeHtml(message.text)}
      ${statusIcon}
    </div>
    <div class="message-info">
      <span class="message-sender">${
        message.isOwn ? "Вы" : this.escapeHtml(message.username)
      }</span>
      <span class="message-time">${time}</span>
    </div>
  `;

    // Добавляем кнопку повторной отправки для неудачных сообщений
    if (message.failed && message.isOwn) {
      const retryButton = document.createElement("button");
      retryButton.className = "retry-button";
      retryButton.innerHTML = '<i class="fas fa-redo"></i>';
      retryButton.title = "Повторить отправку";
      retryButton.onclick = () => {
        // Находим неотправленное сообщение
        const unsentItem = this.unsentMessages?.find(
          (item) => item.message.id === message.id
        );
        if (unsentItem) {
          // Сбрасываем статус
          message.failed = false;
          message.pending = true;
          message.attempts = 0;

          // Пытаемся отправить снова
          this.attemptToSend(unsentItem.message, message);
        }
      };
      messageElement.querySelector(".message-content").appendChild(retryButton);
    }

    this.messagesContainer.appendChild(messageElement);
  }

  scrollToBottom() {
    setTimeout(() => {
      this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight;
    }, 50);
  }

  handleNewMessage(data) {
    const pendingLocalId = this.pendingMessages.get(data.id);

    if (pendingLocalId) {
      const pendingIndex = this.messages.findIndex(
        (msg) => msg.localId === pendingLocalId
      );

      if (pendingIndex !== -1) {
        this.messages[pendingIndex] = {
          ...this.messages[pendingIndex],
          id: data.id,
          pending: false,
          waiting: false,
        };

        this.pendingMessages.delete(data.id);
        this.renderMessages();
        return;
      }
    }

    const message = {
      id: data.id,
      text: data.text,
      username: data.username,
      timestamp: data.timestamp || Date.now(),
      isOwn: data.username === this.username,
      pending: false,
    };

    // Если мы были оффлайн, сохраняем сообщение
    if (!this.isTabActive || document.hidden) {
      this.offlineMessages.push(message);
      this.saveOfflineData();
    }

    // iPhone уведомление
    if (!message.isOwn) {
      this.showIOSNotification(
        `💬 ${message.username}`,
        message.text.length > 50
          ? message.text.substring(0, 50) + "..."
          : message.text
      );
    }

    this.messages.push(message);
    this.renderMessage(message);
    this.scrollToBottom();
  }

  sendMessage() {
    const text = this.messageInput.value.trim();

    if (!text) {
      return;
    }

    // Создаем уникальный ID для сообщения
    const messageId =
      Date.now() + "-" + Math.random().toString(36).substr(2, 9);
    const timestamp = Date.now();

    // Сообщение для отправки на сервер
    const messageToSend = {
      type: "message",
      id: messageId,
      text: text,
      username: this.username,
      timestamp: timestamp,
    };

    // Локальная копия для отображения
    const localMessage = {
      id: messageId,
      localId: messageId,
      text: text,
      username: this.username,
      timestamp: timestamp,
      isOwn: true,
      pending: true,
      attempts: 0, // Счетчик попыток отправки
      maxAttempts: 3, // Максимум 3 попытки
    };

    // Добавляем в локальные сообщения для отображения
    this.messages.push(localMessage);
    this.renderMessage(localMessage);
    this.scrollToBottom();

    // Сохраняем неотправленное сообщение
    this.saveUnsentMessage(messageToSend, localMessage);

    // Пытаемся отправить
    this.attemptToSend(messageToSend, localMessage);

    // Очищаем поле ввода
    this.messageInput.value = "";
    this.sendBtn.disabled = true;

    // Сохраняем состояние
    this.saveToStorage();
  }

  saveUnsentMessage(messageToSend, localMessage) {
    if (!this.unsentMessages) {
      this.unsentMessages = [];
    }

    // Проверяем, нет ли уже такого сообщения
    const existingIndex = this.unsentMessages.findIndex(
      (item) => item.message.id === messageToSend.id
    );

    if (existingIndex === -1) {
      this.unsentMessages.push({
        message: messageToSend,
        localMessage: localMessage,
        timestamp: Date.now(),
        attempts: 0,
      });

      // Сохраняем в localStorage
      try {
        localStorage.setItem(
          "chat_unsent_messages",
          JSON.stringify(this.unsentMessages)
        );
      } catch (e) {
        console.error("Ошибка сохранения неотправленных сообщений:", e);
      }
    }
  }

  // Пытаемся отправить сообщение
  attemptToSend(messageToSend, localMessage) {
    console.log("🚀 attemptToSend вызван для:", messageToSend.id);
    console.log("📡 Состояние WebSocket:", {
      isConnected: this.isConnected,
      readyState: this.socket ? this.socket.readyState : "no socket",
      socketExists: !!this.socket,
    });
    if (!messageToSend || !localMessage) return;

    // Увеличиваем счетчик попыток
    if (localMessage.attempts === undefined) localMessage.attempts = 0;
    localMessage.attempts++;

    // Обновляем отображение сообщения
    this.updateMessageStatus(localMessage.id, "attempt", localMessage.attempts);

    if (
      this.isConnected &&
      this.socket &&
      this.socket.readyState === WebSocket.OPEN
    ) {
      try {
        console.log("📤 Отправляю сообщение:", messageToSend.id);

        // Отправляем через WebSocket
        this.socket.send(JSON.stringify(messageToSend));

        // Добавляем в pendingMessages для отслеживания
        this.pendingMessages.set(messageToSend.id, localMessage.id);

        // Ставим таймер для проверки доставки
        this.setDeliveryTimeout(messageToSend.id, localMessage);
      } catch (error) {
        console.error("❌ Ошибка отправки:", error);
        this.handleSendError(messageToSend, localMessage, error);
      }
    } else {
      console.log(
        "📦 Соединение отсутствует, сообщение сохранено для отправки позже"
      );

      // Если нет соединения, пытаемся подключиться
      if (!this.isConnected && this.isLoggedIn()) {
        this.connectWebSocket();
      }

      // Планируем повторную попытку через 5 секунд
      setTimeout(() => {
        if (this.isConnected) {
          this.attemptToSend(messageToSend, localMessage);
        } else if (localMessage.attempts < localMessage.maxAttempts) {
          // Планируем еще одну попытку
          setTimeout(() => {
            this.attemptToSend(messageToSend, localMessage);
          }, 5000);
        }
      }, 5000);
    }
  }

  // Таймер для проверки доставки
  setDeliveryTimeout(messageId, localMessage) {
    // Удаляем старый таймер если есть
    if (localMessage.deliveryTimer) {
      clearTimeout(localMessage.deliveryTimer);
    }

    // Устанавливаем новый таймер (10 секунд)
    localMessage.deliveryTimer = setTimeout(() => {
      if (this.messages.some((msg) => msg.id === messageId && msg.pending)) {
        console.log("⏰ Таймаут доставки для сообщения:", messageId);

        // Увеличиваем счетчик попыток
        localMessage.attempts++;

        if (localMessage.attempts >= localMessage.maxAttempts) {
          // Превышено количество попыток
          this.updateMessageStatus(messageId, "failed");
          this.showNotification("Не удалось отправить сообщение");
        } else {
          // Пытаемся отправить снова
          const unsentItem = this.unsentMessages.find(
            (item) => item.message.id === messageId
          );
          if (unsentItem) {
            this.attemptToSend(unsentItem.message, localMessage);
          }
        }
      }
    }, 10000); // 10 секунд
  }

  // Обработка ошибки отправки
  handleSendError(messageToSend, localMessage, error) {
    console.error("Ошибка отправки сообщения:", error);

    if (localMessage.attempts < localMessage.maxAttempts) {
      // Планируем повторную попытку через 3 секунды
      setTimeout(() => {
        this.attemptToSend(messageToSend, localMessage);
      }, 3000);
    } else {
      // Превышено количество попыток
      this.updateMessageStatus(localMessage.id, "failed");
      this.showNotification("Не удалось отправить сообщение");
    }
  }

  // Обновляем статус сообщения
  updateMessageStatus(messageId, status, attempts = 0) {
    const messageIndex = this.messages.findIndex((msg) => msg.id === messageId);
    if (messageIndex !== -1) {
      const message = this.messages[messageIndex];

      switch (status) {
        case "attempt":
          message.pending = true;
          message.statusText = `Попытка ${attempts}/${
            message.maxAttempts || 3
          }`;
          break;
        case "sent":
          message.pending = false;
          message.statusText = "";
          // Удаляем таймер
          if (message.deliveryTimer) {
            clearTimeout(message.deliveryTimer);
          }
          break;
        case "failed":
          message.pending = false;
          message.failed = true;
          message.statusText = "Не отправлено";
          break;
      }

      // Перерисовываем сообщение
      this.renderMessages();
    }
  }

  handleNewMessage(data) {
    console.log("📨 Получено сообщение от сервера:", data.id);

    // Проверяем, не наше ли это сообщение (подтверждение отправки)
    const isOurMessage = data.username === this.username;
    const pendingLocalId = this.pendingMessages.get(data.id);

    if (isOurMessage && pendingLocalId) {
      // Это подтверждение нашего сообщения
      console.log("✅ Подтверждение доставки для сообщения:", data.id);

      // Обновляем статус сообщения
      this.updateMessageStatus(data.id, "sent");

      // Удаляем из pendingMessages
      this.pendingMessages.delete(data.id);

      // Удаляем из unsentMessages
      this.removeFromUnsent(data.id);

      // Обновляем сообщение в списке
      const messageIndex = this.messages.findIndex((msg) => msg.id === data.id);
      if (messageIndex !== -1) {
        this.messages[messageIndex] = {
          ...this.messages[messageIndex],
          id: data.id,
          pending: false,
          statusText: "",
        };
      }

      this.renderMessages();
      return;
    }

    // Это сообщение от другого пользователя
    const message = {
      id: data.id,
      text: data.text,
      username: data.username,
      timestamp: data.timestamp || Date.now(),
      isOwn: data.username === this.username,
      pending: false,
    };

    // Если мы были оффлайн, сохраняем сообщение
    if (!this.isTabActive || document.hidden) {
      this.saveOfflineMessage(message);
    }

    // iPhone уведомление
    if (!message.isOwn) {
      this.showIOSNotification(
        `💬 ${message.username}`,
        message.text.length > 50
          ? message.text.substring(0, 50) + "..."
          : message.text
      );
    }

    this.messages.push(message);
    this.renderMessage(message);
    this.scrollToBottom();
  }

  // Удаляем сообщение из unsentMessages
  removeFromUnsent(messageId) {
    if (!this.unsentMessages) return;

    const index = this.unsentMessages.findIndex(
      (item) => item.message.id === messageId
    );
    if (index !== -1) {
      this.unsentMessages.splice(index, 1);

      // Сохраняем обновленный список
      try {
        localStorage.setItem(
          "chat_unsent_messages",
          JSON.stringify(this.unsentMessages)
        );
      } catch (e) {
        console.error("Ошибка сохранения unsentMessages:", e);
      }
    }
  }

  // Сохраняем оффлайн-сообщение
  saveOfflineMessage(message) {
    if (!this.offlineMessages) {
      this.offlineMessages = [];
    }

    this.offlineMessages.push(message);

    try {
      localStorage.setItem(
        "chat_offline_messages",
        JSON.stringify(this.offlineMessages.slice(-100))
      );
    } catch (e) {
      console.error("Ошибка сохранения оффлайн-сообщений:", e);
    }
  }

  updateOnlineCount(count) {
    this.onlineCount.textContent = count || 1;
  }

  updateConnectionStatus(status) {
    this.connectionStatus.textContent = status;
  }

  clearChat() {
    if (confirm("Очистить историю чата?")) {
      const clearMessage = {
        type: "clear_chat",
        username: this.username,
        timestamp: Date.now(),
      };

      // Используем safeSend
      this.safeSend(clearMessage);

      this.messages = [];
      this.pendingMessages.clear();
      this.renderMessages();
      this.saveToStorage();
      this.showNotification("Чат очищен");
    }
  }

  goBack() {
    if (confirm("Выйти из чата?")) {
      if (this.socket && this.isConnected) {
        this.socket.close();
      }

      this.clearStorage();

      this.chatScreen.classList.remove("active");
      this.loginScreen.classList.add("active");
      this.usernameInput.value = "";
      this.username = "";
      this.messages = [];
      this.pendingMessages.clear();
      this.isConnected = false;
      this.reconnectAttempts = 0;

      setTimeout(() => {
        this.usernameInput.focus();
      }, 300);
    }
  }

  showNotification(text) {
    const notification = document.getElementById("notification");
    if (!notification) return;

    notification.textContent = text;
    notification.classList.add("show");

    setTimeout(() => {
      notification.classList.remove("show");
    }, 3000);
  }

  escapeHtml(text) {
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
  }
}

// Инициализация
document.addEventListener("DOMContentLoaded", () => {
  if (!window.WebSocket) {
    alert("Ваш браузер не поддерживает WebSocket. Обновите браузер.");
    return;
  }

  window.chatApp = new SimpleChat();
});
