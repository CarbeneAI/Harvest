#!/usr/bin/env bun
/**
 * MarketRegime.ts - Market Regime Detection via SPY Trend Analysis
 *
 * Determines whether the overall market is in a BULL, CAUTION, or BEAR regime
 * by analyzing SPY's relationship to its moving averages. Used as a gate before
 * entering new positions.
 *
 * Regimes:
 *   BULL    - SPY price > 200 SMA AND 50 SMA > 200 SMA (golden cross)
 *   CAUTION - SPY price > 200 SMA BUT 50 SMA < 200 SMA (death cross)
 *   BEAR    - SPY price < 200 SMA
 *
 * Usage:
 *   bun src/scanners/MarketRegime.ts
 */

import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fetchBars, sma, computeRSI } from "../analysis/TechnicalAnalysis.js";

// Load .env from project root
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
    const val = trimmed.slice(eqIdx + 1).trim();
    if (!process.env[key]) process.env[key] = val;
  }
}

loadEnv();

const log = (msg: string) => console.error(`[MarketRegime] ${msg}`);

// --- Types ---

export type RegimeLabel = "BULL" | "CAUTION" | "BEAR";

export interface MarketRegime {
  regime: RegimeLabel;
  spyPrice: number;
  sma200: number;
  sma50: number;
  sma20: number;
  rsi: number;
  description: string;
}

// --- Regime Detection ---

export async function checkMarketRegime(): Promise<MarketRegime> {
  log("Fetching 250 days of SPY bars from Alpaca...");
  const bars = await fetchBars("SPY", 250);

  if (bars.length < 210) {
    throw new Error(
      `Insufficient SPY data: only ${bars.length} bars available (need at least 210 for 200-day SMA)`
    );
  }

  const closes = bars.map((b) => b.c);
  const spyPrice = closes[closes.length - 1];

  const sma200val = sma(closes, 200);
  const sma50val = sma(closes, 50);
  const sma20val = sma(closes, 20);
  const rsiVal = computeRSI(closes, 14);

  log(
    `SPY: $${spyPrice.toFixed(2)} | SMA200: $${sma200val.toFixed(2)} | SMA50: $${sma50val.toFixed(2)} | SMA20: $${sma20val.toFixed(2)} | RSI: ${rsiVal.toFixed(1)}`
  );

  let regime: RegimeLabel;
  let description: string;

  if (spyPrice > sma200val && sma50val > sma200val) {
    regime = "BULL";
    const pctAbove200 = (((spyPrice - sma200val) / sma200val) * 100).toFixed(1);
    const ma50vsma200 = (((sma50val - sma200val) / sma200val) * 100).toFixed(1);
    description =
      `BULL market: SPY ($${spyPrice.toFixed(2)}) is ${pctAbove200}% above the 200 SMA ($${sma200val.toFixed(2)}). ` +
      `50 SMA ($${sma50val.toFixed(2)}) is ${ma50vsma200}% above 200 SMA — golden cross confirmed. ` +
      `Full position sizing allowed.`;
  } else if (spyPrice > sma200val && sma50val <= sma200val) {
    regime = "CAUTION";
    const pctAbove200 = (((spyPrice - sma200val) / sma200val) * 100).toFixed(1);
    const ma50vsma200 = (((sma50val - sma200val) / sma200val) * 100).toFixed(1);
    description =
      `CAUTION: SPY ($${spyPrice.toFixed(2)}) is ${pctAbove200}% above the 200 SMA ($${sma200val.toFixed(2)}), ` +
      `but the 50 SMA ($${sma50val.toFixed(2)}) is ${Math.abs(parseFloat(ma50vsma200)).toFixed(1)}% BELOW the 200 SMA — ` +
      `death cross in effect. Reduce position sizes by 50%.`;
  } else {
    regime = "BEAR";
    const pctBelow200 = (((sma200val - spyPrice) / sma200val) * 100).toFixed(1);
    description =
      `BEAR market: SPY ($${spyPrice.toFixed(2)}) is ${pctBelow200}% BELOW the 200 SMA ($${sma200val.toFixed(2)}). ` +
      `50 SMA ($${sma50val.toFixed(2)}). No new long positions — protect capital.`;
  }

  return { regime, spyPrice, sma200: sma200val, sma50: sma50val, sma20: sma20val, rsi: rsiVal, description };
}

/**
 * Returns whether new long positions are permitted under this regime.
 * BULL and CAUTION both allow longs (CAUTION at reduced sizing).
 * BEAR blocks new longs entirely.
 */
export function shouldAllowNewLongs(regime: MarketRegime): boolean {
  return regime.regime === "BULL" || regime.regime === "CAUTION";
}

/**
 * Returns a position size multiplier for this regime.
 *   BULL    → 1.0  (full sizing)
 *   CAUTION → 0.5  (half sizing — death cross risk)
 *   BEAR    → 0.0  (no new longs)
 */
export function positionSizeMultiplier(regime: MarketRegime): number {
  switch (regime.regime) {
    case "BULL": return 1.0;
    case "CAUTION": return 0.5;
    case "BEAR": return 0.0;
  }
}

// --- CLI ---

if (import.meta.main) {
  log("Checking market regime via SPY trend analysis...");

  try {
    const regime = await checkMarketRegime();
    const multiplier = positionSizeMultiplier(regime);
    const allowLongs = shouldAllowNewLongs(regime);

    console.log(`\nMarket Regime: ${regime.regime}`);
    console.log(`  SPY Price:  $${regime.spyPrice.toFixed(2)}`);
    console.log(`  SMA 200:    $${regime.sma200.toFixed(2)}`);
    console.log(`  SMA 50:     $${regime.sma50.toFixed(2)}`);
    console.log(`  SMA 20:     $${regime.sma20.toFixed(2)}`);
    console.log(`  RSI (14):   ${regime.rsi.toFixed(1)}`);
    console.log(`  Allow Longs: ${allowLongs ? "YES" : "NO"}`);
    console.log(`  Size Multiplier: ${multiplier.toFixed(1)}x`);
    console.log(`\n  ${regime.description}\n`);
  } catch (err: any) {
    console.error(`[MarketRegime] Fatal: ${err.message || String(err)}`);
    process.exit(1);
  }
}
