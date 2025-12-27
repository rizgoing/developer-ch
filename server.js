const WebSocket = require("ws");
const http = require("http");
const fs = require("fs");
const path = require("path");

const USER_RECONNECT_TIMEOUT = 5000;
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

const pendingMessages = new Map(); // username -> [{message, timestamp}]

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
  // Проверяем, нет ли уже такого сообщения (по id или по содержанию)
  const isDuplicate = chatHistory.some(
    (msg) =>
      msg.id === message.id ||
      (msg.text === message.text &&
        msg.username === message.username &&
        Math.abs(msg.timestamp - message.timestamp) < 1000)
  );

  if (!isDuplicate) {
    chatHistory.push(message);
    console.log(`💾 Сохранено в историю: ${message.id}`);

    // Ограничиваем размер истории
    if (chatHistory.length > MAX_HISTORY) {
      chatHistory = chatHistory.slice(-MAX_HISTORY);
    }

    // Сохраняем на диск каждое сообщение
    saveHistory();
  } else {
    console.log(`⚠️ Пропущено дублирующее сообщение: ${message.id}`);
  }
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

  setTimeout(() => {
    if (ws.readyState === 1) {
      // WebSocket.OPEN
      ws.send(
        JSON.stringify({
          type: "history",
          messages: chatHistory.slice(-50), // Последние 50 сообщений
        })
      );
      console.log(
        `📜 Отправлена история (${chatHistory.slice(-50).length} сообщений)`
      );
    }
  }, 500); // Небольшая задержка

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

  // В server.js замените весь блок ws.on("message") на этот:
  ws.on("message", (data) => {
    try {
      const message = JSON.parse(data.toString()); // Используем toString() для безопасности
      console.log(`📨 Получено сообщение типа: ${message.type}`);

      if (message.type === "join") {
        const username = message.username;

        // Проверяем, есть ли уже пользователь с таким именем
        const existingUserEntry = Array.from(connectedUsers.entries()).find(
          ([ws, user]) => user.username === username
        );

        if (existingUserEntry) {
          const [existingWs, existingUser] = existingUserEntry;

          // Если это тот же самый сокет (переподключение) или старый сокет закрыт
          if (existingWs === ws || existingWs.readyState !== 1) {
            // Заменяем старый сокет на новый
            connectedUsers.delete(existingWs);
            connectedUsers.set(ws, { username: username });

            console.log(`🔄 ${username} переподключился`);

            // Не уведомляем о "новом" пользователе, только обновляем online count
            broadcastOnlineCount();

            // Отправляем историю новому соединению
            ws.send(
              JSON.stringify({
                type: "history",
                messages: chatHistory.slice(-50),
              })
            );

            return;
          } else {
            // Другой пользователь пытается зайти под тем же именем
            ws.send(
              JSON.stringify({
                type: "error",
                message: "Пользователь с таким именем уже в чате",
              })
            );
            ws.close();
            return;
          }
        }

        // Добавляем пользователя
        const user = { ws, username: message.username };
        connectedUsers.set(ws, { username: username });

        console.log(`👤 ${username} присоединился`);

        // Уведомляем всех о новом пользователе
        broadcast(
          {
            type: "user_joined",
            username: username,
            onlineCount: connectedUsers.size,
            timestamp: Date.now(),
          },
          ws
        );

        // Отправляем обновлённое количество онлайн
        broadcastOnlineCount();
      }

      if (message.type === "message") {
        const user = connectedUsers.get(ws);
        if (!user) {
          console.log("❌ Сообщение от неавторизованного пользователя");
          ws.send(
            JSON.stringify({
              type: "error",
              message: "Сначала войдите в чат",
            })
          );
          return;
        }

        // Используем ID от клиента или создаем новый
        const chatMessage = {
          id:
            message.id ||
            `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
          type: "message",
          text: (message.text || "").substring(0, 500),
          username: user.username,
          timestamp: message.timestamp || Date.now(),
        };

        console.log(
          `💬 ${user.username} отправил: "${chatMessage.text.substring(0, 50)}${
            chatMessage.text.length > 50 ? "..." : ""
          }"`
        );

        // Сохраняем в историю
        addToHistory(chatMessage);

        // ОТПРАВЛЯЕМ ВСЕМ ВКЛЮЧАЯ ОТПРАВИТЕЛЯ (для подтверждения)
        broadcast(chatMessage);

        console.log(`✅ Сообщение ${chatMessage.id} сохранено и отправлено`);
      }

      if (message.type === "clear_chat") {
        const user = connectedUsers.get(ws);
        if (user && connectedUsers.size <= 2) {
          // Только если мало пользователей
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

      // Обработка heartbeat
      if (message.type === "heartbeat") {
        const user = connectedUsers.get(ws);
        if (user) {
          ws.send(
            JSON.stringify({
              type: "heartbeat_ack",
              timestamp: Date.now(),
            })
          );
        }
      }

      // Обработка user_status
      if (message.type === "user_status") {
        const user = connectedUsers.get(ws);
        if (user) {
          broadcast({
            type: "user_status",
            username: user.username,
            status: message.status,
            timestamp: message.timestamp,
          });
        }
      }
    } catch (error) {
      console.error("❌ Ошибка обработки сообщения:", error, "Данные:", data);

      // Отправляем клиенту сообщение об ошибке
      try {
        ws.send(
          JSON.stringify({
            type: "error",
            message: "Ошибка обработки сообщения",
          })
        );
      } catch (e) {
        console.error("Не удалось отправить ошибку клиенту:", e);
      }
    }
  });

  ws.on("close", () => {
    const user = connectedUsers.get(ws);

    if (user) {
      console.log(`🔌 ${user.username} разорвал соединение`);

      // Не удаляем сразу, даем время на переподключение
      setTimeout(() => {
        // Проверяем, не переподключился ли пользователь за это время
        const isStillConnected = Array.from(connectedUsers.entries()).some(
          ([existingWs, existingUser]) =>
            existingUser.username === user.username &&
            existingWs.readyState === 1
        );

        if (!isStillConnected) {
          connectedUsers.delete(ws);
          console.log(`👋 ${user.username} окончательно вышел`);

          broadcast({
            type: "user_left",
            username: user.username,
            onlineCount: connectedUsers.size,
            timestamp: Date.now(),
          });

          broadcastOnlineCount();
        }
      }, USER_RECONNECT_TIMEOUT);
    }
  });

  ws.on("error", (error) => {
    console.error("❌ WebSocket ошибка:", error);
  });
});

function broadcast(message, excludeWs = null) {
  const data = JSON.stringify(message);
  let sentCount = 0;

  wss.clients.forEach((client) => {
    if (client.readyState === 1) {
      // 1 = OPEN
      try {
        client.send(data);
        sentCount++;
      } catch (error) {
        console.error("❌ Ошибка отправки сообщения клиенту:", error);
      }
    }
  });

  console.log(`📤 Сообщение ${message.type} отправлено ${sentCount} клиентам`);
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

// Периодическая очистка мертвых соединений
setInterval(() => {
  const deadConnections = [];

  connectedUsers.forEach((user, ws) => {
    if (ws.readyState !== 1) {
      // Не OPEN
      deadConnections.push({ ws, user });
    }
  });

  deadConnections.forEach(({ ws, user }) => {
    connectedUsers.delete(ws);
    console.log(`🧹 Очищено мертвое соединение для ${user.username}`);
  });

  if (deadConnections.length > 0) {
    broadcastOnlineCount();
  }
}, 30000); // Каждые 30 секунд

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
