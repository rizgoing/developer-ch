const WebSocket = require("ws");
const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, "public");

// Убедимся, что папка public существует
if (!fs.existsSync(PUBLIC_DIR)) {
  console.log("⚠️ Папка public не найдена, создаю...");
  fs.mkdirSync(PUBLIC_DIR, { recursive: true });

  // Создаем базовый index.html если его нет
  const basicHTML = `<!DOCTYPE html>
<html>
<head>
    <title>Chat Loading...</title>
    <style>body { font-family: Arial; padding: 50px; text-align: center; }</style>
</head>
<body>
    <h1>Chat is loading...</h1>
    <p>If you see this, static files are being served.</p>
</body>
</html>`;

  fs.writeFileSync(path.join(PUBLIC_DIR, "index.html"), basicHTML);
}

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
  const fullPath = path.join(PUBLIC_DIR, filePath);

  // Проверяем, существует ли файл
  fs.readFile(fullPath, (err, content) => {
    if (err) {
      // Если файл не найден, показываем index.html (для SPA)
      if (err.code === "ENOENT") {
        fs.readFile(path.join(PUBLIC_DIR, "index.html"), (err, data) => {
          if (err) {
            res.writeHead(500, { "Content-Type": "text/plain" });
            res.end("Server Error: Cannot load index.html");
          } else {
            res.writeHead(200, { "Content-Type": "text/html" });
            res.end(data);
          }
        });
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

let users = [];

wss.on("connection", (ws) => {
  console.log("🔗 Новое WebSocket подключение");

  ws.on("message", (data) => {
    try {
      const message = JSON.parse(data);

      if (message.type === "join") {
        // Проверяем, нет ли уже пользователя с таким именем
        const existingUser = users.find((u) => u.username === message.username);
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
        users.push(user);

        console.log(`👤 ${message.username} присоединился`);

        // Отправляем историю (пустую для простоты)
        ws.send(
          JSON.stringify({
            type: "history",
            messages: [],
          })
        );

        // Уведомляем всех о новом пользователе
        broadcast(
          {
            type: "user_joined",
            username: message.username,
            onlineCount: users.length,
          },
          ws
        );
      }

      if (message.type === "message") {
        const user = users.find((u) => u.ws === ws);
        if (!user) return;

        const chatMessage = {
          type: "message",
          id: Date.now(),
          text: message.text.substring(0, 500),
          username: user.username,
          timestamp: Date.now(),
        };

        console.log(
          `💬 ${user.username}: ${chatMessage.text.substring(0, 50)}`
        );

        // Отправляем всем
        broadcast(chatMessage);
      }
    } catch (error) {
      console.error("❌ Ошибка обработки сообщения:", error);
    }
  });

  ws.on("close", () => {
    const userIndex = users.findIndex((u) => u.ws === ws);
    if (userIndex !== -1) {
      const username = users[userIndex].username;
      users.splice(userIndex, 1);
      console.log(`👋 ${username} отключился`);

      broadcast({
        type: "user_left",
        username: username,
        onlineCount: users.length,
      });
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

// Запускаем сервер
server.listen(PORT, () => {
  console.log("=".repeat(50));
  console.log(`🚀 Сервер запущен на порту: ${PORT}`);
  console.log(`📁 Папка public: ${PUBLIC_DIR}`);
  console.log(`📂 Файлы в public: ${fs.readdirSync(PUBLIC_DIR).join(", ")}`);
  console.log("=".repeat(50));
});

// Обработка ошибок
process.on("uncaughtException", (error) => {
  console.error("🔥 Необработанная ошибка:", error);
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("🔥 Необработанный промис:", reason);
});
