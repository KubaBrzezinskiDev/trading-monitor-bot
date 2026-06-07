import { config } from "./config.js";
import { logger } from "./logger.js";
import { preFilter } from "../analyzer/scamDetector.js";
import { analyzeToken } from "../analyzer/claude.js";
import { getQuote, executeSwap } from "../trader/jupiter.js";
import { keypair } from "../trader/wallet.js";
import { addPosition, fetchPrice } from "../monitor/priceMonitor.js";
import { checkTpSl } from "../monitor/tpsl.js";
import { MOCK_TOKEN_DATA, MOCK_MINT, MOCK_BUY_PRICE_USD } from "./mockToken.js";

const SOL_MINT = "So11111111111111111111111111111111111111112";

function step(n: number, name: string): void {
  logger.info(`──── STEP ${n}: ${name} ────`);
}

function parsePercent(s: string): number {
  return Math.abs(parseFloat(s.replace("%", "")));
}

async function run(): Promise<void> {
  logger.info("=== TEST FLOW START ===");
  logger.info(`Network: ${config.solanaNetwork} | DRY_RUN: ${config.dryRun}`);

  if (!config.dryRun) {
    logger.error("test:flow requires DRY_RUN=true — aborting to prevent real transactions");
    process.exit(1);
  }

  // ── Step 1: mock data ──────────────────────────────────────────────────────
  step(1, "Mock token data");
  logger.info(JSON.stringify(MOCK_TOKEN_DATA, null, 2));

  // ── Step 2: preFilter ──────────────────────────────────────────────────────
  step(2, "preFilter (scam pre-check)");
  const passes = preFilter(MOCK_TOKEN_DATA);
  logger.info(`Result: ${passes ? "PASS ✓" : "FAIL ✗"}`);
  if (!passes) {
    logger.warn("Adjust mock data to pass pre-filter if needed");
    return;
  }

  // ── Step 3: Claude analysis ────────────────────────────────────────────────
  step(3, "Claude analyzeToken");
  const decision = await analyzeToken(MOCK_TOKEN_DATA);
  if (!decision) {
    logger.error("Claude returned no decision — check ANTHROPIC_API_KEY");
    return;
  }
  logger.info(JSON.stringify(decision, null, 2));

  if (!decision.buy) {
    logger.info(`Claude says no-buy: ${decision.reason}`);
    logger.info("=== TEST FLOW COMPLETE (no buy signal) ===");
    return;
  }
  if (decision.confidence < config.claudeMinConfidence) {
    logger.info(
      `Confidence ${decision.confidence} < threshold ${config.claudeMinConfidence} — skip`
    );
    logger.info("=== TEST FLOW COMPLETE (below confidence threshold) ===");
    return;
  }

  // ── Step 4: Jupiter quote ──────────────────────────────────────────────────
  step(4, "Jupiter getQuote (SOL → token)");
  const quote = await getQuote(SOL_MINT, MOCK_MINT, config.maxTradeAmountSol);
  if (!quote) {
    logger.error("Jupiter quote failed — check JUPITER_API_URL or network");
    return;
  }
  logger.info(
    `${config.maxTradeAmountSol} SOL → ${quote.outAmount} tokens` +
      ` | impact=${quote.priceImpactPct}% slippage=${quote.slippageBps}bps`
  );

  // ── Step 5: executeSwap (dry run) ──────────────────────────────────────────
  step(5, "executeSwap (DRY RUN — no real transaction)");
  const txid = await executeSwap(quote, keypair);
  logger.info(`txid: ${txid ?? "null (dry run — expected)"}`);

  // ── Step 6: Dexscreener price ──────────────────────────────────────────────
  step(6, "fetchPrice via Dexscreener");
  const livePrice = await fetchPrice(MOCK_MINT);
  logger.info(`Live price: ${livePrice !== null ? `$${livePrice}` : "unavailable — using mock fallback"}`);
  const buyPriceUsd = livePrice ?? MOCK_BUY_PRICE_USD;

  // ── Step 7: addPosition ────────────────────────────────────────────────────
  step(7, "addPosition (price monitor)");
  const tpPercent = parsePercent(decision.suggestedTP);
  const slPercent = parsePercent(decision.suggestedSL);
  const position = {
    mint: MOCK_MINT,
    name: MOCK_TOKEN_DATA.name,
    symbol: MOCK_TOKEN_DATA.symbol,
    buyPriceUsd,
    amountTokens: quote.outAmount,
    tpPercent,
    slPercent,
    solSpent: config.maxTradeAmountSol,
    boughtAt: 0, // test — treat as already past hold period
  };
  addPosition(position);

  // ── Step 8: checkTpSl simulation ──────────────────────────────────────────
  step(8, "checkTpSl simulation at TP / SL / current price");
  const tpPrice = buyPriceUsd * (1 + tpPercent / 100);
  const slPrice = buyPriceUsd * (1 - slPercent / 100);
  logger.info(
    `buyPrice=$${buyPriceUsd}` +
      ` | TP=$${tpPrice.toFixed(10)} (+${tpPercent}%)` +
      ` | SL=$${slPrice.toFixed(10)} (-${slPercent}%)`
  );
  logger.info(`At TP price    → ${checkTpSl(position, tpPrice) ?? "hold"}`);
  logger.info(`At SL price    → ${checkTpSl(position, slPrice) ?? "hold"}`);
  logger.info(`At buy price   → ${checkTpSl(position, buyPriceUsd) ?? "hold"}`);

  logger.info("=== TEST FLOW COMPLETE ===");
}

run().catch((err: unknown) => {
  logger.error(`Test flow crashed: ${err}`);
  process.exit(1);
});
