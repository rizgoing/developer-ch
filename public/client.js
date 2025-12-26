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
    this.notificationPermission = false;
    this.isTabActive = true;
    this.lastNotificationTime = 0;

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
    this.checkAutoLogin();
    this.setupNotifications();
    this.setupTabVisibility();
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
    });

    // Восстановление соединения
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") {
        if (!this.isConnected && this.isLoggedIn()) {
          this.connectWebSocket();
        }
      }
    });
  }

  setupNotifications() {
    // Проверяем поддержку уведомлений
    if (!("Notification" in window)) {
      console.log("Браузер не поддерживает уведомления");
      return;
    }

    // Проверяем текущий статус разрешения
    if (Notification.permission === "granted") {
      this.notificationPermission = true;
      console.log("Уведомления разрешены");
    } else if (Notification.permission !== "denied") {
      // Запрашиваем разрешение не сразу, а через 3 секунды после входа
      setTimeout(() => {
        this.requestNotificationPermission();
      }, 3000);
    }
  }

  requestNotificationPermission() {
    Notification.requestPermission().then((permission) => {
      this.notificationPermission = permission === "granted";
      if (this.notificationPermission) {
        this.showNotification("Уведомления включены");
        console.log("Разрешение на уведомления получено");
      }
    });
  }

  setupTabVisibility() {
    // Отслеживаем активность вкладки
    document.addEventListener("visibilitychange", () => {
      this.isTabActive = !document.hidden;
    });

    // Также отслеживаем focus/blur окна
    window.addEventListener("focus", () => {
      this.isTabActive = true;
    });

    window.addEventListener("blur", () => {
      this.isTabActive = false;
    });
  }

  showBrowserNotification(title, body, tag = "chat-notification") {
    // Не показываем уведомления, если вкладка активна
    if (this.isTabActive) {
      return;
    }

    // Не чаще чем раз в 5 секунд для одного отправителя
    const now = Date.now();
    if (now - this.lastNotificationTime < 5000) {
      return;
    }

    if (!this.notificationPermission) {
      return;
    }

    // Показываем уведомление
    const notification = new Notification(title, {
      body: body,
      icon: "/favicon.ico",
      tag: tag, // Группирует уведомления
      requireInteraction: false,
      silent: false,
      vibrate: [200, 100, 200], // Вибрация на поддерживаемых устройствах
    });

    this.lastNotificationTime = now;

    // При клике на уведомление активируем вкладку
    notification.onclick = () => {
      window.focus();
      notification.close();
    };

    // Автоматически закрываем через 5 секунд
    setTimeout(() => {
      notification.close();
    }, 5000);
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

  connectWebSocket() {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      return;
    }

    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.showNotification("Не удалось подключиться. Проверьте интернет.");
      return;
    }

    this.updateConnectionStatus("Подключение...");

    try {
      this.socket = new WebSocket(this.WS_SERVER);

      this.socket.onopen = () => {
        this.isConnected = true;
        this.reconnectAttempts = 0;
        this.updateConnectionStatus("В сети");

        this.socket.send(
          JSON.stringify({
            type: "join",
            username: this.username,
            timestamp: Date.now(),
          })
        );

        if (this.messages.length > 0) {
          this.renderMessages();
        }

        this.showNotification("Подключено к чату");
      };

      this.socket.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          this.handleWebSocketMessage(data);
          this.saveToStorage();
        } catch (error) {
          console.error("Ошибка парсинга сообщения:", error);
        }
      };

      this.socket.onclose = (event) => {
        this.isConnected = false;
        this.reconnectAttempts++;

        if (event.code === 1006) {
          this.updateConnectionStatus("Переподключение...");
        } else {
          this.updateConnectionStatus("Отключено");
        }

        if (this.isLoggedIn()) {
          const delay = Math.min(1000 * this.reconnectAttempts, 10000);
          setTimeout(() => {
            if (!this.isConnected) {
              this.connectWebSocket();
            }
          }, delay);
        }
      };

      this.socket.onerror = (error) => {
        console.error("WebSocket ошибка:", error);
        this.updateConnectionStatus("Ошибка подключения");
      };
    } catch (error) {
      console.error("Ошибка подключения:", error);
      this.showNotification("Ошибка подключения к серверу");
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
        this.showBrowserNotification("Чат", `${data.username} присоединился`);
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
    }
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

    const time = new Date(message.timestamp).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });

    messageElement.innerHTML = `
            <div class="message-content">
                ${this.escapeHtml(message.text)}
                ${
                  message.pending
                    ? '<span class="pending-indicator"><i class="fas fa-clock"></i></span>'
                    : ""
                }
            </div>
            <div class="message-info">
                <span class="message-sender">${
                  message.isOwn ? "Вы" : this.escapeHtml(message.username)
                }</span>
                <span class="message-time">${time}</span>
            </div>
        `;

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

    // Показываем уведомление, если сообщение не от нас и вкладка не активна
    if (!message.isOwn) {
      this.showBrowserNotification(
        `Новое сообщение от ${message.username}`,
        message.text.length > 100
          ? message.text.substring(0, 100) + "..."
          : message.text,
        `message-${message.username}`
      );
    }

    this.messages.push(message);
    this.renderMessage(message);
    this.scrollToBottom();
  }

  sendMessage() {
    const text = this.messageInput.value.trim();

    if (!text || !this.isConnected) {
      return;
    }

    const localId = Date.now() + "-" + Math.random().toString(36).substr(2, 9);
    const timestamp = Date.now();

    const message = {
      type: "message",
      id: localId,
      text: text,
      username: this.username,
      timestamp: timestamp,
    };

    const localMessage = {
      localId: localId,
      text: text,
      username: this.username,
      timestamp: timestamp,
      isOwn: true,
      pending: true,
    };

    this.pendingMessages.set(localId, localId);
    this.messages.push(localMessage);
    this.renderMessage(localMessage);
    this.scrollToBottom();

    this.socket.send(JSON.stringify(message));

    this.messageInput.value = "";
    this.sendBtn.disabled = true;
    this.saveToStorage();
  }

  updateOnlineCount(count) {
    this.onlineCount.textContent = count || 1;
  }

  updateConnectionStatus(status) {
    this.connectionStatus.textContent = status;
  }

  clearChat() {
    if (confirm("Очистить историю чата?")) {
      if (this.isConnected) {
        this.socket.send(
          JSON.stringify({
            type: "clear_chat",
            username: this.username,
            timestamp: Date.now(),
          })
        );
      }

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

  // Проверка на iOS Safari - запрашиваем разрешение после жеста пользователя
  if (/iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream) {
    // На iOS нужно, чтобы запрос разрешения был инициирован пользовательским жестом
    const requestPermissionOnClick = () => {
      window.chatApp.requestNotificationPermission();
      document.removeEventListener("click", requestPermissionOnClick);
    };
    document.addEventListener("click", requestPermissionOnClick, {
      once: true,
    });
  }

  window.chatApp = new SimpleChat();
});
