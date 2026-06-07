/**
 * Token Research Mode
 *
 * Connects to Pump.fun WebSocket, applies the same fast-buy filter as the real
 * bot, then observes each qualifying token's price for 10 minutes (30 s polls).
 * No purchases are ever made. Results are appended to research.json.
 *
 * Run via: npm run research
 */

import { writeFileSync, readFileSync, existsSync } from "fs";
import { logger } from "./logger.js";
import { sleep } from "./helpers.js";
import { startPumpFunDetector } from "../detector/pumpfun.js";
import type { TokenLaunchEvent } from "../detector/pumpfun.js";
import { fetchPrice, checkBondingCurve, getSolPriceUsd } from "../monitor/priceMonitor.js";
import { config } from "./config.js";

// ── Research parameters ────────────────────────────────────────────────────────

const TARGET_TOKEN_COUNT = 5;
const TP_PERCENT         = 10;    // same threshold as real bot default
const SL_PERCENT         = 8;     // same threshold as real bot default
const POLL_INTERVAL_MS   = 30_000; // 30 s between price samples
const OBSERVATION_POLLS  = 20;    // 20 × 30 s = 10 min total observation
const OUTPUT_FILE        = "research.json";

// Pump.fun bonding-curve launch parameters (virtual reserves at t=0)
// Price at launch = 30 SOL / 1,073,000,000 tokens ≈ $0.00000419 at SOL=$150
const PUMPFUN_BASE_SOL_RESERVE = 30;           // SOL
const PUMPFUN_BASE_TOKEN_COUNT = 1_073_000_000; // tokens (human-readable units)

// Mirror the banned-word list from index.ts
const FAST_BUY_BANNED_WORDS = [
  "elon", "trump", "biden", "legally", "official", "registered",
  "binance", "coinbase", "solana team",
];

// ── Types ──────────────────────────────────────────────────────────────────────

interface PriceSample {
  timestamp: string; // ISO
  price: number;
  ageSeconds: number; // seconds since token launch (not since detection)
}

interface ResearchResult {
  mint: string;
  name: string;
  symbol: string;
  detectedAt: string;            // ISO — when this bot received the WS event
  launchTimestamp: number;       // Unix seconds from Pump.fun event
  ageAtDetectionSeconds: number; // token age when first seen by the bot
  priceAtDetection: number;      // bonding-curve price at detection moment
  priceHistory: PriceSample[];   // t=0 (detection) + one entry per 30 s poll
  maxPrice: number;              // peak price during observation window
  maxPriceAgeSeconds: number;    // token age (since launch) when peak occurred
  finalPrice: number;            // last recorded price (end of 10-min window)
  wouldHitTP: boolean;           // did price ever reach +10% from detection?
  wouldHitSL: boolean;           // did price ever fall to  -8% from detection?
  tpAgeSeconds: number | null;   // token age when TP threshold first crossed
  slAgeSeconds: number | null;   // token age when SL threshold first crossed
  basePriceUsd: number;          // theoretical Pump.fun launch price (30 SOL / 1.073B tokens × SOL/USD)
  entryPremium: number;          // % above basePriceUsd the bot would have paid at detection
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function isBannedName(name: string, symbol: string): boolean {
  const haystack = `${name} ${symbol}`.toLowerCase();
  return FAST_BUY_BANNED_WORDS.some(w => haystack.includes(w));
}

function pct(price: number, base: number): string {
  const v = ((price - base) / base) * 100;
  return `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`;
}

function printSummary(results: ResearchResult[]): void {
  if (results.length === 0) return;

  const bar = "─".repeat(78);
  console.log(`\n${bar}`);
  console.log("  TOKEN RESEARCH — 10-minute behaviour after fast-buy detection");
  console.log(bar);
  console.log(
    "  " +
    "Name".padEnd(22) +
    "Age".padStart(5) +
    "  Entry+".padStart(9) +
    "  Max gain".padStart(11) +
    "  10m PnL".padStart(10) +
    "  TP hit".padStart(9) +
    "  SL hit".padStart(9)
  );
  console.log("  " + "─".repeat(83));

  for (const r of results) {
    const premStr  = `+${r.entryPremium.toFixed(1)}%`;
    const maxPct   = pct(r.maxPrice, r.priceAtDetection);
    const finalPct = pct(r.finalPrice, r.priceAtDetection);
    const tp = r.tpAgeSeconds !== null ? `@${r.tpAgeSeconds}s` : "no";
    const sl = r.slAgeSeconds !== null ? `@${r.slAgeSeconds}s` : "no";
    console.log(
      "  " +
      `${r.name} (${r.symbol})`.padEnd(22) +
      `${r.ageAtDetectionSeconds}s`.padStart(5) +
      premStr.padStart(9) +
      maxPct.padStart(11) +
      finalPct.padStart(10) +
      tp.padStart(9) +
      sl.padStart(9)
    );
  }

  console.log(bar);

  const tpHits   = results.filter(r => r.wouldHitTP).length;
  const slHits   = results.filter(r => r.wouldHitSL).length;
  const both     = results.filter(r => r.wouldHitTP && r.wouldHitSL).length;
  const avgPrem  = results.reduce((s, r) => s + r.entryPremium, 0) / results.length;
  const avgMax   = results.reduce((s, r) => s + (r.maxPrice   - r.priceAtDetection) / r.priceAtDetection * 100, 0) / results.length;
  const avgFin   = results.reduce((s, r) => s + (r.finalPrice - r.priceAtDetection) / r.priceAtDetection * 100, 0) / results.length;

  console.log(
    `  TP (≥+${TP_PERCENT}%): ${tpHits}/${results.length}  ` +
    `SL (≤-${SL_PERCENT}%): ${slHits}/${results.length}  ` +
    `Both: ${both}/${results.length}`
  );
  console.log(
    `  Avg entry premium: +${avgPrem.toFixed(1)}%  ` +
    `Avg max gain: +${avgMax.toFixed(1)}%  ` +
    `Avg 10m PnL: ${avgFin >= 0 ? "+" : ""}${avgFin.toFixed(1)}%`
  );
  console.log(`${bar}\n`);
}

// ── Observation loop ───────────────────────────────────────────────────────────

async function observeToken(
  event: TokenLaunchEvent,
  ageAtDetectionSeconds: number,
  detectedAt: Date,
  priceAtDetection: number,   // already fetched by handleToken
): Promise<ResearchResult> {
  // Reconstruct launch Unix seconds from event (or estimate from detection time)
  const launchTimestamp: number = event.timestamp
    ?? Math.floor(detectedAt.getTime() / 1_000) - ageAtDetectionSeconds;

  // Theoretical Pump.fun launch price based on initial virtual reserves.
  // Uses live SOL/USD so the premium reflects actual market conditions at detection.
  const solPriceUsd  = await getSolPriceUsd();
  const basePriceUsd = (PUMPFUN_BASE_SOL_RESERVE / PUMPFUN_BASE_TOKEN_COUNT) * solPriceUsd;
  const entryPremium = ((priceAtDetection - basePriceUsd) / basePriceUsd) * 100;

  logger.info(
    `[RESEARCH] ${event.name} base=$${basePriceUsd.toFixed(8)} ` +
    `entry=$${priceAtDetection.toFixed(8)} ` +
    `premium=${entryPremium >= 0 ? "+" : ""}${entryPremium.toFixed(1)}% ` +
    `(SOL=$${solPriceUsd.toFixed(2)})`
  );

  const priceHistory: PriceSample[] = [{
    timestamp: detectedAt.toISOString(),
    price:     priceAtDetection,
    ageSeconds: ageAtDetectionSeconds,
  }];

  let maxPrice          = priceAtDetection;
  let maxPriceAgeSeconds = ageAtDetectionSeconds;
  let tpAgeSeconds: number | null = null;
  let slAgeSeconds: number | null = null;
  let lastKnownPrice    = priceAtDetection;

  for (let poll = 1; poll <= OBSERVATION_POLLS; poll++) {
    await sleep(POLL_INTERVAL_MS);

    const now        = Date.now();
    const ageSeconds = Math.floor((now - launchTimestamp * 1_000) / 1_000);
    const price      = await fetchPrice(event.mint);

    if (price === null) {
      // No price source available — carry forward last known value
      logger.warn(
        `[RESEARCH] ${event.name} poll ${poll}/${OBSERVATION_POLLS}: ` +
        `no price — carrying $${lastKnownPrice.toFixed(8)}`
      );
      priceHistory.push({
        timestamp: new Date(now).toISOString(),
        price: lastKnownPrice,
        ageSeconds,
      });
    } else {
      lastKnownPrice = price;
      priceHistory.push({ timestamp: new Date(now).toISOString(), price, ageSeconds });

      if (price > maxPrice) {
        maxPrice          = price;
        maxPriceAgeSeconds = ageSeconds;
      }

      const changePct = ((price - priceAtDetection) / priceAtDetection) * 100;
      if (tpAgeSeconds === null && changePct >= TP_PERCENT)  tpAgeSeconds = ageSeconds;
      if (slAgeSeconds === null && changePct <= -SL_PERCENT) slAgeSeconds = ageSeconds;

      logger.info(
        `[RESEARCH] ${event.name} poll ${poll}/${OBSERVATION_POLLS}: ` +
        `$${price.toFixed(8)} (${pct(price, priceAtDetection)}) ` +
        `age=${ageSeconds}s`
      );
    }
  }

  return {
    mint:                  event.mint,
    name:                  event.name,
    symbol:                event.symbol,
    detectedAt:            detectedAt.toISOString(),
    launchTimestamp,
    ageAtDetectionSeconds,
    priceAtDetection,
    priceHistory,
    maxPrice,
    maxPriceAgeSeconds,
    finalPrice:            lastKnownPrice,
    wouldHitTP:            tpAgeSeconds !== null,
    wouldHitSL:            slAgeSeconds !== null,
    tpAgeSeconds,
    slAgeSeconds,
    basePriceUsd,
    entryPremium,
  };
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Hard-block any accidental purchase paths
  process.env["DRY_RUN"] = "true";

  logger.info("=== Token Research Mode — DRY_RUN forced, no purchases ===");
  logger.info(
    `Target: ${TARGET_TOKEN_COUNT} tokens | ` +
    `TP=${TP_PERCENT}% SL=${SL_PERCENT}% | ` +
    `Observation: ${OBSERVATION_POLLS} × ${POLL_INTERVAL_MS / 1_000}s = ` +
    `${(OBSERVATION_POLLS * POLL_INTERVAL_MS) / 60_000} min`
  );
  logger.info(`Fast-buy age filter: < ${config.fastBuyMaxAgeSeconds}s | Output: ${OUTPUT_FILE}`);

  // Slot counter — incremented *before* the first await so concurrent events
  // can't both think "I'm slot 5".  Decremented if initial price fetch fails.
  let collectedCount = 0;
  const observedMints       = new Set<string>();
  const pendingObservations: Promise<ResearchResult>[] = [];

  async function handleToken(event: TokenLaunchEvent): Promise<void> {
    // ── Early exits (synchronous, no slot consumed) ──────────────────────────
    if (collectedCount >= TARGET_TOKEN_COUNT) return;
    if (observedMints.has(event.mint))        return;

    if (isBannedName(event.name, event.symbol)) {
      logger.info(`[RESEARCH] SKIP ${event.name} (${event.symbol}) — banned name`);
      return;
    }

    const ageSeconds = event.timestamp
      ? Math.max(0, Math.floor(Date.now() / 1_000 - event.timestamp))
      : 0;

    if (ageSeconds >= config.fastBuyMaxAgeSeconds) {
      logger.info(
        `[RESEARCH] SKIP ${event.name} — age=${ageSeconds}s ` +
        `(limit ${config.fastBuyMaxAgeSeconds}s)`
      );
      return;
    }

    // ── Claim mint before any await to prevent duplicate concurrent checks ────
    // (A second WS message for the same mint could arrive while we await the RPC.)
    observedMints.add(event.mint);

    // ── Bonding-curve check (RPC, up to ~4 s with retry) ─────────────────────
    const bcInfo = await checkBondingCurve(event.mint);
    if (bcInfo.status !== "active") {
      logger.info(
        `[RESEARCH] SKIP ${event.name} (${event.symbol}) — not a Pump.fun token (no BC)`
      );
      // Keep in observedMints — repeated RPC calls for the same non-Pump.fun
      // mint would always fail and waste time.
      return;
    }

    // Recheck after await — another token may have filled the last slot while
    // the BC check was running.
    if (collectedCount >= TARGET_TOKEN_COUNT) return;

    // ── Reserve slot (effectively atomic — JS event loop is single-threaded) ─
    collectedCount++;
    const detectedAt = new Date();

    logger.info(
      `[RESEARCH] [${collectedCount}/${TARGET_TOKEN_COUNT}] ` +
      `Accepted ${event.name} (${event.symbol}) age=${ageSeconds}s ` +
      `mint=${event.mint}`
    );

    // ── Fetch initial price (1 retry after 3 s) ───────────────────────────────
    let priceAtDetection = await fetchPrice(event.mint);
    if (priceAtDetection === null) {
      await sleep(3_000);
      priceAtDetection = await fetchPrice(event.mint);
    }

    if (priceAtDetection === null) {
      logger.warn(
        `[RESEARCH] ${event.name} — no initial price after retry, ` +
        `releasing slot (${collectedCount - 1}/${TARGET_TOKEN_COUNT})`
      );
      collectedCount--;             // release reserved slot
      observedMints.delete(event.mint); // allow re-evaluation later
      return;
    }

    logger.info(
      `[RESEARCH] ${event.name} initial price: $${priceAtDetection.toFixed(8)} ` +
      `— starting ${(OBSERVATION_POLLS * POLL_INTERVAL_MS) / 60_000}-min observation`
    );

    // ── Start 10-minute background observation ────────────────────────────────
    pendingObservations.push(
      observeToken(event, ageSeconds, detectedAt, priceAtDetection)
    );
  }

  // Run WebSocket detector in background (loops forever)
  startPumpFunDetector(handleToken).catch(err => {
    logger.error(`[RESEARCH] WebSocket detector crashed: ${err}`);
  });

  // Block until TARGET_TOKEN_COUNT slots are filled with valid initial prices
  while (collectedCount < TARGET_TOKEN_COUNT) {
    await sleep(500);
  }

  logger.info(
    `[RESEARCH] All ${TARGET_TOKEN_COUNT} tokens collected — ` +
    `waiting for 10-min observations to complete...`
  );

  const results = await Promise.all(pendingObservations);

  // ── Persist results ───────────────────────────────────────────────────────
  let allResults: ResearchResult[] = [];
  if (existsSync(OUTPUT_FILE)) {
    try {
      const existing = JSON.parse(readFileSync(OUTPUT_FILE, "utf8")) as unknown;
      if (Array.isArray(existing)) allResults = existing as ResearchResult[];
      logger.info(
        `[RESEARCH] Appending to existing ${OUTPUT_FILE} ` +
        `(${allResults.length} previous entries)`
      );
    } catch {
      logger.warn(`[RESEARCH] Could not parse existing ${OUTPUT_FILE} — overwriting`);
    }
  }

  allResults.push(...results);
  writeFileSync(OUTPUT_FILE, JSON.stringify(allResults, null, 2), "utf8");
  logger.info(
    `[RESEARCH] Saved ${results.length} new results → ${OUTPUT_FILE} ` +
    `(total in file: ${allResults.length})`
  );

  // ── Console summary ───────────────────────────────────────────────────────
  printSummary(results);

  process.exit(0);
}

main().catch(err => {
  logger.error(`[RESEARCH] Fatal error: ${err}`);
  process.exit(1);
});
