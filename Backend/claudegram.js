const TelegramBot = require("node-telegram-bot-api");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const https = require("https");
const os = require("os");

const token = "8764353844:AAGW3lOL3zA6iif5HU7K188D6ej8x4KByPM";
const allowedChatId = 7142981840;

const CLAUDE_EXE = path.join(
  process.env.APPDATA || "",
  "npm",
  "node_modules",
  "@anthropic-ai",
  "claude-code",
  "bin",
  "claude.exe",
);

// Detect project root by walking up from __dirname until we find CLAUDE.md
function findProjectRoot(startDir) {
  let dir = startDir;
  while (true) {
    if (fs.existsSync(path.join(dir, "CLAUDE.md"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error("Could not find project root (no CLAUDE.md found)");
    dir = parent;
  }
}

const WORK_DIR = findProjectRoot(__dirname);

// Persistent storage paths — always relative to project root, not __dirname
const SESSIONS_FILE = path.join(WORK_DIR, ".claude-sessions.json");
const WORK_CONTEXT_FILE = path.join(WORK_DIR, "work_context.md");

const bot = new TelegramBot(token, { polling: true });

console.log("🚀 Claude Telegram Bot Running");
console.log("📁 Working dir:", WORK_DIR);
console.log("🤖 Claude EXE:", CLAUDE_EXE);

// ─── Session persistence ─────────────────────────────────────────────────────

function loadSessions() {
  try {
    fs.mkdirSync(path.dirname(SESSIONS_FILE), { recursive: true });
    if (fs.existsSync(SESSIONS_FILE)) {
      const data = JSON.parse(fs.readFileSync(SESSIONS_FILE, "utf8"));
      return new Map(Object.entries(data));
    }
  } catch (e) {
    console.error("[Sessions] Failed to load sessions file:", e.message);
  }
  return new Map();
}

function saveSessions(sessions) {
  try {
    fs.mkdirSync(path.dirname(SESSIONS_FILE), { recursive: true });
    const obj = {};
    for (const [k, v] of sessions) obj[k] = v;
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(obj, null, 2));
  } catch (e) {
    console.error("[Sessions] Failed to save sessions file:", e.message);
  }
}

// chatId → sessionId (loaded from disk on startup)
const sessions = loadSessions();
console.log(`[Sessions] Loaded ${sessions.size} persisted session(s)`);

// ─── Work context ─────────────────────────────────────────────────────────────

function loadWorkContext() {
  try {
    if (fs.existsSync(WORK_CONTEXT_FILE)) {
      return fs.readFileSync(WORK_CONTEXT_FILE, "utf8").trim();
    }
  } catch (e) {}
  return null;
}

function buildFreshSessionPrompt(userPrompt) {
  const context = loadWorkContext();
  if (!context) return userPrompt;

  return `PREVIOUS WORK CONTEXT (session expired, resuming from saved state):
---
${context}
---

USER REQUEST: ${userPrompt}`;
}

// Appended to every prompt so Claude keeps work_context.md up to date
const CONTEXT_UPDATE_SUFFIX = `

---
IMPORTANT: After completing the above task, update the file at D:/Project/21042026/work_context.md with a brief summary of:
- What was just done (1-3 bullet points)
- What is currently in progress or pending
- Which files were modified and which branch is active
Keep it under 30 lines. Overwrite the whole file each time.

ALSO IMPORTANT: Always end your response with a plain-text summary of what you found or did — even for simple questions. Never finish silently with only tool calls. The user reads your final text message on Telegram.`;

// ─── Claude spawner ───────────────────────────────────────────────────────────

const COMMON_ARGS = ["--allowedTools", "Read,Edit,Bash,Write,Glob,Grep", "--output-format", "json"];

function spawnClaude(args, stdinText, chatId) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    const startedAt = Date.now();

    const label = args[0] === "--resume" ? `resume:${args[1].slice(0, 8)}` : "new";
    console.log(`[Claude][${label}] Spawning: claude ${args.slice(0, 3).join(" ")} ...`);
    console.log(`[Claude][${label}] CWD: ${WORK_DIR}`);
    if (stdinText) {
      console.log(`[Claude][${label}] Stdin (first 200 chars): ${stdinText.slice(0, 200)}`);
    }

    const proc = spawn(CLAUDE_EXE, args, {
      cwd: WORK_DIR,
      env: { ...process.env },
      stdio: ["pipe", "pipe", "pipe"],
    });

    console.log(`[Claude][${label}] PID: ${proc.pid}`);

    if (stdinText) {
      proc.stdin.write(stdinText);
    }
    proc.stdin.end();

    // Heartbeat — log every 30s so we know it's still running
    const heartbeat = setInterval(() => {
      const elapsed = Math.round((Date.now() - startedAt) / 1000);
      console.log(`[Claude][${label}] Still running... ${elapsed}s elapsed | stdout=${stdout.length}b stderr=${stderr.length}b`);
    }, 30000);

    proc.stdout.on("data", (d) => {
      const chunk = d.toString();
      stdout += chunk;
      console.log(`[Claude][${label}] stdout chunk (${chunk.length}b): ${chunk.slice(0, 120).replace(/\n/g, "\\n")}`);
    });

    proc.stderr.on("data", (d) => {
      const chunk = d.toString();
      stderr += chunk;
      // Log each stderr line individually so we can see Claude's progress
      for (const line of chunk.split("\n")) {
        if (line.trim()) console.log(`[Claude][${label}] stderr: ${line}`);
      }
    });

    const timer = setTimeout(() => {
      clearInterval(heartbeat);
      const elapsed = Math.round((Date.now() - startedAt) / 1000);
      console.log(`[Claude][${label}] TIMEOUT after ${elapsed}s — killing PID ${proc.pid}`);
      proc.kill();
      bot.sendMessage(chatId, "⏰ Timeout after 10 minutes.");
      resolve({ code: -1, text: "", sessionId: null });
    }, 600000);

    proc.on("close", (code) => {
      clearTimeout(timer);
      clearInterval(heartbeat);
      const elapsed = Math.round((Date.now() - startedAt) / 1000);
      console.log(`[Claude][${label}] Exited with code ${code} after ${elapsed}s | stdout=${stdout.length}b stderr=${stderr.length}b`);
      try {
        const json = JSON.parse(stdout.trim());
        const text = json.result || json.content || json.message || json.text || json.response || "";
        const sessionId = json.session_id || json.sessionId || null;
        console.log(`[Claude][${label}] Parsed JSON ok | session=${sessionId} | text_len=${text.length} | turns=${json.num_turns || "?"} | cost=$${(json.total_cost_usd || 0).toFixed(4)}`);
        resolve({ code, text, sessionId });
      } catch (e) {
        console.log(`[Claude][${label}] JSON parse failed (${e.message}) | raw: ${stdout.slice(0, 300)}`);
        resolve({ code, text: (stdout || stderr || "").trim(), sessionId: null });
      }
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      clearInterval(heartbeat);
      console.log(`[Claude][${label}] Spawn error: ${err.message}`);
      resolve({ code: -1, text: err.message, sessionId: null });
    });
  });
}

async function runClaude(chatId, prompt) {
  console.log(`[${new Date().toISOString()}] Prompt: ${prompt.slice(0, 100)}`);

  const sessionId = sessions.get(String(chatId));
  const promptWithSuffix = prompt + CONTEXT_UPDATE_SUFFIX;
  let result;

  if (sessionId) {
    bot.sendMessage(chatId, `⏳ Continuing conversation...\n${prompt.slice(0, 80)}`);
    console.log(`[${new Date().toISOString()}] Resuming session: ${sessionId}`);
    result = await spawnClaude(
      ["--resume", sessionId, ...COMMON_ARGS],
      promptWithSuffix,
      chatId,
    );

    if (result.code !== 0) {
      console.log(`[${new Date().toISOString()}] Resume failed — starting fresh with context`);
      sessions.delete(String(chatId));
      saveSessions(sessions);
      const freshPrompt = buildFreshSessionPrompt(promptWithSuffix);
      const hasContext = !!loadWorkContext();
      bot.sendMessage(chatId, `🔄 Session expired — starting new session${hasContext ? " with previous work context" : ""}...`);
      result = await spawnClaude(["-p", freshPrompt, ...COMMON_ARGS], null, chatId);
    }
  } else {
    const freshPrompt = buildFreshSessionPrompt(promptWithSuffix);
    const hasContext = !!loadWorkContext();
    bot.sendMessage(chatId, `🆕 Starting new session${hasContext ? " with previous work context" : ""}...\n${prompt.slice(0, 80)}`);
    result = await spawnClaude(["-p", freshPrompt, ...COMMON_ARGS], null, chatId);
  }

  const { code, text, sessionId: newSessionId } = result;
  console.log(`[${new Date().toISOString()}] Exit: ${code}, Session: ${newSessionId}, Output: ${text.length} chars`);

  if (newSessionId) {
    sessions.set(String(chatId), newSessionId);
    saveSessions(sessions);
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
      "✅ Claude Code bot is running!\n\nSend me:\n• Any text instruction\n• A photo/screenshot with a caption describing what to do\n• /new — start a fresh session\n• /status — show current session info",
    );
    return;
  }

  if (msg.text === "/new") {
    sessions.delete(String(chatId));
    saveSessions(sessions);
    bot.sendMessage(chatId, "🆕 Session cleared. Starting fresh on your next message.");
    return;
  }

  if (msg.text === "/status") {
    const sid = sessions.get(String(chatId));
    const ctx = loadWorkContext();
    const ctxPreview = ctx ? ctx.slice(0, 300) + (ctx.length > 300 ? "..." : "") : "No saved context yet.";
    bot.sendMessage(chatId, `📋 Session: ${sid ? sid.slice(0, 20) + "..." : "none (will start fresh)"}\n\nLast work context:\n${ctxPreview}`);
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
