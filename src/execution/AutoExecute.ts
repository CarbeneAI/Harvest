#!/usr/bin/env bun
/**
 * AutoExecute.ts - Strategy-Aware Trade Execution
 *
 * Reads pending recommendations from MultiScan and executes trades using
 * LIMIT orders (0.1% above current price) for better fills.
 *
 * Strategy-specific behavior:
 *   - Momentum: No fixed stop order (PositionMonitor handles trailing ATR stops)
 *   - Mean Reversion: Hard stop placed below 200 SMA
 *   - Respects market regime position size multiplier
 *
 * Usage:
 *   bun AutoExecute.ts              # Execute pending recommendations
 *   bun AutoExecute.ts --dry-run    # Preview only, no orders
 *   bun AutoExecute.ts --help
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { sendDiscord } from "../notifications/discord-notify.js";

// --- Paths ---
const PROJECT_ROOT = resolve(dirname(new URL(import.meta.url).pathname), "../..");
const DATA_DIR = resolve(PROJECT_ROOT, "data");
const RECS_FILE = resolve(DATA_DIR, "recommendations.json");
const JOURNAL_DIR = resolve(DATA_DIR, "journal");

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
interface Recommendation {
  id: string;
  ticker: string;
  direction: "LONG" | "SHORT";
  strategy?: "momentum" | "mean_reversion";
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  trailingStopATR?: number;
  maxHoldDays?: number;
  exitCondition?: string;
  positionSizePct: number;
  conviction: number;
  thesis: string;
  status: string;
  createdAt: string;
  strength: string;
  sources: string[];
  atr?: number;
  rsi?: number;
  marketRegime?: string;
  regimeSizeMultiplier?: number;
  researchScore?: number;
  executedAt?: string;
  executionPrice?: number;
  executionQty?: number;
  orderId?: string;
  highWaterMark?: number;
  trendStrength?: number;
  volumeRatio?: number;
  moatType?: string;
  [key: string]: any;
}

// --- Helpers ---
const log = (msg: string) => console.error(`[AutoExecute] ${msg}`);
const today = () => new Date().toISOString().split("T")[0];

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

// --- Alpaca API ---
async function alpacaFetch(endpoint: string, options: RequestInit = {}): Promise<any> {
  const apiKey = process.env.ALPACA_API_KEY || "";
  const apiSecret = process.env.ALPACA_API_SECRET || "";
  const baseUrl = process.env.ALPACA_BASE_URL || "https://paper-api.alpaca.markets";

  if (!apiKey || !apiSecret) {
    log("ERROR: Alpaca API keys not configured");
    return null;
  }

  const resp = await fetch(`${baseUrl}${endpoint}`, {
    ...options,
    headers: {
      "APCA-API-KEY-ID": apiKey,
      "APCA-API-SECRET-KEY": apiSecret,
      "Content-Type": "application/json",
      ...options.headers,
    },
  });

  if (!resp.ok) {
    const body = await resp.text();
    log(`Alpaca API error: HTTP ${resp.status} - ${body}`);
    return null;
  }

  return resp.json();
}

// --- Get current price ---
async function getCurrentPrice(ticker: string): Promise<number | null> {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=1d`;
    const resp = await fetch(url);
    if (!resp.ok) return null;
    const data = await resp.json();
    return data.chart?.result?.[0]?.meta?.regularMarketPrice || null;
  } catch {
    return null;
  }
}

// --- Execute a single trade ---
async function executeTrade(
  rec: Recommendation,
  equity: number,
  dryRun: boolean
): Promise<{ success: boolean; orderId?: string; qty?: number; price?: number; error?: string }> {
  const ticker = rec.ticker;

  const currentPrice = await getCurrentPrice(ticker);
  if (!currentPrice) {
    return { success: false, error: `Could not get current price for ${ticker}` };
  }

  // Check slippage from recommendation entry price (allow up to 2%)
  const slippage = Math.abs((currentPrice - rec.entryPrice) / rec.entryPrice) * 100;
  if (slippage > 2) {
    return { success: false, error: `Slippage too high: ${slippage.toFixed(1)}% (entry: $${rec.entryPrice}, current: $${currentPrice})` };
  }

  // Calculate position size
  const positionPct = rec.positionSizePct / 100;
  const positionValue = equity * positionPct;
  const qty = Math.floor(positionValue / currentPrice);

  if (qty < 1) {
    return { success: false, error: `Position too small: ${qty} shares ($${positionValue.toFixed(2)})` };
  }

  // Set limit price slightly above current (0.1% to ensure fill)
  const limitPrice = +(currentPrice * 1.001).toFixed(2);

  log(`  ${ticker} [${rec.strategy || "standard"}]: ${qty} shares @ limit $${limitPrice} ($${(qty * currentPrice).toFixed(2)})`);

  if (dryRun) {
    return { success: true, qty, price: currentPrice };
  }

  // Submit LIMIT buy order
  const orderResult = await alpacaFetch("/v2/orders", {
    method: "POST",
    body: JSON.stringify({
      symbol: ticker,
      qty: String(qty),
      side: "buy",
      type: "limit",
      limit_price: String(limitPrice),
      time_in_force: "day",
    }),
  });

  if (!orderResult?.id) {
    return { success: false, error: `Order failed: ${JSON.stringify(orderResult)}` };
  }

  log(`  ${ticker}: Limit order submitted (${orderResult.id})`);

  // Wait for fill (poll up to 60 seconds for limit orders)
  let filled = false;
  let fillPrice = currentPrice;
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const status = await alpacaFetch(`/v2/orders/${orderResult.id}`);
    if (status?.status === "filled") {
      filled = true;
      fillPrice = parseFloat(status.filled_avg_price) || currentPrice;
      log(`  ${ticker}: Filled at $${fillPrice.toFixed(2)}`);
      break;
    }
    if (status?.status === "cancelled" || status?.status === "rejected") {
      return { success: false, error: `Order ${status.status}`, orderId: orderResult.id };
    }
  }

  if (!filled) {
    // Check one more time
    const status = await alpacaFetch(`/v2/orders/${orderResult.id}`);
    if (status?.status === "filled") {
      fillPrice = parseFloat(status.filled_avg_price) || currentPrice;
    } else {
      // Cancel unfilled limit order
      await alpacaFetch(`/v2/orders/${orderResult.id}`, { method: "DELETE" });
      return { success: false, error: `Limit order not filled in 60s, cancelled`, orderId: orderResult.id };
    }
  }

  // For mean reversion: set a hard stop below 200 SMA
  // For momentum: NO stop order — PositionMonitor handles trailing stops dynamically
  if (rec.strategy === "mean_reversion" && rec.stopLoss > 0) {
    const stopResult = await alpacaFetch("/v2/orders", {
      method: "POST",
      body: JSON.stringify({
        symbol: ticker,
        qty: String(qty),
        side: "sell",
        type: "stop",
        stop_price: String(rec.stopLoss),
        time_in_force: "gtc",
      }),
    });
    if (stopResult?.id) {
      log(`  ${ticker}: Hard stop set at $${rec.stopLoss} (200 SMA protection)`);
    } else {
      log(`  ${ticker}: WARNING - Stop order failed!`);
    }
  }

  if (rec.strategy === "momentum") {
    log(`  ${ticker}: Trailing stop managed by PositionMonitor (2x ATR)`);
  }

  return {
    success: true,
    orderId: orderResult.id,
    qty,
    price: fillPrice,
  };
}

// --- Journal entry ---
function journalTrade(rec: Recommendation, result: { qty?: number; price?: number; orderId?: string }): void {
  const monthDir = resolve(JOURNAL_DIR, new Date().toISOString().slice(0, 7));
  if (!existsSync(monthDir)) mkdirSync(monthDir, { recursive: true });

  const positionValue = (result.qty || 0) * (result.price || 0);
  const stratLabel = rec.strategy === "momentum" ? "Momentum Trend Following"
    : rec.strategy === "mean_reversion" ? "Mean Reversion on Quality"
    : "Standard Strategy";

  const content = `# Trade Journal: ${rec.ticker}

- **Date:** ${today()}
- **Ticker:** ${rec.ticker}
- **Strategy:** ${stratLabel}
- **Direction:** ${rec.direction}
- **Entry:** $${(result.price || 0).toFixed(2)} (limit order)
- **Size:** ${result.qty} shares ($${positionValue.toFixed(2)})
- **Conviction:** ${rec.conviction}/10
- **Signal Strength:** ${rec.strength}
- **Sources:** ${rec.sources.join(", ")}
- **Market Regime:** ${rec.marketRegime || "Unknown"}
- **Order ID:** ${result.orderId || "N/A"}

## Exit Plan

- **Strategy:** ${rec.strategy || "standard"}
- **Exit Condition:** ${rec.exitCondition || "Standard stop/target"}
- **Stop Loss:** $${rec.stopLoss.toFixed(2)}
- **Take Profit:** $${rec.takeProfit.toFixed(2)}
- **Max Hold:** ${rec.maxHoldDays || 20} days
${rec.strategy === "momentum" ? `- **Trailing Stop:** 2x ATR (managed by PositionMonitor)` : ""}
${rec.strategy === "mean_reversion" ? `- **RSI Target:** > 50 (mean reversion complete)` : ""}

## Thesis

${rec.thesis}

## Technical Context

- RSI: ${rec.rsi?.toFixed(0) || "N/A"}
${rec.atr ? `- ATR: $${rec.atr.toFixed(2)}` : ""}
${rec.trendStrength ? `- Trend Strength: ${rec.trendStrength.toFixed(1)}% above 50 SMA` : ""}
${rec.volumeRatio ? `- Volume: ${rec.volumeRatio.toFixed(1)}x average` : ""}
${rec.moatType ? `- Moat: ${rec.moatType}` : ""}

## Tags

#trading #${rec.ticker.toLowerCase()} #${rec.strategy || "standard"} #${rec.direction.toLowerCase()} #auto-executed

---

*Auto-executed by Harvest Trading Pipeline*
`;

  const file = resolve(monthDir, `${today()}-${rec.ticker}-entry.md`);
  writeFileSync(file, content);
  log(`  Journal entry: ${file}`);
}

// --- Telegram notification ---
async function sendTelegram(executed: Array<{ rec: Recommendation; result: any }>, skipped: string[], equity: number): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;

  if (executed.length === 0 && skipped.length === 0) return;

  const lines = [`*Harvest AutoExecute* — ${today()}`, ``];

  if (executed.length > 0) {
    lines.push(`*Trades Executed (${executed.length}):*`);
    for (const { rec, result } of executed) {
      const value = ((result.qty || 0) * (result.price || 0)).toFixed(2);
      const pctOfPort = (((result.qty || 0) * (result.price || 0)) / equity * 100).toFixed(1);
      const stratTag = rec.strategy === "momentum" ? "MOM" : rec.strategy === "mean_reversion" ? "MREV" : "STD";
      lines.push(`- *${rec.ticker}* [${stratTag}] — ${result.qty} shares @ $${(result.price || 0).toFixed(2)} ($${value}, ${pctOfPort}%)`);
      lines.push(`  Conv: ${rec.conviction}/10 | Exit: ${rec.exitCondition || "standard"}`);
    }
    lines.push(``);
  }

  if (skipped.length > 0) {
    lines.push(`*Skipped (${skipped.length}):*`);
    for (const reason of skipped.slice(0, 5)) {
      lines.push(`- ${reason}`);
    }
    if (skipped.length > 5) lines.push(`- ...and ${skipped.length - 5} more`);
  }

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

// --- Help ---
function showHelp() {
  console.log(`
AutoExecute - Strategy-Aware Trade Execution

Reads pending recommendations and executes trades using LIMIT orders.

Usage:
  bun AutoExecute.ts              # Execute pending recommendations
  bun AutoExecute.ts --dry-run    # Preview only, no orders
  bun AutoExecute.ts --help

Execution Rules:
  - Only executes recs with conviction >= 5 (auto-expire lower)
  - Max 5 open positions at once
  - Max 50% of portfolio allocated
  - Skips if slippage > 2% from recommendation price
  - Auto-journals every trade with strategy context
  - LIMIT orders (0.1% above current price) for better fills

Strategy-Specific Stops:
  - Momentum: No fixed stop (PositionMonitor manages trailing ATR stops)
  - Mean Reversion: Hard stop placed below 200 SMA immediately

Recommended cron schedule:
  # Run 30 minutes after MultiScan (9:30 AM EST)
  30 14 * * 1-5 cd /path/to/harvest && bun src/execution/AutoExecute.ts
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
  log(`Starting AutoExecute (dry-run: ${dryRun})`);

  // Load recommendations
  if (!existsSync(RECS_FILE)) {
    log("No recommendations file found. Run MultiScan first.");
    process.exit(0);
  }

  let recs: Recommendation[] = [];
  try {
    recs = JSON.parse(readFileSync(RECS_FILE, "utf-8"));
  } catch {
    log("Failed to parse recommendations.json");
    process.exit(1);
  }

  // Auto-expire pending recs that are low conviction or stale
  let expired = 0;
  for (const r of recs) {
    if (r.status !== "pending") continue;
    const ageHours = (Date.now() - new Date(r.createdAt).getTime()) / (1000 * 60 * 60);
    if (r.conviction < 5 || ageHours > 48) {
      r.status = "expired";
      r.expiredAt = new Date().toISOString();
      r.expireReason = r.conviction < 5 ? `conviction ${r.conviction} < 5` : "stale (> 48h)";
      expired++;
    }
  }
  if (expired > 0) {
    writeFileSync(RECS_FILE, JSON.stringify(recs, null, 2));
    log(`Auto-expired ${expired} ineligible pending recommendations`);
  }

  // Filter to pending recommendations
  const pending = recs.filter((r) => r.status === "pending");

  log(`Found ${pending.length} eligible pending recommendations`);

  if (pending.length === 0) {
    log("No eligible recommendations to execute.");
    process.exit(0);
  }

  // Get account info
  const account = await alpacaFetch("/v2/account");
  if (!account) {
    log("Failed to get account info");
    process.exit(1);
  }

  const equity = parseFloat(account.equity);
  const buyingPower = parseFloat(account.buying_power);
  log(`Account equity: $${equity.toFixed(2)} | Buying power: $${buyingPower.toFixed(2)}`);

  // Get current positions
  const positions = (await alpacaFetch("/v2/positions")) || [];
  const openCount = Array.isArray(positions) ? positions.length : 0;
  const allocatedValue = Array.isArray(positions) ? positions.reduce((sum: number, p: any) => sum + parseFloat(p.market_value), 0) : 0;
  const allocatedPct = (allocatedValue / equity) * 100;

  log(`Open positions: ${openCount} | Allocated: $${allocatedValue.toFixed(2)} (${allocatedPct.toFixed(1)}%)`);

  const maxPositions = 5;
  const maxAllocationPct = 50;
  const slotsAvailable = maxPositions - openCount;
  const allocationRoom = (maxAllocationPct - allocatedPct) / 100 * equity;

  if (slotsAvailable <= 0) {
    log(`All ${maxPositions} position slots full.`);
    process.exit(0);
  }

  if (allocationRoom <= 0) {
    log(`Portfolio at ${allocatedPct.toFixed(1)}% (max ${maxAllocationPct}%).`);
    process.exit(0);
  }

  const heldTickers = new Set(Array.isArray(positions) ? positions.map((p: any) => p.symbol) : []);

  // Sort: momentum first, then mean reversion, within each by conviction
  const sorted = [...pending].sort((a, b) => {
    const stratOrder: Record<string, number> = { momentum: 2, mean_reversion: 1 };
    const stratDiff = (stratOrder[b.strategy || ""] || 0) - (stratOrder[a.strategy || ""] || 0);
    if (stratDiff !== 0) return stratDiff;
    return b.conviction - a.conviction;
  });

  const executed: Array<{ rec: Recommendation; result: any }> = [];
  const skipped: string[] = [];
  let usedAllocation = 0;

  for (const rec of sorted) {
    if (executed.length >= slotsAvailable) {
      skipped.push(`${rec.ticker}: No position slots`);
      continue;
    }

    if (heldTickers.has(rec.ticker)) {
      skipped.push(`${rec.ticker}: Already holding`);
      continue;
    }

    const positionValue = equity * (rec.positionSizePct / 100);
    if (usedAllocation + positionValue > allocationRoom) {
      skipped.push(`${rec.ticker}: Would exceed ${maxAllocationPct}% allocation`);
      continue;
    }

    // Reject negative research scores
    if (rec.researchScore !== undefined && rec.researchScore < 0) {
      skipped.push(`${rec.ticker}: Research bearish (${(rec.researchScore * 100).toFixed(0)}%)`);
      continue;
    }

    log(`Executing ${rec.ticker} [${rec.strategy || "standard"}] (conviction: ${rec.conviction})...`);
    const result = await executeTrade(rec, equity, dryRun);

    if (result.success) {
      executed.push({ rec, result });
      usedAllocation += (result.qty || 0) * (result.price || 0);
      heldTickers.add(rec.ticker);

      if (!dryRun) {
        rec.status = "executed";
        rec.executedAt = new Date().toISOString();
        rec.executionPrice = result.price;
        rec.executionQty = result.qty;
        rec.orderId = result.orderId;
        rec.highWaterMark = result.price; // Initialize high water mark for trailing stop
        journalTrade(rec, result);
      }
    } else {
      skipped.push(`${rec.ticker}: ${result.error}`);
    }
  }

  // Save updated recommendations
  if (!dryRun && executed.length > 0) {
    writeFileSync(RECS_FILE, JSON.stringify(recs, null, 2));
    log(`Updated ${executed.length} recommendations to 'executed'`);
  }

  if (!dryRun) {
    await sendTelegram(executed, skipped, equity);
  }

  // Summary
  log(`\n--- AutoExecute Summary ---`);
  log(`Executed: ${executed.length} trades`);
  log(`Skipped: ${skipped.length}`);
  for (const { rec, result } of executed) {
    const stratTag = rec.strategy === "momentum" ? "MOM" : rec.strategy === "mean_reversion" ? "MREV" : "STD";
    log(`  [${stratTag}] ${rec.ticker}: ${result.qty} shares @ $${(result.price || 0).toFixed(2)}`);
  }

  if (dryRun) {
    console.log(JSON.stringify({
      dryRun: true,
      wouldExecute: executed.map(({ rec, result }) => ({
        ticker: rec.ticker,
        strategy: rec.strategy,
        qty: result.qty,
        price: result.price,
        conviction: rec.conviction,
        exitCondition: rec.exitCondition,
      })),
      skipped,
    }, null, 2));
  }

  log("AutoExecute complete.");
}

main().catch((e) => {
  log(`Fatal error: ${e}`);
  process.exit(1);
});
