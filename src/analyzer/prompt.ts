import type { TokenData } from "./scamDetector.js";

export function buildPrompt(token: TokenData): string {
  const ageSeconds = ((Date.now() - token.createdAt.getTime()) / 1000).toFixed(0);
  const liquidity = token.liquidityUsd > 0
    ? `$${token.liquidityUsd.toFixed(0)}`
    : "not yet available (normal for Pump.fun at this stage)";

  const holderNote = token.holderCount === 0
    ? "0 (bonding curve stage — normal, SPL accounts created on first buy)"
    : String(token.holderCount);

  return [
    `Token: ${token.name} (${token.symbol})`,
    `Mint: ${token.mint}`,
    `Detected: ${ageSeconds}s ago`,
    `Creator supply: ${token.creatorSupplyPercent.toFixed(2)}%`,
    `SPL holders: ${holderNote}`,
    `Liquidity USD: ${liquidity}`,
    `Liquidity locked: ${token.liquidityLocked}`,
  ].join("\n");
}
