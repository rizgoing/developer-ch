const WebSocket = require("ws");
const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const HISTORY_FILE = path.join(__dirname, "chat_history.json");
const MAX_HISTORY = 1000; // Увеличим до 1000 сообщений
const userSessions = new Map();
const MESSAGE_TYPES = {
  PRESENCE_UPDATE: "presence_update",
  TYPING_START: "typing_start",
  TYPING_END: "typing_end",
  READ_RECEIPT: "read_receipt",
};
const USER_STATUS = {
  ONLINE: "online", // Активно в чате
  AWAY: "away", // Неактивен 30+ секунд
  OFFLINE: "offline", // Не в сети
};
// Хранилище всех пользователей (даже если соединение разорвано)
const allUsers = new Map(); // Ключ: имя пользователя, Значение: {статус, последняя активность}

// Активные WebSocket соединения
const activeConnections = new Map(); // Ключ: WebSocket, Значение: имя пользователя
// Хранилище данных
let chatHistory = [];
let connectedUsers = new Map();

setInterval(() => {
  const now = Date.now();
  userSessions.forEach((session, sessionId) => {
    if (now - session.lastActivity > 60000) {
      // 60 секунд без активности
      session.status = "away";
      broadcastPresenceUpdate(session.username, "away");
    }
  });
}, 30000);

// Загружаем историю из файла
function loadHistory() {
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      const data = fs.readFileSync(HISTORY_FILE, "utf8");
      const parsed = JSON.parse(data);
      // Оставляем только последние MAX_HISTORY сообщений
      chatHistory = parsed.slice(-MAX_HISTORY);
      console.log(`✅ Загружено ${chatHistory.length} сообщений из истории`);
    }
  } catch (error) {
    console.error("❌ Ошибка загрузки истории:", error.message);
    chatHistory = [];
  }
}

// Сохраняем историю в файл
function saveHistory() {
  try {
    // Сохраняем только последние MAX_HISTORY сообщений
    const toSave = chatHistory.slice(-MAX_HISTORY);
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(toSave, null, 2));
    console.log(`💾 История сохранена (${toSave.length} сообщений)`);
  } catch (error) {
    console.error("❌ Ошибка сохранения истории:", error.message);
  }
}

// ДОБАВЬ ЭТО ПОСЛЕ ФУНКЦИЙ loadHistory() и saveHistory()

// Функция для обновления статуса пользователя
function updateUserStatus(username, status) {
  if (!allUsers.has(username)) {
    // Если пользователь новый, создаем запись
    allUsers.set(username, {
      username: username,
      status: status,
      lastSeen: Date.now(),
      joinedAt: Date.now(),
    });
  } else {
    // Если пользователь уже есть, обновляем статус
    const user = allUsers.get(username);
    user.status = status;
    user.lastSeen = Date.now();
    allUsers.set(username, user);
  }

  console.log(`👤 ${username} → ${status}`);

  // Отправляем всем обновление статуса
  broadcastUserStatus(username, status);
}

// Функция для отправки обновления статуса всем в чате
function broadcastUserStatus(username, status) {
  const user = allUsers.get(username);
  if (!user) return;

  const message = {
    type: "user_status",
    username: username,
    status: status,
    lastSeen: user.lastSeen,
    timestamp: Date.now(),
  };

  broadcast(message);
}

// Функция для получения списка онлайн-пользователей
function getOnlineUsers() {
  const online = [];

  allUsers.forEach((user, username) => {
    if (
      user.status === USER_STATUS.ONLINE ||
      user.status === USER_STATUS.AWAY
    ) {
      online.push({
        username: username,
        status: user.status,
        lastSeen: user.lastSeen,
      });
    }
  });

  return online;
}

// Добавляем сообщение в историю
function addToHistory(message) {
  chatHistory.push(message);

  // Ограничиваем размер истории
  if (chatHistory.length > MAX_HISTORY) {
    chatHistory = chatHistory.slice(-MAX_HISTORY);
  }

  // Сохраняем на диск каждое сообщение
  saveHistory();
}

// Создаем HTTP сервер
const server = http.createServer((req, res) => {
  console.log(`📥 ${req.method} ${req.url}`);

  // Игнорируем favicon.ico если нет файла
  if (req.url === "/favicon.ico") {
    res.writeHead(204);
    res.end();
    return;
  }

  // Определяем путь к файлу
  let filePath = req.url === "/" ? "/index.html" : req.url;
  const fullPath = path.join(__dirname, "public", filePath);

  // Проверяем, существует ли файл
  fs.readFile(fullPath, (err, content) => {
    if (err) {
      // Если файл не найден, показываем index.html (для SPA)
      if (err.code === "ENOENT") {
        fs.readFile(
          path.join(__dirname, "public", "index.html"),
          (err, data) => {
            if (err) {
              res.writeHead(500, { "Content-Type": "text/plain" });
              res.end("Server Error: Cannot load index.html");
            } else {
              res.writeHead(200, { "Content-Type": "text/html" });
              res.end(data);
            }
          }
        );
      } else {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end(`Server Error: ${err.code}`);
      }
      return;
    }

    // Определяем Content-Type
    const ext = path.extname(fullPath);
    let contentType = "text/html";

    switch (ext) {
      case ".js":
        contentType = "application/javascript";
        break;
      case ".css":
        contentType = "text/css";
        break;
      case ".json":
        contentType = "application/json";
        break;
      case ".png":
        contentType = "image/png";
        break;
      case ".jpg":
      case ".jpeg":
        contentType = "image/jpeg";
        break;
      case ".ico":
        contentType = "image/x-icon";
        break;
    }

    res.writeHead(200, { "Content-Type": contentType });
    res.end(content);
  });
});

// WebSocket сервер
const wss = new WebSocket.Server({ server });

// Загружаем историю при старте сервера
loadHistory();

wss.on("connection", (ws) => {
  console.log("🔗 Новое WebSocket подключение");

  // Таймер для проверки активности
  let activityTimer = null;

  // Функция для сброса таймера активности
  function resetActivityTimer() {
    if (activityTimer) clearTimeout(activityTimer);

    // Если пользователь не активен 30 секунд, меняем статус на "away"
    activityTimer = setTimeout(() => {
      const username = activeConnections.get(ws);
      if (username) {
        updateUserStatus(username, USER_STATUS.AWAY);
      }
    }, 30000); // 30 секунд
  }

  // Сбрасываем таймер при любом сообщении от клиента
  ws.on("message", () => resetActivityTimer());

  // Сразу отправляем историю чата новому пользователю
  ws.send(
    JSON.stringify({
      type: "history",
      messages: chatHistory,
    })
  );

  // Отправляем список текущих пользователей
  ws.send(
    JSON.stringify({
      type: "users_list",
      users: getOnlineUsers(),
      timestamp: Date.now(),
    })
  );

  ws.on("message", (data) => {
    try {
      const message = JSON.parse(data);

      if (message.type === "join") {
        const username = message.username;

        // Проверяем, онлайн ли уже пользователь с таким именем
        const existingUser = allUsers.get(username);

        if (existingUser && existingUser.status === USER_STATUS.ONLINE) {
          // Пользователь уже онлайн в другом окне/вкладке
          ws.send(
            JSON.stringify({
              type: "error",
              message: "Вы уже вошли в чат с другого устройства или вкладки",
            })
          );
          ws.close();
          return;
        }

        // Регистрируем пользователя
        updateUserStatus(username, USER_STATUS.ONLINE);
        activeConnections.set(ws, username);

        console.log(`👤 ${username} присоединился`);

        // Уведомляем всех о новом пользователе
        broadcast(
          {
            type: "user_joined",
            username: username,
            onlineCount: getOnlineUsers().length,
            timestamp: Date.now(),
          },
          ws
        );

        // Отправляем обновлённое количество онлайн
        broadcastOnlineCount();

        // Сбрасываем таймер активности
        resetActivityTimer();
      }

      if (message.type === "message") {
        const user = connectedUsers.get(ws);
        if (!user) return;

        // Создаём сообщение с уникальным ID
        const chatMessage = {
          id:
            message.id ||
            Date.now() + "-" + Math.random().toString(36).substr(2, 9),
          type: "message",
          text: message.text.substring(0, 500),
          username: user.username,
          timestamp: message.timestamp || Date.now(),
        };

        console.log(
          `💬 ${user.username}: ${chatMessage.text.substring(0, 50)}${
            chatMessage.text.length > 50 ? "..." : ""
          }`
        );

        // Сохраняем в историю
        addToHistory(chatMessage);

        // Отправляем всем
        broadcast(chatMessage);
      }

      if (message.type === "clear_chat") {
        const user = connectedUsers.get(ws);
        if (user && connectedUsers.size <= 2) {
          chatHistory = [];
          saveHistory();

          console.log(`🧹 ${user.username} очистил чат`);

          broadcast({
            type: "clear_chat",
            username: user.username,
            timestamp: Date.now(),
          });
        }
      }
      if (message.type === "heartbeat") {
        const username = activeConnections.get(ws);
        if (username) {
          // Обновляем время последней активности
          resetActivityTimer();

          // Отправляем подтверждение клиенту
          ws.send(
            JSON.stringify({
              type: "heartbeat_ack",
              timestamp: Date.now(),
            })
          );
        }
      }
    } catch (error) {
      console.error("❌ Ошибка обработки сообщения:", error);
    }
  });

  ws.on("close", () => {
    const username = activeConnections.get(ws);

    if (username) {
      console.log(`🔌 ${username} разорвал соединение`);
      activeConnections.delete(ws);

      // Не сразу помечаем как offline, даем время на переподключение
      setTimeout(() => {
        // Если пользователь так и не переподключился за 60 секунд
        if (!Array.from(activeConnections.values()).includes(username)) {
          updateUserStatus(username, USER_STATUS.OFFLINE);

          broadcast({
            type: "user_left",
            username: username,
            onlineCount: getOnlineUsers().length,
            timestamp: Date.now(),
          });

          broadcastOnlineCount();
        }
      }, 60000); // Ждем 60 секунд
    }

    // Очищаем таймер
    if (activityTimer) clearTimeout(activityTimer);
  });

  ws.on("error", (error) => {
    console.error("❌ WebSocket ошибка:", error);
  });
});

function broadcast(message, excludeWs = null) {
  const data = JSON.stringify(message);

  wss.clients.forEach((client) => {
    if (client.readyState === 1 && client !== excludeWs) {
      // 1 = OPEN
      client.send(data);
    }
  });
}

function broadcastOnlineCount() {
  broadcast({
    type: "online_count",
    count: getOnlineUsers().length,
    timestamp: Date.now(),
  });
}

// Запускаем сервер
server.listen(PORT, () => {
  console.log("=".repeat(50));
  console.log(`🚀 Сервер запущен на порту: ${PORT}`);
  console.log(`💾 История загружена: ${chatHistory.length} сообщений`);
  console.log(`💬 Максимум сообщений в истории: ${MAX_HISTORY}`);
  console.log("=".repeat(50));
});

server.on("request", (req, res) => {
  if (req.method === "GET" && req.url.startsWith("/api/last-messages")) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const since = parseInt(url.searchParams.get("since")) || 0;

    const recentMessages = chatHistory
      .filter((msg) => msg.timestamp > since)
      .slice(-10);

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(recentMessages));
    return;
  }
});

// Обработка ошибок
process.on("uncaughtException", (error) => {
  console.error("🔥 Необработанная ошибка:", error);
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("🔥 Необработанный промис:", reason);
});

// Graceful shutdown
process.on("SIGINT", () => {
  console.log("\n🛑 Остановка сервера...");
  saveHistory();
  wss.close(() => {
    server.close(() => {
      console.log("✅ Сервер остановлен");
      process.exit(0);
    });
  });
});
