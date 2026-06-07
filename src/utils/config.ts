import "dotenv/config";

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

function optionalEnv(key: string, defaultValue: string): string {
  return process.env[key] ?? defaultValue;
}

export const config = {
  // Anthropic / Claude
  anthropicApiKey: requireEnv("ANTHROPIC_API_KEY"),
  claudeModel: optionalEnv("CLAUDE_MODEL", "claude-haiku-4-5-20251001"),
  claudeMinConfidence: parseInt(optionalEnv("CLAUDE_MIN_CONFIDENCE", "60"), 10),

  // Solana network
  solanaRpcUrl: requireEnv("SOLANA_RPC_URL"),
  solanaNetwork: optionalEnv("SOLANA_NETWORK", "mainnet-beta"),

  // Wallet
  walletPrivateKey: requireEnv("WALLET_PRIVATE_KEY"),

  // Trading parameters
  maxTradeAmountSol: parseFloat(optionalEnv("MAX_TRADE_AMOUNT_SOL", "0.1")),
  slippageBps: parseInt(optionalEnv("SLIPPAGE_BPS", "50"), 10),

  // Jupiter aggregator (for token swaps)
  jupiterApiUrl: optionalEnv("JUPITER_API_URL", "https://api.jup.ag/swap/v1"),

  // Dry-run mode — no real transactions
  dryRun: optionalEnv("DRY_RUN", "false") === "true",

  // TP/SL defaults — used when Claude returns an unparseable value
  defaultTpPercent: parseFloat(optionalEnv("DEFAULT_TP_PERCENT", "12")),
  defaultSlPercent: parseFloat(optionalEnv("DEFAULT_SL_PERCENT", "10")),

  // Fast buy — buy immediately for fresh tokens, verify creator supply in background
  fastBuyEnabled: optionalEnv("FAST_BUY_ENABLED", "true") === "true",
  fastBuyMaxAgeSeconds: parseInt(optionalEnv("FAST_BUY_MAX_AGE_SECONDS", "60"), 10),

  // Telegram notifications (optional — leave blank to disable)
  telegramBotToken: optionalEnv("TELEGRAM_BOT_TOKEN", ""),
  telegramChatId: optionalEnv("TELEGRAM_CHAT_ID", ""),
} as const;

export type Config = typeof config;
