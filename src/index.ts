import { config } from "./utils/config.js";
import { logger } from "./utils/logger.js";
import { sleep } from "./utils/helpers.js";
import { getBalance, keypair } from "./trader/wallet.js";
import { startPumpFunDetector } from "./detector/pumpfun.js";
import type { TokenLaunchEvent } from "./detector/pumpfun.js";
import { parseTokenMetrics } from "./detector/tokenParser.js";
import { preFilter } from "./analyzer/scamDetector.js";
import type { TokenData } from "./analyzer/scamDetector.js";
import { analyzeToken, isDailyLimitReached } from "./analyzer/claude.js";
import { getQuote, executeSwap } from "./trader/jupiter.js";
import {
  addPosition, hasPosition, getPosition, removePosition,
  startPriceMonitor, fetchPrice, setWalletBalance, getSolPriceUsd,
  checkBondingCurve,
} from "./monitor/priceMonitor.js";
import { executeSell } from "./monitor/tpsl.js";
import { logBuy } from "./utils/tradeLogger.js";
import { sendTelegram } from "./utils/telegram.js";

const SOL_MINT = "So11111111111111111111111111111111111111112";
const PRICE_FETCH_DELAY_MS    = 5_000;
const PRICE_FETCH_MAX_RETRIES = 24;   // 24 × 5s = 2 min max wait for buy price
const TOKEN_INDEX_DELAY_MS = 45_000; // wait for RPC to index new token
const MAX_CONCURRENT_ANALYSIS = 5;   // cap parallel parseTokenMetrics calls

// Words that indicate obvious scams / impersonators — skip fast buy if present in name/symbol
const FAST_BUY_BANNED_WORDS = [
  "elon", "trump", "biden", "legally", "official", "registered",
  "binance", "coinbase", "solana team",
];

// Simple counting semaphore — limits concurrent async operations
class Semaphore {
  private running = 0;
  private queue: Array<() => void> = [];
  constructor(private readonly limit: number) {}

  async acquire(): Promise<void> {
    if (this.running < this.limit) {
      this.running++;
      return;
    }
    await new Promise<void>((resolve) => this.queue.push(resolve));
    this.running++;
  }

  release(): void {
    this.running--;
    const next = this.queue.shift();
    if (next) next();
  }
}

const analysisSemaphore = new Semaphore(MAX_CONCURRENT_ANALYSIS);

// Tracks mints currently being analyzed (after hasPosition check but before addPosition).
// Prevents duplicate buys when the same mint arrives twice from the WebSocket.
const pendingMints = new Set<string>();

const BUY_COOLDOWN_MS = 2 * 60 * 1_000; // max 1 buy per 2 minutes
let lastBuyTime = 0;

// Daily-limit pause — set when Claude limit hit, cleared at UTC midnight
let dailyLimitPaused = false;

function scheduleMidnightReset(): void {
  const now = new Date();
  const midnight = new Date(now);
  midnight.setUTCHours(24, 0, 0, 0);
  setTimeout(() => {
    dailyLimitPaused = false;
    logger.info("Daily Claude limit reset — resuming token analysis");
  }, midnight.getTime() - now.getTime());
}

function parsePercent(s: string, fallback: number): number {
  const n = Math.abs(parseFloat(s.replace("%", "")));
  return isNaN(n) ? fallback : n;
}

function clampTp(raw: string): number {
  const n = parsePercent(raw, config.defaultTpPercent);
  return Math.min(Math.max(n, 10), 15);
}

function clampSl(raw: string): number {
  const n = parsePercent(raw, config.defaultSlPercent);
  return Math.min(Math.max(n, 8), 12);
}

function isBannedName(name: string, symbol: string): boolean {
  const haystack = `${name} ${symbol}`.toLowerCase();
  return FAST_BUY_BANNED_WORDS.some((word) => haystack.includes(word));
}

// Shared buy execution: get quote → swap → derive price → log → addPosition.
// Returns false if quote or swap failed.
async function executeBuyAndTrack(
  mint: string,
  name: string,
  symbol: string,
  tpPercent: number,
  slPercent: number,
): Promise<boolean> {
  const quote = await getQuote(SOL_MINT, mint, config.maxTradeAmountSol);
  if (!quote) return false;

  const txid = await executeSwap(quote, keypair);
  lastBuyTime = Date.now();
  if (txid) logger.info(`[BOUGHT] ${name} (${symbol}) tx=${txid}`);

  // ── Derive buy price ──────────────────────────────────────────────────────
  // Primary: compute from swap quote — exact, no API needed.
  // quote.inAmount  = SOL lamports spent
  // quote.outAmount = raw tokens received (Pump.fun = 6 decimals)
  let buyPriceUsd: number | null = null;

  const solPrice = await getSolPriceUsd();
  const tokensReceived = Number(quote.outAmount) / 1e6;
  if (solPrice > 0 && tokensReceived > 0) {
    const solPerToken = (Number(quote.inAmount) / 1e9) / tokensReceived;
    buyPriceUsd = solPerToken * solPrice;
    logger.info(`[BUY PRICE] ${name} $${buyPriceUsd.toFixed(8)} (derived from quote, SOL=$${solPrice.toFixed(2)})`);
  }

  // Fallback: poll bonding curve / Jupiter for up to 2 minutes
  if (buyPriceUsd === null) {
    logger.warn(`[BUY PRICE] ${name} — SOL price unavailable, retrying fetchPrice up to ${PRICE_FETCH_MAX_RETRIES * PRICE_FETCH_DELAY_MS / 1000}s`);
    for (let i = 0; i < PRICE_FETCH_MAX_RETRIES && buyPriceUsd === null; i++) {
      if (i > 0) await sleep(PRICE_FETCH_DELAY_MS);
      buyPriceUsd = await fetchPrice(mint);
    }
    if (buyPriceUsd !== null) {
      logger.info(`[BUY PRICE] ${name} $${buyPriceUsd.toFixed(8)} (from price API after retry)`);
    } else {
      logger.warn(`[BUY PRICE] ${name} — still null after 2 min, TP/SL will activate on first price update`);
    }
  }

  logBuy({
    mint,
    name,
    symbol,
    amountSOL: config.maxTradeAmountSol,
    priceUSD: buyPriceUsd ?? 0,
    txid,
  });

  addPosition({
    mint,
    name,
    symbol,
    buyPriceUsd: buyPriceUsd ?? 0,
    amountTokens: quote.outAmount,
    tpPercent,
    slPercent,
    solSpent: config.maxTradeAmountSol,
  });

  return true;
}

// PHASE 2 — background verification after fast buy.
// Fetches creator supply % from RPC; emergency-sells if creator holds > 50%.
async function verifyAfterFastBuy(
  mint: string,
  name: string,
  symbol: string,
  creatorAddress: string,
): Promise<void> {
  logger.info(`[FAST BUY VERIFY] ${name} — waiting ${TOKEN_INDEX_DELAY_MS / 1000}s for RPC`);
  await sleep(TOKEN_INDEX_DELAY_MS);

  await analysisSemaphore.acquire();
  let metrics;
  try {
    metrics = await parseTokenMetrics(mint, creatorAddress);
  } finally {
    analysisSemaphore.release();
  }

  if (!metrics) {
    logger.warn(`[FAST BUY VERIFY] ${name} — metrics unavailable, keeping position`);
    return;
  }

  if (metrics.creatorSupplyPercent <= 50) {
    logger.info(`[FAST BUY VERIFY] ${name} — creator ${metrics.creatorSupplyPercent.toFixed(1)}% OK`);
    sendTelegram(
      `✅ Fast buy verified: ${name} — creator ${metrics.creatorSupplyPercent.toFixed(1)}% supply, all clear`
    ).catch(() => {});
    return;
  }

  logger.warn(`[EMERGENCY SELL] ${name} — creator holds ${metrics.creatorSupplyPercent.toFixed(1)}%`);
  sendTelegram(
    `🚨 Emergency sell: ${name} — creator holds ${metrics.creatorSupplyPercent.toFixed(1)}% supply`
  ).catch(() => {});

  if (!hasPosition(mint)) return; // already closed by TP/SL

  const position = getPosition(mint);
  if (!position) return;

  const currentPrice = (await fetchPrice(mint)) ?? position.buyPriceUsd;
  const sold = await executeSell(position, currentPrice, "manual");
  if (sold) removePosition(mint);
}

// PHASE 1 — immediate buy for fresh tokens (age < fastBuyMaxAgeSeconds).
async function handleFastBuy(event: TokenLaunchEvent, ageSeconds: number): Promise<void> {
  const { mint, name, symbol, traderPublicKey: creatorAddress } = event;

  if (isBannedName(name, symbol)) {
    logger.info(`[SKIP] ${name} (${symbol}) age=${ageSeconds}s — banned name`);
    return;
  }

  // Minimum age — wait ≥10 s so first buyers can enter the curve
  if (ageSeconds <= 10) {
    logger.info(`[SKIP] ${name} (${symbol}) age=${ageSeconds}s — too fresh (min 10s)`);
    return;
  }

  const cooldownRemaining = BUY_COOLDOWN_MS - (Date.now() - lastBuyTime);
  if (cooldownRemaining > 0) {
    logger.info(`[SKIP] ${mint} — buy cooldown active (${Math.ceil(cooldownRemaining / 1000)}s remaining)`);
    return;
  }

  if (hasPosition(mint)) {
    logger.info(`[SKIP] ${name} (${symbol}) — already have open position`);
    return;
  }

  const bcInfo = await checkBondingCurve(mint);
  if (bcInfo.status !== "active") {
    logger.info(`[SKIP] ${name} (${symbol}) — not a Pump.fun token (no BC)`);
    return;
  }

  // Activity filter — launch reserve is exactly 30 SOL; require >31 SOL to confirm buys
  const MIN_ACTIVITY_VSOL = 31;
  if (bcInfo.vSolSol !== null && bcInfo.vSolSol <= MIN_ACTIVITY_VSOL) {
    logger.info(
      `[SKIP] ${name} (${symbol}) — no buying activity (vSol=${bcInfo.vSolSol.toFixed(3)})`
    );
    return;
  }

  logger.info(`[FAST BUY] ${name} (${symbol}) age=${ageSeconds}s — skipping RPC analysis`);

  const bought = await executeBuyAndTrack(mint, name, symbol, config.defaultTpPercent, config.defaultSlPercent);
  if (!bought) return;

  // Fire-and-forget background verification
  verifyAfterFastBuy(mint, name, symbol, creatorAddress).catch((err) => {
    logger.error(`[FAST BUY VERIFY] ${name} crashed: ${err}`);
  });
}

// PHASE 3 — full analysis for tokens older than fastBuyMaxAgeSeconds.
async function handleSlowBuy(event: TokenLaunchEvent, detectedAt: Date): Promise<void> {
  if (dailyLimitPaused) return;

  const { mint, name, symbol, traderPublicKey: creatorAddress } = event;

  logger.info(`[WAIT] ${name} (${symbol}) — indexing delay ${TOKEN_INDEX_DELAY_MS / 1000}s`);
  await sleep(TOKEN_INDEX_DELAY_MS);

  await analysisSemaphore.acquire();
  let metrics;
  try {
    metrics = await parseTokenMetrics(mint, creatorAddress);
  } finally {
    analysisSemaphore.release();
  }
  if (!metrics) return;

  const tokenData: TokenData = {
    mint,
    name,
    symbol,
    creatorAddress,
    createdAt: detectedAt,
    creatorSupplyPercent: metrics.creatorSupplyPercent,
    holderCount: metrics.holderCount,
    liquidityUsd: metrics.liquidityUsd,
    liquidityLocked: metrics.liquidityLocked,
  };

  if (!preFilter(tokenData)) return;

  const decision = await analyzeToken(tokenData);
  if (!decision) {
    if (isDailyLimitReached() && !dailyLimitPaused) {
      dailyLimitPaused = true;
      logger.info("Daily limit reached, pausing until midnight");
      sendTelegram("📊 Dzienny limit 300 analiz osiągnięty — bot wstrzymuje zakupy do północy").catch(() => {});
      scheduleMidnightReset();
    }
    return;
  }

  if (!decision.buy) {
    logger.info(`[SKIP] ${mint} — ${decision.reason}`);
    return;
  }

  if (decision.confidence < config.claudeMinConfidence) {
    logger.info(`[SKIP] ${mint} — confidence ${decision.confidence} < ${config.claudeMinConfidence}`);
    return;
  }

  const cooldownRemaining = BUY_COOLDOWN_MS - (Date.now() - lastBuyTime);
  if (cooldownRemaining > 0) {
    logger.info(`[SKIP] ${mint} — buy cooldown active (${Math.ceil(cooldownRemaining / 1000)}s remaining)`);
    return;
  }

  if (hasPosition(mint)) {
    logger.info(`[SKIP] ${name} (${symbol}) — already have open position`);
    return;
  }

  logger.info(
    `[BUY] ${name} (${symbol}) | confidence=${decision.confidence} TP=${decision.suggestedTP} SL=${decision.suggestedSL} | ${decision.reason}`
  );

  await executeBuyAndTrack(mint, name, symbol, clampTp(decision.suggestedTP), clampSl(decision.suggestedSL));
}

async function handleNewToken(event: TokenLaunchEvent): Promise<void> {
  const { mint } = event;

  if (hasPosition(mint) || pendingMints.has(mint)) {
    logger.info(`[SKIP] ${mint} — already processing or position open`);
    return;
  }
  pendingMints.add(mint);

  try {
    const detectedAt = new Date();
    // event.timestamp is Unix seconds from PumpPortal; absent → assume token is fresh
    const ageSeconds = event.timestamp
      ? Math.max(0, Math.floor(Date.now() / 1000 - event.timestamp))
      : 0;

    if (config.fastBuyEnabled && ageSeconds < config.fastBuyMaxAgeSeconds) {
      await handleFastBuy(event, ageSeconds);
    } else {
      await handleSlowBuy(event, detectedAt);
    }
  } finally {
    pendingMints.delete(mint);
  }
}

async function main(): Promise<void> {
  logger.info("=== Solana Memecoin Trading Bot starting ===");
  logger.info(`Network: ${config.solanaNetwork} | DRY_RUN: ${config.dryRun}`);
  logger.info(
    `Fast buy: ${config.fastBuyEnabled ? `enabled (age < ${config.fastBuyMaxAgeSeconds}s)` : "disabled"}`
  );

  const balance = await getBalance();
  setWalletBalance(balance);
  logger.info(`Wallet: ${keypair.publicKey.toBase58()} | Balance: ${balance.toFixed(4)} SOL`);

  await sendTelegram(
    `🟢 Bot uruchomiony | Sieć: ${config.solanaNetwork} | DRY_RUN: ${config.dryRun} | Balans: ${balance.toFixed(4)} SOL`
  );

  if (!config.dryRun && balance < config.maxTradeAmountSol) {
    logger.error(
      `Insufficient balance: ${balance.toFixed(4)} SOL < ${config.maxTradeAmountSol} SOL required`
    );
    process.exit(1);
  }

  startPriceMonitor().catch((err: unknown) => {
    logger.error(`Price monitor crashed: ${err}`);
    process.exit(1);
  });

  logger.info("Listening for new token launches on Pump.fun...");
  await startPumpFunDetector(handleNewToken);
}

async function shutdown(): Promise<void> {
  logger.info("Bot stopping...");
  await sendTelegram("🔴 Bot zatrzymany");
  process.exit(0);
}

process.on("SIGINT", () => { shutdown().catch(() => process.exit(0)); });
process.on("SIGTERM", () => { shutdown().catch(() => process.exit(0)); });

main().catch((err: unknown) => {
  logger.error(`Fatal error: ${err}`);
  process.exit(1);
});
