# Solana Memecoin Trading Bot

Automated bot that detects new token launches on Pump.fun, uses Claude AI to filter scams, and executes trades via Jupiter DEX aggregator.

## How it works

```
New token on Pump.fun
        ↓
Collect token data (holders, liquidity, supply distribution)
        ↓
Claude API — scam detection & buy decision
        ↓
[BUY] Jupiter API executes swap
        ↓
Price monitor — auto sell on TP or SL
```

## Stack

- **Language:** TypeScript (Node.js 18+)
- **Blockchain:** Solana via `@solana/web3.js`
- **Token detection:** Pump.fun WebSocket API
- **Trade execution:** Jupiter Aggregator API
- **Price monitoring:** Dexscreener API
- **AI decision layer:** Anthropic Claude API (claude-haiku)
- **RPC:** Helius (free tier for development)

## Project structure

```
src/
├── detector/
│   ├── pumpfun.ts        # WebSocket listener for new tokens
│   └── tokenParser.ts    # Parse raw token data
├── analyzer/
│   ├── claude.ts         # Claude API integration
│   ├── scamDetector.ts   # Pre-filter obvious scams before Claude call
│   └── prompt.ts         # Prompt templates for Claude
├── trader/
│   ├── jupiter.ts        # Jupiter API — swap execution
│   └── wallet.ts         # Solana wallet management
├── monitor/
│   ├── priceMonitor.ts   # Watch price after purchase
│   └── tpsl.ts           # Take profit / stop loss logic
├── utils/
│   ├── logger.ts         # Structured logging
│   ├── config.ts         # Environment config
│   └── helpers.ts        # Shared utilities
└── index.ts              # Entry point
```

## Setup

### 1. Clone and install

```bash
git clone <repo>
cd solana-memecoin-bot
npm install
```

### 2. Environment variables

Create `.env` file in project root:

```env
# Anthropic
ANTHROPIC_API_KEY=your_key_here

# Solana
SOLANA_RPC_URL=https://mainnet.helius-rpc.com/?api-key=your_key
WALLET_PRIVATE_KEY=your_base58_private_key

# Trading config
DRY_RUN=true               # ALWAYS start with true
BUY_AMOUNT_SOL=0.01        # Amount per trade in SOL
TAKE_PROFIT_PERCENT=15     # Sell when +15%
STOP_LOSS_PERCENT=7        # Sell when -7%
MAX_SLIPPAGE_BPS=300       # 3% max slippage

# Claude config
CLAUDE_MODEL=claude-haiku-4-5-20251001
CLAUDE_MIN_CONFIDENCE=70   # Min confidence score to buy (0-100)
```

### 3. Get free RPC (development)

1. Register at [helius.dev](https://helius.dev)
2. Create free API key (100k requests/day)
3. Paste URL into `SOLANA_RPC_URL`

### 4. Run

```bash
# Development (no real transactions)
npm run dev

# Production (real money — tylko gdy bot działa poprawnie)
DRY_RUN=false npm start
```

## Claude decision logic

For every new token, Claude receives:

```json
{
  "name": "TOKEN",
  "symbol": "TKN",
  "creatorHoldsPercent": 15,
  "top10HoldersPercent": 45,
  "liquidityUSD": 12000,
  "liquidityLocked": true,
  "holdersCount": 234,
  "volume5min": 8500,
  "description": "..."
}
```

Claude responds with:

```json
{
  "buy": true,
  "confidence": 78,
  "reason": "Liquidity locked, creator holds <20%, healthy distribution",
  "suggestedTP": "+15%",
  "suggestedSL": "-7%"
}
```

Bot only buys if `buy: true` AND `confidence >= CLAUDE_MIN_CONFIDENCE`.

## Pre-filters (before Claude call — saves API costs)

Bot automatically skips token if:
- Creator holds >50% of supply
- Liquidity < $5,000
- Holders count < 50
- Token is < 30 seconds old (bot frontrun protection)

## Red flags Claude looks for

- Suspicious name (copy of existing coin, celebrity name without context)
- Creator wallet has history of rug pulls
- Supply heavily concentrated in few wallets
- No description or social links
- Liquidity not locked

## Cost estimate

| Service | Plan | Cost |
|---|---|---|
| Helius RPC | Free | $0/mies |
| Anthropic API (Haiku) | ~500 calls/day | ~$15/mies |
| VPS hosting | DigitalOcean basic | $6/mies |
| **Total** | | **~$21/mies** |

## Development phases

```
Faza 1 — Build & test on devnet (DRY_RUN=true)
  ✓ Token detection works
  ✓ Claude responses parsed correctly
  ✓ Trade logic correct (no real money)

Faza 2 — Mainnet with tiny amounts (DRY_RUN=false, 0.001 SOL)
  ✓ Real transactions execute
  ✓ TP/SL triggers correctly
  ✓ Logging works

Faza 3 — Scale up if profitable
  ✓ Increase buy amount
  ✓ Upgrade to paid RPC if needed
  ✓ Tune Claude confidence threshold
```

## Important warnings

> **NIGDY nie uruchamiaj z DRY_RUN=false dopóki bot nie działa poprawnie przez co najmniej tydzień w trybie symulacji.**

> **Traktuj każdą zainwestowaną kwotę jako potencjalnie straconą. Memecoiny to wysokie ryzyko.**

> **Zarobki z krypto podlegają podatkowi Belki (19%) — prowadź ewidencję transakcji.**

## Resources

- [Solana Web3.js docs](https://solana-labs.github.io/solana-web3.js/)
- [Jupiter API docs](https://station.jup.ag/docs/apis/swap-api)
- [Pump.fun](https://pump.fun)
- [Dexscreener API](https://docs.dexscreener.com)
- [Helius RPC](https://helius.dev)
- [Anthropic API docs](https://docs.anthropic.com)
