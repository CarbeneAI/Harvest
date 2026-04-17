# Harvest

Automated stock trading pipeline built with TypeScript and Bun. Harvest combines multi-strategy scanning, AI-powered research, and disciplined risk management to generate and execute swing trade signals via the Alpaca paper trading API.

## Overview

Harvest runs two complementary strategies in parallel:

- **Momentum Trend Following** — ~80 liquid large-cap stocks. Enters when price > 20 SMA > 50 SMA with RSI 40-70, MACD bullish, ADX > 20, and above-average volume. Exits via trailing 2x ATR stop or sustained 20 SMA break.
- **Mean Reversion on Quality** — ~20 moat stocks. Enters when RSI < 35 (or Z-score < -2), price above 200 SMA, at or below lower Bollinger Band. Exits when RSI recovers above 50 or price reaches 20 SMA.

A market regime gate (SPY vs. 200/50 SMA) adjusts position sizes: full in BULL, half in CAUTION, quarter or mean-reversion-only in BEAR.

## Architecture

```
MarketRegime.ts
    |
    v
MultiScan.ts --parallel--> MomentumScanner.ts
             |              MeanReversionScanner.ts
             v
        FundamentalCheck.ts (quality gate)
             |
             v
        RiskManager.ts (volatility-adjusted sizing)
             |
             v
    Recommendations JSON
             |
             v
       AutoExecute.ts (limit orders via Alpaca)
             |
             v
     PositionMonitor.ts (strategy-aware exits)
```

Research pipeline runs independently:

```
DeepResearch.ts ----> Perplexity (sonar)
    |                      + SECFilingAnalyzer.ts (EDGAR)
    v                      + TechnicalAnalysis.ts
ResearchEnricher.ts ---> conviction adjustment
```

## Project Structure

```
Harvest/
├── src/
│   ├── analysis/
│   │   ├── TechnicalAnalysis.ts   # SMA, EMA, RSI, MACD, ATR, ADX, Hurst, Z-score
│   │   ├── FundamentalCheck.ts    # Yahoo Finance quality gate
│   │   ├── RiskManager.ts         # Volatility-adjusted sizing + correlation limits
│   │   └── BacktestMetrics.ts     # Sharpe, Sortino, MaxDrawdown
│   ├── scanners/
│   │   ├── MarketRegime.ts        # SPY-based BULL/CAUTION/BEAR detection
│   │   ├── MomentumScanner.ts     # 80-stock momentum universe
│   │   └── MeanReversionScanner.ts # 20-stock moat universe
│   ├── execution/
│   │   ├── AlpacaClient.ts        # Alpaca REST API wrapper
│   │   ├── AutoExecute.ts         # Limit order execution
│   │   └── PositionMonitor.ts     # Strategy-aware exit rules
│   ├── research/
│   │   ├── DeepResearch.ts        # Parallel 5-section Perplexity research
│   │   ├── SECFilingAnalyzer.ts   # EDGAR 10-K/10-Q analysis
│   │   ├── ResearchEnricher.ts    # Conviction adjustment from research
│   │   └── SentimentAnalyzer.ts   # Keyword-based sentiment scoring
│   ├── reporting/
│   │   ├── DailyReport.ts         # EOD P&L report
│   │   ├── WeeklyReport.ts        # Performance analytics
│   │   ├── PortfolioReview.ts     # Friday AI position evaluation
│   │   └── ScanMarket.ts          # Yahoo Finance data fetcher
│   ├── notifications/
│   │   └── discord-notify.ts      # Discord + Telegram notifications
│   ├── orchestration/
│   │   └── MultiScan.ts           # Main strategy orchestrator
│   ├── api/
│   │   └── DashboardServer.ts     # Bun HTTP dashboard server
│   └── journal/
│       ├── JournalEntry.ts        # Trade journal markdown generator
│       ├── LearningsManager.ts    # Trading learnings CRUD
│       └── SalienceScorer.ts      # Salience scoring with time decay
├── dashboard/
│   ├── index.html                 # Main trading dashboard
│   └── research.html              # Deep research viewer
├── data/                          # Runtime data (gitignored)
│   ├── recommendations.json
│   ├── learnings.md
│   ├── research/
│   ├── journal/
│   └── archive/
├── docs/
│   ├── strategy.md                # Strategy details and rationale
│   ├── setup.md                   # Installation and configuration
│   ├── cron.md                    # Cron schedule reference
│   └── architecture.md            # System architecture deep-dive
└── examples/
    └── sample-scan-output.json    # Example MultiScan output
```

## Requirements

- [Bun](https://bun.sh) >= 1.1
- [Alpaca Markets](https://alpaca.markets) account (paper trading is free)
- [Perplexity API](https://www.perplexity.ai) key (for deep research, optional)
- Discord webhook URL (for trade notifications, optional)
- Telegram bot token + chat ID (for mobile alerts, optional)

## Setup

```bash
git clone https://github.com/CarbeneAI/Harvest.git
cd Harvest
bun install

cp .env.example .env
# Edit .env with your API keys
```

See [docs/setup.md](docs/setup.md) for full configuration instructions.

## Usage

### Run a strategy scan

```bash
bun src/orchestration/MultiScan.ts
```

Output is written to `data/recommendations.json` and sent to Discord/Telegram if configured.

### Execute pending recommendations

```bash
bun src/execution/AutoExecute.ts
```

Only executes recommendations with conviction >= 7 that haven't expired.

### Monitor open positions

```bash
bun src/execution/PositionMonitor.ts --auto-sell
```

Checks exit conditions for each open position. Pass `--auto-sell` to execute exits automatically.

### Start the dashboard

```bash
bun src/api/DashboardServer.ts
# Open http://localhost:8083
```

### Run deep research on a ticker

```bash
bun src/research/DeepResearch.ts --ticker AAPL
```

Results cached in `data/research/AAPL-YYYY-MM-DD.json`.

### Generate reports

```bash
# EOD report
bun src/reporting/DailyReport.ts

# Weekly performance report
bun src/reporting/WeeklyReport.ts

# Friday portfolio review
bun src/reporting/PortfolioReview.ts
```

### Manage trade learnings

```bash
# Add a learning
bun src/journal/LearningsManager.ts add \
  --title "Buy dips after earnings beat" \
  --learning "Stock typically recovers within 3 days after a post-earnings dip" \
  --source "AAPL trade 2026-01-15" \
  --tags "earnings,momentum"

# List all learnings
bun src/journal/LearningsManager.ts list

# Run weekly salience sweep
bun src/journal/SalienceScorer.ts --sweep
```

## Cron Schedule

For running Harvest automatically on a Linux server:

```cron
# Market scan at open (9:00 AM EST = 14:00 UTC)
0 14 * * 1-5 cd /path/to/Harvest && bun src/orchestration/MultiScan.ts

# Auto-execute at market open (9:30 AM EST = 14:30 UTC)
30 14 * * 1-5 cd /path/to/Harvest && bun src/execution/AutoExecute.ts

# Position monitor at close (3:55 PM EST = 20:55 UTC)
55 20 * * 1-5 cd /path/to/Harvest && bun src/execution/PositionMonitor.ts --auto-sell

# Daily report after close (6:00 PM EST = 23:00 UTC)
0 23 * * 1-5 cd /path/to/Harvest && bun src/reporting/DailyReport.ts

# Friday portfolio review (4:30 PM EST = 21:30 UTC)
30 21 * * 5 cd /path/to/Harvest && bun src/reporting/PortfolioReview.ts

# Friday weekly report (5:00 PM EST = 22:00 UTC)
0 22 * * 5 cd /path/to/Harvest && bun src/reporting/WeeklyReport.ts
```

See [docs/cron.md](docs/cron.md) for the complete cron reference.

## Key Technical Indicators

| Indicator | Purpose | Source |
|-----------|---------|--------|
| SMA 20/50/200 | Trend direction and regime | TechnicalAnalysis.ts |
| RSI (14) | Momentum, overbought/oversold | TechnicalAnalysis.ts |
| MACD (12/26/9) | Momentum crossover signal | TechnicalAnalysis.ts |
| ATR (14) | Volatility for stop sizing | TechnicalAnalysis.ts |
| ADX (14) | Trend strength filter (>20) | TechnicalAnalysis.ts |
| Bollinger Bands | Mean reversion envelope | TechnicalAnalysis.ts |
| Hurst Exponent | Mean-reverting behavior test | TechnicalAnalysis.ts |
| Z-Score | Statistical oversold trigger | TechnicalAnalysis.ts |
| Multi-TF Momentum | 1m/3m/6m weighted composite | TechnicalAnalysis.ts |

## Risk Management

- **Momentum positions:** 5% of portfolio (volatility-adjusted)
- **Mean reversion positions:** 4% of portfolio (volatility-adjusted)
- **Volatility tiers:** annualized vol < 15% → 6% max, 15-30% → 5%, 30-50% → 4%, > 50% → 3%
- **Correlation limits:** high-correlation positions (> 0.8) get 0.65x size reduction
- **Max hold:** 40 days momentum, 15 days mean reversion
- **Market regime:** half size in CAUTION, quarter size (MR only) in BEAR

## Dashboard

The dashboard serves at `http://localhost:${DASHBOARD_PORT || 8083}`:

- Portfolio stats (equity, daily P&L, buying power, open positions)
- Live recommendations with conviction scores and entry/stop/target levels
- Open positions with unrealized P&L and AI portfolio review
- Recent orders
- Active trade learnings with salience scores
- Deep research viewer per ticker (5 Perplexity sections + SEC + technical)

## Environment Variables

See [.env.example](.env.example) for the full list. Required variables:

```env
ALPACA_API_KEY=your_key
ALPACA_API_SECRET=your_secret
ALPACA_BASE_URL=https://paper-api.alpaca.markets
```

Optional (for full feature set):

```env
PERPLEXITY_API_KEY=your_key
DISCORD_WEBHOOK_URL=your_webhook
DISCORD_TRADING_CHANNEL_ID=your_channel_id
DISCORD_BOT_TOKEN=your_bot_token
TELEGRAM_BOT_TOKEN=your_bot_token
TELEGRAM_CHAT_ID=your_chat_id
```

## Disclaimer

Harvest is for educational and research purposes only. It uses paper trading by default. Nothing in this repository constitutes financial advice. Past performance of any algorithm does not guarantee future results. Trading involves significant risk of loss.

## License

MIT License. See [LICENSE](LICENSE).

---

Built by [CarbeneAI](https://carbene.ai).
