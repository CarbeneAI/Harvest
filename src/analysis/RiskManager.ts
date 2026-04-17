#!/usr/bin/env bun
/**
 * RiskManager.ts - Volatility-Adjusted Position Sizing & Correlation Risk
 *
 * Implements institutional-grade position sizing:
 *   1. Annualized volatility calculation (60-day lookback)
 *   2. Volatility-tiered position limits
 *   3. Correlation-adjusted position limits (reduce size when holdings are correlated)
 *
 * Usage:
 *   bun RiskManager.ts --ticker AAPL                    # Single ticker volatility analysis
 *   bun RiskManager.ts --portfolio AAPL,MSFT,NVDA       # Portfolio correlation check
 *   bun RiskManager.ts --size TSLA --held AAPL,MSFT     # Full position sizing
 *   bun RiskManager.ts --help
 */

import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fetchBars, type Bar } from "./TechnicalAnalysis.js";

// Load .env from project root
const PROJECT_ROOT = resolve(dirname(new URL(import.meta.url).pathname), "../..");
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

// --- Volatility Calculation ---

/**
 * Calculate annualized volatility from daily returns.
 * Uses 60-day lookback, scales to 252 trading days.
 */
export function calculateAnnualizedVolatility(bars: Bar[]): number {
  const lookback = Math.min(60, bars.length - 1);
  if (lookback < 10) return NaN;

  const closes = bars.slice(-lookback - 1).map((b) => b.c);
  const dailyReturns: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    dailyReturns.push((closes[i] - closes[i - 1]) / closes[i - 1]);
  }

  const mean = dailyReturns.reduce((a, b) => a + b, 0) / dailyReturns.length;
  const variance =
    dailyReturns.reduce((sum, r) => sum + (r - mean) ** 2, 0) /
    (dailyReturns.length - 1);
  const dailyVol = Math.sqrt(variance);

  // Annualize: daily_vol * sqrt(252)
  return dailyVol * Math.sqrt(252);
}

// --- Volatility Tiers ---

export interface VolatilityTier {
  label: string;
  maxAllocationPct: number;
  annualizedVol: number;
}

/**
 * Determine position size limit based on annualized volatility.
 * Higher volatility means smaller position to normalize risk.
 *
 * Tiers:
 *   < 15% vol → 6% max allocation (low vol, e.g. JNJ, KO)
 *   15-30%    → 5% max (moderate, e.g. AAPL, MSFT)
 *   30-50%    → 4% max (high vol, e.g. TSLA, AMD)
 *   > 50%     → 3% max (very high vol)
 */
export function getVolatilityTier(annualizedVol: number): VolatilityTier {
  if (annualizedVol < 0.15) {
    return { label: "LOW", maxAllocationPct: 6, annualizedVol };
  } else if (annualizedVol < 0.30) {
    return { label: "MODERATE", maxAllocationPct: 5, annualizedVol };
  } else if (annualizedVol < 0.50) {
    return { label: "HIGH", maxAllocationPct: 4, annualizedVol };
  } else {
    return { label: "VERY_HIGH", maxAllocationPct: 3, annualizedVol };
  }
}

// --- Correlation Matrix ---

/**
 * Compute Pearson correlation between two return series.
 */
function pearsonCorrelation(x: number[], y: number[]): number {
  const n = Math.min(x.length, y.length);
  if (n < 10) return 0;

  const xSlice = x.slice(-n);
  const ySlice = y.slice(-n);

  const meanX = xSlice.reduce((a, b) => a + b, 0) / n;
  const meanY = ySlice.reduce((a, b) => a + b, 0) / n;

  let covXY = 0;
  let varX = 0;
  let varY = 0;
  for (let i = 0; i < n; i++) {
    const dx = xSlice[i] - meanX;
    const dy = ySlice[i] - meanY;
    covXY += dx * dy;
    varX += dx * dx;
    varY += dy * dy;
  }

  const denom = Math.sqrt(varX * varY);
  if (denom === 0) return 0;
  return covXY / denom;
}

/**
 * Calculate daily returns from bars.
 */
function getDailyReturns(bars: Bar[]): number[] {
  const returns: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    returns.push((bars[i].c - bars[i - 1].c) / bars[i - 1].c);
  }
  return returns;
}

/**
 * Calculate correlation multiplier for a new position relative to existing holdings.
 *
 * avg_correlation > 0.8 → 0.65x (highly correlated — significant size reduction)
 * avg_correlation > 0.6 → 0.80x (moderately correlated)
 * avg_correlation > 0.4 → 0.90x (somewhat correlated)
 * avg_correlation <= 0.4 → 1.0x (diversified — no reduction)
 */
export async function calculateCorrelationMultiplier(
  candidateTicker: string,
  heldTickers: string[]
): Promise<{ multiplier: number; avgCorrelation: number; correlations: Record<string, number> }> {
  if (heldTickers.length === 0) {
    return { multiplier: 1.0, avgCorrelation: 0, correlations: {} };
  }

  let candidateBars: Bar[];
  try {
    candidateBars = await fetchBars(candidateTicker, 60);
    if (candidateBars.length < 20) {
      return { multiplier: 1.0, avgCorrelation: 0, correlations: {} };
    }
  } catch {
    return { multiplier: 1.0, avgCorrelation: 0, correlations: {} };
  }

  const candidateReturns = getDailyReturns(candidateBars);
  const correlations: Record<string, number> = {};

  const corrPromises = heldTickers.map(async (held) => {
    try {
      const heldBars = await fetchBars(held, 60);
      const heldReturns = getDailyReturns(heldBars);
      const corr = pearsonCorrelation(candidateReturns, heldReturns);
      return { ticker: held, corr };
    } catch {
      return { ticker: held, corr: 0 };
    }
  });

  const results = await Promise.allSettled(corrPromises);
  let totalCorr = 0;
  let count = 0;

  for (const result of results) {
    if (result.status === "fulfilled") {
      correlations[result.value.ticker] = +result.value.corr.toFixed(3);
      totalCorr += Math.abs(result.value.corr);
      count++;
    }
  }

  const avgCorrelation = count > 0 ? totalCorr / count : 0;

  let multiplier: number;
  if (avgCorrelation > 0.8) {
    multiplier = 0.65;
  } else if (avgCorrelation > 0.6) {
    multiplier = 0.80;
  } else if (avgCorrelation > 0.4) {
    multiplier = 0.90;
  } else {
    multiplier = 1.0;
  }

  return { multiplier: +multiplier.toFixed(2), avgCorrelation: +avgCorrelation.toFixed(3), correlations };
}

// --- Full Position Size Calculation ---

export interface PositionSizeResult {
  ticker: string;
  baseSizePct: number;
  volTierMax: number;
  volTierLabel: string;
  annualizedVol: number;
  correlationMultiplier: number;
  avgCorrelation: number;
  regimeMultiplier: number;
  finalSizePct: number;
  adjustments: string[];
}

/**
 * Calculate the final position size for a trade, applying:
 *   1. Volatility tier cap
 *   2. Correlation multiplier
 *   3. Market regime multiplier
 */
export async function calculatePositionSize(
  ticker: string,
  baseSizePct: number,
  regimeMultiplier: number,
  heldTickers: string[]
): Promise<PositionSizeResult> {
  const adjustments: string[] = [];

  // 1. Calculate volatility tier
  let volTier: VolatilityTier;
  let bars: Bar[];
  try {
    bars = await fetchBars(ticker, 90);
    const annVol = calculateAnnualizedVolatility(bars);
    volTier = getVolatilityTier(annVol);
  } catch {
    volTier = { label: "MODERATE", maxAllocationPct: 5, annualizedVol: 0.25 };
    adjustments.push("Vol calc failed — using MODERATE default");
  }

  // Cap at vol tier max
  let sizePct = Math.min(baseSizePct, volTier.maxAllocationPct);
  if (sizePct < baseSizePct) {
    adjustments.push(`Vol tier ${volTier.label} capped: ${baseSizePct}% → ${sizePct}%`);
  }

  // 2. Correlation adjustment
  const corrResult = await calculateCorrelationMultiplier(ticker, heldTickers);
  if (corrResult.multiplier < 1.0) {
    const before = sizePct;
    sizePct = +(sizePct * corrResult.multiplier).toFixed(1);
    adjustments.push(`Correlation adj (avg ${corrResult.avgCorrelation.toFixed(2)}): ${before}% → ${sizePct}%`);
  }

  // 3. Regime multiplier
  if (regimeMultiplier < 1.0) {
    const before = sizePct;
    sizePct = +(sizePct * regimeMultiplier).toFixed(1);
    adjustments.push(`Regime adj (${regimeMultiplier}x): ${before}% → ${sizePct}%`);
  }

  // Floor at 1%
  sizePct = Math.max(1, sizePct);

  return {
    ticker,
    baseSizePct,
    volTierMax: volTier.maxAllocationPct,
    volTierLabel: volTier.label,
    annualizedVol: volTier.annualizedVol,
    correlationMultiplier: corrResult.multiplier,
    avgCorrelation: corrResult.avgCorrelation,
    regimeMultiplier,
    finalSizePct: sizePct,
    adjustments,
  };
}

// --- CLI ---

if (import.meta.main) {
  const args = process.argv.slice(2);

  if (args.includes("--help")) {
    console.log(`
RiskManager - Volatility-Adjusted Position Sizing

Usage:
  bun RiskManager.ts --ticker AAPL                    # Single ticker vol analysis
  bun RiskManager.ts --portfolio AAPL,MSFT,NVDA       # Portfolio correlation check
  bun RiskManager.ts --size TSLA --held AAPL,MSFT     # Full position sizing

Options:
  --ticker AAPL     Analyze volatility for a single stock
  --portfolio X,Y   Show correlation matrix for portfolio
  --size TSLA       Calculate position size for a candidate
  --held X,Y        Current holdings (for correlation adjustment)
  --base 5          Base position size % (default: 5)
  --regime 1.0      Regime multiplier (default: 1.0)
`);
    process.exit(0);
  }

  const tickerIdx = args.indexOf("--ticker");
  const portfolioIdx = args.indexOf("--portfolio");
  const sizeIdx = args.indexOf("--size");
  const heldIdx = args.indexOf("--held");
  const baseIdx = args.indexOf("--base");
  const regimeIdx = args.indexOf("--regime");

  if (tickerIdx >= 0 && args[tickerIdx + 1]) {
    const ticker = args[tickerIdx + 1].toUpperCase();
    console.log(`Analyzing volatility for ${ticker}...`);
    const bars = await fetchBars(ticker, 90);
    const vol = calculateAnnualizedVolatility(bars);
    const tier = getVolatilityTier(vol);
    console.log(`\n${ticker} Volatility Analysis:`);
    console.log(`  Annualized Volatility: ${(vol * 100).toFixed(1)}%`);
    console.log(`  Tier: ${tier.label}`);
    console.log(`  Max Position: ${tier.maxAllocationPct}%`);
  }

  if (sizeIdx >= 0 && args[sizeIdx + 1]) {
    const ticker = args[sizeIdx + 1].toUpperCase();
    const held = heldIdx >= 0 && args[heldIdx + 1] ? args[heldIdx + 1].split(",").map(s => s.toUpperCase()) : [];
    const base = baseIdx >= 0 && args[baseIdx + 1] ? parseFloat(args[baseIdx + 1]) : 5;
    const regime = regimeIdx >= 0 && args[regimeIdx + 1] ? parseFloat(args[regimeIdx + 1]) : 1.0;

    console.log(`\nCalculating position size for ${ticker}...`);
    console.log(`  Base: ${base}% | Regime: ${regime}x | Held: ${held.join(", ") || "none"}`);

    const result = await calculatePositionSize(ticker, base, regime, held);
    console.log(`\nResult:`);
    console.log(`  Vol: ${(result.annualizedVol * 100).toFixed(1)}% (${result.volTierLabel})`);
    console.log(`  Vol Tier Cap: ${result.volTierMax}%`);
    console.log(`  Correlation Multiplier: ${result.correlationMultiplier}x (avg corr: ${result.avgCorrelation})`);
    console.log(`  Final Size: ${result.finalSizePct}%`);
    if (result.adjustments.length > 0) {
      console.log(`  Adjustments:`);
      for (const adj of result.adjustments) {
        console.log(`    - ${adj}`);
      }
    }
  }

  if (portfolioIdx >= 0 && args[portfolioIdx + 1]) {
    const tickers = args[portfolioIdx + 1].split(",").map(s => s.toUpperCase());
    console.log(`\nCorrelation Matrix for ${tickers.join(", ")}...`);

    const allBars: Record<string, Bar[]> = {};
    for (const t of tickers) {
      try {
        allBars[t] = await fetchBars(t, 60);
      } catch (e) {
        console.log(`  Could not fetch ${t}`);
      }
    }

    const allReturns: Record<string, number[]> = {};
    for (const [t, bars] of Object.entries(allBars)) {
      allReturns[t] = getDailyReturns(bars);
    }

    const validTickers = Object.keys(allReturns);
    const header = ["        ", ...validTickers.map(t => t.padStart(8))].join("");
    console.log(header);
    for (const t1 of validTickers) {
      const row = [t1.padEnd(8)];
      for (const t2 of validTickers) {
        if (t1 === t2) {
          row.push("   1.000");
        } else {
          const corr = pearsonCorrelation(allReturns[t1], allReturns[t2]);
          row.push(corr.toFixed(3).padStart(8));
        }
      }
      console.log(row.join(""));
    }
  }
}
