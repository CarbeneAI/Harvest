#!/usr/bin/env bun
/**
 * ScanMarket.ts - Market Data Fetcher
 *
 * Fetches real-time market data from Yahoo Finance API.
 * Supports single ticker or watchlist scanning.
 *
 * Usage:
 *   bun ScanMarket.ts --ticker AAPL
 *   bun ScanMarket.ts --watchlist
 *   bun ScanMarket.ts --ticker AAPL,MSFT,GOOGL
 */

// Parse command line arguments
function parseArgs(argv: string[]): Record<string, string | boolean> {
  const args: Record<string, string | boolean> = {};
  for (let i = 2; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      const nextValue = argv[i + 1];
      if (nextValue && !nextValue.startsWith('--')) {
        args[key] = nextValue;
        i++;
      } else {
        args[key] = true;
      }
    }
  }
  return args;
}

// Default watchlist
const DEFAULT_WATCHLIST = [
  'AAPL', 'MSFT', 'GOOGL', 'AMZN', 'NVDA',
  'META', 'TSLA', 'SPY', 'QQQ'
];

// Fetch market data for a single ticker
async function fetchTickerData(ticker: string) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=5d`;

  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.json();
    const chart = data.chart.result[0];

    if (!chart) {
      return {
        ticker,
        error: 'No data available',
      };
    }

    const meta = chart.meta;
    const quotes = chart.indicators.quote[0];

    // Get current and previous close
    const currentPrice = meta.regularMarketPrice;
    const previousClose = meta.chartPreviousClose;

    // Calculate daily change
    const dailyChange = currentPrice - previousClose;
    const dailyChangePercent = (dailyChange / previousClose) * 100;

    // Calculate 5-day change
    const closePrices = quotes.close.filter((p: number | null) => p !== null);
    const firstPrice = closePrices[0];
    const fiveDayChange = currentPrice - firstPrice;
    const fiveDayChangePercent = (fiveDayChange / firstPrice) * 100;

    // Calculate average volume
    const volumes = quotes.volume.filter((v: number | null) => v !== null);
    const avgVolume = volumes.reduce((a: number, b: number) => a + b, 0) / volumes.length;
    const currentVolume = meta.regularMarketVolume || volumes[volumes.length - 1];
    const volumeRatio = currentVolume / avgVolume;

    // Flag notable moves
    const flags = [];
    if (Math.abs(dailyChangePercent) > 3) {
      flags.push('HIGH_MOVE');
    }
    if (volumeRatio > 2) {
      flags.push('HIGH_VOLUME');
    }

    return {
      ticker,
      currentPrice: currentPrice.toFixed(2),
      dailyChange: dailyChange.toFixed(2),
      dailyChangePercent: dailyChangePercent.toFixed(2),
      fiveDayChangePercent: fiveDayChangePercent.toFixed(2),
      volume: currentVolume,
      avgVolume: Math.round(avgVolume),
      volumeRatio: volumeRatio.toFixed(2),
      flags,
    };

  } catch (error) {
    return {
      ticker,
      error: `Failed to fetch: ${error}`,
    };
  }
}

// Show help
function showHelp() {
  console.log(`
Market Data Fetcher

Usage:
  bun ScanMarket.ts [options]

Options:
  --ticker <symbol>      Scan specific ticker(s) (comma-separated)
  --watchlist            Scan default watchlist
  --help                 Show this help message

Examples:
  bun ScanMarket.ts --ticker AAPL
  bun ScanMarket.ts --ticker AAPL,MSFT,GOOGL
  bun ScanMarket.ts --watchlist

Default Watchlist:
  ${DEFAULT_WATCHLIST.join(', ')}

Output:
  JSON array with market data for each ticker including:
  - Current price
  - Daily change ($ and %)
  - 5-day change (%)
  - Volume vs average volume ratio
  - Flags for notable moves (>3% move, >2x volume)
`);
}

// Main execution
async function main() {
  const args = parseArgs(process.argv);

  if (args.help) {
    showHelp();
    process.exit(0);
  }

  let tickers: string[] = [];

  if (args.ticker) {
    tickers = (args.ticker as string).split(',').map(t => t.trim().toUpperCase());
  } else if (args.watchlist) {
    tickers = DEFAULT_WATCHLIST;
  } else {
    console.error('Error: Must specify --ticker or --watchlist');
    showHelp();
    process.exit(1);
  }

  console.error(`Scanning ${tickers.length} ticker(s)...`);

  const results = await Promise.all(
    tickers.map(ticker => fetchTickerData(ticker))
  );

  console.log(JSON.stringify(results, null, 2));
  process.exit(0);
}

main();
