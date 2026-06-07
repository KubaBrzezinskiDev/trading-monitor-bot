import { existsSync, appendFileSync } from "fs";
import { logger } from "./logger.js";

const TRADES_FILE = "trades.csv";
const CSV_HEADER = "date,mint,name,symbol,action,amountSOL,priceUSD,txid,pnlSOL\n";

export interface BuyTrade {
  mint: string;
  name: string;
  symbol: string;
  amountSOL: number;
  priceUSD: number;
  txid: string | null;
}

export interface SellTrade {
  mint: string;
  name: string;
  symbol: string;
  amountSOL: number;
  priceUSD: number;
  txid: string | null;
  pnlSOL: number;
}

function escapeField(value: string): string {
  if (value.includes(",") || value.includes('"') || value.includes("\n")) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function appendRow(fields: (string | number)[]): void {
  try {
    if (!existsSync(TRADES_FILE)) {
      appendFileSync(TRADES_FILE, CSV_HEADER, "utf8");
    }
    const row = fields.map((f) => escapeField(String(f))).join(",") + "\n";
    appendFileSync(TRADES_FILE, row, "utf8");
  } catch (err) {
    logger.error(`tradeLogger write failed: ${err}`);
  }
}

export function logBuy(trade: BuyTrade): void {
  appendRow([
    new Date().toISOString(),
    trade.mint,
    trade.name,
    trade.symbol,
    "BUY",
    trade.amountSOL.toFixed(6),
    trade.priceUSD.toFixed(10),
    trade.txid ?? "",
    "",
  ]);
}

export function logSell(trade: SellTrade): void {
  appendRow([
    new Date().toISOString(),
    trade.mint,
    trade.name,
    trade.symbol,
    "SELL",
    trade.amountSOL.toFixed(6),
    trade.priceUSD.toFixed(10),
    trade.txid ?? "",
    trade.pnlSOL.toFixed(6),
  ]);
}
