# Setup Guide

## Prerequisites

### 1. Install Bun

Harvest requires Bun >= 1.1. Install it:

```bash
curl -fsSL https://bun.sh/install | bash
```

Verify:

```bash
bun --version
```

### 2. Alpaca Markets Account

Sign up at [alpaca.markets](https://alpaca.markets). Paper trading is free and requires no funding.

1. Create an account
2. Generate API keys from the dashboard (Paper Trading section)
3. Note your `API Key ID` and `Secret Key`

### 3. Optional: Perplexity API

For AI-powered deep research on each ticker:

1. Sign up at [perplexity.ai](https://www.perplexity.ai)
2. Generate an API key from settings
3. Starter plan ($5/month) is sufficient for typical usage

### 4. Optional: Discord Notifications

For trade alerts in a Discord server:

1. Create a Discord server or use an existing one
2. Create a webhook: Server Settings > Integrations > Webhooks > New Webhook
3. Copy the webhook URL
4. Optionally set up a bot for more advanced notifications (bot token + channel ID)

### 5. Optional: Telegram Notifications

For mobile alerts via Telegram:

1. Message `@BotFather` on Telegram to create a bot
2. Note the bot token
3. Start a conversation with your bot
4. Get your chat ID by messaging `@userinfobot`

---

## Installation

```bash
git clone https://github.com/CarbeneAI/Harvest.git
cd Harvest
bun install
```

---

## Configuration

```bash
cp .env.example .env
```

Edit `.env` with your credentials:

```env
# Required
ALPACA_API_KEY=PKXXXXXXXXXXXXXXXX
ALPACA_API_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
ALPACA_BASE_URL=https://paper-api.alpaca.markets

# Optional: AI research
PERPLEXITY_API_KEY=pplx-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# Optional: Discord notifications
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...
DISCORD_TRADING_CHANNEL_ID=000000000000000000
DISCORD_BOT_TOKEN=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# Optional: Telegram notifications
TELEGRAM_BOT_TOKEN=0000000000:xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TELEGRAM_CHAT_ID=0000000000

# Optional: Dashboard
DASHBOARD_PORT=8083
```

**Important:** Never commit your `.env` file. It's already in `.gitignore`.

---

## Verify Setup

Run a quick test to verify Alpaca connectivity:

```bash
bun src/scanners/MarketRegime.ts
```

Expected output:

```json
{
  "regime": "BULL",
  "spyPrice": 512.34,
  "sma200": 478.21,
  "sma50": 502.67,
  "details": "SPY above both 200 SMA and 50 SMA"
}
```

---

## First Scan

Run a full strategy scan:

```bash
bun src/orchestration/MultiScan.ts
```

This will:
1. Check the market regime
2. Scan ~80 momentum stocks
3. Scan ~20 mean reversion stocks
4. Apply the fundamental quality gate
5. Apply volatility-adjusted position sizing
6. Output recommendations to stdout and `data/recommendations.json`

---

## Start the Dashboard

```bash
bun src/api/DashboardServer.ts
```

Open `http://localhost:8083` in your browser.

The dashboard shows your portfolio stats, recommendations, positions, orders, and learnings.

---

## Setting Up Cron (Optional)

To run Harvest automatically, set up cron jobs on a server. See [cron.md](cron.md) for the full schedule.

Quick start — add to your crontab (`crontab -e`):

```cron
# Strategy scan at market open (9:00 AM EST)
0 14 * * 1-5 cd /path/to/Harvest && bun src/orchestration/MultiScan.ts >> /var/log/harvest-scan.log 2>&1

# Auto-execute at market open (9:30 AM EST)
30 14 * * 1-5 cd /path/to/Harvest && bun src/execution/AutoExecute.ts >> /var/log/harvest-execute.log 2>&1

# Position monitor at close (3:55 PM EST)
55 20 * * 1-5 cd /path/to/Harvest && bun src/execution/PositionMonitor.ts --auto-sell >> /var/log/harvest-monitor.log 2>&1
```

---

## Switching to Live Trading

When you're ready to use real money (be careful):

1. Open Alpaca and fund your account
2. Generate live API keys (separate from paper trading keys)
3. Update `.env`:

```env
ALPACA_API_KEY=your_live_key
ALPACA_API_SECRET=your_live_secret
ALPACA_BASE_URL=https://api.alpaca.markets
```

Live trading uses the same code path — Alpaca handles the routing based on the base URL.

---

## Troubleshooting

### "ALPACA_API_KEY not set"

The `.env` file isn't loading. Verify:
1. `.env` exists in the project root (same directory as `package.json`)
2. It contains `ALPACA_API_KEY=...` with no trailing spaces
3. You're running from the project root directory

### Alpaca 401 errors

Your API key or secret is wrong. Double-check both values in your Alpaca dashboard and `.env`.

### Alpaca 403 errors

You're trying to use live trading credentials against the paper endpoint or vice versa. Check `ALPACA_BASE_URL` in `.env`.

### No recommendations generated

Could be one of several things:
- Market regime is BEAR (momentum scanner skipped)
- No stocks in the universe passed all entry criteria (normal during quiet markets)
- Run with `--verbose` flag if available on the scanner

### Yahoo Finance rate limiting

FundamentalCheck uses Yahoo Finance with a 1-second delay between requests. If you see 429 errors, the delay may need to increase. The crumb/cookie cache in `data/yf-cache.json` is reused per session.

### Perplexity errors

Check your API key and usage limits. The research pipeline gracefully degrades — if research fails, recommendations are still generated with `researchScore: 0`.
