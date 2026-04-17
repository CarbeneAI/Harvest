# Architecture

## Overview

Harvest is built on three principles:

1. **CLI-first** — every component is a standalone executable that reads from stdin/env and writes JSON to stdout
2. **Composition** — components are chained together by the orchestrator (MultiScan.ts)
3. **Graceful degradation** — optional components (Perplexity, Discord, Telegram) fail silently

## Component Map

```
┌─────────────────────────────────────────────────────────────────┐
│                        MultiScan.ts                             │
│  ┌──────────────┐  ┌────────────────────┐  ┌─────────────────┐ │
│  │ MarketRegime │  │  MomentumScanner   │  │ MeanReversion   │ │
│  │    .ts       │  │       .ts          │  │  Scanner.ts     │ │
│  │  SPY check   │  │  80 stocks, 7 pts  │  │  20 moats, 6pts │ │
│  └──────┬───────┘  └────────┬───────────┘  └────────┬────────┘ │
│         │                   └──────────┬─────────────┘          │
│         │ regime               merged recs                       │
│         └────────────────────────┬────┘                         │
│                            ┌─────▼──────────┐                   │
│                            │FundamentalCheck │                   │
│                            │  Yahoo Finance  │                   │
│                            │ SKIP/DAMPEN/AMP │                   │
│                            └─────┬───────────┘                  │
│                            ┌─────▼──────────┐                   │
│                            │  RiskManager   │                   │
│                            │ vol-adj sizing │                   │
│                            │ corr limits    │                   │
│                            └─────┬───────────┘                  │
│                          recommendations.json                    │
└──────────────────────────────────┼──────────────────────────────┘
                                   │
                    ┌──────────────┼──────────────┐
                    ▼              ▼               ▼
            AutoExecute.ts  DashboardServer  discord-notify.ts
            (Alpaca orders)  (HTTP + HTML)   (Discord/Telegram)
```

## Data Flow

### 1. Scanning Phase (MultiScan.ts)

```
1. Check market regime (MarketRegime.ts)
   → Fetch SPY price + 200/50 SMA
   → Return BULL | CAUTION | BEAR

2. Parallel scan
   → MomentumScanner: score each stock in universe (0-7 pts)
   → MeanReversionScanner: score each stock in moat universe (0-6 pts)
   → Both return typed Recommendation[] arrays

3. Merge and deduplicate recommendations

4. Fundamental gate (FundamentalCheck)
   → Fetch Yahoo Finance fundamentals (ROE, gross margin, D/E, FCF)
   → Cache crumb/cookie per session
   → Return SKIP | DAMPEN | NEUTRAL | AMPLIFY verdict
   → Apply conviction adjustment

5. Risk sizing (RiskManager)
   → Calculate annualized volatility from price history
   → Assign volatility tier (LOW | MODERATE | HIGH | VERY_HIGH)
   → Calculate base position size (4-5% of equity)
   → Apply vol tier multiplier
   → Calculate avg portfolio correlation
   → Apply correlation multiplier
   → Return final dollar amount and share count

6. Write recommendations to data/recommendations.json
   → Append to existing file (today's recs)
   → Send notification to Discord/Telegram
```

### 2. Execution Phase (AutoExecute.ts)

```
1. Read data/recommendations.json
2. Filter: status = 'pending', conviction >= 7, not expired
3. Fetch current Alpaca account equity
4. For each eligible rec:
   → Calculate shares from dollar allocation
   → Place LIMIT BUY order at 0.1% above current price
   → Tag order with strategy and scan type
   → Update recommendation status to 'executed'
5. Send execution notification
```

### 3. Monitoring Phase (PositionMonitor.ts)

```
1. Fetch all open positions from Alpaca
2. Fetch historical prices for each position
3. For each position:
   → Look up original recommendation (strategy tag)
   → Calculate ATR
   → Check exit conditions:
     * Momentum: trailing ATR stop, 20 SMA break, max hold
     * Mean reversion: RSI > 50, price at 20 SMA, max hold
   → If exit: place MARKET SELL order
4. Report exit summary
```

### 4. Research Phase (DeepResearch.ts)

```
1. Check cache (data/research/TICKER-YYYY-MM-DD.json)
2. If cached and fresh: return cached
3. Else: run 5 parallel Perplexity queries:
   → industryMomentum: sector trends, acceleration/deceleration
   → competitiveTeardown: market share, moat, recent news
   → policyRadar: regulatory risk, government policy
   → secFiling: 10-K/10-Q analysis via EDGAR
   → technicalAnalysis: price action, trend, key levels
4. Each section returns status: 'pending' | 'complete' | 'error'
5. Update cache as sections complete
6. Return ResearchResult with all sections
```

## File Structure Details

### src/analysis/

**TechnicalAnalysis.ts** — shared indicator library

- `fetchBars(ticker, days)` — Yahoo Finance OHLCV data
- `calcSMA(prices, period)` — simple moving average
- `calcEMA(prices, period)` — exponential moving average
- `calcRSI(prices, period)` — relative strength index (0-100)
- `calcMACD(prices)` — MACD line, signal, histogram
- `calcATR(highs, lows, closes, period)` — average true range
- `calcBollingerBands(prices, period, stdDev)` — upper/middle/lower bands
- `calcADX(highs, lows, closes, period)` — average directional index
- `calcHurstExponent(prices)` — R/S analysis for mean reversion detection
- `calcZScore(prices, period)` — statistical deviation from mean
- `calcMultiTFMomentum(ticker)` — 1m/3m/6m weighted momentum composite

**FundamentalCheck.ts** — Yahoo Finance fundamentals gate

Uses Yahoo Finance crumb authentication (no official API key needed). Fetches via `https://query2.finance.yahoo.com/v10/finance/quoteSummary/TICKER`. Caches crumb per session.

**RiskManager.ts** — volatility-adjusted sizing

Calculates annualized volatility from daily returns. Applies tier multipliers. Calculates Pearson correlation between all portfolio positions. Returns final position size in shares.

**BacktestMetrics.ts** — performance analytics

Takes array of trade objects `{entryPrice, exitPrice, direction, size}`. Returns Sharpe ratio (assuming 252 trading days, 4.5% risk-free), Sortino ratio, max drawdown percentage, win rate, profit factor, average gain/loss.

### src/scanners/

**MarketRegime.ts** — regime detection

Fetches SPY data, calculates 200/50 SMA, returns typed `RegimeResult`.

**MomentumScanner.ts** — 80-stock universe

Hardcoded list of ~80 large-cap liquid stocks across sectors. Scores each stock 0-7. Returns `MomentumSignal[]` sorted by score descending.

**MeanReversionScanner.ts** — 20-stock moat universe

Hardcoded list of ~20 Buffett-quality companies. Scores each stock 0-6. Returns `MeanReversionSignal[]`.

### src/execution/

**AlpacaClient.ts** — REST wrapper

Thin wrapper around Alpaca REST API. All methods are async, returns typed responses. Handles auth headers. Does NOT retry on failure (caller handles errors).

**AutoExecute.ts** — limit order execution

Reads `data/recommendations.json`. Places LIMIT orders via AlpacaClient. Updates recommendation status. Sends notifications.

**PositionMonitor.ts** — exit management

Fetches positions from Alpaca, checks strategy-specific exit rules, places MARKET SELL orders.

### src/research/

**DeepResearch.ts** — parallel 5-section research

Orchestrates 5 concurrent Perplexity queries. Each query runs in a Promise. Updates cache incrementally. Exports `loadCached(ticker)` for use by other modules.

**SECFilingAnalyzer.ts** — EDGAR integration

Fetches company CIK from EDGAR search API. Gets recent 10-K/10-Q filings list. Extracts filing text (first 5000 chars). Sends to Perplexity for analysis.

**ResearchEnricher.ts** — conviction adjustment

Takes `Recommendation` + `ResearchResult`. Sends to Perplexity with professional trader persona prompt. Parses JSON response. Returns `EnrichmentResult` with score (-1 to +1), summary, contradictions, conviction adjustment.

**SentimentAnalyzer.ts** — keyword scoring

Pure function, no API calls. Matches bullish/bearish keyword lists against text. Applies amplifier multipliers. Normalizes to -1.0 to +1.0.

### src/api/

**DashboardServer.ts** — Bun HTTP server

Uses `Bun.serve()`. Serves static files from `dashboard/` directory. REST API routes:
- `GET /api/account` — Alpaca account info
- `GET /api/positions` — open positions
- `GET /api/orders` — recent orders
- `GET /api/daily-pl` — today's P&L breakdown
- `GET /api/recommendations` — recommendations from JSON file
- `GET /api/learnings` — active learnings from learnings.md
- `GET /api/portfolio-review` — latest portfolio review
- `GET /api/research/:ticker` — cached research or null
- `POST /api/research/:ticker` — trigger new research (async)

### src/journal/

**JournalEntry.ts** — markdown entry generator

Creates structured trade journal entries. Calculates P&L, duration. Saves to `data/journal/YYYY-MM/YYYY-MM-DD-TICKER-DIRECTION.md`.

**LearningsManager.ts** — CRUD for trade learnings

Reads/writes `data/learnings.md` (markdown format with metadata). Generates sequential IDs (`L-YYYYMMDD-XXX`). Archive goes to `data/archive/YYYY-MM/`.

**SalienceScorer.ts** — salience decay and lifecycle

Applies `-0.02` score decay per week. Win feedback: `+0.1`. Loss feedback: `-0.15`. Manual boost: `+0.2`. Score > 0.8 → promote to `data/trading-docs/`. Score < 0.2 → archive.

## Type System

Key shared types (defined inline per file, no separate types file):

```typescript
interface Recommendation {
  id: string;                // REC-YYYYMMDD-XXX
  ticker: string;
  direction: 'long' | 'short';
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  conviction: number;        // 0-10
  thesis: string;
  strength: 'Low' | 'Medium' | 'High';
  sources: string[];
  strategy: 'momentum' | 'mean-reversion';
  scanType: string;
  status: 'pending' | 'executed' | 'rejected' | 'expired';
  positionSize?: number;     // Dollar amount after risk adjustment
  researchScore?: number;    // -1 to +1 from ResearchEnricher
  researchSummary?: string;
  convictionAdjustment?: number;
  createdAt: string;
  expiresAt: string;
}

interface ResearchResult {
  ticker: string;
  companyName: string;
  industry: string;
  status: 'in_progress' | 'complete' | 'error';
  sections: {
    industryMomentum: ResearchSection;
    competitiveTeardown: ResearchSection;
    policyRadar: ResearchSection;
    secFiling: ResearchSection;
    technicalAnalysis: ResearchSection;
  };
  generatedAt: string;
}

interface ResearchSection {
  title: string;
  status: 'pending' | 'complete' | 'error';
  content?: string;
  error?: string;
}
```

## Error Handling Philosophy

- **External API failures** (Alpaca, Perplexity, Yahoo) → log to stderr, return empty/default, continue
- **Missing data files** → create with defaults or return empty state
- **Invalid recommendations** → skip silently, log warning
- **Alpaca order failures** → log full error, mark recommendation as 'expired'
- **Dashboard API errors** → return `{ error: message }` JSON, never 500 with HTML

## Concurrency

- MomentumScanner and MeanReversionScanner run in parallel via `Promise.all()`
- DeepResearch runs all 5 Perplexity sections in parallel via `Promise.all()`
- FundamentalCheck processes tickers sequentially with 1-second delay (rate limiting)
- DashboardServer handles concurrent requests via Bun's native async HTTP
