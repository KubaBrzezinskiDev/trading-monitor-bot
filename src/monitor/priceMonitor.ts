import { writeFileSync, readFileSync, existsSync, unlinkSync } from "fs";
import { PublicKey } from "@solana/web3.js";
import { logger } from "../utils/logger.js";
import { sleep } from "../utils/helpers.js";
import { checkTpSl, executeSell } from "./tpsl.js";
import { enqueueSell } from "../utils/sellQueue.js";
import { logSell } from "../utils/tradeLogger.js";
import { connection } from "../trader/wallet.js";
import { sendTelegram } from "../utils/telegram.js";

const POLL_INTERVAL_MS = 30_000;
const MIN_HOLD_MS = 60_000;                    // 1 min minimum hold before TP/SL activates
const MAX_POSITION_AGE_MS = 24 * 60 * 60 * 1_000; // drop positions older than 24h on restore
const DEXSCREENER_API = "https://api.dexscreener.com/latest/dex/tokens";
const JUPITER_PRICE_API = "https://api.jup.ag/price/v2";
const CLOSE_ALL_SIGNAL = "close-all.signal";
const STATE_FILE = "dashboard-state.json";
const POSITIONS_FILE = "positions.json";

export interface Position {
  mint: string;
  name: string;
  symbol: string;
  buyPriceUsd: number;
  amountTokens: string;
  tpPercent: number;
  slPercent: number;
  solSpent: number;
  boughtAt: number; // Unix ms — TP/SL only activates after MIN_HOLD_MS
}

const positions = new Map<string, Position>();
const currentPrices = new Map<string, number>();
const nullPriceStreaks = new Map<string, number>(); // consecutive polls with no price
const DEAD_POSITION_STREAK = 6; // 6 × 30s = 3 min with no price → dead
let walletBalanceSol = 0;

// ── Internet availability ───────────────────────────────────────────────────────

let internetOnline = true;        // assume online at start
let pollInProgress = false;       // guard against concurrent pollOnce() calls

/**
 * Quick connectivity check — HEAD to Jupiter health endpoint, 2-second timeout.
 * Any HTTP response (even 4xx/429) means the network is reachable.
 */
async function isInternetAvailable(): Promise<boolean> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 2_000);
  try {
    await fetch("https://api.jup.ag/health", { method: "HEAD", signal: ac.signal });
    return true;
  } catch {
    return false; // network error or timeout
  } finally {
    clearTimeout(timer);
  }
}

// Runs at import time — restores open positions from the previous session
// before setWalletBalance() can overwrite the state file
loadPositionsFromFile();

export function setWalletBalance(balance: number): void {
  walletBalanceSol = balance;
  writeState();
}

function writeState(): void {
  try {
    const state = {
      positions: Array.from(positions.values()).map((p) => {
        const cur = currentPrices.get(p.mint) ?? null;
        const pnlPercent = cur !== null && p.buyPriceUsd > 0
          ? ((cur - p.buyPriceUsd) / p.buyPriceUsd) * 100
          : null;
        return { ...p, currentPriceUsd: cur, pnlPercent };
      }),
      walletBalance: walletBalanceSol,
      updatedAt: new Date().toISOString(),
    };
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
  } catch {
    // non-critical — dashboard just won't refresh
  }
}

function writePositionsFile(): void {
  try {
    const data = Array.from(positions.values()).map((p) => {
      const cur = currentPrices.get(p.mint) ?? null;
      const pnlPercent = cur !== null && p.buyPriceUsd > 0
        ? ((cur - p.buyPriceUsd) / p.buyPriceUsd) * 100
        : null;
      return {
        mint:           p.mint,
        name:           p.name,
        symbol:         p.symbol,
        buyPriceUsd:    p.buyPriceUsd,
        amountTokens:   p.amountTokens,
        tpPercent:      p.tpPercent,
        slPercent:      p.slPercent,
        solSpent:       p.solSpent,
        openedAt:       new Date(p.boughtAt).toISOString(),
        currentPriceUsd: cur,
        pnlPercent,
      };
    });
    writeFileSync(POSITIONS_FILE, JSON.stringify(data, null, 2), "utf8");
  } catch {
    // non-critical
  }
}

export function hasPosition(mint: string): boolean {
  return positions.has(mint);
}

export function getPosition(mint: string): Position | undefined {
  return positions.get(mint);
}

export function addPosition(position: Omit<Position, "boughtAt">): void {
  const full: Position = { ...position, boughtAt: Date.now() };
  positions.set(full.mint, full);
  writeState();
  writePositionsFile();
  const holdUntil = new Date(full.boughtAt + MIN_HOLD_MS).toLocaleTimeString();
  logger.info(
    `Monitoring [${full.mint}] buyPrice=$${full.buyPriceUsd} TP:+${full.tpPercent}% SL:-${full.slPercent}% | TP/SL active after ${holdUntil}`
  );
}

export function removePosition(mint: string): void {
  positions.delete(mint);
  currentPrices.delete(mint);
  nullPriceStreaks.delete(mint);
  writeState();
  writePositionsFile();
}

// ── Pump.fun bonding curve ─────────────────────────────────────────────────────

const PUMPFUN_PROGRAM_ID = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
const SOL_MINT = "So11111111111111111111111111111111111111112";

// BondingCurve account layout (Anchor, after 8-byte discriminator):
//   offset  8: virtualTokenReserves u64
//   offset 16: virtualSolReserves   u64
//   offset 24: realTokenReserves    u64
//   offset 32: realSolReserves      u64
//   offset 40: tokenTotalSupply     u64
//   offset 48: complete             bool
const BC_VIRTUAL_TOKEN_OFFSET = 8;
const BC_VIRTUAL_SOL_OFFSET   = 16;
const BC_COMPLETE_OFFSET      = 48;

// ── Bonding-curve existence check ─────────────────────────────────────────────

export type BondingCurveStatus = "active" | "graduated" | "not_found";

export interface BondingCurveInfo {
  status: BondingCurveStatus;
  /**
   * Virtual SOL reserves in SOL (launch reserve = 30 SOL exactly).
   * Null when the account was not found or the data was too short to parse.
   * Use to detect buying activity: vSolSol > 31 means at least one buyer entered.
   */
  vSolSol: number | null;
}

/**
 * Reads the Pump.fun bonding-curve account for a given mint.
 * Returns the curve status AND the current virtual SOL reserve level in a
 * single RPC call — no second round-trip needed by callers.
 * Retries once after 2 s to handle RPC propagation delay on brand-new tokens.
 *
 *   "active"    — BC account found, complete=false  → tradeable on Pump.fun
 *   "graduated" — BC complete=true                  → migrated to Raydium
 *   "not_found" — no BC account at all              → not a Pump.fun token
 */
export async function checkBondingCurve(mint: string): Promise<BondingCurveInfo> {
  const mintPk = new PublicKey(mint);
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("bonding-curve"), mintPk.toBuffer()],
    PUMPFUN_PROGRAM_ID
  );

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const info = await connection.getAccountInfo(pda);
      if (!info) {
        if (attempt < 2) { await sleep(2_000); continue; }
        return { status: "not_found", vSolSol: null };
      }
      if (
        info.data.length >= BC_COMPLETE_OFFSET + 1 &&
        info.data[BC_COMPLETE_OFFSET] !== 0
      ) {
        return { status: "graduated", vSolSol: null };
      }

      // Read virtual SOL reserves from the same account data (no extra RPC call)
      let vSolSol: number | null = null;
      if (info.data.length >= BC_VIRTUAL_SOL_OFFSET + 8) {
        vSolSol = Number(info.data.readBigUInt64LE(BC_VIRTUAL_SOL_OFFSET)) / 1e9;
      }

      return { status: "active", vSolSol };
    } catch {
      if (attempt < 2) { await sleep(2_000); continue; }
      return { status: "not_found", vSolSol: null };
    }
  }
  return { status: "not_found", vSolSol: null }; // unreachable — satisfies TS
}

// SOL/USD price cached for 60 s — fetched once from Jupiter
let solPriceUsd   = 0;
let solPricedAt   = 0;

export async function getSolPriceUsd(): Promise<number> {
  if (Date.now() - solPricedAt < 60_000 && solPriceUsd > 0) return solPriceUsd;
  try {
    const res = await fetch(`${JUPITER_PRICE_API}?ids=${SOL_MINT}`);
    if (!res.ok) return solPriceUsd || 150;
    const data = JSON.parse(await res.text()) as {
      data?: Record<string, { price?: string } | null>;
    };
    const p = parseFloat(data.data?.[SOL_MINT]?.price ?? "");
    if (p > 0) { solPriceUsd = p; solPricedAt = Date.now(); }
  } catch { /* use cached */ }
  return solPriceUsd || 150; // 150 rough fallback if Jupiter unreachable
}

async function fetchPriceFromBondingCurve(mint: string): Promise<number | null> {
  try {
    const mintPk = new PublicKey(mint);
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from("bonding-curve"), mintPk.toBuffer()],
      PUMPFUN_PROGRAM_ID
    );

    const info = await connection.getAccountInfo(pda);
    if (!info) {
      logger.warn(`[PRICE] BC not found for ${mint.slice(0, 8)} — PDA=${pda.toBase58().slice(0, 8)} (token may not be on Pump.fun)`);
      return null;
    }
    if (info.data.length < BC_COMPLETE_OFFSET + 1) {
      logger.warn(`[PRICE] BC account too short for ${mint.slice(0, 8)}: ${info.data.length} bytes (expected ≥${BC_COMPLETE_OFFSET + 1})`);
      return null;
    }

    const complete = info.data[BC_COMPLETE_OFFSET] !== 0;
    if (complete) {
      logger.warn(`[PRICE] BC complete=true for ${mint.slice(0, 8)} — token graduated to Raydium, falling back to DEX`);
      return null;
    }

    const vToken = Number(info.data.readBigUInt64LE(BC_VIRTUAL_TOKEN_OFFSET));
    const vSol   = Number(info.data.readBigUInt64LE(BC_VIRTUAL_SOL_OFFSET));
    if (vToken === 0) {
      logger.warn(`[PRICE] BC vTokenReserves=0 for ${mint.slice(0, 8)} — skipping`);
      return null;
    }

    const solPerToken = (vSol / 1e9) / (vToken / 1e6);
    const solPrice    = await getSolPriceUsd();
    const usdPrice    = solPerToken * solPrice;
    logger.info(`[PRICE] BC ${mint.slice(0, 8)}: vSol=${vSol} vToken=${vToken} → $${usdPrice.toFixed(8)} (SOL=$${solPrice.toFixed(2)})`);
    return usdPrice;
  } catch (err) {
    logger.warn(`[PRICE] BC error for ${mint.slice(0, 8)}: ${err}`);
    return null;
  }
}

async function fetchPriceFromJupiter(mint: string): Promise<number | null> {
  try {
    const res = await fetch(`${JUPITER_PRICE_API}?ids=${mint}`);
    if (!res.ok) {
      logger.warn(`[PRICE] Jupiter HTTP ${res.status} for ${mint.slice(0, 8)}`);
      return null;
    }
    const raw = await res.text();
    let data: { data?: Record<string, { price?: number | string } | null> };
    try {
      data = JSON.parse(raw) as typeof data;
    } catch {
      logger.warn(`[PRICE] Jupiter invalid JSON for ${mint.slice(0, 8)}: ${raw.slice(0, 120)}`);
      return null;
    }
    const entry = data.data?.[mint];
    if (!entry) {
      logger.warn(`[PRICE] Jupiter no entry for ${mint.slice(0, 8)} — raw: ${raw.slice(0, 200)}`);
      return null;
    }
    const price = typeof entry.price === "string" ? parseFloat(entry.price) : entry.price;
    return price !== undefined && !isNaN(price) ? price : null;
  } catch (err) {
    logger.warn(`[PRICE] Jupiter error for ${mint.slice(0, 8)}: ${err}`);
    return null;
  }
}

async function fetchPriceFromDexscreener(mint: string): Promise<number | null> {
  try {
    // ?t= busts any CDN/proxy cache on Dexscreener's side
    const res = await fetch(`${DEXSCREENER_API}/${mint}?t=${Date.now()}`);
    if (!res.ok) {
      logger.warn(`[PRICE] Dex HTTP ${res.status} for ${mint.slice(0, 8)}`);
      return null;
    }
    const raw = await res.text();
    let data: { pairs: Array<{ priceUsd: string; baseToken: { address: string } }> | null };
    try {
      data = JSON.parse(raw) as typeof data;
    } catch {
      logger.warn(`[PRICE] Dex invalid JSON for ${mint.slice(0, 8)}: ${raw.slice(0, 120)}`);
      return null;
    }
    const pairs = data.pairs;
    if (!pairs || pairs.length === 0) {
      logger.warn(`[PRICE] Dex no pairs for ${mint.slice(0, 8)} — raw: ${raw.slice(0, 200)}`);
      return null;
    }
    const pair = pairs.find((p) => p.baseToken.address.toLowerCase() === mint.toLowerCase()) ?? pairs[0];
    const price = parseFloat(pair?.priceUsd ?? "");
    if (isNaN(price)) {
      logger.warn(`[PRICE] Dex priceUsd unparseable for ${mint.slice(0, 8)}: "${pair?.priceUsd}"`);
      return null;
    }
    return price;
  } catch (err) {
    logger.warn(`[PRICE] Dex error for ${mint.slice(0, 8)}: ${err}`);
    return null;
  }
}

export async function fetchPrice(mint: string): Promise<number | null> {
  // 1. Bonding curve — works instantly for any Pump.fun token, even brand-new
  const bc = await fetchPriceFromBondingCurve(mint);
  if (bc !== null) return bc;

  // 2. Jupiter — once token leaves bonding curve (graduated to Raydium)
  const jup = await fetchPriceFromJupiter(mint);
  if (jup !== null) return jup;

  // 3. Dexscreener — last resort (slowest to index)
  const dex = await fetchPriceFromDexscreener(mint);
  if (dex === null) logger.error(`[PRICE] all sources null for ${mint.slice(0, 8)}`);
  return dex;
}

async function pollOnce(): Promise<void> {
  if (pollInProgress) {
    logger.warn("[POLL] Previous poll still running — skipping this cycle");
    return;
  }
  if (positions.size === 0) return;

  pollInProgress = true;
  try {
  // Shared internet check — constructed lazily only when needed,
  // reused by all concurrent position checks in the same poll cycle.
  let onlineCheckPromise: Promise<boolean> | null = null;
  function getOnlineStatus(): Promise<boolean> {
    if (!onlineCheckPromise) onlineCheckPromise = isInternetAvailable();
    return onlineCheckPromise;
  }

  const checks = Array.from(positions.values()).map(async (position) => {
    try {
      const currentPrice = await fetchPrice(position.mint);
      if (currentPrice === null) {
        const online = await getOnlineStatus();
        if (!online) {
          // Network is down — freeze the streak, don't punish the token
          logger.warn(
            `[OFFLINE] No internet — pausing nullStreak for ${position.name} (${position.symbol})`
          );
          return;
        }
        const streak = (nullPriceStreaks.get(position.mint) ?? 0) + 1;
        nullPriceStreaks.set(position.mint, streak);
        if (streak >= DEAD_POSITION_STREAK) {
          logger.warn(
            `[DEAD] ${position.name} (${position.symbol}) — no price data for ${streak * POLL_INTERVAL_MS / 1000}s, closing as full loss`
          );
          logSell({
            mint:      position.mint,
            name:      position.name,
            symbol:    position.symbol,
            amountSOL: 0,
            priceUSD:  0,
            txid:      null,
            pnlSOL:    -position.solSpent,
          });
          removePosition(position.mint);
        }
        return;
      }

      nullPriceStreaks.delete(position.mint); // price recovered — reset streak
      const oldPrice = currentPrices.get(position.mint) ?? null;
      currentPrices.set(position.mint, currentPrice);

      // Price was unavailable at buy time — set reference now and skip this poll
      if (position.buyPriceUsd === 0) {
        position.buyPriceUsd = currentPrice;
        positions.set(position.mint, position);
        logger.info(`[BUY PRICE SET] ${position.name} (${position.symbol}) $${currentPrice.toFixed(8)} — first price from monitor`);
        return;
      }

      // ── Per-cycle TPSL diagnostic log (fires whether in hold or not) ──────────
      // buyRef is what was paid; cur is live from RPC this poll; pnl is relative.
      // If pnl shows NaN/Infinity here, buyPriceUsd was 0 — indicates buy-price
      // derivation failed for this position and the reference is not trustworthy.
      const holdRemaining = (position.boughtAt + MIN_HOLD_MS) - Date.now();
      const pnlPct = ((currentPrice - position.buyPriceUsd) / position.buyPriceUsd) * 100;
      const pnlStr = Number.isFinite(pnlPct)
        ? `${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}%`
        : `${pnlPct}%`; // "NaN%" or "Infinity%" — signals bad buyPriceUsd

      if (oldPrice === null || oldPrice !== currentPrice) {
        logger.info(
          `[PRICE UPDATE] ${position.name} (${position.symbol})` +
          ` $${(oldPrice ?? position.buyPriceUsd).toFixed(8)} → $${currentPrice.toFixed(8)}` +
          ` ${pnlStr}`
        );
      }

      if (holdRemaining > 0) {
        logger.info(
          `[TPSL] ${position.name}` +
          ` buyRef=$${position.buyPriceUsd.toFixed(8)}` +
          ` cur=$${currentPrice.toFixed(8)}` +
          ` pnl=${pnlStr}` +
          ` → hold ${Math.ceil(holdRemaining / 1000)}s`
        );
        return;
      }

      logger.info(
        `[TPSL] ${position.name}` +
        ` buyRef=$${position.buyPriceUsd.toFixed(8)}` +
        ` cur=$${currentPrice.toFixed(8)}` +
        ` pnl=${pnlStr}` +
        ` → checking tp=+${position.tpPercent}% sl=-${position.slPercent}%`
      );

      const trigger = checkTpSl(position, currentPrice);
      if (trigger) {
        logger.info(`[TPSL] ${position.name} — ${trigger.toUpperCase()} triggered`);
        const sold = await enqueueSell(() => executeSell(position, currentPrice, trigger));
        if (sold) removePosition(position.mint);
      }
    } catch (err) {
      logger.error(`Position check failed [${position.mint}]: ${err}`);
    }
  });

  await Promise.all(checks);
  writeState();
  writePositionsFile();
  } finally {
    pollInProgress = false;
  }
}

function parsePositionRecord(p: Record<string, unknown>): Position | null {
  if (
    typeof p["mint"] !== "string" ||
    typeof p["name"] !== "string" ||
    typeof p["symbol"] !== "string" ||
    typeof p["buyPriceUsd"] !== "number" ||
    typeof p["amountTokens"] !== "string" ||
    typeof p["tpPercent"] !== "number" ||
    typeof p["slPercent"] !== "number" ||
    typeof p["solSpent"] !== "number"
  ) return null;

  // dashboard-state.json uses boughtAt (ms), positions.json uses openedAt (ISO string)
  let boughtAt: number;
  if (typeof p["boughtAt"] === "number") {
    boughtAt = p["boughtAt"];
  } else if (typeof p["openedAt"] === "string") {
    boughtAt = new Date(p["openedAt"]).getTime();
    if (isNaN(boughtAt)) boughtAt = Date.now() - MIN_HOLD_MS;
  } else {
    boughtAt = Date.now() - MIN_HOLD_MS;
  }

  if (Date.now() - boughtAt > MAX_POSITION_AGE_MS) {
    logger.warn(`[CLEANUP] Dropping stale position ${String(p["mint"])} (>${MAX_POSITION_AGE_MS / 3_600_000}h old)`);
    return null;
  }

  return {
    mint: p["mint"],
    name: p["name"],
    symbol: p["symbol"],
    buyPriceUsd: p["buyPriceUsd"],
    amountTokens: p["amountTokens"],
    tpPercent: p["tpPercent"],
    slPercent: p["slPercent"],
    solSpent: p["solSpent"],
    boughtAt,
  };
}

function loadPositionsFromFile(): void {
  // Try dashboard-state.json first (has boughtAt as number — internal format)
  // Fall back to positions.json (openedAt as ISO string — dashboard export format)
  const candidates: Array<{ file: string; extract: (raw: string) => Array<Record<string, unknown>> }> = [
    {
      file: STATE_FILE,
      extract: (raw) => {
        const parsed = JSON.parse(raw) as { positions?: Array<Record<string, unknown>> };
        return Array.isArray(parsed.positions) ? parsed.positions : [];
      },
    },
    {
      file: POSITIONS_FILE,
      extract: (raw) => {
        const parsed = JSON.parse(raw) as unknown;
        return Array.isArray(parsed) ? (parsed as Array<Record<string, unknown>>) : [];
      },
    },
  ];

  for (const { file, extract } of candidates) {
    if (positions.size > 0) break; // already loaded from a previous source
    if (!existsSync(file)) continue;
    try {
      const rows = extract(readFileSync(file, "utf8"));
      for (const p of rows) {
        if (positions.has(p["mint"] as string)) continue; // dedup
        const pos = parsePositionRecord(p);
        if (pos) positions.set(pos.mint, pos);
      }
    } catch (err) {
      logger.warn(`[RESUME] Failed to parse ${file}: ${err}`);
    }
  }

  if (positions.size === 0) return;

  logger.info(`[RESUME] Loaded ${positions.size} open position(s) from disk`);
  for (const p of positions.values()) {
    logger.info(
      `[RESUME]   ${p.name} (${p.symbol}) buy=$${p.buyPriceUsd.toFixed(8)}` +
      ` TP=+${p.tpPercent}% SL=-${p.slPercent}% opened=${new Date(p.boughtAt).toISOString()}`
    );
  }
}

export async function closeAllPositions(): Promise<void> {
  if (positions.size === 0) {
    logger.info("[CLOSE-ALL] No open positions");
    return;
  }
  logger.info(`[CLOSE-ALL] Closing ${positions.size} position(s)`);
  for (const position of Array.from(positions.values())) {
    try {
      const price = await fetchPrice(position.mint) ?? position.buyPriceUsd;
      const sold = await enqueueSell(() => executeSell(position, price, "manual"));
      if (sold) removePosition(position.mint);
    } catch (err) {
      logger.error(`[CLOSE-ALL] Failed to close ${position.mint}: ${err}`);
    }
  }
  logger.info("[CLOSE-ALL] Done");
}

/**
 * Monitors internet connectivity every 3 seconds.
 * On recovery: immediately refreshes all open positions and notifies via Telegram.
 */
function startInternetMonitor(): void {
  let checkRunning = false;

  setInterval(() => {
    if (checkRunning) return; // previous check still in flight
    checkRunning = true;

    isInternetAvailable()
      .then(async (online) => {
        if (!internetOnline && online) {
          // ── Transition: offline → online ────────────────────────────────────
          internetOnline = true;
          const count = positions.size;
          logger.info(`[INTERNET] Connection restored — refreshing ${count} position(s)`);
          if (count > 0) {
            sendTelegram(`✅ Internet wrócił — sprawdzam ${count} pozycji`).catch(() => {});
            await pollOnce(); // immediate price sweep for all positions
          }
        } else if (internetOnline && !online) {
          // ── Transition: online → offline ────────────────────────────────────
          internetOnline = false;
          logger.warn("[INTERNET] Connection lost — nullStreak frozen for all positions");
          sendTelegram("⚠️ Bot stracił połączenie z internetem — pozycje zamrożone").catch(() => {});
        }
      })
      .catch((err) => logger.error(`[INTERNET] monitor error: ${err}`))
      .finally(() => { checkRunning = false; });
  }, 3_000);
}

export async function startPriceMonitor(): Promise<never> {
  // Poll for close-all signal every 2s — faster than the 30s main poll
  setInterval(() => {
    if (existsSync(CLOSE_ALL_SIGNAL)) {
      unlinkSync(CLOSE_ALL_SIGNAL);
      closeAllPositions().catch(err => logger.error(`[CLOSE-ALL] ${err}`));
    }
  }, 2_000);

  startInternetMonitor();
  logger.info("Price monitor started");
  while (true) {
    await sleep(POLL_INTERVAL_MS);
    await pollOnce();
  }
}
