import { Connection, PublicKey } from "@solana/web3.js";
import { config } from "../utils/config.js";
import { logger } from "../utils/logger.js";
import { sleep } from "../utils/helpers.js";

const TOKEN_PROGRAM_ID = new PublicKey(
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
);

// Owners that indicate burned or locked LP tokens
const LOCK_ADDRESSES = new Set([
  "1nc1nerator11111111111111111111111111111111", // burn address
  "LocktDzaV1W2Bm9DeZeiyz4J9sMIBTCqNYQsRagw4VFE", // Streamflow locker
]);

const connection = new Connection(config.solanaRpcUrl, "confirmed");

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error("RPC timeout")), ms)
  );
  return Promise.race([promise, timeout]);
}

export interface TokenMetrics {
  mint: string;
  creatorSupplyPercent: number;
  holderCount: number;
  liquidityLocked: boolean;
  // TODO: implement real liquidity calculation
  // (SOL balance of bonding curve account × SOL price)
  liquidityUsd: number;
}

export async function parseTokenMetrics(
  mintAddress: string,
  creatorAddress: string
): Promise<TokenMetrics | null> {
  try {
    const mint = new PublicKey(mintAddress);

    // Retry mint account lookup — new tokens may not be indexed immediately
    const MINT_RETRIES = 5;
    const MINT_RETRY_DELAY_MS = 2_000;
    let mintAccountInfo: Awaited<ReturnType<typeof connection.getParsedAccountInfo>> | null = null;
    for (let attempt = 0; attempt < MINT_RETRIES; attempt++) {
      if (attempt > 0) await sleep(MINT_RETRY_DELAY_MS);
      mintAccountInfo = await connection.getParsedAccountInfo(mint);
      if (mintAccountInfo.value) break;
      logger.info(`Mint not yet indexed [${mintAddress}], attempt ${attempt + 1}/${MINT_RETRIES}`);
    }
    if (!mintAccountInfo?.value) {
      logger.warn(`Mint not found after ${MINT_RETRIES} attempts: ${mintAddress}`);
      return null;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mintData = (mintAccountInfo.value.data as any).parsed?.info;
    if (!mintData) {
      logger.warn(`Cannot parse mint data: ${mintAddress}`);
      return null;
    }
    const totalSupply = BigInt(mintData.supply as string);

    // All token accounts for this mint (dataSize=165 = standard SPL token account)
    const tokenAccounts = await withTimeout(
      connection.getParsedProgramAccounts(TOKEN_PROGRAM_ID, {
        filters: [
          { dataSize: 165 },
          { memcmp: { offset: 0, bytes: mintAddress } },
        ],
      }),
      10_000
    );

    let holderCount = 0;
    let creatorBalance = 0n;
    let liquidityLocked = false;

    for (const { account } of tokenAccounts) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const parsed = (account.data as any).parsed?.info;
      if (!parsed) continue;

      const amount = BigInt(parsed.tokenAmount.amount as string);
      if (amount === 0n) continue;

      holderCount++;

      if (parsed.owner === creatorAddress) {
        creatorBalance += amount;
      }

      if (LOCK_ADDRESSES.has(parsed.owner as string)) {
        liquidityLocked = true;
      }
    }

    // Integer math → no float precision loss
    const creatorSupplyPercent =
      totalSupply > 0n
        ? Number((creatorBalance * 10_000n) / totalSupply) / 100
        : 0;

    logger.info(
      `Metrics [${mintAddress}] creator=${creatorSupplyPercent.toFixed(2)}% holders=${holderCount} locked=${liquidityLocked}`
    );

    return { mint: mintAddress, creatorSupplyPercent, holderCount, liquidityLocked, liquidityUsd: 0 };
  } catch (err) {
    logger.error(`parseTokenMetrics failed [${mintAddress}]: ${err}`);
    return null;
  }
}
