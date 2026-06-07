import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

const LOG_FILE = join("logs", "bot.log");
const MAX_LINES = 1_000;

function ensureLogDir(): void {
  if (!existsSync("logs")) mkdirSync("logs", { recursive: true });
}

function writeToFile(line: string): void {
  try {
    ensureLogDir();
    appendFileSync(LOG_FILE, line + "\n", "utf8");

    // Trim to MAX_LINES when file grows too large (check every ~50 writes)
    if (Math.random() < 0.02) {
      const content = readFileSync(LOG_FILE, "utf8");
      const lines = content.split("\n").filter(Boolean);
      if (lines.length > MAX_LINES) {
        writeFileSync(LOG_FILE, lines.slice(-MAX_LINES).join("\n") + "\n", "utf8");
      }
    }
  } catch {
    // non-critical — console output still works
  }
}

type LogLevel = "INFO" | "WARN" | "ERROR";

function log(level: LogLevel, message: string): void {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] [${level}] ${message}`;
  console.log(line);
  writeToFile(line);
}

export const logger = {
  info:  (message: string) => log("INFO",  message),
  warn:  (message: string) => log("WARN",  message),
  error: (message: string) => log("ERROR", message),
};
