#!/usr/bin/env bun
/**
 * PositionMonitor.ts - Strategy-Aware Position Management
 *
 * Implements strategy-specific exit rules for open positions:
 *
 * MOMENTUM positions:
 *   - Trailing stop at 2x ATR below high water mark
 *   - Close below 20 SMA for 2 consecutive days → sell
 *   - Hard stop: -7% from entry (safety backstop)
 *   - Max hold: 40 trading days (~8 weeks)
 *
 * MEAN REVERSION positions:
 *   - RSI > 50 → take profit (mean reverted)
 *   - Price reaches 20 SMA → take profit
 *   - Hard stop: 2% below 200 SMA (thesis broken)
 *   - Max hold: 15 trading days
 *
 * LEGACY positions (no strategy tag):
 *   - Standard 7% stop-loss, 10% take-profit
 *   - Max hold: 20 trading days
 *
 * Usage:
 *   bun PositionMonitor.ts              # Check positions, alert via Telegram
 *   bun PositionMonitor.ts --auto-sell  # Auto-sell positions hitting exit rules
 *   bun PositionMonitor.ts --dry-run    # Report only
 *   bun PositionMonitor.ts --help
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { fetchBars, sma, computeRSI, computeATR } from "../analysis/TechnicalAnalysis.js";
import { sendDiscord } from "../notifications/discord-notify.js";

// --- Paths ---
const PROJECT_ROOT = resolve(dirname(new URL(import.meta.url).pathname), "../..");
const DATA_DIR = resolve(PROJECT_ROOT, "data");
const RECS_FILE = resolve(DATA_DIR, "recommendations.json");
const MONITOR_LOG_DIR = resolve(DATA_DIR, "monitor-logs");
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
interface Position {
  symbol: string;
  qty: string;
  avg_entry_price: string;
  current_price: string;
  unrealized_pl: string;
  unrealized_plpc: string;
  market_value: string;
}

interface Recommendation {
  id: string;
  ticker: string;
  direction: string;
  strategy?: "momentum" | "mean_reversion";
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  trailingStopATR?: number;
  maxHoldDays?: number;
  exitCondition?: string;
  conviction: number;
  status: string;
  createdAt: string;
  executedAt?: string;
  sources?: string[];
  atr?: number;
  sma200?: number;
  highWaterMark?: number;
  [key: string]: any;
}

interface PositionAlert {
  symbol: string;
  strategy: string;
  alertType: "trailing-stop" | "sma-exit" | "rsi-target" | "max-hold" | "hard-stop" | "take-profit" | "stop-loss";
  action: "SELL" | "REVIEW" | "HOLD";
  reason: string;
  currentPrice: number;
  entryPrice: number;
  plPct: number;
  daysHeld: number;
  qty: number;
}

interface TechnicalContext {
  rsi: number;
  sma20: number;
  sma50: number;
  sma200: number;
  atr: number;
  highSinceEntry: number;
  closedBelowSMA20Days: number;
}

// --- Helpers ---
const log = (msg: string) => console.error(`[Monitor] ${msg}`);
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
    log(`Alpaca API error: HTTP ${resp.status}`);
    return null;
  }

  return resp.json();
}

// --- Fetch Technical Context for a Position ---
async function getTechnicalContext(symbol: string, entryDate?: string): Promise<TechnicalContext | null> {
  try {
    const bars = await fetchBars(symbol, 90);
    if (bars.length < 30) return null;

    const closes = bars.map(b => b.c);
    const rsi = computeRSI(closes);
    const sma20Val = sma(closes, 20);
    const sma50Val = sma(closes, 50);
    const atr = computeATR(bars);

    let sma200Val = NaN;
    if (closes.length >= 200) {
      sma200Val = sma(closes, 200);
    }

    // High water mark since entry
    let highSinceEntry = Math.max(...closes.slice(-20));
    if (entryDate) {
      const entryIdx = bars.findIndex(b => b.t.slice(0, 10) >= entryDate);
      if (entryIdx >= 0) {
        highSinceEntry = Math.max(...bars.slice(entryIdx).map(b => b.h));
      }
    }

    // Count consecutive days closing below 20 SMA (from most recent)
    let closedBelowSMA20Days = 0;
    if (!isNaN(sma20Val)) {
      for (let i = closes.length - 1; i >= Math.max(0, closes.length - 5); i--) {
        if (closes[i] < sma20Val) closedBelowSMA20Days++;
        else break;
      }
    }

    return { rsi, sma20: sma20Val, sma50: sma50Val, sma200: sma200Val, atr, highSinceEntry, closedBelowSMA20Days };
  } catch (err: any) {
    log(`  Technical context error for ${symbol}: ${err.message}`);
    return null;
  }
}

// --- Position Analysis (Strategy-Aware) ---
async function analyzePositions(positions: Position[], recs: Recommendation[]): Promise<PositionAlert[]> {
  const alerts: PositionAlert[] = [];
  const now = new Date();

  for (const pos of positions) {
    const symbol = pos.symbol;
    const currentPrice = parseFloat(pos.current_price);
    const entryPrice = parseFloat(pos.avg_entry_price);
    const plPct = parseFloat(pos.unrealized_plpc) * 100;
    const qty = parseInt(pos.qty);

    const rec = recs.find(
      (r) => r.ticker === symbol && (r.status === "executed" || r.status === "active")
    );

    const strategy = rec?.strategy || "legacy";
    const executedDate = rec?.executedAt ? new Date(rec.executedAt) : null;
    const daysHeld = executedDate
      ? Math.floor((now.getTime() - executedDate.getTime()) / (1000 * 60 * 60 * 24))
      : 0;
    const maxHoldDays = rec?.maxHoldDays || 20;

    const tech = await getTechnicalContext(symbol, rec?.executedAt?.slice(0, 10));

    if (strategy === "momentum") {
      // === MOMENTUM EXIT RULES ===
      const atr = tech?.atr || rec?.atr || 0;
      const highWaterMark = tech?.highSinceEntry || rec?.highWaterMark || entryPrice;

      if (rec && tech?.highSinceEntry && tech.highSinceEntry > (rec.highWaterMark || 0)) {
        rec.highWaterMark = tech.highSinceEntry;
      }

      // 1. Trailing stop: price < high water mark - 2*ATR
      const trailingStop = highWaterMark - 2 * atr;
      if (atr > 0 && currentPrice <= trailingStop) {
        alerts.push({
          symbol, strategy: "momentum",
          alertType: "trailing-stop", action: "SELL",
          reason: `Trailing stop hit. HWM $${highWaterMark.toFixed(2)} - 2*ATR($${atr.toFixed(2)}) = $${trailingStop.toFixed(2)}. Current: $${currentPrice.toFixed(2)} (${plPct.toFixed(1)}%)`,
          currentPrice, entryPrice, plPct, daysHeld, qty,
        });
        continue;
      }

      // 2. Close below 20 SMA for 2+ consecutive days
      if (tech && tech.closedBelowSMA20Days >= 2) {
        alerts.push({
          symbol, strategy: "momentum",
          alertType: "sma-exit", action: "SELL",
          reason: `Closed below 20 SMA ($${tech.sma20.toFixed(2)}) for ${tech.closedBelowSMA20Days} consecutive days. Trend broken. (${plPct.toFixed(1)}%)`,
          currentPrice, entryPrice, plPct, daysHeld, qty,
        });
        continue;
      }

      // 3. Max hold (40 days)
      if (daysHeld >= maxHoldDays) {
        alerts.push({
          symbol, strategy: "momentum",
          alertType: "max-hold", action: "SELL",
          reason: `Max hold ${maxHoldDays} days reached. ${plPct > 0 ? "Locking in" : "Cutting"} at ${plPct.toFixed(1)}%.`,
          currentPrice, entryPrice, plPct, daysHeld, qty,
        });
        continue;
      }

      // 4. Hard stop: 7% loss from entry
      if (plPct <= -7) {
        alerts.push({
          symbol, strategy: "momentum",
          alertType: "hard-stop", action: "SELL",
          reason: `Hard stop at -7% hit (${plPct.toFixed(1)}%). Safety backstop.`,
          currentPrice, entryPrice, plPct, daysHeld, qty,
        });
        continue;
      }

      if (tech) {
        const trailPct = atr > 0 ? ((currentPrice - trailingStop) / currentPrice * 100).toFixed(1) : "N/A";
        log(`  ${symbol} [MOM]: ${plPct.toFixed(1)}% | Day ${daysHeld}/${maxHoldDays} | RSI ${tech.rsi.toFixed(0)} | Trail cushion: ${trailPct}% | HWM $${highWaterMark.toFixed(2)}`);
      }

    } else if (strategy === "mean_reversion") {
      // === MEAN REVERSION EXIT RULES ===

      // 1. RSI > 50: mean reverted, take profit
      if (tech && tech.rsi > 50) {
        alerts.push({
          symbol, strategy: "mean_reversion",
          alertType: "rsi-target", action: "SELL",
          reason: `RSI ${tech.rsi.toFixed(0)} > 50 — mean reversion target hit. Taking profit at ${plPct.toFixed(1)}%.`,
          currentPrice, entryPrice, plPct, daysHeld, qty,
        });
        continue;
      }

      // 2. Price reaches 20 SMA: mean reverted
      if (tech && !isNaN(tech.sma20) && currentPrice >= tech.sma20) {
        alerts.push({
          symbol, strategy: "mean_reversion",
          alertType: "take-profit", action: "SELL",
          reason: `Price $${currentPrice.toFixed(2)} reached 20 SMA $${tech.sma20.toFixed(2)}. Mean reversion complete. (${plPct.toFixed(1)}%)`,
          currentPrice, entryPrice, plPct, daysHeld, qty,
        });
        continue;
      }

      // 3. Hard stop: price drops below 200 SMA
      if (tech && !isNaN(tech.sma200) && currentPrice < tech.sma200 * 0.98) {
        alerts.push({
          symbol, strategy: "mean_reversion",
          alertType: "hard-stop", action: "SELL",
          reason: `Price $${currentPrice.toFixed(2)} broke below 200 SMA $${tech.sma200.toFixed(2)} — thesis broken. (${plPct.toFixed(1)}%)`,
          currentPrice, entryPrice, plPct, daysHeld, qty,
        });
        continue;
      }

      // 4. Max hold (15 days)
      if (daysHeld >= maxHoldDays) {
        alerts.push({
          symbol, strategy: "mean_reversion",
          alertType: "max-hold", action: "SELL",
          reason: `Max hold ${maxHoldDays} days reached. Mean reversion didn't complete. (${plPct.toFixed(1)}%)`,
          currentPrice, entryPrice, plPct, daysHeld, qty,
        });
        continue;
      }

      if (tech) {
        log(`  ${symbol} [MREV]: ${plPct.toFixed(1)}% | Day ${daysHeld}/${maxHoldDays} | RSI ${tech.rsi.toFixed(0)} | Target: 20 SMA $${tech.sma20.toFixed(2)}`);
      }

    } else {
      // === LEGACY EXIT RULES ===
      const stopLoss = entryPrice * 0.93; // 7% stop
      const takeProfit = entryPrice * 1.10; // 10% target

      if (currentPrice <= stopLoss) {
        alerts.push({
          symbol, strategy: "legacy",
          alertType: "stop-loss", action: "SELL",
          reason: `Stop-loss hit at $${stopLoss.toFixed(2)} (${plPct.toFixed(1)}%)`,
          currentPrice, entryPrice, plPct, daysHeld, qty,
        });
        continue;
      }

      if (currentPrice >= takeProfit) {
        alerts.push({
          symbol, strategy: "legacy",
          alertType: "take-profit", action: "SELL",
          reason: `Take-profit hit at $${takeProfit.toFixed(2)} (${plPct.toFixed(1)}%)`,
          currentPrice, entryPrice, plPct, daysHeld, qty,
        });
        continue;
      }

      if (daysHeld >= 20) {
        alerts.push({
          symbol, strategy: "legacy",
          alertType: "max-hold", action: "SELL",
          reason: `Legacy max hold 20 days reached. (${plPct.toFixed(1)}%)`,
          currentPrice, entryPrice, plPct, daysHeld, qty,
        });
        continue;
      }

      log(`  ${symbol} [LEGACY]: ${plPct.toFixed(1)}% | Day ${daysHeld}/20`);
    }
  }

  return alerts;
}

// --- Execute Sell ---
async function executeSell(symbol: string, qty: number): Promise<any> {
  log(`Selling ${qty} shares of ${symbol}...`);
  return alpacaFetch("/v2/orders", {
    method: "POST",
    body: JSON.stringify({
      symbol,
      qty: String(qty),
      side: "sell",
      type: "market",
      time_in_force: "day",
    }),
  });
}

// --- Cancel Existing Stop Orders for a Symbol ---
async function cancelStopOrders(symbol: string): Promise<void> {
  try {
    const orders = await alpacaFetch(`/v2/orders?status=open&symbols=${symbol}`);
    if (!Array.isArray(orders)) return;
    for (const order of orders) {
      if (order.type === "stop" && order.symbol === symbol) {
        await alpacaFetch(`/v2/orders/${order.id}`, { method: "DELETE" });
        log(`  Cancelled stop order ${order.id} for ${symbol}`);
      }
    }
  } catch (e) {
    log(`  Error cancelling stop orders for ${symbol}: ${e}`);
  }
}

// --- Telegram Notification ---
async function sendTelegram(alerts: PositionAlert[], sellResults: any[]): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;

  if (alerts.length === 0) {
    const text = `*Position Monitor* — ${today()}\n\nAll positions healthy. No alerts.`;
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown" }),
    });
    return;
  }

  const sellAlerts = alerts.filter((a) => a.action === "SELL");
  const reviewAlerts = alerts.filter((a) => a.action === "REVIEW");

  const lines = [`*Position Monitor* — ${today()}`, ``];

  if (sellAlerts.length > 0) {
    lines.push(`*EXIT Signals (${sellAlerts.length}):*`);
    for (const a of sellAlerts) {
      const stratTag = a.strategy === "momentum" ? "MOM" : a.strategy === "mean_reversion" ? "MREV" : "LEG";
      const sold = sellResults.find((r) => r?.symbol === a.symbol);
      const status = sold?.id ? "SOLD" : "Pending";
      lines.push(`- *${a.symbol}* [${stratTag}] — ${a.alertType}`);
      lines.push(`  ${a.reason} | ${status}`);
    }
    lines.push(``);
  }

  if (reviewAlerts.length > 0) {
    lines.push(`*Review (${reviewAlerts.length}):*`);
    for (const a of reviewAlerts) {
      lines.push(`- *${a.symbol}* — ${a.reason}`);
    }
  }

  const text = lines.join("\n");
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown" }),
  });
  log("Telegram notification sent");

  await sendDiscord(text);
}

// --- Auto-Journal Closed Trades ---
async function journalClosedTrade(alert: PositionAlert, sellResult: any): Promise<void> {
  const journalDir = resolve(JOURNAL_DIR, new Date().toISOString().slice(0, 7));
  if (!existsSync(journalDir)) mkdirSync(journalDir, { recursive: true });

  const plDollar = ((alert.plPct / 100) * alert.entryPrice * alert.qty).toFixed(2);
  const content = `# Trade Journal: ${alert.symbol} (Auto-Closed)

- **Date:** ${today()}
- **Ticker:** ${alert.symbol}
- **Strategy:** ${alert.strategy}
- **Direction:** Long
- **Entry:** $${alert.entryPrice.toFixed(2)}
- **Exit:** $${alert.currentPrice.toFixed(2)}
- **Size:** ${alert.qty} shares
- **P&L:** $${plDollar} (${alert.plPct.toFixed(2)}%)
- **Days Held:** ${alert.daysHeld}
- **Exit Trigger:** ${alert.alertType}

## Exit Reason

${alert.reason}

## Tags

#trading #${alert.symbol.toLowerCase()} #${alert.strategy} ${alert.plPct > 0 ? "#win" : "#loss"} #auto-closed #${alert.alertType}

---

*Auto-generated by Harvest Position Monitor*
`;

  const file = resolve(journalDir, `${today()}-${alert.symbol}-close.md`);
  writeFileSync(file, content);
  log(`  Journal entry saved: ${file}`);
}

// --- Save Monitor Log ---
function saveMonitorLog(alerts: PositionAlert[], sellResults: any[]): void {
  if (!existsSync(MONITOR_LOG_DIR)) mkdirSync(MONITOR_LOG_DIR, { recursive: true });

  const report = {
    date: today(),
    timestamp: new Date().toISOString(),
    alertCount: alerts.length,
    sellAlerts: alerts.filter((a) => a.action === "SELL").length,
    reviewAlerts: alerts.filter((a) => a.action === "REVIEW").length,
    alerts,
    sellResults,
  };

  const file = resolve(MONITOR_LOG_DIR, `${today()}.json`);
  writeFileSync(file, JSON.stringify(report, null, 2));
  log(`Monitor log saved: ${file}`);
}

// --- Help ---
function showHelp() {
  console.log(`
Position Monitor - Strategy-Aware Position Management

Usage:
  bun PositionMonitor.ts              # Check positions, alert via Telegram
  bun PositionMonitor.ts --auto-sell  # Auto-sell positions hitting exit rules
  bun PositionMonitor.ts --dry-run    # Report only, no sells or notifications
  bun PositionMonitor.ts --help

Exit Rules by Strategy:

  MOMENTUM:
    - Trailing stop at 2x ATR below high water mark
    - Close below 20 SMA for 2+ consecutive days
    - Hard stop: -7% from entry (safety net)
    - Max hold: 40 trading days (~8 weeks)

  MEAN REVERSION:
    - RSI > 50 (mean reverted, take profit)
    - Price reaches 20 SMA (mean reverted)
    - Price breaks below 200 SMA (thesis broken)
    - Max hold: 15 trading days

  LEGACY (no strategy tag):
    - Stop-loss: -7% from entry
    - Take-profit: +10% from entry
    - Max hold: 20 trading days

Recommended cron schedule:
  # Weekdays at 3:55 PM EST (5 min before market close)
  55 20 * * 1-5 cd /path/to/harvest && bun src/execution/PositionMonitor.ts --auto-sell
`);
}

// --- Main ---
async function main() {
  const args = parseArgs(process.argv);

  if (args.help) {
    showHelp();
    process.exit(0);
  }

  const autoSell = !!args["auto-sell"];
  const dryRun = !!args["dry-run"];

  log(`Starting Position Monitor (auto-sell: ${autoSell}, dry-run: ${dryRun})`);

  // Fetch positions
  const positions = await alpacaFetch("/v2/positions");
  if (!positions || !Array.isArray(positions)) {
    log("No positions found or API error.");
    if (!dryRun) await sendTelegram([], []);
    process.exit(0);
  }

  log(`Found ${positions.length} open positions`);

  // Load recommendations for strategy data
  let recs: Recommendation[] = [];
  if (existsSync(RECS_FILE)) {
    try {
      recs = JSON.parse(readFileSync(RECS_FILE, "utf-8"));
    } catch {
      recs = [];
    }
  }

  // Analyze positions with strategy-aware rules
  const alerts = await analyzePositions(positions, recs);
  log(`Generated ${alerts.length} alerts`);

  if (dryRun) {
    log("DRY RUN — no actions taken");
    console.log(JSON.stringify({ positions: positions.length, alerts }, null, 2));
    process.exit(0);
  }

  // Execute auto-sells
  const sellResults: any[] = [];
  if (autoSell) {
    const sellAlerts = alerts.filter((a) => a.action === "SELL");
    for (const alert of sellAlerts) {
      await cancelStopOrders(alert.symbol);

      const result = await executeSell(alert.symbol, alert.qty);
      if (result?.id) {
        log(`  Sold ${alert.qty} ${alert.symbol} (order: ${result.id})`);
        const rec = recs.find((r) => r.ticker === alert.symbol && (r.status === "executed" || r.status === "active"));
        if (rec) {
          rec.status = "closed";
          rec.closedAt = new Date().toISOString();
          rec.closeReason = alert.alertType;
          rec.closePL = alert.plPct;
          rec.closeStrategy = alert.strategy;
        }
        await journalClosedTrade(alert, result);
      } else {
        log(`  Failed to sell ${alert.symbol}: ${JSON.stringify(result)}`);
      }
      sellResults.push({ symbol: alert.symbol, ...result });
    }

    if (sellResults.length > 0 || recs.some(r => r.highWaterMark)) {
      writeFileSync(RECS_FILE, JSON.stringify(recs, null, 2));
    }
  }

  await sendTelegram(alerts, sellResults);
  saveMonitorLog(alerts, sellResults);

  log("Position Monitor complete.");
}

main().catch((e) => {
  log(`Fatal error: ${e}`);
  process.exit(1);
});
