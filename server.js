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

  // Сразу отправляем историю чата новому пользователю
  ws.send(
    JSON.stringify({
      type: "history",
      messages: chatHistory,
    })
  );

  ws.on("message", (data) => {
    try {
      const message = JSON.parse(data);

      if (message.type === "join") {
        // Проверяем, нет ли уже пользователя с таким именем
        const existingUser = Array.from(connectedUsers.values()).find(
          (user) => user.username === message.username
        );

        if (existingUser) {
          ws.send(
            JSON.stringify({
              type: "error",
              message: "Пользователь с таким именем уже в чате",
            })
          );
          ws.close();
          return;
        }

        // Добавляем пользователя
        const user = { ws, username: message.username };
        connectedUsers.set(ws, user);

        console.log(`👤 ${message.username} присоединился`);

        // Уведомляем всех о новом пользователе
        broadcast(
          {
            type: "user_joined",
            username: message.username,
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
    } catch (error) {
      console.error("❌ Ошибка обработки сообщения:", error);
    }
  });

  ws.on("close", () => {
    const user = connectedUsers.get(ws);
    if (user) {
      console.log(`👋 ${user.username} отключился`);
      connectedUsers.delete(ws);

      broadcast({
        type: "user_left",
        username: user.username,
        onlineCount: connectedUsers.size,
        timestamp: Date.now(),
      });

      broadcastOnlineCount();
    }
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
    count: connectedUsers.size,
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
