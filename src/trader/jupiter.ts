import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  VersionedTransaction,
} from "@solana/web3.js";
import { config } from "../utils/config.js";
import { logger } from "../utils/logger.js";
import { formatSOL, sleep } from "../utils/helpers.js";
import { checkDryRun } from "./wallet.js";

const TOKEN_NOT_TRADABLE_CODE = "TOKEN_NOT_TRADABLE";
const SELL_MAX_RETRIES      = 5;     // TOKEN_NOT_TRADABLE: retries × 30s
const SELL_RETRY_DELAY_MS   = 30_000;
const SELL_MAX_429_RETRIES  = 3;     // rate-limit: retries × 5s, then defer to next poll
const SELL_429_DELAY_MS     = 5_000;

export interface QuoteResponse {
  inputMint: string;
  inAmount: string;
  outputMint: string;
  outAmount: string;
  otherAmountThreshold: string;
  swapMode: string;
  slippageBps: number;
  priceImpactPct: string;
  routePlan: unknown[];
}

const connection = new Connection(config.solanaRpcUrl, "confirmed");

export async function getQuote(
  inputMint: string,
  outputMint: string,
  amountSOL: number
): Promise<QuoteResponse | null> {
  try {
    const amountLamports = Math.floor(amountSOL * LAMPORTS_PER_SOL);
    const url = new URL(`${config.jupiterApiUrl}/quote`);
    url.searchParams.set("inputMint", inputMint);
    url.searchParams.set("outputMint", outputMint);
    url.searchParams.set("amount", String(amountLamports));
    url.searchParams.set("slippageBps", String(config.slippageBps));

    const res = await fetch(url.toString());
    if (!res.ok) {
      logger.error(`Jupiter quote failed (${res.status}): ${await res.text()}`);
      return null;
    }

    const quote = (await res.json()) as QuoteResponse;
    logger.info(
      `Quote: ${formatSOL(Number(quote.inAmount))} SOL → ${quote.outAmount} tokens` +
        ` | impact=${quote.priceImpactPct}% slippage=${quote.slippageBps}bps`
    );
    return quote;
  } catch (err) {
    logger.error(`getQuote error: ${err}`);
    return null;
  }
}

export async function getQuoteForTokens(
  inputMint: string,
  outputMint: string,
  tokenAmount: string
): Promise<QuoteResponse | null> {
  try {
    const url = new URL(`${config.jupiterApiUrl}/quote`);
    url.searchParams.set("inputMint", inputMint);
    url.searchParams.set("outputMint", outputMint);
    url.searchParams.set("amount", tokenAmount);
    url.searchParams.set("slippageBps", String(config.slippageBps));

    const res = await fetch(url.toString());
    if (!res.ok) {
      logger.error(`Jupiter sell quote failed (${res.status}): ${await res.text()}`);
      return null;
    }

    const quote = (await res.json()) as QuoteResponse;
    logger.info(
      `Sell quote: ${quote.inAmount} tokens → ${formatSOL(Number(quote.outAmount))} SOL` +
        ` | impact=${quote.priceImpactPct}% slippage=${quote.slippageBps}bps`
    );
    return quote;
  } catch (err) {
    logger.error(`getQuoteForTokens error: ${err}`);
    return null;
  }
}

/**
 * Sell-specific quote with layered retry logic.
 *
 * Returns:
 *   QuoteResponse — success, proceed with swap
 *   "dead"        — TOKEN_NOT_TRADABLE exhausted (5×30s); caller logs full loss
 *   null          — 429 exhausted (3×5s) or other error; caller retries next poll
 *
 * Retry matrix:
 *   429                  → 5s wait, up to 3 retries, then null
 *   TOKEN_NOT_TRADABLE   → 30s wait, up to 5 retries, then "dead"
 *   other HTTP / network → null immediately
 */
export async function getQuoteForSell(
  inputMint: string,
  outputMint: string,
  tokenAmount: string
): Promise<QuoteResponse | "dead" | null> {
  const tag = inputMint.slice(0, 8);
  let attempts429 = 0;
  let attemptsTNT = 0; // TOKEN_NOT_TRADABLE

  while (true) {
    try {
      const url = new URL(`${config.jupiterApiUrl}/quote`);
      url.searchParams.set("inputMint", inputMint);
      url.searchParams.set("outputMint", outputMint);
      url.searchParams.set("amount", tokenAmount);
      url.searchParams.set("slippageBps", String(config.slippageBps));

      const res = await fetch(url.toString());

      if (res.ok) {
        const quote = (await res.json()) as QuoteResponse;
        logger.info(
          `Sell quote: ${quote.inAmount} tokens → ${formatSOL(Number(quote.outAmount))} SOL` +
            ` | impact=${quote.priceImpactPct}% slippage=${quote.slippageBps}bps`
        );
        return quote;
      }

      const body = await res.text();

      // ── 429 Rate limit ────────────────────────────────────────────────────────
      if (res.status === 429) {
        attempts429++;
        if (attempts429 <= SELL_MAX_429_RETRIES) {
          logger.warn(
            `[SELL] Jupiter 429 for ${tag}` +
              ` — retry ${attempts429}/${SELL_MAX_429_RETRIES} in 5s`
          );
          await sleep(SELL_429_DELAY_MS);
          continue;
        }
        logger.error(
          `[SELL] Jupiter 429 — ${SELL_MAX_429_RETRIES} retries exhausted` +
            ` for ${tag}, deferring to next poll cycle`
        );
        return null;
      }

      // ── Token not yet indexed by Jupiter ─────────────────────────────────────
      if (body.includes(TOKEN_NOT_TRADABLE_CODE)) {
        attemptsTNT++;
        if (attemptsTNT <= SELL_MAX_RETRIES) {
          logger.warn(
            `[SELL] TOKEN_NOT_TRADABLE for ${tag}` +
              ` — attempt ${attemptsTNT}/${SELL_MAX_RETRIES}, retrying in 30s`
          );
          await sleep(SELL_RETRY_DELAY_MS);
          continue;
        }
        logger.error(
          `[SELL] TOKEN_NOT_TRADABLE — ${SELL_MAX_RETRIES} attempts exhausted` +
            ` for ${tag}, marking dead`
        );
        return "dead";
      }

      // ── Other HTTP error ──────────────────────────────────────────────────────
      logger.error(`[SELL] Jupiter quote failed (${res.status}) for ${tag}: ${body}`);
      return null;
    } catch (err) {
      logger.error(`[SELL] getQuoteForSell network error for ${tag}: ${err}`);
      return null;
    }
  }
}

export async function executeSwap(
  quote: QuoteResponse,
  wallet: Keypair
): Promise<string | null> {
  const inSOL = formatSOL(Number(quote.inAmount));

  if (checkDryRun(`swap ${inSOL} SOL → ${quote.outputMint} (out: ${quote.outAmount} tokens, impact: ${quote.priceImpactPct}%)`)) {
    return null;
  }

  try {
    const swapRes = await fetch(`${config.jupiterApiUrl}/swap`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        quoteResponse: quote,
        userPublicKey: wallet.publicKey.toBase58(),
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: "auto",
      }),
    });

    if (!swapRes.ok) {
      logger.error(`Jupiter swap request failed (${swapRes.status}): ${await swapRes.text()}`);
      return null;
    }

    const { swapTransaction } = (await swapRes.json()) as { swapTransaction: string };

    const tx = VersionedTransaction.deserialize(Buffer.from(swapTransaction, "base64"));
    tx.sign([wallet]);

    const txid = await connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
      maxRetries: 3,
    });
    logger.info(`Swap sent: ${txid}`);

    await connection.confirmTransaction(txid, "confirmed");
    logger.info(`Swap confirmed: ${txid}`);

    return txid;
  } catch (err) {
    logger.error(`executeSwap error: ${err}`);
    return null;
  }
}
