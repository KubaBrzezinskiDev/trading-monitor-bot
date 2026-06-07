import { logger } from "../utils/logger.js";
import { sleep } from "../utils/helpers.js";
import { sendTelegram } from "../utils/telegram.js";

// PumpPortal public WebSocket API — free for new-token subscriptions.
// Set PUMPPORTAL_API_KEY in .env if you have one (unlocks higher rate limits).
// Override the full URL via PUMPFUN_WS_URL if you prefer a different provider.
function buildWsUrl(): string {
  if (process.env.PUMPFUN_WS_URL) return process.env.PUMPFUN_WS_URL;
  const base = "wss://pumpportal.fun/api/data";
  const key = process.env.PUMPPORTAL_API_KEY;
  return key ? `${base}?api-key=${key}` : base;
}

const PUMPFUN_WS_URL = buildWsUrl();

const RECONNECT_BASE_MS = 10_000;  // start at 10s
const RECONNECT_MAX_MS  = 120_000; // cap at 2 min
const INACTIVITY_TIMEOUT_MS = 30_000; // reconnect if no message for 30s

export interface TokenLaunchEvent {
  txType: string;
  mint: string;
  traderPublicKey: string;
  name: string;
  symbol: string;
  uri?: string;
  timestamp?: number; // Unix seconds — provided by PumpPortal; used to compute token age
}

function isTokenLaunch(data: unknown): data is TokenLaunchEvent {
  if (typeof data !== "object" || data === null) return false;
  const d = data as Record<string, unknown>;
  return (
    d.txType === "create" &&
    typeof d.mint === "string" &&
    typeof d.traderPublicKey === "string" &&
    typeof d.name === "string" &&
    typeof d.symbol === "string"
  );
}

type TokenHandler = (event: TokenLaunchEvent) => Promise<void>;

function handleMessage(raw: string, onToken: TokenHandler): void {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return;
  }

  if (!isTokenLaunch(data)) return;

  logger.info(
    `New token | name=${data.name} symbol=${data.symbol} mint=${data.mint} creator=${data.traderPublicKey}`
  );

  onToken(data).catch((err) => {
    logger.error(`Token handler failed [${data.mint}]: ${err}`);
  });
}

// Returns true if the WebSocket opened at least once (connection was established),
// false if it never connected (e.g. network error before "open").
async function connect(onToken: TokenHandler): Promise<boolean> {
  return new Promise((resolve) => {
    logger.info(`Connecting to Pump.fun WebSocket: ${PUMPFUN_WS_URL}`);

    const ws = new WebSocket(PUMPFUN_WS_URL);
    let done = false;
    let opened = false;

    const finish = (reason: string) => {
      if (done) return;
      done = true;
      clearInterval(inactivityTimer);
      logger.warn(`${reason}. Will reconnect...`);
      try { ws.close(); } catch { /* already closed */ }
      resolve(opened);
    };

    // Inactivity watchdog — reconnect if no message arrives for INACTIVITY_TIMEOUT_MS
    let lastMessageAt = Date.now();
    const inactivityTimer = setInterval(() => {
      if (Date.now() - lastMessageAt > INACTIVITY_TIMEOUT_MS) {
        finish(`WebSocket inactivity (no message for ${INACTIVITY_TIMEOUT_MS / 1000}s)`);
      }
    }, 5_000);

    ws.addEventListener("open", () => {
      opened = true;
      logger.info("Pump.fun WebSocket connected. Subscribing to new tokens...");
      lastMessageAt = Date.now();
      ws.send(JSON.stringify({ method: "subscribeNewToken" }));
    });

    ws.addEventListener("message", (event) => {
      lastMessageAt = Date.now();
      handleMessage(typeof event.data === "string" ? event.data : String(event.data), onToken);
    });

    ws.addEventListener("error", (event) => {
      const msg = (event as ErrorEvent).message ?? "unknown error";
      logger.error(`WebSocket error: ${msg}`);
      finish("WebSocket error");
    });

    ws.addEventListener("close", (event) => {
      finish(`WebSocket closed (code=${event.code})`);
    });
  });
}

// 3 consecutive "never opened" fails within this window → alert + long pause
const RAPID_FAIL_THRESHOLD  = 3;
const RAPID_FAIL_WINDOW_MS  = 30_000;
const PENALTY_DELAY_MS      = 5 * 60_000;

export async function startPumpFunDetector(onToken: TokenHandler): Promise<never> {
  let reconnectDelay = RECONNECT_BASE_MS;
  let failStreak     = 0;
  let streakStartAt: number | null = null;

  while (true) {
    const connected = await connect(onToken);

    if (connected) {
      // Session opened (even if it later dropped) — reset everything
      reconnectDelay = RECONNECT_BASE_MS;
      failStreak     = 0;
      streakStartAt  = null;
    } else {
      // Never opened — count toward rapid-fail streak
      failStreak++;
      if (streakStartAt === null) streakStartAt = Date.now();
      reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);

      const streakMs = Date.now() - streakStartAt;
      if (failStreak >= RAPID_FAIL_THRESHOLD && streakMs <= RAPID_FAIL_WINDOW_MS) {
        logger.warn(
          `WebSocket: ${failStreak} failed reconnects in ${(streakMs / 1000).toFixed(1)}s — pausing ${PENALTY_DELAY_MS / 60_000} min`
        );
        sendTelegram("⚠️ Przerwano połączenie z Pump.fun").catch(() => {});
        await sleep(PENALTY_DELAY_MS);
        // Reset after long pause — fresh start
        failStreak     = 0;
        streakStartAt  = null;
        reconnectDelay = RECONNECT_BASE_MS;
        continue;
      }
    }

    logger.info(`Reconnecting in ${reconnectDelay / 1000}s...`);
    await sleep(reconnectDelay);
  }
}
