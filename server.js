const WebSocket = require("ws");
const http = require("http");
const fs = require("fs");
const path = require("path");

// Конфигурация
const PORT = process.env.PORT || 3000;
const HISTORY_FILE = path.join(__dirname, "chat_history.json");
const MAX_HISTORY = 100;

// Хранилище данных
let chatHistory = [];
let connectedUsers = new Map();

// Загружаем историю из файла
function loadHistory() {
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      const data = fs.readFileSync(HISTORY_FILE, "utf8");
      chatHistory = JSON.parse(data);
      console.log(`Загружено ${chatHistory.length} сообщений из истории`);
    }
  } catch (error) {
    console.error("Ошибка загрузки истории:", error);
    chatHistory = [];
  }
}

// Сохраняем историю в файл
function saveHistory() {
  try {
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(chatHistory, null, 2));
  } catch (error) {
    console.error("Ошибка сохранения истории:", error);
  }
}

// Добавляем сообщение в историю
function addToHistory(message) {
  chatHistory.push(message);

  if (chatHistory.length > MAX_HISTORY) {
    chatHistory = chatHistory.slice(-MAX_HISTORY);
  }

  saveHistory();
}

// Создаем HTTP сервер
const server = http.createServer((req, res) => {
  const ext = path.extname(req.url);
  let contentType = "text/html";
  let filePath = "";

  if (req.url === "/" || req.url === "/index.html") {
    filePath = path.join(__dirname, "index.html");
    contentType = "text/html";
  } else if (req.url === "/style.css") {
    filePath = path.join(__dirname, "style.css");
    contentType = "text/css";
  } else if (req.url === "/client.js") {
    filePath = path.join(__dirname, "client.js");
    contentType = "application/javascript";
  } else {
    res.writeHead(404);
    res.end("Not Found");
    return;
  }

  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(500);
      res.end("Server Error");
    } else {
      res.writeHead(200, { "Content-Type": contentType });
      res.end(content);
    }
  });
});

// Создаем WebSocket сервер
const wss = new WebSocket.Server({ server });

// Обработка подключений WebSocket
wss.on("connection", (ws, req) => {
  console.log("Новое подключение");

  // Отправляем историю чата новому пользователю
  ws.send(
    JSON.stringify({
      type: "history",
      messages: chatHistory,
    })
  );

  // Обработка сообщений от клиента
  ws.on("message", (data) => {
    try {
      const message = JSON.parse(data);
      handleClientMessage(ws, message);
    } catch (error) {
      console.error("Ошибка парсинга сообщения:", error);
      ws.send(
        JSON.stringify({
          type: "error",
          message: "Неверный формат сообщения",
        })
      );
    }
  });

  // Обработка отключения
  ws.on("close", () => {
    const user = connectedUsers.get(ws);
    if (user) {
      console.log(`${user.username} отключился`);
      connectedUsers.delete(ws);

      broadcast(
        {
          type: "user_left",
          username: user.username,
          onlineCount: connectedUsers.size,
        },
        ws
      );

      broadcastOnlineCount();
    }
  });

  // Обработка ошибок
  ws.on("error", (error) => {
    console.error("WebSocket ошибка:", error);
  });
});

// Обработка сообщений от клиентов
function handleClientMessage(ws, message) {
  switch (message.type) {
    case "join":
      const existingUser = Array.from(connectedUsers.values()).find(
        (u) => u.username === message.username
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

      connectedUsers.set(ws, {
        username: message.username,
        joinTime: Date.now(),
      });

      console.log(`${message.username} присоединился к чату`);

      broadcast(
        {
          type: "user_joined",
          username: message.username,
          onlineCount: connectedUsers.size,
        },
        ws
      );

      broadcastOnlineCount();
      break;

    case "message":
      const user = connectedUsers.get(ws);
      if (!user) {
        ws.send(
          JSON.stringify({
            type: "error",
            message: "Сначала представьтесь",
          })
        );
        return;
      }

      if (!message.text || message.text.trim().length === 0) {
        return;
      }

      const chatMessage = {
        id:
          message.id ||
          Date.now() + "-" + Math.random().toString(36).substr(2, 9),
        type: "message",
        text: message.text.trim().substring(0, 500),
        username: user.username,
        timestamp: message.timestamp || Date.now(),
      };

      // Сохраняем в историю
      addToHistory(chatMessage);

      // Отправляем всем
      broadcast(chatMessage);
      break;

    case "clear_chat":
      if (connectedUsers.size <= 2) {
        chatHistory = [];
        saveHistory();

        broadcast({
          type: "clear_chat",
          username: message.username,
          timestamp: Date.now(),
        });
      }
      break;
  }
}

// Рассылка сообщения всем подключенным клиентам
function broadcast(message, excludeWs = null) {
  const data = JSON.stringify(message);

  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN && client !== excludeWs) {
      client.send(data);
    }
  });
}

// Рассылка количества онлайн пользователей
function broadcastOnlineCount() {
  broadcast({
    type: "online_count",
    count: connectedUsers.size,
  });
}

// Запуск сервера
server.listen(PORT, () => {
  loadHistory();
  console.log(`Сервер запущен на порту ${PORT}`);
  console.log(`Откройте http://localhost:${PORT} в браузере`);
});

// Обработка завершения работы
process.on("SIGINT", () => {
  console.log("\nСервер останавливается...");
  saveHistory();
  process.exit(0);
});
