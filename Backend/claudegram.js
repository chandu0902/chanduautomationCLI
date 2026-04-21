const TelegramBot = require("node-telegram-bot-api");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const https = require("https");
const os = require("os");

const token = "8764353844:AAGW3lOL3zA6iif5HU7K188D6ej8x4KByPM";
const allowedChatId = 7142981840;
const WORK_DIR = path.resolve(__dirname, "..");

const CLAUDE_EXE = path.join(
  process.env.APPDATA || "",
  "npm",
  "node_modules",
  "@anthropic-ai",
  "claude-code",
  "bin",
  "claude.exe",
);

const bot = new TelegramBot(token, { polling: true });

console.log("🚀 Claude Telegram Bot Running");
console.log("📁 Working dir:", WORK_DIR);
console.log("🤖 Claude EXE:", CLAUDE_EXE);

// chatId → sessionId
const sessions = new Map();

const COMMON_ARGS = ["--allowedTools", "Read,Edit,Bash,Write", "--output-format", "json"];

function spawnClaude(args, stdinText, chatId) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";

    const proc = spawn(CLAUDE_EXE, args, {
      cwd: WORK_DIR,
      env: { ...process.env },
      stdio: ["pipe", "pipe", "pipe"],
    });

    if (stdinText) {
      proc.stdin.write(stdinText);
    }
    proc.stdin.end();

    proc.stdout.on("data", (d) => { stdout += d.toString(); });
    proc.stderr.on("data", (d) => { stderr += d.toString(); });

    const timer = setTimeout(() => {
      proc.kill();
      bot.sendMessage(chatId, "⏰ Timeout after 3 minutes.");
      resolve({ code: -1, text: "", sessionId: null });
    }, 180000);

    proc.on("close", (code) => {
      clearTimeout(timer);
      try {
        const json = JSON.parse(stdout.trim());
        resolve({
          code,
          text: json.result || "",
          sessionId: json.session_id || null,
        });
      } catch {
        resolve({ code, text: (stdout || stderr || "").trim(), sessionId: null });
      }
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: -1, text: err.message, sessionId: null });
    });
  });
}

async function runClaude(chatId, prompt) {
  console.log(`[${new Date().toISOString()}] Prompt: ${prompt.slice(0, 100)}`);
  bot.sendMessage(chatId, `⏳ Running Claude...\n${prompt.slice(0, 80)}`);

  const sessionId = sessions.get(chatId);
  let result;

  if (sessionId) {
    console.log(`[${new Date().toISOString()}] Resuming session: ${sessionId}`);
    result = await spawnClaude(
      ["--resume", sessionId, ...COMMON_ARGS],
      prompt,
      chatId,
    );

    if (result.code !== 0) {
      console.log(`[${new Date().toISOString()}] Resume failed — starting fresh`);
      sessions.delete(chatId);
      result = await spawnClaude(["-p", prompt, ...COMMON_ARGS], null, chatId);
    }
  } else {
    result = await spawnClaude(["-p", prompt, ...COMMON_ARGS], null, chatId);
  }

  const { code, text, sessionId: newSessionId } = result;
  console.log(`[${new Date().toISOString()}] Exit: ${code}, Session: ${newSessionId}, Output: ${text.length} chars`);

  if (newSessionId) {
    sessions.set(chatId, newSessionId);
  }

  if (!text) {
    bot.sendMessage(chatId, code === 0 ? "✅ Done. No output." : `❌ Failed (exit ${code}). No output.`);
    return;
  }

  for (let i = 0; i < text.length; i += 4000) {
    bot.sendMessage(chatId, text.slice(i, i + 4000));
  }

  if (code === 0) {
    bot.sendMessage(chatId, "✅ Task completed successfully.");
  } else {
    bot.sendMessage(chatId, `❌ Claude exited with code ${code}. Check output above for errors.`);
  }
}

function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    https.get(url, (res) => {
      res.pipe(file);
      file.on("finish", () => file.close(resolve));
    }).on("error", (err) => {
      fs.unlink(destPath, () => {});
      reject(err);
    });
  });
}

async function handleFileMessage(chatId, fileId, caption, mimeType) {
  try {
    const fileInfo = await bot.getFile(fileId);
    const fileUrl = `https://api.telegram.org/file/bot${token}/${fileInfo.file_path}`;
    const ext = path.extname(fileInfo.file_path) || (mimeType && mimeType.includes("png") ? ".png" : ".jpg");
    const tmpPath = path.join(os.tmpdir(), `tg_file_${Date.now()}${ext}`);

    bot.sendMessage(chatId, "⬇️ Downloading file...");
    await downloadFile(fileUrl, tmpPath);
    console.log(`[${new Date().toISOString()}] File saved: ${tmpPath}`);

    const instruction = caption || "Describe what you see in this image and suggest relevant code changes.";
    const prompt = `The user sent an image with this instruction: "${instruction}"\n\nThe image has been saved to: ${tmpPath}\n\nUse the Read tool to view the image at that path, understand what the user wants, then make the appropriate changes to the project codebase.`;
    runClaude(chatId, prompt);
  } catch (err) {
    console.error("File download error:", err);
    bot.sendMessage(chatId, `❌ Failed to process file: ${err.message}`);
  }
}

bot.on("message", async (msg) => {
  const msgType = msg.photo ? "photo" : msg.document ? "document" : msg.text ? "text" : "other";
  console.log(`[${new Date().toISOString()}] MSG from ${msg.chat.id}: type=${msgType} caption="${(msg.caption || "").slice(0, 60)}" text="${(msg.text || "").slice(0, 60)}"`);

  if (msg.chat.id !== allowedChatId) {
    bot.sendMessage(msg.chat.id, "❌ Unauthorized.");
    return;
  }

  const chatId = msg.chat.id;

  if (msg.text === "/start") {
    bot.sendMessage(
      chatId,
      "✅ Claude Code bot is running!\n\nSend me:\n• Any text instruction\n• A photo/screenshot with a caption describing what to do\n• /new — start a fresh session",
    );
    return;
  }

  if (msg.text === "/new") {
    sessions.delete(chatId);
    bot.sendMessage(chatId, "🆕 Session cleared. Starting fresh on your next message.");
    return;
  }

  if (msg.photo) {
    const photo = msg.photo[msg.photo.length - 1];
    await handleFileMessage(chatId, photo.file_id, msg.caption, "image/jpeg");
    return;
  }

  if (msg.document) {
    const mime = msg.document.mime_type || "";
    if (mime.startsWith("image/")) {
      await handleFileMessage(chatId, msg.document.file_id, msg.caption, mime);
    } else {
      bot.sendMessage(chatId, `⚠️ Unsupported file type: ${mime}. Send images or text instructions.`);
    }
    return;
  }

  if (msg.text) {
    runClaude(chatId, msg.text);
    return;
  }

  bot.sendMessage(chatId, "⚠️ Unsupported message type. Send text or an image.");
});

bot.on("polling_error", (err) => {
  console.error("Polling error:", err.message);
});

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection:", reason);
});
