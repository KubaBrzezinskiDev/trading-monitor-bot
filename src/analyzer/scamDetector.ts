import { logger } from "../utils/logger.js";

export interface TokenData {
  mint: string;
  name: string;
  symbol: string;
  creatorAddress: string;
  createdAt: Date;
  creatorSupplyPercent: number;
  holderCount: number;
  liquidityUsd: number;
  liquidityLocked: boolean;
}

export function preFilter(token: TokenData): boolean {
  if (token.creatorSupplyPercent > 50) {
    logger.warn(
      `[SKIP] ${token.mint} creator holds ${token.creatorSupplyPercent.toFixed(1)}% supply`
    );
    return false;
  }

  // liquidityUsd is always 0 until real calculation is implemented — skip this check for now
  if (token.liquidityUsd > 0 && token.liquidityUsd < 5_000) {
    logger.warn(
      `[SKIP] ${token.mint} liquidity $${token.liquidityUsd.toFixed(0)} < $5000`
    );
    return false;
  }

  return true;
}
