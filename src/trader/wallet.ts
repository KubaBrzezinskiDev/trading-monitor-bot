import { createRequire } from "module";
import { Connection, Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { config } from "../utils/config.js";
import { logger } from "../utils/logger.js";

// bs58 is a CJS transitive dependency of @solana/web3.js — use createRequire for ESM compatibility
const require = createRequire(import.meta.url);
const bs58 = require("bs58") as { decode: (str: string) => Uint8Array };

function loadKeypair(): Keypair {
  try {
    return Keypair.fromSecretKey(bs58.decode(config.walletPrivateKey));
  } catch {
    if (config.dryRun) {
      const kp = Keypair.generate();
      logger.warn(
        `WALLET_PRIVATE_KEY invalid — ephemeral keypair generated for dry-run: ${kp.publicKey.toBase58()}`
      );
      return kp;
    }
    throw new Error("Invalid WALLET_PRIVATE_KEY — set a valid base58-encoded Solana private key");
  }
}

export const keypair = loadKeypair();
export const publicKey = keypair.publicKey;

export const connection = new Connection(config.solanaRpcUrl, "confirmed");

export async function getBalance(): Promise<number> {
  const lamports = await connection.getBalance(publicKey);
  return lamports / LAMPORTS_PER_SOL;
}

/**
 * Call before any transaction. Returns true and logs if DRY_RUN=true,
 * meaning the caller should skip the real operation.
 */
export function checkDryRun(action = "transaction"): boolean {
  if (config.dryRun) {
    logger.info(`DRY RUN - ${action} skipped`);
    return true;
  }
  return false;
}
