#!/usr/bin/env bun
/**
 * MultiScan.ts - Technical Momentum + Mean Reversion Strategy Engine
 *
 * Strategy Mix:
 *   1. Momentum Trend Following (primary) - Buy strength in uptrends
 *   2. Mean Reversion on Quality (secondary) - Buy oversold moat stocks
 *
 * Critical Addition: Market Regime Filter
 *   - SPY > 200 SMA = BULL → full momentum + mean reversion
 *   - SPY < 200 SMA but > 50 SMA = CAUTION → mean reversion only, half size
 *   - SPY < 200 SMA and < 50 SMA = BEAR → mean reversion only, quarter size
 *
 * Note: QuiverQuant bonus signals removed (not required for core strategy).
 *
 * Usage:
 *   bun MultiScan.ts              # Full scan with all strategies
 *   bun MultiScan.ts --dry-run    # Scan + report only, no writes
 *   bun MultiScan.ts --help
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { scanMomentum, type MomentumSignal } from "../scanners/MomentumScanner.js";
import { scanMeanReversion, type MeanReversionSignal } from "../scanners/MeanReversionScanner.js";
import { checkMarketRegime, shouldAllowNewLongs, positionSizeMultiplier, type MarketRegime } from "../scanners/MarketRegime.js";
import { runFundamentalCheck, type FundamentalResult } from "../analysis/FundamentalCheck.js";
import { sendDiscord } from "../notifications/discord-notify.js";
import { calculatePositionSize, type PositionSizeResult } from "../analysis/RiskManager.js";

// --- Paths ---
const PROJECT_ROOT = resolve(dirname(new URL(import.meta.url).pathname), "../..");
const DATA_DIR = resolve(PROJECT_ROOT, "data");
const SCANS_DIR = resolve(DATA_DIR, "scans");
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

// --- Interfaces ---
type Strategy = "momentum" | "mean_reversion";

interface Recommendation {
  id: string;
  ticker: string;
  direction: "LONG" | "SHORT";
  strategy: Strategy;
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  trailingStopATR: number; // ATR multiplier for trailing stop
  maxHoldDays: number;
  exitCondition: string;
  positionSizePct: number;
  conviction: number;
  thesis: string;
  status: "pending" | "active" | "closed" | "expired";
  createdAt: string;
  strength: string;
  sources: string[];
  // Momentum-specific
  rsi?: number;
  macdHistogram?: number;
  trendStrength?: number;
  volumeRatio?: number;
  atr?: number;
  adx?: number;
  multiMomentum?: number;
  // Mean reversion-specific
  sma200?: number;
  bollingerLower?: number;
  moatType?: string;
  zScore?: number;
  hurstExponent?: number;
  // Fundamental quality fields
  qualityScore?: number;
  qualityVerdict?: string;
  qualitySignalAdj?: number;
  moatLabel?: string;
  valuationFlags?: number;
  entryAdjustment?: string;
  // Risk manager fields
  annualizedVol?: number;
  volTier?: string;
  correlationMultiplier?: number;
  riskAdjustments?: string[];
  // Market regime at time of scan
  marketRegime?: string;
  regimeSizeMultiplier?: number;
}

// --- Helpers ---
const today = () => new Date().toISOString().split("T")[0];
const log = (msg: string) => console.error(`[MultiScan] ${msg}`);

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const args: Record<string, string | boolean> = {};
  for (let i = 2; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      const key = argv[i].slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        args[key] = next;
        i++;
      } else {
        args[key] = true;
      }
    }
  }
  return args;
}

// --- Convert Scanner Signals to Recommendations ---

function momentumToRec(signal: MomentumSignal, regime: MarketRegime): Recommendation {
  const sizeMult = positionSizeMultiplier(regime);
  const baseSize = 5; // 5% base for momentum
  const convictionBase = Math.round(signal.score * 10); // 0-10

  return {
    id: `mom-${today().replace(/-/g, "")}-${signal.ticker}`,
    ticker: signal.ticker,
    direction: "LONG",
    strategy: "momentum",
    entryPrice: +signal.price.toFixed(2),
    stopLoss: +signal.suggestedStop.toFixed(2),
    takeProfit: +signal.suggestedTarget.toFixed(2),
    trailingStopATR: 2.0, // Trail at 2x ATR
    maxHoldDays: 40, // Up to ~8 weeks
    exitCondition: "Trailing stop (2x ATR) OR close below 20 SMA for 2 consecutive days",
    positionSizePct: +Math.max(1, baseSize * sizeMult).toFixed(1),
    conviction: Math.min(10, convictionBase),
    thesis: signal.thesis,
    status: "pending",
    createdAt: new Date().toISOString(),
    strength: signal.score >= 0.7 ? "Very High" : signal.score >= 0.5 ? "High" : "Medium",
    sources: ["Momentum"],
    rsi: signal.rsi,
    macdHistogram: signal.macdHistogram,
    trendStrength: signal.trendStrength,
    volumeRatio: signal.volumeRatio,
    atr: signal.atr,
    adx: signal.adx,
    multiMomentum: signal.multiMomentum,
    marketRegime: regime.regime,
    regimeSizeMultiplier: sizeMult,
  };
}

function meanRevToRec(signal: MeanReversionSignal, regime: MarketRegime): Recommendation {
  const sizeMult = positionSizeMultiplier(regime);
  const baseSize = 4; // 4% base for mean reversion
  const convictionBase = Math.round(signal.score * 10);

  return {
    id: `mrev-${today().replace(/-/g, "")}-${signal.ticker}`,
    ticker: signal.ticker,
    direction: "LONG",
    strategy: "mean_reversion",
    entryPrice: +signal.price.toFixed(2),
    stopLoss: +signal.suggestedStop.toFixed(2),
    takeProfit: +signal.suggestedTarget.toFixed(2),
    trailingStopATR: 0, // Mean reversion uses fixed target, not trailing
    maxHoldDays: 15, // 5-15 days for mean reversion
    exitCondition: "RSI > 50 OR price reaches 20 SMA OR 15 days max hold",
    positionSizePct: +Math.max(1, baseSize * sizeMult).toFixed(1),
    conviction: Math.min(10, convictionBase),
    thesis: signal.thesis,
    status: "pending",
    createdAt: new Date().toISOString(),
    strength: signal.score >= 0.7 ? "Very High" : signal.score >= 0.5 ? "High" : "Medium",
    sources: ["MeanReversion"],
    rsi: signal.rsi,
    sma200: signal.sma200,
    bollingerLower: signal.bollingerLower,
    moatType: signal.moatType,
    moatLabel: signal.moatLabel,
    zScore: signal.zScore,
    hurstExponent: signal.hurstExponent,
    marketRegime: regime.regime,
    regimeSizeMultiplier: sizeMult,
  };
}

// --- Fundamental Quality Gate ---

async function applyFundamentalGate(recs: Recommendation[]): Promise<Recommendation[]> {
  if (recs.length === 0) return recs;

  log(`Running fundamental quality gate on ${recs.length} recommendations...`);

  const checkResults = await Promise.allSettled(
    recs.map(async (rec) => {
      try {
        const result = await runFundamentalCheck(rec.ticker);
        return { ticker: rec.ticker, result };
      } catch (err: any) {
        log(`  Fundamental check failed for ${rec.ticker}: ${err.message}`);
        return { ticker: rec.ticker, result: null };
      }
    })
  );

  const fundamentalMap = new Map<string, FundamentalResult>();
  for (const settled of checkResults) {
    if (settled.status === "fulfilled" && settled.value.result) {
      fundamentalMap.set(settled.value.ticker, settled.value.result);
    }
  }

  const filtered: Recommendation[] = [];

  for (const rec of recs) {
    const fund = fundamentalMap.get(rec.ticker);

    if (!fund || fund.status === "error") {
      log(`  ${rec.ticker}: No fundamental data — proceeding with signal-only rules`);
      filtered.push(rec);
      continue;
    }

    if (fund.status === "etf_exempt") {
      log(`  ${rec.ticker}: ETF exempt from quality gate`);
      filtered.push(rec);
      continue;
    }

    const q = fund.quality;
    const v = fund.valuation;

    rec.qualityScore = q.score;
    rec.qualityVerdict = q.verdict;
    rec.qualitySignalAdj = q.signalAdjustment;
    rec.moatLabel = fund.moat.moatLabel !== "No identified moat" ? fund.moat.moatLabel : undefined;
    rec.valuationFlags = v.overvaluedFlags;
    rec.entryAdjustment = v.entryAdjustment;

    // SKIP verdict = do not trade (for momentum only - mean reversion on moat stocks gets a pass)
    if (q.verdict === "SKIP" && rec.strategy === "momentum") {
      const failedMetrics = q.metrics.filter((m) => m.required && !m.pass);
      log(`  ${rec.ticker}: SKIP — failed ${failedMetrics.length} required metrics`);
      continue;
    }

    // Apply conviction adjustment
    const oldConviction = rec.conviction;
    rec.conviction = Math.max(1, Math.min(10, rec.conviction + Math.round(q.signalAdjustment * 10)));
    if (oldConviction !== rec.conviction) {
      log(`  ${rec.ticker}: ${q.verdict} — conviction ${oldConviction}→${rec.conviction}`);
    }

    // Halve position on overvalued
    if (v.overvaluedFlags >= 2) {
      rec.positionSizePct = +Math.max(1, rec.positionSizePct / 2).toFixed(1);
      log(`  ${rec.ticker}: 2 overvalued flags — position halved to ${rec.positionSizePct}%`);
    }

    filtered.push(rec);
  }

  log(`Fundamental gate: ${filtered.length}/${recs.length} passed`);
  return filtered;
}

// --- Alpaca Position Dedup ---

async function getHeldTickers(): Promise<Set<string>> {
  const apiKey = process.env.ALPACA_API_KEY || "";
  const apiSecret = process.env.ALPACA_API_SECRET || "";
  const baseUrl = process.env.ALPACA_BASE_URL || "https://paper-api.alpaca.markets";
  if (!apiKey || !apiSecret) return new Set();

  try {
    const resp = await fetch(`${baseUrl}/v2/positions`, {
      headers: {
        "APCA-API-KEY-ID": apiKey,
        "APCA-API-SECRET-KEY": apiSecret,
      },
    });
    if (!resp.ok) return new Set();
    const positions = await resp.json() as any[];
    return new Set(positions.map((p: any) => p.symbol));
  } catch {
    return new Set();
  }
}

// --- Write Recommendations ---

async function writeRecommendations(newRecs: Recommendation[]): Promise<void> {
  let existing: Recommendation[] = [];
  if (existsSync(RECS_FILE)) {
    try {
      existing = JSON.parse(readFileSync(RECS_FILE, "utf-8"));
    } catch {
      existing = [];
    }
  }

  // Expire old pending recs (>3 days for momentum, >2 days for mean reversion)
  const now = Date.now();
  existing = existing.map((r) => {
    if (r.status !== "pending") return r;
    const ageHours = (now - new Date(r.createdAt).getTime()) / (1000 * 60 * 60);
    const maxAge = r.strategy === "mean_reversion" ? 48 : 72;
    if (ageHours > maxAge) return { ...r, status: "expired" as const };
    return r;
  });

  // Skip held tickers and active recs
  const heldTickers = await getHeldTickers();
  const activeTickers = new Set(
    existing.filter((r) => r.status === "pending" || r.status === "active").map((r) => r.ticker)
  );
  const existingIds = new Set(existing.map((r) => r.id));

  const toAdd = newRecs.filter((r) => {
    if (existingIds.has(r.id)) return false;
    if (heldTickers.has(r.ticker)) {
      log(`  Skipping ${r.ticker}: already held`);
      return false;
    }
    if (activeTickers.has(r.ticker)) {
      log(`  Skipping ${r.ticker}: already has pending/active rec`);
      return false;
    }
    return true;
  });

  const merged = [...existing, ...toAdd];
  writeFileSync(RECS_FILE, JSON.stringify(merged, null, 2));
  log(`Wrote ${merged.length} recommendations (${toAdd.length} new)`);
}

// --- Telegram ---

async function sendTelegram(recs: Recommendation[], regime: MarketRegime, stats: any): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    log("Telegram not configured");
    return;
  }

  const regimeEmoji = regime.regime === "BULL" ? "+" : regime.regime === "CAUTION" ? "~" : "-";
  const momentumRecs = recs.filter(r => r.strategy === "momentum");
  const meanRevRecs = recs.filter(r => r.strategy === "mean_reversion");
  const dashboardPort = process.env.DASHBOARD_PORT || "8083";

  const lines = [
    `*Harvest Strategy Scan* — ${today()}`,
    ``,
    `[${regimeEmoji}] *Market Regime: ${regime.regime}* (SPY $${regime.spyPrice.toFixed(2)}, RSI ${regime.rsi.toFixed(0)})`,
    `200 SMA: $${regime.sma200.toFixed(2)} | 50 SMA: $${regime.sma50.toFixed(2)}`,
    ``,
  ];

  if (momentumRecs.length > 0) {
    lines.push(`*Momentum Signals (${momentumRecs.length}):*`);
    for (const r of momentumRecs.slice(0, 5)) {
      lines.push(`- *${r.ticker}* — Conv ${r.conviction}/10 | $${r.entryPrice} | RSI ${r.rsi?.toFixed(0)} | Vol ${r.volumeRatio?.toFixed(1)}x`);
      lines.push(`  SL: $${r.stopLoss} (trailing 2x ATR) | Size: ${r.positionSizePct}%`);
    }
    lines.push(``);
  }

  if (meanRevRecs.length > 0) {
    lines.push(`*Mean Reversion Signals (${meanRevRecs.length}):*`);
    for (const r of meanRevRecs.slice(0, 5)) {
      lines.push(`- *${r.ticker}* — Conv ${r.conviction}/10 | $${r.entryPrice} | RSI ${r.rsi?.toFixed(0)} | Moat: ${r.moatType || "?"}`);
      lines.push(`  Target: $${r.takeProfit} (20 SMA) | SL: $${r.stopLoss} | Size: ${r.positionSizePct}%`);
    }
    lines.push(``);
  }

  if (recs.length === 0) {
    lines.push(`No signals today. ${regime.regime === "BEAR" ? "Market in bear regime — cash is a position." : "Patience."}`);
    lines.push(``);
  }

  lines.push(`Scanned: ${stats.momentumScanned} momentum, ${stats.meanRevScanned} moat stocks (technical signals only)`);
  lines.push(`Dashboard: http://localhost:${dashboardPort}`);

  const text = lines.join("\n");

  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown" }),
    });
    log("Telegram notification sent");
  } catch (e) {
    log(`Telegram error: ${e}`);
  }

  await sendDiscord(text);
}

// --- Save Report ---

function saveScanReport(recs: Recommendation[], regime: MarketRegime, stats: any): void {
  if (!existsSync(SCANS_DIR)) mkdirSync(SCANS_DIR, { recursive: true });

  const report = {
    date: today(),
    timestamp: new Date().toISOString(),
    scanType: "strategy-multiscan",
    marketRegime: regime,
    stats,
    recommendationsGenerated: recs.length,
    recommendations: recs,
  };

  const file = resolve(SCANS_DIR, `${today()}-strategy.json`);
  writeFileSync(file, JSON.stringify(report, null, 2));
  log(`Scan report saved: ${file}`);
}

// --- Help ---

function showHelp() {
  console.log(`
Harvest Strategy Scanner - Technical Momentum + Mean Reversion

Usage:
  bun MultiScan.ts              # Full scan with all strategies
  bun MultiScan.ts --dry-run    # Scan + report only, no writes
  bun MultiScan.ts --help

Strategies:
  1. Momentum Trend Following
     - Scans ~80 liquid large-caps for bullish setups
     - Entry: Price > 20 SMA > 50 SMA, RSI 40-70, MACD bullish, volume above avg
     - Exit: Trailing stop at 2x ATR, or close below 20 SMA
     - Hold: 2-8 weeks

  2. Mean Reversion on Quality
     - Scans ~20 moat stocks (Buffett-quality) for oversold bounces
     - Entry: RSI < 35, price above 200 SMA, at/below lower Bollinger Band
     - Exit: RSI > 50 or price reaches 20 SMA
     - Hold: 5-15 days

Market Regime Filter:
  - BULL: SPY > 200 SMA → Full momentum + mean reversion
  - CAUTION: SPY between 50-200 SMA → Half position sizes
  - BEAR: SPY < 50 SMA → Mean reversion only, quarter size

Environment:
  ALPACA_API_KEY       Alpaca API key (required)
  ALPACA_API_SECRET    Alpaca API secret (required)
  TELEGRAM_BOT_TOKEN   Telegram notifications (optional)
  TELEGRAM_CHAT_ID     Telegram chat ID (optional)
  DASHBOARD_PORT       Dashboard server port (default: 8083)
`);
}

// --- Main ---

async function main() {
  const args = parseArgs(process.argv);

  if (args.help) {
    showHelp();
    process.exit(0);
  }

  const dryRun = !!args["dry-run"];

  log(`Starting Harvest Strategy Scan (dry-run: ${dryRun})`);

  // Step 1: Market Regime Check
  log("=== Step 1: Market Regime ===");
  let regime: MarketRegime;
  try {
    regime = await checkMarketRegime();
    log(`Regime: ${regime.regime} — SPY $${regime.spyPrice.toFixed(2)} | 200 SMA $${regime.sma200.toFixed(2)} | RSI ${regime.rsi.toFixed(1)}`);
    log(`  ${regime.description}`);
  } catch (err: any) {
    log(`Market regime check failed: ${err.message}. Defaulting to CAUTION.`);
    regime = {
      regime: "CAUTION",
      spyPrice: 0,
      sma200: 0,
      sma50: 0,
      sma20: 0,
      rsi: 50,
      description: "Failed to check market regime — defaulting to CAUTION",
    };
  }

  // Step 2: Run Scanners (in parallel)
  log("=== Step 2: Running Scanners ===");
  const allowLongs = shouldAllowNewLongs(regime);

  const scanPromises: Promise<any>[] = [];

  // Momentum scanner (skip in BEAR regime)
  if (allowLongs) {
    log("Running momentum scanner...");
    scanPromises.push(
      scanMomentum().catch((e) => {
        log(`Momentum scanner error: ${e}`);
        return [] as MomentumSignal[];
      })
    );
  } else {
    log("Skipping momentum scanner (BEAR regime)");
    scanPromises.push(Promise.resolve([] as MomentumSignal[]));
  }

  // Mean reversion scanner (always runs — buying quality at discounts)
  log("Running mean reversion scanner...");
  scanPromises.push(
    scanMeanReversion().catch((e) => {
      log(`Mean reversion scanner error: ${e}`);
      return [] as MeanReversionSignal[];
    })
  );

  const [momentumSignals, meanRevSignals] = await Promise.all(scanPromises) as [
    MomentumSignal[],
    MeanReversionSignal[]
  ];

  const stats = {
    momentumScanned: 80, // Universe size
    momentumSignals: momentumSignals.length,
    meanRevScanned: 20, // Moat universe size
    meanRevSignals: meanRevSignals.length,
    regime: regime.regime,
  };

  log(`Results: ${momentumSignals.length} momentum | ${meanRevSignals.length} mean reversion`);

  // Step 3: Convert signals to recommendations
  log("=== Step 3: Building Recommendations ===");
  let recs: Recommendation[] = [];

  for (const sig of momentumSignals) {
    recs.push(momentumToRec(sig, regime));
  }

  for (const sig of meanRevSignals) {
    recs.push(meanRevToRec(sig, regime));
  }

  // Sort by conviction descending
  recs.sort((a, b) => b.conviction - a.conviction);

  // Cap at 10 recommendations
  recs = recs.slice(0, 10);

  log(`Generated ${recs.length} raw recommendations`);

  // Step 4: Fundamental Quality Gate
  log("=== Step 4: Fundamental Quality Gate ===");
  if (recs.length > 0) {
    recs = await applyFundamentalGate(recs);
  }

  // Step 5: Volatility-Adjusted Position Sizing (RiskManager)
  log("=== Step 5: Risk-Adjusted Position Sizing ===");
  if (recs.length > 0) {
    const heldTickers = [...await getHeldTickers()];
    const alreadySized: string[] = [];

    for (const rec of recs) {
      try {
        const basePct = rec.strategy === "momentum" ? 5 : 4;
        const sizeMult = positionSizeMultiplier(regime);
        const sizeResult = await calculatePositionSize(
          rec.ticker,
          basePct,
          sizeMult,
          [...heldTickers, ...alreadySized]
        );

        const oldSize = rec.positionSizePct;
        rec.positionSizePct = sizeResult.finalSizePct;
        rec.annualizedVol = sizeResult.annualizedVol;
        rec.volTier = sizeResult.volTierLabel;
        rec.correlationMultiplier = sizeResult.correlationMultiplier;
        rec.riskAdjustments = sizeResult.adjustments;

        if (oldSize !== rec.positionSizePct) {
          log(`  ${rec.ticker}: ${oldSize}% → ${rec.positionSizePct}% (vol: ${(sizeResult.annualizedVol * 100).toFixed(0)}% ${sizeResult.volTierLabel}, corr: ${sizeResult.correlationMultiplier}x)`);
        }

        alreadySized.push(rec.ticker);
      } catch (err: any) {
        log(`  ${rec.ticker}: Risk sizing failed (${err.message}), keeping default size`);
      }
    }
  }

  // Step 6: Output
  log("=== Step 6: Output ===");

  if (dryRun) {
    log("DRY RUN — printing results without writing");
    console.log(JSON.stringify({ regime, stats, recommendations: recs }, null, 2));
    process.exit(0);
  }

  // Write and notify
  await writeRecommendations(recs);
  await sendTelegram(recs, regime, stats);
  saveScanReport(recs, regime, stats);

  // Summary
  log("\n--- Scan Summary ---");
  log(`Market Regime: ${regime.regime}`);
  log(`Recommendations: ${recs.length}`);
  for (const r of recs) {
    const stratTag = r.strategy === "momentum" ? "MOM" : "MREV";
    log(`  [${stratTag}] ${r.ticker}: Conv ${r.conviction}/10 | $${r.entryPrice} | SL $${r.stopLoss} | ${r.positionSizePct}%`);
  }

  log("\nHarvest Strategy Scan complete.");
}

main().catch((e) => {
  log(`Fatal error: ${e}`);
  process.exit(1);
});
