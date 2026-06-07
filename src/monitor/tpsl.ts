import { logger } from "../utils/logger.js";
import { config } from "../utils/config.js";
import { getQuoteForSell, executeSwap } from "../trader/jupiter.js";
import { keypair } from "../trader/wallet.js";
import { logSell } from "../utils/tradeLogger.js";
import { sendTelegram } from "../utils/telegram.js";
import type { Position } from "./priceMonitor.js";

const SOL_MINT = "So11111111111111111111111111111111111111112";

/**
 * Pure TP/SL decision — no side effects, no logging.
 * Logging happens in pollOnce() before this call so it fires every cycle
 * regardless of hold status.
 */
export function checkTpSl(position: Position, currentPrice: number): "tp" | "sl" | null {
  const changePct = ((currentPrice - position.buyPriceUsd) / position.buyPriceUsd) * 100;
  return changePct >= position.tpPercent  ? "tp"
       : changePct <= -position.slPercent ? "sl"
       : null;
}

// Returns true if sell succeeded (or dry-run simulated), false if real swap failed.
// Caller should only remove the position on true — false means retry next poll.
export async function executeSell(
  position: Position,
  currentPrice: number,
  trigger: "tp" | "sl" | "manual"
): Promise<boolean> {
  const changePct = ((currentPrice - position.buyPriceUsd) / position.buyPriceUsd) * 100;
  const outcome = trigger === "tp" ? "PROFIT" : trigger === "sl" ? "LOSS" : "SELL";

  const quoteResult = await getQuoteForSell(position.mint, SOL_MINT, position.amountTokens);

  if (quoteResult === "dead") {
    // TOKEN_NOT_TRADABLE exhausted — Jupiter never indexed this token
    logger.error(
      `[DEAD] ${position.name} (${position.symbol}) — TOKEN_NOT_TRADABLE after 5 attempts,` +
        ` logging as full loss (-${position.solSpent.toFixed(4)} SOL)`
    );
    logSell({
      mint:      position.mint,
      name:      position.name,
      symbol:    position.symbol,
      amountSOL: 0,
      priceUSD:  currentPrice,
      txid:      null,
      pnlSOL:    -position.solSpent,
    });
    sendTelegram(
      `💀 ${position.name} (${position.symbol}) niehandlowalny po 5 próbach — pełna strata -${position.solSpent.toFixed(4)} SOL`
    ).catch(() => {});
    return true; // remove position
  }

  if (!quoteResult) {
    logger.error(`Failed to get sell quote for ${position.mint} — will retry next poll`);
    return false;
  }

  const quote = quoteResult;
  const txid = await executeSwap(quote, keypair);

  if (!txid && !config.dryRun) {
    logger.error(`Sell swap failed for ${position.mint} — tokens unsold, will retry next poll`);
    return false;
  }

  const solReceived = Number(quote.outAmount) / 1_000_000_000;
  const pnlSol = solReceived - position.solSpent;

  logger.info(
    `${outcome} [${position.mint}] ${changePct >= 0 ? "+" : ""}${changePct.toFixed(2)}%` +
      ` | spent: ${position.solSpent.toFixed(4)} SOL` +
      ` | received: ${solReceived.toFixed(4)} SOL` +
      ` | PnL: ${pnlSol >= 0 ? "+" : ""}${pnlSol.toFixed(4)} SOL` +
      (txid ? ` | tx: ${txid}` : " | (dry run)")
  );

  logSell({
    mint: position.mint,
    name: position.name,
    symbol: position.symbol,
    amountSOL: solReceived,
    priceUSD: currentPrice,
    txid,
    pnlSOL: pnlSol,
  });

  const absPnl = Math.abs(pnlSol).toFixed(4);
  if (trigger === "tp") {
    sendTelegram(`✅ Sprzedano ${position.name} (${position.symbol}) z zyskiem +${absPnl} SOL`).catch(() => {});
  } else if (trigger === "sl") {
    sendTelegram(`❌ Sprzedano ${position.name} (${position.symbol}) ze stratą -${absPnl} SOL`).catch(() => {});
  } else {
    sendTelegram(`🔄 Zamknięto ręcznie ${position.name} (${position.symbol}) PnL ${pnlSol >= 0 ? "+" : "-"}${absPnl} SOL`).catch(() => {});
  }

  return true;
}
