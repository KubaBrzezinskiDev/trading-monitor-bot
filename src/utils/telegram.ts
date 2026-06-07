import { config } from "./config.js";
import { logger } from "./logger.js";

export async function sendTelegram(message: string): Promise<void> {
  const { telegramBotToken, telegramChatId } = config;
  if (!telegramBotToken || !telegramChatId) return;

  try {
    const res = await fetch(
      `https://api.telegram.org/bot${telegramBotToken}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: telegramChatId, text: message }),
      }
    );
    if (!res.ok) {
      const body = await res.text();
      logger.warn(`Telegram API error (${res.status}): ${body}`);
    }
  } catch (err) {
    logger.warn(`Telegram send failed: ${err}`);
  }
}
