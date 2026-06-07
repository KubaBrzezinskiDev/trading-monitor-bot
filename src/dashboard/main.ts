import { app, BrowserWindow, ipcMain } from "electron";
import { join } from "path";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { spawn, exec, ChildProcess } from "child_process";
import https from "https";

const PROJECT_ROOT = process.cwd();

// ── .env parser ────────────────────────────────────────────────────────────────

function parseDotEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  const file = join(PROJECT_ROOT, ".env");
  if (!existsSync(file)) return env;
  for (const raw of readFileSync(file, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf("=");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    const val = line.slice(idx + 1).trim().replace(/^["']|["']$/g, "");
    env[key] = val;
  }
  return env;
}

// ── Telegram from main process ─────────────────────────────────────────────────

function sendTelegramDirect(message: string): Promise<void> {
  return new Promise((resolve) => {
    const env = parseDotEnv();
    const token = env["TELEGRAM_BOT_TOKEN"] ?? "";
    const chatId = env["TELEGRAM_CHAT_ID"] ?? "";
    if (!token || !chatId) { resolve(); return; }

    const body = JSON.stringify({ chat_id: chatId, text: message });
    const req = https.request(
      {
        hostname: "api.telegram.org",
        path: `/bot${token}/sendMessage`,
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
      },
      () => resolve()
    );
    req.on("error", () => resolve());
    req.setTimeout(5_000, () => { req.destroy(); resolve(); });
    req.write(body);
    req.end();
  });
}

// ── Bot process management ─────────────────────────────────────────────────────

let botProcess: ChildProcess | null = null;

function killBot(): void {
  if (!botProcess) return;
  const pid = botProcess.pid;
  botProcess.removeAllListeners();
  botProcess = null;
  if (!pid) return;
  if (process.platform === "win32") {
    exec(`taskkill /F /T /PID ${pid}`);
  } else {
    try { process.kill(pid, "SIGTERM"); } catch { /* already dead */ }
  }
}

ipcMain.handle("start-bot", () => {
  if (botProcess && !botProcess.killed) return { success: false, reason: "already running" };

  const ext = process.platform === "win32" ? ".cmd" : "";
  const tsx = join(PROJECT_ROOT, "node_modules", ".bin", `tsx${ext}`);

  botProcess = spawn(tsx, ["src/index.ts"], {
    cwd: PROJECT_ROOT,
    env: parseDotEnv(),
    shell: process.platform === "win32",
    windowsHide: true,
    stdio: "inherit",
  });

  botProcess.on("exit", () => { botProcess = null; });
  return { success: true };
});

ipcMain.handle("stop-bot", async () => {
  if (!botProcess || botProcess.killed) return { success: false, reason: "not running" };
  // Send Telegram here — SIGTERM on Windows is unreliable so main process handles it
  await sendTelegramDirect("🔴 Bot zatrzymany");
  killBot();
  return { success: true };
});

ipcMain.handle("close-all-positions", () => {
  if (botProcess && !botProcess.killed) {
    // Bot running — write signal file; price monitor picks it up within 2s
    writeFileSync(join(PROJECT_ROOT, "close-all.signal"), "1", "utf8");
    return { success: true };
  }
  // Bot not running — just clear stale position files directly
  const posFile   = join(PROJECT_ROOT, "positions.json");
  const stateFile = join(PROJECT_ROOT, "dashboard-state.json");
  if (existsSync(posFile)) writeFileSync(posFile, "[]", "utf8");
  if (existsSync(stateFile)) {
    try {
      const s = JSON.parse(readFileSync(stateFile, "utf8")) as { walletBalance?: number };
      writeFileSync(stateFile, JSON.stringify(
        { positions: [], walletBalance: s.walletBalance ?? 0, updatedAt: new Date().toISOString() },
        null, 2
      ), "utf8");
    } catch {
      writeFileSync(stateFile, JSON.stringify(
        { positions: [], walletBalance: 0, updatedAt: new Date().toISOString() },
        null, 2
      ), "utf8");
    }
  }
  return { success: true };
});

ipcMain.handle("get-bot-status", () => {
  const running = botProcess !== null && !botProcess.killed;
  return { running, pid: running ? (botProcess?.pid ?? null) : null };
});

// ── State / trades ─────────────────────────────────────────────────────────────

function parseCSVLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
      else { inQuotes = !inQuotes; }
    } else if (ch === "," && !inQuotes) {
      fields.push(current); current = "";
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields;
}

function parseCSV(content: string): Record<string, string>[] {
  // Normalise Windows (\r\n) and old-Mac (\r) line endings before splitting,
  // and strip a UTF-8 BOM that Windows tools sometimes prepend.
  const cleaned = content
    .replace(/^﻿/, "")   // BOM
    .replace(/\r\n/g, "\n")   // CRLF → LF
    .replace(/\r/g, "\n");    // bare CR → LF
  const lines = cleaned.trim().split("\n").filter(l => l.trim());
  if (lines.length < 2) return [];
  const headers = parseCSVLine(lines[0] ?? "");
  return lines.slice(1).map(line => {
    const values = parseCSVLine(line);
    const obj: Record<string, string> = {};
    headers.forEach((h, i) => { obj[h.trim()] = (values[i] ?? "").trim(); });
    return obj;
  });
}

const LOG_KEYWORDS = ["[BUY]", "[SKIP]", "[SELL]", "[ERROR]", "[PROFIT]", "[LOSS]", "[BOUGHT]"];

ipcMain.handle("get-logs", () => {
  const file = join(PROJECT_ROOT, "logs", "bot.log");
  if (!existsSync(file)) return [];
  try {
    const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
    return lines.filter(l => LOG_KEYWORDS.some(kw => l.includes(kw))).slice(-200);
  } catch {
    return [];
  }
});

ipcMain.handle("get-positions", () => {
  const file = join(PROJECT_ROOT, "positions.json");
  if (!existsSync(file)) return [];
  try {
    return JSON.parse(readFileSync(file, "utf8")) as unknown[];
  } catch {
    return [];
  }
});

ipcMain.handle("get-state", () => {
  const file = join(PROJECT_ROOT, "dashboard-state.json");
  if (!existsSync(file)) return { positions: [], walletBalance: 0, updatedAt: null };
  try {
    return JSON.parse(readFileSync(file, "utf8")) as unknown;
  } catch {
    return { positions: [], walletBalance: 0, updatedAt: null };
  }
});

ipcMain.handle("get-trades", () => {
  const file = join(PROJECT_ROOT, "trades.csv");
  if (!existsSync(file)) return [];
  try {
    return parseCSV(readFileSync(file, "utf8"));
  } catch {
    return [];
  }
});

// ── Window ─────────────────────────────────────────────────────────────────────

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: "Trading Bot Dashboard",
    backgroundColor: "#0f1117",
    webPreferences: {
      preload: join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.loadFile(join(__dirname, "index.html"));
}

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  killBot();
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
