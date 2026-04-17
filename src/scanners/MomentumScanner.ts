#!/usr/bin/env bun
/**
 * MomentumScanner.ts - Momentum Signal Scanner
 *
 * Scans a universe of ~80 liquid large-cap stocks and identifies those with
 * strong bullish momentum setups suitable for swing/position trading.
 *
 * Entry Criteria (ALL must pass):
 *   - Price > 20 SMA > 50 SMA (confirmed uptrend)
 *   - RSI between 40 and 70 (momentum, not overbought)
 *   - MACD histogram > 0 (bullish momentum)
 *   - Volume ratio > 1.0 (at least average volume)
 *   - Price within 15% of 90-day high (not in deep pullback)
 *   - ADX > 20 (confirmed trend strength)
 *
 * Usage:
 *   bun src/scanners/MomentumScanner.ts            # Table output (top 15)
 *   bun src/scanners/MomentumScanner.ts --json     # JSON output
 */

import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import {
  fetchBars,
  sma,
  computeRSI,
  computeMACD,
  computeATR,
  computeADX,
  computeMultiTimeframeMomentum,
} from "../analysis/TechnicalAnalysis.js";

// Load .env
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

// --- Universe ---
const MOMENTUM_UNIVERSE = [
  // Technology
  "AAPL", "MSFT", "NVDA", "AVGO", "ORCL", "CRM", "ADBE", "AMD", "INTC", "CSCO",
  "QCOM", "TXN", "AMAT", "NOW", "PLTR", "PANW", "CRWD",
  // Communication
  "GOOGL", "META", "NFLX", "DIS", "CMCSA", "T", "VZ", "TMUS",
  // Consumer Discretionary
  "AMZN", "TSLA", "HD", "MCD", "NKE", "SBUX", "TJX", "LOW", "COST", "WMT",
  // Financial
  "JPM", "V", "MA", "BAC", "GS", "MS", "BLK", "AXP", "SCHW",
  // Healthcare
  "UNH", "JNJ", "LLY", "PFE", "ABBV", "MRK", "TMO", "ABT", "DHR",
  // Industrial
  "CAT", "DE", "HON", "GE", "RTX", "LMT", "BA", "UPS", "UNP",
  // Energy
  "XOM", "CVX", "COP", "SLB", "EOG", "MPC",
  // Materials
  "LIN", "APD", "FCX", "NEM",
  // Consumer Staples
  "PG", "KO", "PEP", "PM", "CL",
  // Utilities
  "NEE", "DUK", "SO",
  // REITs
  "AMT", "PLD", "CCI",
];

// --- Types ---
export interface MomentumSignal {
  ticker: string;
  strategy: "momentum";
  score: number;
  price: number;
  rsi: number;
  macdHistogram: number;
  sma20: number;
  sma50: number;
  atr: number;
  volumeRatio: number;
  highProximity: number;
  trendStrength: number;
  adx: number;
  multiMomentum: number;
  suggestedStop: number;
  suggestedTarget: number;
  thesis: string;
}

// --- Scoring ---

function scoreRSI(rsi: number): number {
  const optimal = 60;
  const halfWindow = 15;
  const distFromOptimal = Math.abs(rsi - optimal);
  return Math.max(0, 1 - distFromOptimal / halfWindow);
}

function scoreMACDHistogram(histogram: number): number {
  if (histogram <= 0) return 0;
  return Math.min(1, histogram / 1.0);
}

function scoreVolumeRatio(ratio: number): number {
  const cappedRatio = Math.min(ratio, 3.0);
  return cappedRatio / 3.0;
}

function scoreHighProximity(proximityPct: number): number {
  return Math.max(0, 1 - proximityPct / 15);
}

function scoreTrendStrength(trendPct: number): number {
  if (trendPct <= 0) return 0;
  return Math.min(1, trendPct / 10);
}

function scoreADX(adx: number): number {
  if (isNaN(adx) || adx < 15) return 0;
  return Math.min(1, (adx - 15) / 35);
}

function scoreMultiMomentum(composite: number): number {
  if (composite <= 0) return 0;
  return Math.min(1, composite / 0.10);
}

function computeScore(
  rsi: number,
  macdHistogram: number,
  volumeRatio: number,
  highProximity: number,
  trendStrength: number,
  adx: number = NaN,
  multiMomentum: number = 0
): number {
  const weights = {
    rsi: 0.15,
    macd: 0.15,
    volume: 0.15,
    proximity: 0.10,
    trend: 0.10,
    adx: 0.15,
    multiMom: 0.20,
  };

  const components = {
    rsi: scoreRSI(rsi),
    macd: scoreMACDHistogram(macdHistogram),
    volume: scoreVolumeRatio(volumeRatio),
    proximity: scoreHighProximity(highProximity),
    trend: scoreTrendStrength(trendStrength),
    adx: scoreADX(adx),
    multiMom: scoreMultiMomentum(multiMomentum),
  };

  return (
    components.rsi * weights.rsi +
    components.macd * weights.macd +
    components.volume * weights.volume +
    components.proximity * weights.proximity +
    components.trend * weights.trend +
    components.adx * weights.adx +
    components.multiMom * weights.multiMom
  );
}

function buildThesis(
  ticker: string,
  price: number,
  rsi: number,
  macdHistogram: number,
  volumeRatio: number,
  highProximity: number,
  trendStrength: number,
  sma20: number,
  sma50: number
): string {
  const parts: string[] = [];

  parts.push(`${ticker} is in a confirmed uptrend (price $${price.toFixed(2)} > SMA20 $${sma20.toFixed(2)} > SMA50 $${sma50.toFixed(2)}).`);

  if (rsi >= 55 && rsi <= 65) {
    parts.push(`RSI ${rsi.toFixed(1)} is in the optimal momentum zone (55-65).`);
  } else if (rsi > 65) {
    parts.push(`RSI ${rsi.toFixed(1)} shows strong momentum, approaching but not overbought.`);
  } else {
    parts.push(`RSI ${rsi.toFixed(1)} shows early momentum building from a lower base.`);
  }

  if (macdHistogram > 0.5) {
    parts.push(`MACD histogram ${macdHistogram.toFixed(3)} is strongly positive, indicating solid bullish momentum.`);
  } else {
    parts.push(`MACD histogram ${macdHistogram.toFixed(3)} is positive, indicating bullish momentum.`);
  }

  if (volumeRatio >= 1.5) {
    parts.push(`Volume is elevated at ${volumeRatio.toFixed(1)}x the 20-day average, showing strong conviction.`);
  } else {
    parts.push(`Volume at ${volumeRatio.toFixed(1)}x average supports the move.`);
  }

  parts.push(`Price is ${highProximity.toFixed(1)}% below the 90-day high and ${trendStrength.toFixed(1)}% above the 50 SMA.`);

  return parts.join(" ");
}

// --- Core Scan ---

async function scanTicker(ticker: string): Promise<MomentumSignal | null> {
  try {
    const bars = await fetchBars(ticker, 180);

    if (bars.length < 55) {
      console.error(`[MomentumScanner] ${ticker}: insufficient data (${bars.length} bars)`);
      return null;
    }

    const closes = bars.map((b) => b.c);
    const volumes = bars.map((b) => b.v);
    const lastBar = bars[bars.length - 1];
    const price = lastBar.c;

    const rsi = computeRSI(closes, 14);
    const macdResult = computeMACD(closes);
    const macdHistogram = macdResult.histogram;
    const sma20 = sma(closes, 20);
    const sma50 = sma(closes, 50);
    const atr = computeATR(bars, 14);
    const volumeAvg20 = sma(volumes, 20);
    const volumeLatest = lastBar.v;
    const volumeRatio = volumeAvg20 > 0 ? volumeLatest / volumeAvg20 : 0;
    const adx = computeADX(bars, 14);
    const mtfMom = computeMultiTimeframeMomentum(closes);

    const recentCloses = closes.slice(-90);
    const highestClose = Math.max(...recentCloses);
    const highProximity = ((highestClose - price) / highestClose) * 100;
    const trendStrength = sma50 > 0 ? ((price - sma50) / sma50) * 100 : 0;

    if (isNaN(rsi) || isNaN(macdHistogram) || isNaN(sma20) || isNaN(sma50) || isNaN(atr)) {
      console.error(`[MomentumScanner] ${ticker}: NaN in indicators, skipping`);
      return null;
    }

    // Entry criteria
    if (!(price > sma20 && sma20 > sma50)) return null;
    if (rsi < 40 || rsi > 70) return null;
    if (macdHistogram <= 0) return null;
    if (volumeRatio <= 1.0) return null;
    if (highProximity > 15) return null;
    if (!isNaN(adx) && adx < 20) {
      console.error(`[MomentumScanner] ${ticker}: weak trend (ADX ${adx.toFixed(1)} < 20), skipping`);
      return null;
    }

    const multiMomentum = mtfMom?.composite || 0;
    const score = computeScore(rsi, macdHistogram, volumeRatio, highProximity, trendStrength, adx, multiMomentum);

    const suggestedStop = price - 2 * atr;
    const suggestedTarget = price + 3 * atr;

    const thesis = buildThesis(ticker, price, rsi, macdHistogram, volumeRatio, highProximity, trendStrength, sma20, sma50)
      + (adx > 25 ? ` ADX ${adx.toFixed(0)} confirms strong trend.` : "")
      + (mtfMom ? ` Multi-TF momentum: 1m ${(mtfMom.mom1m * 100).toFixed(1)}%, 3m ${(mtfMom.mom3m * 100).toFixed(1)}%, 6m ${(mtfMom.mom6m * 100).toFixed(1)}%.` : "");

    return {
      ticker,
      strategy: "momentum",
      score,
      price,
      rsi,
      macdHistogram,
      sma20,
      sma50,
      atr,
      volumeRatio,
      highProximity,
      trendStrength,
      adx: adx || 0,
      multiMomentum,
      suggestedStop,
      suggestedTarget,
      thesis,
    };
  } catch (err: any) {
    console.error(`[MomentumScanner] ${ticker}: error - ${err.message || String(err)}`);
    return null;
  }
}

// --- Exported scan function ---

export async function scanMomentum(): Promise<MomentumSignal[]> {
  const BATCH_SIZE = 10;
  const BATCH_DELAY_MS = 500;
  const signals: MomentumSignal[] = [];

  const tickers = [...MOMENTUM_UNIVERSE];
  const batches: string[][] = [];
  for (let i = 0; i < tickers.length; i += BATCH_SIZE) {
    batches.push(tickers.slice(i, i + BATCH_SIZE));
  }

  console.error(`[MomentumScanner] Scanning ${tickers.length} tickers in ${batches.length} batches of ${BATCH_SIZE}...`);

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    console.error(`[MomentumScanner] Batch ${i + 1}/${batches.length}: ${batch.join(", ")}`);

    const results = await Promise.allSettled(batch.map((ticker) => scanTicker(ticker)));

    for (const result of results) {
      if (result.status === "fulfilled" && result.value !== null) {
        signals.push(result.value);
      }
    }

    if (i < batches.length - 1) {
      await new Promise((res) => setTimeout(res, BATCH_DELAY_MS));
    }
  }

  signals.sort((a, b) => b.score - a.score);
  const top15 = signals.slice(0, 15);

  console.error(`[MomentumScanner] Scan complete. ${signals.length} signals found, returning top ${top15.length}.`);

  return top15;
}

// --- CLI ---

function printTable(signals: MomentumSignal[]): void {
  if (signals.length === 0) {
    console.log("No momentum signals found.");
    return;
  }

  const header = ["Rank", "Ticker", "Score", "Price", "RSI", "MACD Hist", "Vol Ratio", "% vs High", "Trend Str", "Stop", "Target"];

  const rows = signals.map((s, i) => [
    String(i + 1),
    s.ticker,
    s.score.toFixed(3),
    `$${s.price.toFixed(2)}`,
    s.rsi.toFixed(1),
    s.macdHistogram.toFixed(4),
    `${s.volumeRatio.toFixed(2)}x`,
    `-${s.highProximity.toFixed(1)}%`,
    `+${s.trendStrength.toFixed(1)}%`,
    `$${s.suggestedStop.toFixed(2)}`,
    `$${s.suggestedTarget.toFixed(2)}`,
  ]);

  const colWidths = header.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => r[i].length))
  );

  const divider = colWidths.map((w) => "-".repeat(w + 2)).join("+");
  const formatRow = (cells: string[]) =>
    cells.map((c, i) => ` ${c.padEnd(colWidths[i])} `).join("|");

  console.log(`\nMomentum Scanner Results - ${new Date().toISOString().slice(0, 10)}`);
  console.log(`${signals.length} signal(s) passing all criteria\n`);
  console.log(divider);
  console.log(formatRow(header));
  console.log(divider);
  for (const row of rows) {
    console.log(formatRow(row));
  }
  console.log(divider);

  console.log("\nSignal Theses:");
  for (let i = 0; i < signals.length; i++) {
    const s = signals[i];
    console.log(`\n${i + 1}. ${s.ticker} (score: ${s.score.toFixed(3)})`);
    console.log(`   ${s.thesis}`);
    console.log(`   Stop: $${s.suggestedStop.toFixed(2)} | Target: $${s.suggestedTarget.toFixed(2)} | ATR: $${s.atr.toFixed(2)}`);
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const jsonMode = args.includes("--json");

  console.error(`[MomentumScanner] Starting momentum scan (${MOMENTUM_UNIVERSE.length} tickers)...`);

  const signals = await scanMomentum();

  if (jsonMode) {
    console.log(JSON.stringify(signals, null, 2));
  } else {
    printTable(signals);
  }
}
