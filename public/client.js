class SimpleChat {
  constructor() {
    // Конфигурация
    const isLocalhost =
      window.location.hostname === "localhost" ||
      window.location.hostname === "127.0.0.1";
    if (isLocalhost) {
      this.WS_SERVER = "ws://localhost:3000";
    } else {
      // На Railway и других хостингах используем тот же хост и протокол, но без порта
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      this.WS_SERVER = `${protocol}//${window.location.host}`;
    }
    // Состояние
    this.username = "";
    this.socket = null;
    this.isConnected = false;
    this.messages = [];
    this.autoLoginAttempted = false;
    this.pendingMessages = new Map(); // Храним ID pending сообщений

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

  init() {
    this.setupEventListeners();
    this.loadFromStorage();
    this.checkAutoLogin();
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

    // Сохранение состояния перед закрытием/обновлением
    window.addEventListener("beforeunload", () => {
      this.saveToStorage();
    });

    // Восстановление при возвращении на вкладку
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") {
        if (!this.isConnected && this.isLoggedIn()) {
          this.connectWebSocket();
        }
      }
    });
  }

  loadFromStorage() {
    try {
      const savedState = localStorage.getItem("chat_state");
      if (savedState) {
        const state = JSON.parse(savedState);

        // Восстанавливаем имя пользователя
        if (state.username) {
          this.usernameInput.value = state.username;
        }

        // Восстанавливаем сообщения (убираем pending статус при загрузке)
        if (state.messages && Array.isArray(state.messages)) {
          this.messages = state.messages.map((msg) => ({
            ...msg,
            pending: false, // Все сообщения считаем подтверждёнными при загрузке
          }));
        }

        // Восстанавливаем скролл позицию
        if (state.scrollPosition) {
          setTimeout(() => {
            this.messagesContainer.scrollTop = state.scrollPosition;
          }, 100);
        }
      }
    } catch (error) {
      console.error("Ошибка загрузки из localStorage:", error);
    }
  }

  saveToStorage() {
    try {
      // Сохраняем только последние 200 не-pending сообщений
      const nonPendingMessages = this.messages
        .filter((msg) => !msg.pending)
        .slice(-200);

      const state = {
        username: this.username,
        messages: nonPendingMessages,
        scrollPosition: this.messagesContainer.scrollTop,
        timestamp: Date.now(),
      };

      localStorage.setItem("chat_state", JSON.stringify(state));
      console.log(
        "💾 Состояние сохранено:",
        nonPendingMessages.length,
        "сообщений"
      );
    } catch (error) {
      console.error("❌ Ошибка сохранения в localStorage:", error);
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
    // Проверяем, был ли пользователь уже в чате
    const savedUsername = localStorage.getItem("chat_username");
    const savedState = localStorage.getItem("chat_state");

    if (savedUsername && savedState && !this.autoLoginAttempted) {
      try {
        const state = JSON.parse(savedState);

        // Если с момента последней активности прошло меньше 2 часов, авто-вход
        const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;

        if (state.timestamp && state.timestamp > twoHoursAgo) {
          this.autoLoginAttempted = true;

          // Показываем уведомление об авто-входе
          setTimeout(() => {
            this.showNotification("Автоматический вход...");
          }, 100);

          // Автоматически логинимся
          setTimeout(() => {
            this.username = savedUsername;
            this.loginScreen.classList.remove("active");
            this.chatScreen.classList.add("active");
            this.connectWebSocket();
          }, 500);

          return;
        }
      } catch (error) {
        console.error("Ошибка авто-входа:", error);
      }
    }

    // Если авто-вход не сработал, фокусируемся на поле ввода
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

    // Сохраняем имя пользователя
    localStorage.setItem("chat_username", username);

    // Сохраняем состояние
    this.saveToStorage();

    // Переключаем экраны
    this.loginScreen.classList.remove("active");
    this.chatScreen.classList.add("active");

    // Подключаемся к WebSocket
    this.connectWebSocket();

    // Фокусируемся на поле ввода
    setTimeout(() => {
      this.messageInput.focus();
    }, 300);
  }

  connectWebSocket() {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      return;
    }

    this.updateConnectionStatus("Подключение...");

    try {
      this.socket = new WebSocket(this.WS_SERVER);

      this.socket.onopen = () => {
        this.isConnected = true;
        this.updateConnectionStatus("В сети");

        // Отправляем информацию о пользователе
        this.socket.send(
          JSON.stringify({
            type: "join",
            username: this.username,
            timestamp: Date.now(),
          })
        );

        // Показываем локальные сообщения до получения истории с сервера
        if (this.messages.length > 0) {
          this.renderMessages();
        }

        this.showNotification("Подключено к чату");
      };

      this.socket.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          this.handleWebSocketMessage(data);

          // Сохраняем состояние после получения сообщения
          this.saveToStorage();
        } catch (error) {
          console.error("Ошибка парсинга сообщения:", error);
        }
      };

      this.socket.onclose = () => {
        this.isConnected = false;
        this.updateConnectionStatus("Нет подключения");

        // Пытаемся переподключиться через 3 секунды
        setTimeout(() => {
          if (!this.isConnected && this.isLoggedIn()) {
            this.connectWebSocket();
          }
        }, 3000);
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
    console.log("📨 Получено сообщение от сервера:", data.type, data);

    switch (data.type) {
      case "history":
        console.log(
          "📚 Получена история сообщений:",
          data.messages?.length || 0,
          "сообщений"
        );
        this.mergeMessagesWithHistory(data.messages || []);
        break;

      case "message":
        this.handleNewMessage(data);
        break;

      case "user_joined":
        this.showNotification(`👤 ${data.username} присоединился`);
        this.updateOnlineCount(data.onlineCount);
        break;

      case "user_left":
        this.showNotification(`👋 ${data.username} вышел`);
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
        this.showNotification("🧹 Чат очищен");
        break;

      case "error":
        this.showNotification(`❌ Ошибка: ${data.message}`);
        if (data.message.includes("уже в чате")) {
          setTimeout(() => this.goBack(), 2000);
        }
        break;
    }
  }

  mergeMessagesWithHistory(serverMessages) {
    console.log("🔄 Объединение истории:", {
      локальных: this.messages.length,
      сСервера: serverMessages.length,
    });

    // Если серверная история пуста, ничего не делаем
    if (!serverMessages || serverMessages.length === 0) {
      console.log("📭 История с сервера пуста");
      return;
    }

    // Сортируем серверные сообщения по времени
    serverMessages.sort((a, b) => a.timestamp - b.timestamp);

    // Создаем Set для быстрой проверки ID сообщений
    const existingMessageIds = new Set(this.messages.map((msg) => msg.id));
    const existingLocalIds = new Set(
      this.messages.map((msg) => msg.localId).filter((id) => id)
    );

    // Добавляем только новые сообщения с сервера
    let addedCount = 0;
    serverMessages.forEach((serverMsg) => {
      // Проверяем, есть ли такое сообщение уже у нас
      const alreadyExists =
        existingMessageIds.has(serverMsg.id) ||
        (serverMsg.id && existingLocalIds.has(serverMsg.id));

      if (!alreadyExists) {
        const message = {
          ...serverMsg,
          isOwn: serverMsg.username === this.username,
          pending: false,
        };

        this.messages.push(message);
        addedCount++;
      }
    });

    // Сортируем все сообщения по времени
    this.messages.sort((a, b) => a.timestamp - b.timestamp);

    // Ограничиваем количество сообщений в памяти
    if (this.messages.length > 500) {
      this.messages = this.messages.slice(-500);
    }

    console.log(`✅ Добавлено ${addedCount} новых сообщений из истории`);

    // Перерисовываем сообщения
    this.renderMessages();

    // Прокручиваем вниз
    this.scrollToBottom();

    // Сохраняем обновлённую историю
    this.saveToStorage();
  }

  handleNewMessage(data) {
    console.log("💬 Новое сообщение от сервера:", data);

    // Проверяем, не является ли это подтверждением нашего pending сообщения
    const pendingLocalId = this.pendingMessages.get(data.id);

    if (pendingLocalId) {
      // Нашли pending сообщение, обновляем его
      const pendingIndex = this.messages.findIndex(
        (msg) => msg.localId === pendingLocalId
      );

      if (pendingIndex !== -1) {
        // Обновляем существующее сообщение
        this.messages[pendingIndex] = {
          ...this.messages[pendingIndex],
          id: data.id,
          pending: false,
        };

        console.log("✅ Pending сообщение подтверждено");

        // Обновляем отображение
        this.updateMessageInDOM(this.messages[pendingIndex]);

        // Удаляем из pending
        this.pendingMessages.delete(data.id);

        this.scrollToBottom();
        return;
      }
    }

    // Проверяем, нет ли уже такого сообщения (дубликат)
    const alreadyExists = this.messages.some(
      (msg) => msg.id === data.id || (data.id && msg.localId === data.id)
    );

    if (alreadyExists) {
      console.log("⚠️ Сообщение уже существует, пропускаем");
      return;
    }

    // Обычное новое сообщение
    const message = {
      id: data.id,
      text: data.text,
      username: data.username,
      timestamp: data.timestamp || Date.now(),
      isOwn: data.username === this.username,
      pending: false,
    };

    this.messages.push(message);
    this.renderMessage(message);
    this.scrollToBottom();

    // Сохраняем в localStorage
    this.saveToStorage();
  }

  updateMessageInDOM(message) {
    const messageElement = this.messagesContainer.querySelector(
      `[data-id="${message.id || message.localId}"]`
    );
    if (messageElement) {
      const time = new Date(message.timestamp).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      });

      messageElement.className = `message ${
        message.isOwn ? "sent" : "received"
      }`;

      if (message.pending) {
        messageElement.classList.add("pending");
      } else {
        messageElement.classList.remove("pending");
      }

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
    }
  }

  scrollToBottom() {
    setTimeout(() => {
      this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight;
    }, 50);
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

      // Очищаем состояние
      this.clearStorage();

      this.chatScreen.classList.remove("active");
      this.loginScreen.classList.add("active");
      this.usernameInput.value = "";
      this.username = "";
      this.messages = [];
      this.pendingMessages.clear();
      this.isConnected = false;

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

// Инициализация приложения
document.addEventListener("DOMContentLoaded", () => {
  // Проверка поддержки WebSocket
  if (!window.WebSocket) {
    alert("Ваш браузер не поддерживает WebSocket. Обновите браузер.");
    return;
  }

  // Для отладки - показываем какой URL используется
  console.log("Текущий URL:", window.location.href);

  // Инициализация чата
  window.chatApp = new SimpleChat();

  // Для отладки
  setTimeout(() => {
    console.log("WebSocket URL для подключения:", window.chatApp.WS_SERVER);
  }, 1000);
});
