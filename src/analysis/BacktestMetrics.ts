#!/usr/bin/env bun
/**
 * BacktestMetrics.ts - Portfolio Performance Analytics
 *
 * Computes risk-adjusted performance metrics:
 *   - Sharpe Ratio (risk-adjusted return vs risk-free rate)
 *   - Sortino Ratio (downside-only deviation — better for non-normal returns)
 *   - Maximum Drawdown (largest peak-to-trough decline)
 *   - Win Rate, Profit Factor, Expectancy
 *
 * Usage:
 *   bun BacktestMetrics.ts                # Full portfolio analysis
 *   bun BacktestMetrics.ts --trades       # Trade-level metrics only
 *   bun BacktestMetrics.ts --json         # JSON output
 *   bun BacktestMetrics.ts --help
 */

import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";

// --- Paths ---
const PROJECT_ROOT = resolve(dirname(new URL(import.meta.url).pathname), "../..");
const DATA_DIR = resolve(PROJECT_ROOT, "data");
const RECS_FILE = resolve(DATA_DIR, "recommendations.json");

// --- Load .env ---
const ENV_FILE = resolve(PROJECT_ROOT, ".env");
if (existsSync(ENV_FILE)) {
  const envContent = readFileSync(ENV_FILE, "utf-8");
  for (const line of envContent.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim();
    if (!process.env[key]) process.env[key] = val;
  }
}

// --- Core Metrics ---

/**
 * Sharpe Ratio: risk-adjusted excess return.
 * Formula: sqrt(252) * mean(excess_return) / std(excess_return)
 * where excess_return = daily_return - daily_risk_free_rate
 *
 * @param dailyReturns Array of daily returns (e.g. 0.01 = 1%)
 * @param annualRiskFreeRate Annual risk-free rate (default 5% = 0.05)
 */
export function sharpeRatio(
  dailyReturns: number[],
  annualRiskFreeRate: number = 0.05
): number {
  if (dailyReturns.length < 5) return NaN;

  const dailyRf = annualRiskFreeRate / 252;
  const excessReturns = dailyReturns.map((r) => r - dailyRf);

  const mean =
    excessReturns.reduce((a, b) => a + b, 0) / excessReturns.length;
  const variance =
    excessReturns.reduce((sum, r) => sum + (r - mean) ** 2, 0) /
    (excessReturns.length - 1);
  const std = Math.sqrt(variance);

  if (std === 0) return 0;
  return Math.sqrt(252) * (mean / std);
}

/**
 * Sortino Ratio: like Sharpe but only penalizes downside volatility.
 * Better than Sharpe for strategies with non-normal return distributions.
 * Formula: sqrt(252) * mean(excess_return) / downside_deviation
 */
export function sortinoRatio(
  dailyReturns: number[],
  annualRiskFreeRate: number = 0.05
): number {
  if (dailyReturns.length < 5) return NaN;

  const dailyRf = annualRiskFreeRate / 252;
  const excessReturns = dailyReturns.map((r) => r - dailyRf);

  const mean =
    excessReturns.reduce((a, b) => a + b, 0) / excessReturns.length;

  // Only negative excess returns contribute to downside deviation
  const downsideSquared = excessReturns
    .filter((r) => r < 0)
    .map((r) => r * r);

  if (downsideSquared.length === 0) return Infinity; // No downside

  const downsideDeviation = Math.sqrt(
    downsideSquared.reduce((a, b) => a + b, 0) / excessReturns.length
  );

  if (downsideDeviation === 0) return 0;
  return Math.sqrt(252) * (mean / downsideDeviation);
}

/**
 * Maximum Drawdown: largest peak-to-trough decline.
 */
export function maxDrawdown(equityCurve: number[]): {
  maxDrawdownPct: number;
  peakIdx: number;
  troughIdx: number;
} {
  if (equityCurve.length < 2) return { maxDrawdownPct: 0, peakIdx: 0, troughIdx: 0 };

  let peak = equityCurve[0];
  let peakIdx = 0;
  let maxDd = 0;
  let maxDdPeakIdx = 0;
  let maxDdTroughIdx = 0;

  for (let i = 1; i < equityCurve.length; i++) {
    if (equityCurve[i] > peak) {
      peak = equityCurve[i];
      peakIdx = i;
    }
    const dd = (peak - equityCurve[i]) / peak;
    if (dd > maxDd) {
      maxDd = dd;
      maxDdPeakIdx = peakIdx;
      maxDdTroughIdx = i;
    }
  }

  return {
    maxDrawdownPct: +(maxDd * 100).toFixed(2),
    peakIdx: maxDdPeakIdx,
    troughIdx: maxDdTroughIdx,
  };
}

// --- Trade-Level Metrics ---

export interface TradeResult {
  ticker: string;
  strategy: string;
  entryPrice: number;
  exitPrice: number;
  plPct: number;
  daysHeld: number;
}

export interface TradeMetrics {
  totalTrades: number;
  winCount: number;
  lossCount: number;
  winRate: number;
  avgWinPct: number;
  avgLossPct: number;
  profitFactor: number;
  expectancy: number;
  avgDaysHeld: number;
  bestTrade: { ticker: string; plPct: number } | null;
  worstTrade: { ticker: string; plPct: number } | null;
  byStrategy: Record<
    string,
    { count: number; winRate: number; avgPl: number }
  >;
}

/**
 * Compute trade-level metrics from closed trades.
 */
export function computeTradeMetrics(trades: TradeResult[]): TradeMetrics {
  if (trades.length === 0) {
    return {
      totalTrades: 0,
      winCount: 0,
      lossCount: 0,
      winRate: 0,
      avgWinPct: 0,
      avgLossPct: 0,
      profitFactor: 0,
      expectancy: 0,
      avgDaysHeld: 0,
      bestTrade: null,
      worstTrade: null,
      byStrategy: {},
    };
  }

  const wins = trades.filter((t) => t.plPct > 0);
  const losses = trades.filter((t) => t.plPct <= 0);

  const grossProfit = wins.reduce((sum, t) => sum + t.plPct, 0);
  const grossLoss = Math.abs(losses.reduce((sum, t) => sum + t.plPct, 0));

  const avgWinPct = wins.length > 0 ? grossProfit / wins.length : 0;
  const avgLossPct = losses.length > 0 ? grossLoss / losses.length : 0;
  const winRate = wins.length / trades.length;

  // Expectancy = (winRate * avgWin) - (lossRate * avgLoss)
  const expectancy = winRate * avgWinPct - (1 - winRate) * avgLossPct;

  // By strategy breakdown
  const byStrategy: Record<string, { count: number; wins: number; totalPl: number }> = {};
  for (const t of trades) {
    const strat = t.strategy || "unknown";
    if (!byStrategy[strat]) byStrategy[strat] = { count: 0, wins: 0, totalPl: 0 };
    byStrategy[strat].count++;
    if (t.plPct > 0) byStrategy[strat].wins++;
    byStrategy[strat].totalPl += t.plPct;
  }

  const stratMetrics: Record<string, { count: number; winRate: number; avgPl: number }> = {};
  for (const [strat, data] of Object.entries(byStrategy)) {
    stratMetrics[strat] = {
      count: data.count,
      winRate: +(data.wins / data.count).toFixed(3),
      avgPl: +(data.totalPl / data.count).toFixed(2),
    };
  }

  const sorted = [...trades].sort((a, b) => b.plPct - a.plPct);

  return {
    totalTrades: trades.length,
    winCount: wins.length,
    lossCount: losses.length,
    winRate: +winRate.toFixed(3),
    avgWinPct: +avgWinPct.toFixed(2),
    avgLossPct: +avgLossPct.toFixed(2),
    profitFactor: grossLoss > 0 ? +(grossProfit / grossLoss).toFixed(2) : Infinity,
    expectancy: +expectancy.toFixed(2),
    avgDaysHeld: +(trades.reduce((sum, t) => sum + t.daysHeld, 0) / trades.length).toFixed(1),
    bestTrade: sorted[0] ? { ticker: sorted[0].ticker, plPct: +sorted[0].plPct.toFixed(2) } : null,
    worstTrade: sorted[sorted.length - 1] ? { ticker: sorted[sorted.length - 1].ticker, plPct: +sorted[sorted.length - 1].plPct.toFixed(2) } : null,
    byStrategy: stratMetrics,
  };
}

// --- Load Closed Trades from Recommendations ---

function loadClosedTrades(): TradeResult[] {
  if (!existsSync(RECS_FILE)) return [];

  let recs: any[];
  try {
    recs = JSON.parse(readFileSync(RECS_FILE, "utf-8"));
  } catch {
    return [];
  }

  return recs
    .filter((r) => r.status === "closed" && r.closePL !== undefined)
    .map((r) => ({
      ticker: r.ticker,
      strategy: r.strategy || "legacy",
      entryPrice: r.entryPrice || r.executionPrice || 0,
      exitPrice: r.entryPrice ? r.entryPrice * (1 + (r.closePL || 0) / 100) : 0,
      plPct: r.closePL || 0,
      daysHeld: r.executedAt && r.closedAt
        ? Math.floor((new Date(r.closedAt).getTime() - new Date(r.executedAt).getTime()) / (1000 * 60 * 60 * 24))
        : 0,
    }));
}

// --- Get Portfolio Daily Returns from Alpaca ---

async function getPortfolioDailyReturns(): Promise<{
  returns: number[];
  equityCurve: number[];
  dates: string[];
}> {
  const apiKey = process.env.ALPACA_API_KEY || "";
  const apiSecret = process.env.ALPACA_API_SECRET || "";
  const baseUrl = process.env.ALPACA_BASE_URL || "https://paper-api.alpaca.markets";

  if (!apiKey || !apiSecret) {
    return { returns: [], equityCurve: [], dates: [] };
  }

  try {
    const resp = await fetch(
      `${baseUrl}/v2/account/portfolio/history?period=3M&timeframe=1D`,
      {
        headers: {
          "APCA-API-KEY-ID": apiKey,
          "APCA-API-SECRET-KEY": apiSecret,
        },
      }
    );

    if (!resp.ok) return { returns: [], equityCurve: [], dates: [] };

    const data = await resp.json() as any;
    const equityCurve: number[] = data.equity || [];
    const timestamps: number[] = data.timestamp || [];

    if (equityCurve.length < 2) return { returns: [], equityCurve: [], dates: [] };

    const returns: number[] = [];
    for (let i = 1; i < equityCurve.length; i++) {
      returns.push((equityCurve[i] - equityCurve[i - 1]) / equityCurve[i - 1]);
    }

    const dates = timestamps.map((t) => new Date(t * 1000).toISOString().slice(0, 10));

    return { returns, equityCurve, dates };
  } catch {
    return { returns: [], equityCurve: [], dates: [] };
  }
}

// --- CLI ---

if (import.meta.main) {
  const args = process.argv.slice(2);

  if (args.includes("--help")) {
    console.log(`
BacktestMetrics - Portfolio Performance Analytics

Usage:
  bun BacktestMetrics.ts                # Full portfolio analysis
  bun BacktestMetrics.ts --trades       # Trade-level metrics only
  bun BacktestMetrics.ts --json         # JSON output
  bun BacktestMetrics.ts --help

Metrics Computed:
  Portfolio Level:
    - Sharpe Ratio (risk-adjusted return)
    - Sortino Ratio (downside-risk-adjusted)
    - Maximum Drawdown (largest peak-to-trough decline)

  Trade Level:
    - Win Rate, Profit Factor, Expectancy
    - Average Win/Loss, Best/Worst Trade
    - Strategy-level breakdown (momentum vs mean reversion)
`);
    process.exit(0);
  }

  const jsonMode = args.includes("--json");
  const tradesOnly = args.includes("--trades");

  console.error("[BacktestMetrics] Analyzing portfolio performance...");

  const closedTrades = loadClosedTrades();
  const tradeMetrics = computeTradeMetrics(closedTrades);

  let portfolioMetrics: any = null;
  if (!tradesOnly) {
    const { returns, equityCurve, dates } = await getPortfolioDailyReturns();
    if (returns.length > 0) {
      const dd = maxDrawdown(equityCurve);
      portfolioMetrics = {
        sharpe: +sharpeRatio(returns).toFixed(3),
        sortino: +sortinoRatio(returns).toFixed(3),
        maxDrawdown: dd.maxDrawdownPct,
        totalReturn: +((equityCurve[equityCurve.length - 1] / equityCurve[0] - 1) * 100).toFixed(2),
        tradingDays: returns.length,
        startDate: dates[0] || "N/A",
        endDate: dates[dates.length - 1] || "N/A",
      };
    }
  }

  if (jsonMode) {
    console.log(JSON.stringify({ portfolioMetrics, tradeMetrics }, null, 2));
    process.exit(0);
  }

  console.log("\n" + "=".repeat(70));
  console.log("HARVEST - PERFORMANCE ANALYTICS");
  console.log("=".repeat(70));

  if (portfolioMetrics) {
    console.log("\n--- Portfolio Metrics ---");
    console.log(`  Period: ${portfolioMetrics.startDate} → ${portfolioMetrics.endDate} (${portfolioMetrics.tradingDays} days)`);
    console.log(`  Total Return:     ${portfolioMetrics.totalReturn > 0 ? "+" : ""}${portfolioMetrics.totalReturn}%`);
    console.log(`  Sharpe Ratio:     ${portfolioMetrics.sharpe} ${portfolioMetrics.sharpe > 1 ? "(good)" : portfolioMetrics.sharpe > 0.5 ? "(ok)" : "(poor)"}`);
    console.log(`  Sortino Ratio:    ${portfolioMetrics.sortino} ${portfolioMetrics.sortino > 1.5 ? "(good)" : portfolioMetrics.sortino > 0.7 ? "(ok)" : "(poor)"}`);
    console.log(`  Max Drawdown:     -${portfolioMetrics.maxDrawdown}%`);
  } else if (!tradesOnly) {
    console.log("\n--- Portfolio Metrics ---");
    console.log("  No portfolio history available from Alpaca.");
  }

  console.log("\n--- Trade Metrics ---");
  if (tradeMetrics.totalTrades === 0) {
    console.log("  No closed trades found in recommendations.json.");
  } else {
    console.log(`  Total Trades:     ${tradeMetrics.totalTrades}`);
    console.log(`  Win Rate:         ${(tradeMetrics.winRate * 100).toFixed(1)}% (${tradeMetrics.winCount}W / ${tradeMetrics.lossCount}L)`);
    console.log(`  Avg Win:          +${tradeMetrics.avgWinPct}%`);
    console.log(`  Avg Loss:         -${tradeMetrics.avgLossPct}%`);
    console.log(`  Profit Factor:    ${tradeMetrics.profitFactor}`);
    console.log(`  Expectancy:       ${tradeMetrics.expectancy > 0 ? "+" : ""}${tradeMetrics.expectancy}% per trade`);
    console.log(`  Avg Days Held:    ${tradeMetrics.avgDaysHeld}`);
    if (tradeMetrics.bestTrade) {
      console.log(`  Best Trade:       ${tradeMetrics.bestTrade.ticker} (+${tradeMetrics.bestTrade.plPct}%)`);
    }
    if (tradeMetrics.worstTrade) {
      console.log(`  Worst Trade:      ${tradeMetrics.worstTrade.ticker} (${tradeMetrics.worstTrade.plPct}%)`);
    }

    if (Object.keys(tradeMetrics.byStrategy).length > 1) {
      console.log("\n  By Strategy:");
      for (const [strat, data] of Object.entries(tradeMetrics.byStrategy)) {
        const tag = strat === "momentum" ? "MOM " : strat === "mean_reversion" ? "MREV" : "LEG ";
        console.log(`    [${tag}] ${data.count} trades | ${(data.winRate * 100).toFixed(0)}% win rate | avg ${data.avgPl > 0 ? "+" : ""}${data.avgPl}%`);
      }
    }
  }

  console.log("\n" + "=".repeat(70));
  console.log("[BacktestMetrics] Analysis complete.");
}
