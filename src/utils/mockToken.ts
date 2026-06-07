import type { TokenData } from "../analyzer/scamDetector.js";

// BONK — real mainnet token with Jupiter liquidity, used for realistic quote testing
export const MOCK_MINT = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";

export const MOCK_TOKEN_DATA: TokenData = {
  mint: MOCK_MINT,
  name: "MoonRocket",
  symbol: "MOON",
  creatorAddress: "11111111111111111111111111111111",
  createdAt: new Date(Date.now() - 300_000), // 5 min old
  creatorSupplyPercent: 3,    // low creator concentration
  holderCount: 850,           // healthy distribution
  liquidityUsd: 48_000,       // $48k liquidity
  liquidityLocked: true,
};

// Fallback price used when Dexscreener hasn't indexed the token yet
export const MOCK_BUY_PRICE_USD = 0.000001;
