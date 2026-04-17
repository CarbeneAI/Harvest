# CLAUDE.md

This file provides guidance to Claude Code when working with the Harvest codebase.

## Project Overview

Harvest is an automated stock trading pipeline built with TypeScript and Bun. It uses the Alpaca paper trading API and generates swing trade signals via dual-strategy scanning (momentum + mean reversion).

## Technology Stack

| Component | Technology |
|-----------|-----------|
| Runtime | Bun (NOT Node.js) |
| Language | TypeScript |
| Package Manager | bun |
| API | Alpaca Markets REST API |
| Research | Perplexity API (sonar model) |
| Notifications | Discord webhook + Telegram bot |

## Key Conventions

### ESM Import Paths

All imports between project files MUST use `.js` extension:

```typescript
import { fetchBars } from "../analysis/TechnicalAnalysis.js";
import { loadCached } from "./DeepResearch.js";
```

This is required for Bun ESM compatibility. Never use `.ts` extensions in imports.

### Project Root Pattern

Every script resolves the project root like this:

```typescript
import { resolve, dirname } from 'path';
const PROJECT_ROOT = resolve(dirname(new URL(import.meta.url).pathname), '../..');
```

Adjust the number of `..` segments based on directory depth from project root:
- `src/analysis/` → `'../..'`
- `src/api/` → `'../..'`
- `src/orchestration/` → `'../..'`

### Environment Loading

Every script that needs env vars loads `.env` from project root:

```typescript
import { readFileSync, existsSync } from 'fs';
const ENV_FILE = resolve(PROJECT_ROOT, '.env');
if (existsSync(ENV_FILE)) {
  const envContent = readFileSync(ENV_FILE, 'utf-8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim();
    if (!process.env[key]) process.env[key] = val;
  }
}
```

### JSON Output

All CLI scripts output JSON to stdout and errors to stderr. This allows piping and composition.

### Running Scripts

Always run with `bun`, never `node` or `ts-node`:

```bash
bun src/orchestration/MultiScan.ts
bun src/execution/AutoExecute.ts
bun src/api/DashboardServer.ts --port 8083
```

## Directory Structure

```
src/
  analysis/      # Technical indicators, fundamentals, risk management
  scanners/      # Strategy scanners (momentum, mean reversion, regime)
  execution/     # Order execution and position management
  research/      # AI research pipeline (Perplexity, SEC, sentiment)
  reporting/     # Daily, weekly, portfolio reports
  notifications/ # Discord and Telegram notifications
  orchestration/ # MultiScan orchestrator
  api/           # HTTP dashboard server
  journal/       # Trade journal and learnings system
dashboard/       # HTML dashboard files served by DashboardServer
data/            # Runtime data (gitignored)
docs/            # Documentation
examples/        # Example outputs
```

## Data Files (gitignored)

Runtime data lives in `data/` (gitignored):

| File/Dir | Purpose |
|---------|---------|
| `data/recommendations.json` | Pending/executed recommendations |
| `data/learnings.md` | Trade learnings with salience scores |
| `data/research/` | Cached Perplexity research per ticker/date |
| `data/journal/` | Trade journal markdown entries |
| `data/archive/` | Archived learnings and old recommendations |
| `data/trading-docs/` | Promoted high-salience learnings |

## Alpaca API Notes

- Paper trading base URL: `https://paper-api.alpaca.markets`
- Live trading base URL: `https://api.alpaca.markets`
- Auth headers: `APCA-API-KEY-ID` and `APCA-API-SECRET-KEY`
- Always default to paper trading unless `ALPACA_BASE_URL` is explicitly set to live

## Perplexity API Notes

- Model: `sonar` for research queries
- Rate limit: ~5 req/min on starter plan
- Always check `PERPLEXITY_API_KEY` is set before calling
- Errors should degrade gracefully (return empty/default result, not crash)

## SEC EDGAR Notes

- No API key required
- User-Agent header required: `Harvest/1.0 (contact@carbene.ai)`
- Rate limit: max 10 requests/second
- CIK lookup: `https://efts.sec.gov/LATEST/search-index?q=%22TICKER%22&dateRange=custom&startdt=...`

## Strategy Parameters

These are core to how Harvest works. Do not change without understanding the implications:

| Parameter | Value | Notes |
|-----------|-------|-------|
| Momentum position size | 5% of portfolio | Volatility-adjusted |
| Mean reversion position size | 4% of portfolio | Volatility-adjusted |
| Conviction threshold | >= 7 | For auto-execution |
| Momentum max hold | 40 trading days | Hard exit |
| Mean reversion max hold | 15 trading days | Hard exit |
| ADX threshold | > 20 | Trend strength requirement |
| Momentum RSI range | 40-70 | Not overbought, not oversold |
| MR RSI entry | < 35 | Or Z-score < -2 |
| MR RSI exit | > 50 | Recovery signal |

## Dashboard Server

`DashboardServer.ts` serves:
- Static files from `dashboard/` directory
- REST API on `/api/*` routes
- Port controlled by `DASHBOARD_PORT` env var (default: 8083)

The dashboard HTML files make fetch calls to relative paths (e.g., `/api/account`) so they work when served from the same origin as the API.

## Testing

No formal test suite. Manual testing approach:
- Run `bun src/orchestration/MultiScan.ts` with paper trading configured
- Verify output JSON structure matches expected schema
- Check `data/recommendations.json` for properly formed recommendations

## Security Notes

- Never commit `.env` file (it's in `.gitignore`)
- Never hardcode API keys
- Always use `ALPACA_BASE_URL=https://paper-api.alpaca.markets` in `.env` unless intentionally live trading
- The SEC User-Agent must remain `Harvest/1.0 (contact@carbene.ai)` per EDGAR guidelines
