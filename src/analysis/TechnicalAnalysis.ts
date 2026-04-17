#!/usr/bin/env bun
/**
 * TechnicalAnalysis.ts - Technical Indicator Library
 *
 * Fetches daily price/volume data from Alpaca Markets API and computes
 * technical indicators for swing trading strategies:
 *   - SMA / EMA
 *   - RSI (14-day)
 *   - MACD (12/26/9)
 *   - ATR (14-day) for volatility / stop placement
 *   - ADX (trend strength filter)
 *   - Hurst Exponent (mean-reversion detection)
 *   - Z-Score (statistical oversold detection)
 *   - Multi-Timeframe Momentum (1m/3m/6m weighted composite)
 *
 * Usage:
 *   bun src/analysis/TechnicalAnalysis.ts --ticker AAPL
 */

import { readFileSync, existsSync } from "fs";
import { join, resolve } from "path";

const PROJECT_ROOT = resolve(import.meta.dir, "../..");

function loadAlpacaKeys(): { key: string; secret: string } {
  const paths = [
    join(PROJECT_ROOT, ".env"),
    join(process.env.HOME || "", ".env"),
  ].filter(Boolean);
  let key = process.env.ALPACA_API_KEY || "";
  let secret = process.env.ALPACA_API_SECRET || "";
  if (!key || !secret) {
    for (const p of paths) {
      if (existsSync(p)) {
        const content = readFileSync(p, "utf-8");
        const km = content.match(/^ALPACA_API_KEY=(.+)$/m);
        const sm = content.match(/^ALPACA_API_SECRET=(.+)$/m);
        if (km) key = km[1].trim();
        if (sm) secret = sm[1].trim();
        if (key && secret) break;
      }
    }
  }
  if (!key || !secret) throw new Error("ALPACA_API_KEY/SECRET not found in .env");
  return { key, secret };
}

export interface Bar {
  t: string; // timestamp
  o: number; // open
  h: number; // high
  l: number; // low
  c: number; // close
  v: number; // volume
}

export async function fetchBars(ticker: string, days: number = 90): Promise<Bar[]> {
  const { key, secret } = loadAlpacaKeys();
  const end = new Date();
  // 1.5x multiplier to convert trading days to calendar days (weekends, holidays)
  const calendarDays = Math.ceil(days * 1.5);
  const start = new Date(end.getTime() - calendarDays * 24 * 60 * 60 * 1000);

  const url = `https://data.alpaca.markets/v2/stocks/${ticker}/bars?timeframe=1Day&start=${start.toISOString().slice(0, 10)}&limit=${days + 10}`;
  const resp = await fetch(url, {
    headers: {
      "APCA-API-KEY-ID": key,
      "APCA-API-SECRET-KEY": secret,
    },
  });

  if (!resp.ok) throw new Error(`Alpaca ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  const data = await resp.json();
  return (data.bars || []).map((b: any) => ({
    t: b.t,
    o: b.o,
    h: b.h,
    l: b.l,
    c: b.c,
    v: b.v,
  }));
}

// --- Indicator Calculations ---

export function sma(values: number[], period: number): number {
  if (values.length < period) return NaN;
  const slice = values.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

export function ema(values: number[], period: number): number[] {
  const result: number[] = [];
  const k = 2 / (period + 1);
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = 0; i < period; i++) result.push(NaN);
  result[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    result.push(prev);
  }
  return result;
}

export function computeRSI(closes: number[], period: number = 14): number {
  if (closes.length < period + 1) return NaN;
  const changes = closes.slice(1).map((c, i) => c - closes[i]);
  const recent = changes.slice(-period);

  let avgGain = 0;
  let avgLoss = 0;
  for (const ch of recent) {
    if (ch > 0) avgGain += ch;
    else avgLoss += Math.abs(ch);
  }
  avgGain /= period;
  avgLoss /= period;

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

export function computeMACD(closes: number[]): { macd: number; signal: number; histogram: number } {
  if (closes.length < 35) return { macd: NaN, signal: NaN, histogram: NaN };

  const ema12 = ema(closes, 12);
  const ema26 = ema(closes, 26);

  const macdLine: number[] = [];
  for (let i = 0; i < closes.length; i++) {
    if (isNaN(ema12[i]) || isNaN(ema26[i])) {
      macdLine.push(NaN);
    } else {
      macdLine.push(ema12[i] - ema26[i]);
    }
  }

  const validMacd = macdLine.filter((v) => !isNaN(v));
  const signalLine = ema(validMacd, 9);

  const currentMacd = validMacd[validMacd.length - 1] || NaN;
  const currentSignal = signalLine[signalLine.length - 1] || NaN;

  return {
    macd: currentMacd,
    signal: currentSignal,
    histogram: currentMacd - currentSignal,
  };
}

export function computeATR(bars: Bar[], period: number = 14): number {
  if (bars.length < period + 1) return NaN;
  const trs: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const tr = Math.max(
      bars[i].h - bars[i].l,
      Math.abs(bars[i].h - bars[i - 1].c),
      Math.abs(bars[i].l - bars[i - 1].c)
    );
    trs.push(tr);
  }
  return sma(trs, period);
}

/**
 * Average Directional Index (ADX) - measures trend strength.
 * ADX > 25 = strong trend, < 20 = weak/no trend.
 * Prevents trading choppy sideways markets.
 */
export function computeADX(bars: Bar[], period: number = 14): number {
  if (bars.length < period * 2 + 1) return NaN;

  const plusDM: number[] = [];
  const minusDM: number[] = [];
  const trueRange: number[] = [];

  for (let i = 1; i < bars.length; i++) {
    const upMove = bars[i].h - bars[i - 1].h;
    const downMove = bars[i - 1].l - bars[i].l;

    plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0);

    const tr = Math.max(
      bars[i].h - bars[i].l,
      Math.abs(bars[i].h - bars[i - 1].c),
      Math.abs(bars[i].l - bars[i - 1].c)
    );
    trueRange.push(tr);
  }

  // Wilder's smoothing
  const smooth = (arr: number[], p: number): number[] => {
    const result: number[] = [];
    let sum = arr.slice(0, p).reduce((a, b) => a + b, 0);
    result.push(sum);
    for (let i = p; i < arr.length; i++) {
      sum = sum - sum / p + arr[i];
      result.push(sum);
    }
    return result;
  };

  const smoothedTR = smooth(trueRange, period);
  const smoothedPlusDM = smooth(plusDM, period);
  const smoothedMinusDM = smooth(minusDM, period);

  const n = Math.min(smoothedTR.length, smoothedPlusDM.length, smoothedMinusDM.length);
  const dx: number[] = [];

  for (let i = 0; i < n; i++) {
    if (smoothedTR[i] === 0) { dx.push(0); continue; }
    const plusDI = (smoothedPlusDM[i] / smoothedTR[i]) * 100;
    const minusDI = (smoothedMinusDM[i] / smoothedTR[i]) * 100;
    const diSum = plusDI + minusDI;
    dx.push(diSum === 0 ? 0 : (Math.abs(plusDI - minusDI) / diSum) * 100);
  }

  if (dx.length < period) return NaN;

  let adx = dx.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < dx.length; i++) {
    adx = (adx * (period - 1) + dx[i]) / period;
  }

  return adx;
}

/**
 * Hurst Exponent - determines if a series is trending or mean-reverting.
 * H < 0.5 = mean-reverting (good for mean reversion strategy)
 * H = 0.5 = random walk
 * H > 0.5 = trending (good for momentum strategy)
 *
 * Uses rescaled range (R/S) analysis.
 */
export function computeHurstExponent(closes: number[], maxLag: number = 20): number {
  if (closes.length < maxLag * 2) return NaN;

  const lags: number[] = [];
  const logRS: number[] = [];

  for (let lag = 10; lag <= maxLag; lag++) {
    const nChunks = Math.floor(closes.length / lag);
    if (nChunks < 2) continue;

    const rsValues: number[] = [];

    for (let chunk = 0; chunk < nChunks; chunk++) {
      const start = chunk * lag;
      const end = start + lag;
      const slice = closes.slice(start, end);

      const returns: number[] = [];
      for (let i = 1; i < slice.length; i++) {
        returns.push(slice[i] / slice[i - 1] - 1);
      }
      if (returns.length === 0) continue;

      const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
      const deviations = returns.map((r) => r - mean);

      const cumDev: number[] = [];
      let cumSum = 0;
      for (const d of deviations) {
        cumSum += d;
        cumDev.push(cumSum);
      }

      const range = Math.max(...cumDev) - Math.min(...cumDev);
      const std = Math.sqrt(
        deviations.reduce((sum, d) => sum + d * d, 0) / deviations.length
      );

      if (std > 0) {
        rsValues.push(range / std);
      }
    }

    if (rsValues.length > 0) {
      const avgRS = rsValues.reduce((a, b) => a + b, 0) / rsValues.length;
      if (avgRS > 0) {
        lags.push(Math.log(lag));
        logRS.push(Math.log(avgRS));
      }
    }
  }

  if (lags.length < 3) return NaN;

  const n = lags.length;
  const sumX = lags.reduce((a, b) => a + b, 0);
  const sumY = logRS.reduce((a, b) => a + b, 0);
  const sumXY = lags.reduce((sum, x, i) => sum + x * logRS[i], 0);
  const sumXX = lags.reduce((sum, x) => sum + x * x, 0);

  const slope = (n * sumXY - sumX * sumY) / (n * sumXX - sumX * sumX);
  return Math.max(0, Math.min(1, slope));
}

/**
 * Z-Score for mean reversion entry.
 * z = (price - MA) / stddev
 * z < -2 = statistically significant oversold
 */
export function computeZScore(closes: number[], period: number = 50): number {
  if (closes.length < period) return NaN;

  const slice = closes.slice(-period);
  const mean = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((sum, v) => sum + (v - mean) ** 2, 0) / period;
  const std = Math.sqrt(variance);

  if (std === 0) return 0;
  return (closes[closes.length - 1] - mean) / std;
}

/**
 * Multi-timeframe momentum: weighted combination of 1-month, 3-month, 6-month returns.
 * Based on Jegadeesh-Titman academic research.
 * Weights: 1-month (40%), 3-month (30%), 6-month (30%)
 */
export function computeMultiTimeframeMomentum(closes: number[]): {
  composite: number;
  mom1m: number;
  mom3m: number;
  mom6m: number;
} | null {
  const mom1mBars = 21;   // ~1 month
  const mom3mBars = 63;   // ~3 months
  const mom6mBars = 126;  // ~6 months

  const current = closes[closes.length - 1];
  if (!current) return null;

  const mom1m = closes.length >= mom1mBars + 1
    ? (current - closes[closes.length - 1 - mom1mBars]) / closes[closes.length - 1 - mom1mBars]
    : NaN;

  const mom3m = closes.length >= mom3mBars + 1
    ? (current - closes[closes.length - 1 - mom3mBars]) / closes[closes.length - 1 - mom3mBars]
    : NaN;

  const mom6m = closes.length >= mom6mBars + 1
    ? (current - closes[closes.length - 1 - mom6mBars]) / closes[closes.length - 1 - mom6mBars]
    : NaN;

  let composite = 0;
  let totalWeight = 0;

  if (!isNaN(mom1m)) { composite += 0.4 * mom1m; totalWeight += 0.4; }
  if (!isNaN(mom3m)) { composite += 0.3 * mom3m; totalWeight += 0.3; }
  if (!isNaN(mom6m)) { composite += 0.3 * mom6m; totalWeight += 0.3; }

  if (totalWeight > 0) {
    composite /= totalWeight;
  }

  return {
    composite,
    mom1m: isNaN(mom1m) ? 0 : mom1m,
    mom3m: isNaN(mom3m) ? 0 : mom3m,
    mom6m: isNaN(mom6m) ? 0 : mom6m,
  };
}

function findSupportResistance(bars: Bar[]): { support: number; resistance: number } {
  const recent = bars.slice(-20);
  const lows = recent.map((b) => b.l);
  const highs = recent.map((b) => b.h);
  return {
    support: Math.min(...lows),
    resistance: Math.max(...highs),
  };
}

// --- Main Analysis ---

export interface TechnicalResult {
  ticker: string;
  lastPrice: number;
  lastDate: string;
  rsi14: number;
  macd: { macd: number; signal: number; histogram: number };
  sma20: number;
  sma50: number;
  atr14: number;
  volumeAvg20: number;
  volumeLatest: number;
  volumeRatio: number;
  support: number;
  resistance: number;
  signals: string[];
  summary: string;
  status: "complete" | "error";
  error?: string;
}

export async function runTechnicalAnalysis(ticker: string): Promise<TechnicalResult> {
  const normalizedTicker = ticker.toUpperCase();

  try {
    const bars = await fetchBars(normalizedTicker, 90);
    if (bars.length < 30) {
      return {
        ticker: normalizedTicker,
        lastPrice: 0, lastDate: "", rsi14: NaN,
        macd: { macd: NaN, signal: NaN, histogram: NaN },
        sma20: NaN, sma50: NaN, atr14: NaN,
        volumeAvg20: 0, volumeLatest: 0, volumeRatio: 0,
        support: 0, resistance: 0, signals: [],
        summary: `Insufficient data: only ${bars.length} bars available (need 30+).`,
        status: "error", error: "Insufficient data",
      };
    }

    const closes = bars.map((b) => b.c);
    const volumes = bars.map((b) => b.v);
    const lastBar = bars[bars.length - 1];

    const rsi14 = computeRSI(closes);
    const macd = computeMACD(closes);
    const sma20 = sma(closes, 20);
    const sma50 = sma(closes, 50);
    const atr14 = computeATR(bars);
    const volumeAvg20 = sma(volumes, 20);
    const volumeLatest = lastBar.v;
    const volumeRatio = volumeAvg20 > 0 ? volumeLatest / volumeAvg20 : 0;
    const { support, resistance } = findSupportResistance(bars);

    const signals: string[] = [];
    const price = lastBar.c;

    if (rsi14 > 70) signals.push("RSI OVERBOUGHT (>70) - Caution on longs");
    else if (rsi14 > 60) signals.push("RSI elevated (60-70) - Momentum strong");
    else if (rsi14 < 30) signals.push("RSI OVERSOLD (<30) - Potential bounce");
    else if (rsi14 < 40) signals.push("RSI weak (30-40) - Bearish pressure");
    else signals.push("RSI neutral (40-60)");

    if (!isNaN(macd.histogram)) {
      if (macd.histogram > 0 && macd.macd > 0) signals.push("MACD bullish - Above signal & zero");
      else if (macd.histogram > 0) signals.push("MACD improving - Above signal line");
      else if (macd.histogram < 0 && macd.macd < 0) signals.push("MACD bearish - Below signal & zero");
      else signals.push("MACD weakening - Below signal line");
    }

    if (!isNaN(sma20) && !isNaN(sma50)) {
      if (price > sma20 && sma20 > sma50) signals.push("TREND BULLISH - Price > SMA20 > SMA50");
      else if (price < sma20 && sma20 < sma50) signals.push("TREND BEARISH - Price < SMA20 < SMA50");
      else if (price > sma20) signals.push("Short-term bullish - Price above SMA20");
      else signals.push("Short-term bearish - Price below SMA20");
    }

    if (volumeRatio > 1.5) signals.push(`HIGH VOLUME (${volumeRatio.toFixed(1)}x avg) - Strong conviction`);
    else if (volumeRatio > 1.2) signals.push(`Above-avg volume (${volumeRatio.toFixed(1)}x)`);
    else if (volumeRatio < 0.7) signals.push(`LOW VOLUME (${volumeRatio.toFixed(1)}x avg) - Weak conviction`);

    const distToSupport = ((price - support) / price * 100).toFixed(1);
    const distToResist = ((resistance - price) / price * 100).toFixed(1);
    signals.push(`Support: $${support.toFixed(2)} (-${distToSupport}%) | Resistance: $${resistance.toFixed(2)} (+${distToResist}%)`);

    const summaryParts: string[] = [];
    summaryParts.push(`## Technical Analysis: ${normalizedTicker}`);
    summaryParts.push(`**Price:** $${price.toFixed(2)} (${lastBar.t.slice(0, 10)})`);
    summaryParts.push("");
    summaryParts.push("### Key Indicators");
    summaryParts.push(`| Indicator | Value | Signal |`);
    summaryParts.push(`|-----------|-------|--------|`);
    summaryParts.push(`| **RSI (14)** | ${rsi14.toFixed(1)} | ${rsi14 > 70 ? "Overbought" : rsi14 < 30 ? "Oversold" : "Neutral"} |`);
    summaryParts.push(`| **MACD** | ${macd.macd.toFixed(3)} | ${macd.histogram > 0 ? "Bullish" : "Bearish"} (hist: ${macd.histogram.toFixed(3)}) |`);
    summaryParts.push(`| **SMA 20** | $${sma20.toFixed(2)} | Price ${price > sma20 ? "above" : "below"} (${((price/sma20 - 1) * 100).toFixed(1)}%) |`);
    summaryParts.push(`| **SMA 50** | $${isNaN(sma50) ? "N/A" : sma50.toFixed(2)} | ${isNaN(sma50) ? "N/A" : (price > sma50 ? "Bullish" : "Bearish")} |`);
    summaryParts.push(`| **ATR (14)** | $${atr14.toFixed(2)} | Daily range: ${(atr14/price*100).toFixed(1)}% |`);
    summaryParts.push(`| **Volume** | ${(volumeLatest/1e6).toFixed(1)}M | ${volumeRatio.toFixed(1)}x 20-day avg |`);
    summaryParts.push("");
    summaryParts.push("### Support & Resistance (20-day)");
    summaryParts.push(`- **Support:** $${support.toFixed(2)} (${distToSupport}% below)`);
    summaryParts.push(`- **Resistance:** $${resistance.toFixed(2)} (${distToResist}% above)`);
    summaryParts.push(`- **Risk/Reward:** ${(parseFloat(distToResist) / parseFloat(distToSupport)).toFixed(1)}:1`);
    summaryParts.push("");
    summaryParts.push("### Trading Signals");
    signals.forEach((s) => summaryParts.push(`- ${s}`));
    summaryParts.push("");

    let bullishCount = signals.filter((s) => /bullish|bounce|above.*sma|improving/i.test(s)).length;
    let bearishCount = signals.filter((s) => /bearish|overbought|below.*sma|weakening/i.test(s)).length;
    const bias = bullishCount > bearishCount ? "BULLISH" : bearishCount > bullishCount ? "BEARISH" : "NEUTRAL";
    summaryParts.push(`### Overall Technical Bias: **${bias}** (${bullishCount} bull / ${bearishCount} bear signals)`);

    return {
      ticker: normalizedTicker,
      lastPrice: price,
      lastDate: lastBar.t.slice(0, 10),
      rsi14, macd, sma20, sma50, atr14,
      volumeAvg20, volumeLatest, volumeRatio,
      support, resistance, signals,
      summary: summaryParts.join("\n"),
      status: "complete",
    };
  } catch (err: any) {
    return {
      ticker: normalizedTicker,
      lastPrice: 0, lastDate: "", rsi14: NaN,
      macd: { macd: NaN, signal: NaN, histogram: NaN },
      sma20: NaN, sma50: NaN, atr14: NaN,
      volumeAvg20: 0, volumeLatest: 0, volumeRatio: 0,
      support: 0, resistance: 0, signals: [],
      summary: "",
      status: "error", error: err.message || String(err),
    };
  }
}

// --- CLI ---

if (import.meta.main) {
  const args = process.argv.slice(2);
  const tickerIdx = args.indexOf("--ticker");

  if (tickerIdx === -1 || !args[tickerIdx + 1]) {
    console.error("Usage: bun src/analysis/TechnicalAnalysis.ts --ticker AAPL");
    process.exit(1);
  }

  const ticker = args[tickerIdx + 1];
  console.log(`Running technical analysis for ${ticker.toUpperCase()}...`);

  const result = await runTechnicalAnalysis(ticker);
  if (result.status === "error") {
    console.error(`Error: ${result.error}`);
    process.exit(1);
  }
  console.log(result.summary);
}
