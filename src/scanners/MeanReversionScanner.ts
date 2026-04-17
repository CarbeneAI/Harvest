#!/usr/bin/env bun
/**
 * MeanReversionScanner.ts - Mean Reversion Signal Scanner
 *
 * Scans a curated universe of high-quality "moat" stocks and identifies
 * oversold conditions suitable for bounce trades.
 *
 * Entry Criteria (ALL must pass):
 *   - RSI < 35 OR Z-score < -2 (statistically oversold)
 *   - Price above 200 SMA (long-term uptrend intact)
 *   - Price at or near lower Bollinger Band (2 std dev, 20-day)
 *
 * Usage:
 *   bun src/scanners/MeanReversionScanner.ts          # Human-readable table
 *   bun src/scanners/MeanReversionScanner.ts --json   # JSON array output
 */

import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import {
  fetchBars,
  sma,
  computeRSI,
  computeATR,
  computeZScore,
  computeHurstExponent,
} from "../analysis/TechnicalAnalysis.js";

// Load .env
const PROJECT_ROOT = resolve(dirname(new URL(import.meta.url).pathname), "../..");

function loadEnv(): void {
  const envPath = resolve(PROJECT_ROOT, ".env");
  if (!existsSync(envPath)) return;
  const content = readFileSync(envPath, "utf-8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();
    if (key && !process.env[key]) {
      process.env[key] = value;
    }
  }
}

// --- Moat Universe ---
// Quality "moat" stocks with durable competitive advantages
const MOAT_UNIVERSE: Record<string, { type: string; label: string }> = {
  // Brand / Pricing Power
  AAPL: { type: "brand", label: "Brand + Ecosystem" },
  KO: { type: "brand", label: "Global Brand" },
  NKE: { type: "brand", label: "Brand + Distribution" },
  PG: { type: "brand", label: "Consumer Brands Portfolio" },
  COST: { type: "brand", label: "Brand + Membership Model" },
  // Network Effects
  V: { type: "network", label: "Payment Network" },
  MA: { type: "network", label: "Payment Network" },
  AMZN: { type: "network", label: "Marketplace + Cloud" },
  META: { type: "network", label: "Social Network" },
  GOOGL: { type: "network", label: "Search + Ad Network" },
  // Switching Costs
  MSFT: { type: "switching", label: "Enterprise Ecosystem" },
  CRM: { type: "switching", label: "Enterprise CRM" },
  ORCL: { type: "switching", label: "Enterprise Database" },
  ADBE: { type: "switching", label: "Creative Suite Lock-in" },
  // Cost Advantage
  WMT: { type: "cost", label: "Scale + Distribution" },
  UNH: { type: "cost", label: "Healthcare Scale" },
  // Regulatory Moat
  MCO: { type: "regulatory", label: "Credit Rating Oligopoly" },
  SPGI: { type: "regulatory", label: "Credit Rating + Data" },
  UNP: { type: "regulatory", label: "Railroad Monopoly" },
  NEE: { type: "regulatory", label: "Regulated Utility" },
};

// --- Types ---

export interface MeanReversionSignal {
  ticker: string;
  strategy: "mean_reversion";
  score: number;
  price: number;
  rsi: number;
  sma20: number;
  sma50: number;
  sma200: number;
  bollingerLower: number;
  bollingerUpper: number;
  atr: number;
  moatType: string;
  moatLabel: string;
  pctFromSMA20: number;
  pctAbove200SMA: number;
  zScore: number;
  hurstExponent: number;
  suggestedStop: number;
  suggestedTarget: number;
  thesis: string;
}

// --- Indicators ---

function bollingerBands(
  closes: number[],
  period: number = 20
): { upper: number; middle: number; lower: number; stddev: number } {
  const mid = sma(closes, period);
  if (isNaN(mid)) return { upper: NaN, middle: NaN, lower: NaN, stddev: NaN };
  const slice = closes.slice(-period);
  const mean = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((sum, v) => sum + (v - mean) ** 2, 0) / period;
  const stddev = Math.sqrt(variance);
  return { upper: mid + 2 * stddev, middle: mid, lower: mid - 2 * stddev, stddev };
}

// --- Scoring ---

function computeScore(
  rsi: number,
  price: number,
  bollingerLower: number,
  sma200: number,
  moatType: string,
  zScore: number = 0,
  hurstExp: number = NaN
): number {
  const rsiMax = 35;
  const rsiMin = 15;
  const rsiComponent = Math.min(0.25, Math.max(0, ((rsiMax - rsi) / (rsiMax - rsiMin)) * 0.25));

  const pctBelowBand = (bollingerLower - price) / bollingerLower;
  const bbComponent = Math.min(0.20, Math.max(0, (pctBelowBand / 0.05) * 0.20));

  const pctAbove200 = (price - sma200) / sma200;
  const smaComponent = Math.min(0.15, Math.max(0, (1 - pctAbove200 / 0.20) * 0.15));

  const zComponent = Math.min(0.20, Math.max(0, (Math.abs(Math.min(0, zScore)) / 3) * 0.20));

  let hurstComponent = 0;
  if (!isNaN(hurstExp) && hurstExp < 0.50) {
    hurstComponent = Math.min(0.15, ((0.50 - hurstExp) / 0.25) * 0.15);
  }

  const moatBonus = moatType === "brand" || moatType === "network" ? 0.05 : 0;

  return Math.min(1, rsiComponent + bbComponent + smaComponent + zComponent + hurstComponent + moatBonus);
}

// --- Scanner ---

async function analyzeStock(
  ticker: string,
  moat: { type: string; label: string }
): Promise<MeanReversionSignal | null> {
  try {
    const bars = await fetchBars(ticker, 320);

    if (bars.length < 200) {
      console.error(`[MeanReversion] ${ticker}: insufficient bars (${bars.length} < 200), skipping`);
      return null;
    }

    const closes = bars.map((b) => b.c);
    const lastBar = bars[bars.length - 1];
    const price = lastBar.c;

    const rsi = computeRSI(closes, 14);
    const sma20Val = sma(closes, 20);
    const sma50Val = sma(closes, 50);
    const sma200Val = sma(closes, 200);
    const atr = computeATR(bars, 14);
    const bb = bollingerBands(closes, 20);

    if (isNaN(rsi) || isNaN(sma20Val) || isNaN(sma50Val) || isNaN(sma200Val) || isNaN(atr) || isNaN(bb.lower)) {
      console.error(`[MeanReversion] ${ticker}: NaN indicators, skipping`);
      return null;
    }

    const zScore = computeZScore(closes, 50);
    const hurstExp = computeHurstExponent(closes);

    const isAbove200SMA = price > sma200Val;
    const isOversoldRSI = rsi < 35;
    const isOversoldZScore = !isNaN(zScore) && zScore < -2;
    const isOversold = isOversoldRSI || isOversoldZScore;
    const isNearLowerBand = price <= bb.lower * 1.01;

    if (!isOversold || !isAbove200SMA || !isNearLowerBand) {
      console.error(
        `[MeanReversion] ${ticker}: no signal (RSI=${rsi.toFixed(1)}, Z=${zScore.toFixed(2)}, above200=${isAbove200SMA}, nearBB=${isNearLowerBand})`
      );
      return null;
    }

    const score = computeScore(rsi, price, bb.lower, sma200Val, moat.type, zScore, hurstExp);
    const pctFromSMA20 = ((price - sma20Val) / sma20Val) * 100;
    const pctAbove200SMA = ((price - sma200Val) / sma200Val) * 100;

    const suggestedStop = sma200Val * 0.98;
    const suggestedTarget = sma20Val;

    const riskAmt = price - suggestedStop;
    const rewardAmt = suggestedTarget - price;
    const rrRatio = rewardAmt > 0 && riskAmt > 0 ? (rewardAmt / riskAmt).toFixed(1) : "N/A";

    const hurstLabel = !isNaN(hurstExp) && hurstExp < 0.45
      ? ` Hurst ${hurstExp.toFixed(2)} confirms mean-reverting behavior.`
      : "";
    const zScoreLabel = !isNaN(zScore) && zScore < -1.5
      ? ` Z-score ${zScore.toFixed(2)} (statistically oversold).`
      : "";

    const thesis =
      `${ticker} (${moat.label}) oversold at RSI ${rsi.toFixed(1)} while holding above 200 SMA ` +
      `($${sma200Val.toFixed(2)}). Price $${price.toFixed(2)} touched lower Bollinger Band ` +
      `($${bb.lower.toFixed(2)}).${zScoreLabel}${hurstLabel} Mean reversion target: 20 SMA at $${sma20Val.toFixed(2)} ` +
      `(+${rewardAmt.toFixed(2)}, ${((rewardAmt / price) * 100).toFixed(1)}%). ` +
      `Stop below 200 SMA: $${suggestedStop.toFixed(2)} (R:R ${rrRatio}).`;

    return {
      ticker,
      strategy: "mean_reversion",
      score,
      price,
      rsi,
      sma20: sma20Val,
      sma50: sma50Val,
      sma200: sma200Val,
      bollingerLower: bb.lower,
      bollingerUpper: bb.upper,
      atr,
      moatType: moat.type,
      moatLabel: moat.label,
      pctFromSMA20,
      pctAbove200SMA,
      zScore: zScore || 0,
      hurstExponent: hurstExp || 0,
      suggestedStop,
      suggestedTarget,
      thesis,
    };
  } catch (err: any) {
    console.error(`[MeanReversion] ${ticker}: error - ${err.message || String(err)}`);
    return null;
  }
}

export async function scanMeanReversion(): Promise<MeanReversionSignal[]> {
  const tickers = Object.keys(MOAT_UNIVERSE);
  console.error(`[MeanReversion] Scanning ${tickers.length} moat stocks...`);

  const results = await Promise.allSettled(
    tickers.map((ticker) => analyzeStock(ticker, MOAT_UNIVERSE[ticker]))
  );

  const signals: MeanReversionSignal[] = [];
  for (const result of results) {
    if (result.status === "fulfilled" && result.value !== null) {
      signals.push(result.value);
    }
  }

  signals.sort((a, b) => b.score - a.score);

  console.error(`[MeanReversion] Found ${signals.length} mean reversion signal(s)`);
  return signals;
}

// --- CLI ---

function formatTable(signals: MeanReversionSignal[]): string {
  if (signals.length === 0) {
    return "No mean reversion signals found in the moat universe today.";
  }

  const lines: string[] = [];
  lines.push("=".repeat(100));
  lines.push("MEAN REVERSION SCANNER - MOAT UNIVERSE");
  lines.push(`${signals.length} signal(s) found`);
  lines.push("=".repeat(100));

  for (const s of signals) {
    lines.push("");
    lines.push(
      `${s.ticker.padEnd(6)} | Score: ${(s.score * 100).toFixed(0).padStart(3)}% | ` +
        `${s.moatType.toUpperCase().padEnd(10)} | ${s.moatLabel}`
    );
    lines.push("-".repeat(100));
    lines.push(
      `  Price:        $${s.price.toFixed(2).padStart(8)}   ` +
        `RSI(14):    ${s.rsi.toFixed(1).padStart(5)}   ` +
        `ATR(14):   $${s.atr.toFixed(2)}`
    );
    lines.push(
      `  SMA 20:       $${s.sma20.toFixed(2).padStart(8)}   ` +
        `SMA 50:    $${s.sma50.toFixed(2).padStart(8)}   ` +
        `SMA 200:   $${s.sma200.toFixed(2)}`
    );
    lines.push(
      `  BB Lower:     $${s.bollingerLower.toFixed(2).padStart(8)}   ` +
        `BB Upper:  $${s.bollingerUpper.toFixed(2).padStart(8)}   ` +
        `From SMA20: ${s.pctFromSMA20.toFixed(1)}%`
    );
    lines.push(
      `  Above 200SMA: ${s.pctAbove200SMA.toFixed(1).padStart(5)}%         ` +
        `Stop:      $${s.suggestedStop.toFixed(2).padStart(8)}   ` +
        `Target:    $${s.suggestedTarget.toFixed(2)}`
    );
    lines.push("");
    lines.push(`  THESIS: ${s.thesis}`);
  }

  lines.push("");
  lines.push("=".repeat(100));
  return lines.join("\n");
}

if (import.meta.main) {
  loadEnv();

  const args = process.argv.slice(2);
  const jsonOutput = args.includes("--json");

  try {
    const signals = await scanMeanReversion();

    if (jsonOutput) {
      console.log(JSON.stringify(signals, null, 2));
    } else {
      console.log(formatTable(signals));
    }
  } catch (err: any) {
    console.error(`[MeanReversion] Fatal error: ${err.message || String(err)}`);
    process.exit(1);
  }
}
