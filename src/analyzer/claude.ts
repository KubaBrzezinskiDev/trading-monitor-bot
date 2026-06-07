import Anthropic from "@anthropic-ai/sdk";
import { config } from "../utils/config.js";
import { logger } from "../utils/logger.js";
import { sleep } from "../utils/helpers.js";
import { buildPrompt } from "./prompt.js";
import type { TokenData } from "./scamDetector.js";

export interface Decision {
  buy: boolean;
  confidence: number;
  reason: string;
  suggestedTP: string;
  suggestedSL: string;
}

// Static system prompt — must exceed 1024 tokens to activate Anthropic prompt caching.
// Cache TTL is 5 min (ephemeral); with calls every ~2 min the cache stays warm and
// saves ~90% on input token cost for this block across all 300 daily analyses.
const SYSTEM_PROMPT =
  "You are a Solana memecoin early-entry sniper bot. Your role is to analyze tokens within " +
  "45–120 seconds of launch on Pump.fun and return a structured buy/no-buy decision.\n\n" +

  "━━━ PUMP.FUN MECHANICS — READ CAREFULLY ━━━\n\n" +

  "Pump.fun launches tokens on a bonding curve, not a traditional liquidity pool.\n\n" +

  "SPL TOKEN ACCOUNTS: Holder accounts are only created on first purchase. " +
  "\"holders=0\" is ALWAYS normal at launch and does NOT indicate a failed or abandoned token. " +
  "Do not penalize zero holders under any circumstances.\n\n" +

  "LIQUIDITY: \"liquidity=unknown\" or \"$0\" is expected — the bonding curve holds liquidity but " +
  "the bot cannot yet compute its USD value. Do not penalize missing liquidity data.\n\n" +

  "LIQUIDITY LOCKED: \"locked=false\" is normal at this stage. Locking mechanisms apply to " +
  "Raydium LP tokens after graduation, not to the bonding curve phase.\n\n" +

  "TOKEN AGE: 45–120 seconds is the intended analysis window. The bot captures tokens " +
  "immediately after the on-chain create transaction confirms.\n\n" +

  "CREATOR SUPPLY: Reflects the creator wallet's current token balance as a percentage of " +
  "total supply. High creator supply is the primary rug risk on Pump.fun — the creator can " +
  "dump tokens at any time. However, creators cannot rug by withdrawing LP (there is no LP " +
  "at the bonding curve stage).\n\n" +

  "━━━ EVALUATION CRITERIA ━━━\n\n" +

  "1. CREATOR SUPPLY %\n" +
  "   0–10%   : excellent — negligible sell pressure risk, high confidence boost\n" +
  "   10–30%  : acceptable — standard range for memecoin launches\n" +
  "   30–50%  : elevated risk — only buy if name/theme is clearly strong\n" +
  "   >50%    : hard skip — creator can crash price instantly; always buy=false\n\n" +

  "2. TOKEN NAME AND SYMBOL\n\n" +

  "   RED FLAGS (lean toward buy=false or low confidence):\n" +
  "   - Celebrity impersonation without parody intent: Elon, Trump, Biden, Musk, Vitalik\n" +
  "   - Regulatory deception: 'official', 'legally registered', 'SEC approved', 'licensed'\n" +
  "   - Exchange impersonation: Binance, Coinbase, Kraken, Solana Foundation, FTX\n" +
  "   - Guaranteed returns: '100x', 'guaranteed', 'get rich', 'free money'\n" +
  "   - Exact copy of an existing major token name\n" +
  "   - Pure gibberish with no discernible meme concept\n\n" +

  "   GREEN FLAGS (lean toward buy=true with higher confidence):\n" +
  "   - Current internet memes, trending topics, pop-culture references\n" +
  "   - Crypto or DeFi in-jokes, irony, self-aware humor\n" +
  "   - Animals, food, or abstract concepts with a clear personality angle\n" +
  "   - Short, punchy symbol that could trend on social media\n" +
  "   - Parody of a well-known token (clearly labeled as parody)\n\n" +

  "3. VIRAL POTENTIAL\n" +
  "   Ask: could this token name spread organically on Twitter or Telegram? " +
  "   A strong meme theme, cultural relevance, or humor drives community formation.\n\n" +

  "━━━ DECISION RULES ━━━\n\n" +

  "DEFAULT: buy=true, confidence 50–70 for tokens with ≤30% creator supply and a coherent meme theme.\n\n" +

  "HIGH CONFIDENCE (70–90): strong meme identity AND creator supply <15%.\n\n" +

  "LOW CONFIDENCE (30–50): borderline name or creator supply 30–50%; buy=true but with tight SL.\n\n" +

  "buy=false ONLY when: (a) creator supply >50%, OR " +
  "(b) name contains an unambiguous scam/impersonation/regulatory deception pattern, OR " +
  "(c) both creator supply >30% AND name is suspicious.\n\n" +

  "Never set buy=false solely because holders=0, liquidity=unknown, or age is short.\n\n" +

  "━━━ TP / SL GUIDELINES ━━━\n\n" +

  "suggestedTP: +10% to +15%. Use higher end for strong conviction or low creator supply.\n" +
  "suggestedSL: -8% to -12%. Use tighter (closer to -8%) when creator supply is elevated.\n\n" +

  "━━━ OUTPUT FORMAT ━━━\n\n" +

  "Respond ONLY with valid JSON — no explanation, no markdown, no extra text:\n" +
  '{"buy": boolean, "confidence": number (0-100), "reason": string, "suggestedTP": string, "suggestedSL": string}\n\n' +

  "reason: one sentence max. suggestedTP example: \"+12%\". suggestedSL example: \"-10%\".";

const client = new Anthropic({
  apiKey: config.anthropicApiKey,
  maxRetries: 0, // handle retries ourselves to respect rate limits
});

// Daily call limit — resets at UTC midnight
const CLAUDE_DAILY_LIMIT = 300;
let dailyCallCount = 0;
let dailyLimitDate = new Date().toISOString().slice(0, 10); // "YYYY-MM-DD"

function checkDailyLimit(): boolean {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== dailyLimitDate) {
    dailyLimitDate = today;
    dailyCallCount = 0;
  }
  return dailyCallCount < CLAUDE_DAILY_LIMIT;
}

export function isDailyLimitReached(): boolean {
  return dailyCallCount >= CLAUDE_DAILY_LIMIT;
}

// Rate limiter — stay under 50 req/min (Anthropic free tier)
const CLAUDE_MIN_INTERVAL_MS = 1_500; // ~40 req/min
let lastCallTime = 0;
let pending = false;
const claudeQueue: Array<() => void> = [];

async function acquireClaudeSlot(): Promise<void> {
  // Serialize all Claude calls through a single queue
  if (pending) {
    await new Promise<void>((resolve) => claudeQueue.push(resolve));
  }
  pending = true;
  const wait = CLAUDE_MIN_INTERVAL_MS - (Date.now() - lastCallTime);
  if (wait > 0) await sleep(wait);
}

function releaseClaudeSlot(): void {
  lastCallTime = Date.now();
  const next = claudeQueue.shift();
  if (next) {
    next();
  } else {
    pending = false;
  }
}

function parseDecision(text: string): Decision | null {
  try {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    const json = JSON.parse(match[0]) as Record<string, unknown>;
    if (
      typeof json.buy !== "boolean" ||
      typeof json.confidence !== "number" ||
      typeof json.reason !== "string" ||
      typeof json.suggestedTP !== "string" ||
      typeof json.suggestedSL !== "string"
    ) {
      return null;
    }
    return json as unknown as Decision;
  } catch {
    return null;
  }
}

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 30_000; // wait 30s on 429 before retry

export async function analyzeToken(tokenData: TokenData): Promise<Decision | null> {
  if (!checkDailyLimit()) {
    return null; // caller detects via isDailyLimitReached()
  }
  dailyCallCount++;
  logger.info(`[CLAUDE] call ${dailyCallCount}/${CLAUDE_DAILY_LIMIT} today`);

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    await acquireClaudeSlot();
    let released = false;
    const release = () => { if (!released) { released = true; releaseClaudeSlot(); } };

    try {
      const response = await client.messages.create({
        model: config.claudeModel,
        max_tokens: 200,
        system: [
          {
            type: "text",
            text: SYSTEM_PROMPT,
            cache_control: { type: "ephemeral" },
          },
        ],
        messages: [{ role: "user", content: buildPrompt(tokenData) }],
      });

      release();

      const textBlock = response.content.find((b) => b.type === "text");
      if (!textBlock || textBlock.type !== "text") {
        logger.error(`No text block in Claude response for ${tokenData.mint}`);
        return null;
      }

      const decision = parseDecision(textBlock.text);
      if (!decision) {
        logger.error(`Invalid JSON from Claude [${tokenData.mint}]: ${textBlock.text}`);
        return null;
      }

      logger.info(
        `Decision [${tokenData.mint}] buy=${decision.buy} confidence=${decision.confidence} TP=${decision.suggestedTP} SL=${decision.suggestedSL}`
      );
      return decision;
    } catch (err) {
      release();
      const is429 = String(err).includes("429");

      if (is429 && attempt < MAX_RETRIES) {
        logger.warn(`Claude rate limited [${tokenData.mint}], retry ${attempt}/${MAX_RETRIES} in ${RETRY_DELAY_MS / 1000}s`);
        await sleep(RETRY_DELAY_MS);
        continue;
      }

      logger.error(`Claude API failed [${tokenData.mint}]: ${err}`);
      return null;
    }
  }
  return null;
}
