#!/usr/bin/env bun
/**
 * DailyReport.ts - Harvest End-of-Day Trading Report
 *
 * Generates and sends a comprehensive daily trading summary via Telegram.
 * Designed to run at 6 PM CST (midnight UTC) every trading day.
 *
 * Report includes:
 * - Account status (equity, cash, daily P&L)
 * - Trades executed today
 * - All open positions with current P&L
 * - Trades closed today (stop-loss, take-profit, expiry)
 *
 * Usage:
 *   bun DailyReport.ts              # Generate and send daily report
 *   bun DailyReport.ts --dry-run    # Print report without sending
 *   bun DailyReport.ts --help
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { sendDiscord } from "../notifications/discord-notify.js";

// --- Paths ---
const PROJECT_ROOT = resolve(dirname(new URL(import.meta.url).pathname), "../..");
const DATA_DIR = resolve(PROJECT_ROOT, "data");
const RECS_FILE = resolve(DATA_DIR, "recommendations.json");
const REPORTS_DIR = resolve(DATA_DIR, "daily-reports");

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
  direction: string;
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  positionSizePct: number;
  conviction: number;
  thesis: string;
  status: string;
  createdAt: string;
  strength: string;
  sources: string[];
  executedAt?: string;
  executionPrice?: number;
  executionQty?: number;
  closedAt?: string;
  closeReason?: string;
  closePL?: number;
  researchScore?: number;
  researchSummary?: string;
  strategy?: string;
  [key: string]: any;
}

interface Position {
  symbol: string;
  qty: string;
  avg_entry_price: string;
  current_price: string;
  unrealized_pl: string;
  unrealized_plpc: string;
  market_value: string;
  cost_basis: string;
}

interface Account {
  equity: string;
  last_equity: string;
  buying_power: string;
  cash: string;
  portfolio_value: string;
  long_market_value: string;
}

// --- Helpers ---
const log = (msg: string) => console.error(`[DailyReport] ${msg}`);
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
async function alpacaFetch(endpoint: string): Promise<any> {
  const apiKey = process.env.ALPACA_API_KEY || "";
  const apiSecret = process.env.ALPACA_API_SECRET || "";
  const baseUrl = process.env.ALPACA_BASE_URL || "https://paper-api.alpaca.markets";

  if (!apiKey || !apiSecret) {
    log("ERROR: Alpaca API keys not configured");
    return null;
  }

  const resp = await fetch(`${baseUrl}${endpoint}`, {
    headers: {
      "APCA-API-KEY-ID": apiKey,
      "APCA-API-SECRET-KEY": apiSecret,
      "Content-Type": "application/json",
    },
  });

  if (!resp.ok) {
    log(`Alpaca API error: HTTP ${resp.status}`);
    return null;
  }

  return resp.json();
}

// --- Get today's orders ---
async function getTodaysOrders(): Promise<any[]> {
  const todayStr = today();
  const orders = await alpacaFetch(`/v2/orders?status=all&after=${todayStr}T00:00:00Z&limit=100`);
  return orders || [];
}

// --- Build Report ---
async function buildReport(): Promise<{
  text: string;
  reportData: any;
}> {
  const account = (await alpacaFetch("/v2/account")) as Account | null;
  if (!account) {
    return { text: "Failed to get account info", reportData: null };
  }

  const equity = parseFloat(account.equity);
  const lastEquity = parseFloat(account.last_equity);
  const dailyPL = equity - lastEquity;
  const dailyPLPct = lastEquity > 0 ? (dailyPL / lastEquity) * 100 : 0;
  const cash = parseFloat(account.cash);
  const longValue = parseFloat(account.long_market_value);

  const positions = ((await alpacaFetch("/v2/positions")) as Position[]) || [];
  const orders = await getTodaysOrders();
  const filledBuys = orders.filter((o: any) => o.side === "buy" && o.status === "filled");
  const filledSells = orders.filter((o: any) => o.side === "sell" && o.status === "filled");

  let recs: Recommendation[] = [];
  if (existsSync(RECS_FILE)) {
    try {
      recs = JSON.parse(readFileSync(RECS_FILE, "utf-8"));
    } catch {
      recs = [];
    }
  }

  const todayStr = today();
  const todaysExecutions = recs.filter(
    (r) => r.executedAt && r.executedAt.startsWith(todayStr)
  );
  const todaysClosures = recs.filter(
    (r) => r.closedAt && r.closedAt.startsWith(todayStr)
  );

  // --- Build message ---
  const lines: string[] = [];

  const plSign = dailyPL >= 0 ? "+" : "";
  lines.push(`*Harvest Daily Report* — ${todayStr}`);
  lines.push(``);

  lines.push(`*Account Summary*`);
  lines.push(`- Equity: $${equity.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
  lines.push(`- Cash: $${cash.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
  lines.push(`- Invested: $${longValue.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
  lines.push(`- Daily P&L: ${plSign}$${dailyPL.toFixed(2)} (${plSign}${dailyPLPct.toFixed(2)}%)`);

  const targetMet = dailyPLPct >= 0.12;
  lines.push(`- Daily Target (0.12%): ${targetMet ? "MET" : `MISSED (${dailyPLPct.toFixed(2)}% / 0.12%)`}`);
  lines.push(``);

  // Trades executed today
  if (todaysExecutions.length > 0) {
    lines.push(`*Trades Executed Today (${todaysExecutions.length}):*`);
    for (const rec of todaysExecutions) {
      const value = ((rec.executionQty || 0) * (rec.executionPrice || 0)).toFixed(2);
      const stratTag = rec.strategy === "momentum" ? "MOM" : rec.strategy === "mean_reversion" ? "MREV" : "STD";
      lines.push(``);
      lines.push(`*${rec.ticker}* [${stratTag}] — ${rec.direction}`);
      lines.push(`  ${rec.executionQty} shares @ $${(rec.executionPrice || 0).toFixed(2)} ($${value})`);
      lines.push(`  Conviction: ${rec.conviction}/10`);
      lines.push(`  Thesis: ${rec.thesis.slice(0, 200)}${rec.thesis.length > 200 ? "..." : ""}`);
    }
    lines.push(``);
  } else if (filledBuys.length > 0) {
    lines.push(`*Buys Today (${filledBuys.length}):*`);
    for (const order of filledBuys) {
      lines.push(`- ${order.symbol}: ${order.filled_qty} shares @ $${parseFloat(order.filled_avg_price).toFixed(2)}`);
    }
    lines.push(``);
  } else {
    lines.push(`*No new trades today*`);
    lines.push(``);
  }

  // Trades closed today
  if (todaysClosures.length > 0 || filledSells.length > 0) {
    const closedCount = todaysClosures.length || filledSells.length;
    lines.push(`*Positions Closed Today (${closedCount}):*`);
    for (const rec of todaysClosures) {
      const plPct = rec.closePL || 0;
      lines.push(`- *${rec.ticker}*: ${plPct >= 0 ? "+" : ""}${plPct.toFixed(1)}% (${rec.closeReason || "manual"})`);
    }
    for (const order of filledSells) {
      if (!todaysClosures.find((r) => r.ticker === order.symbol)) {
        lines.push(`- ${order.symbol}: Sold ${order.filled_qty} shares @ $${parseFloat(order.filled_avg_price).toFixed(2)}`);
      }
    }
    lines.push(``);
  }

  // Open positions
  if (positions.length > 0) {
    lines.push(`*Open Positions (${positions.length}):*`);
    let totalUnrealizedPL = 0;
    for (const pos of positions) {
      const pl = parseFloat(pos.unrealized_pl);
      const plPct = parseFloat(pos.unrealized_plpc) * 100;
      const entry = parseFloat(pos.avg_entry_price);
      const current = parseFloat(pos.current_price);
      const value = parseFloat(pos.market_value);
      totalUnrealizedPL += pl;

      lines.push(`*${pos.symbol}*: ${pos.qty} shares`);
      lines.push(`  Entry: $${entry.toFixed(2)} → Current: $${current.toFixed(2)}`);
      lines.push(`  P&L: ${pl >= 0 ? "+" : ""}$${pl.toFixed(2)} (${plPct >= 0 ? "+" : ""}${plPct.toFixed(1)}%)`);
      lines.push(`  Value: $${value.toFixed(2)}`);

      const rec = recs.find(
        (r) => r.ticker === pos.symbol && (r.status === "executed" || r.status === "active")
      );
      if (rec) {
        lines.push(`  SL: $${rec.stopLoss.toFixed(2)} | TP: $${rec.takeProfit.toFixed(2)}`);
      }
    }
    lines.push(``);
    lines.push(`*Total Unrealized P&L:* ${totalUnrealizedPL >= 0 ? "+" : ""}$${totalUnrealizedPL.toFixed(2)}`);
  } else {
    lines.push(`*No open positions*`);
  }
  lines.push(``);

  lines.push(`_Report generated ${new Date().toLocaleString("en-US", { timeZone: "America/Chicago" })} CST_`);

  const text = lines.join("\n");

  const reportData = {
    date: todayStr,
    timestamp: new Date().toISOString(),
    account: { equity, lastEquity, dailyPL, dailyPLPct, cash, longValue },
    tradesExecuted: todaysExecutions.length,
    tradesClosed: todaysClosures.length,
    openPositions: positions.length,
    positions: positions.map((p) => ({
      symbol: p.symbol, qty: p.qty,
      entry: parseFloat(p.avg_entry_price),
      current: parseFloat(p.current_price),
      pl: parseFloat(p.unrealized_pl),
      plPct: parseFloat(p.unrealized_plpc) * 100,
    })),
    targetMet,
  };

  return { text, reportData };
}

// --- Send via Telegram ---
async function sendTelegram(text: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    log("Telegram not configured");
    return;
  }

  const maxLen = 4000;
  const parts: string[] = [];
  if (text.length <= maxLen) {
    parts.push(text);
  } else {
    let current = "";
    for (const line of text.split("\n")) {
      if (current.length + line.length + 1 > maxLen) {
        parts.push(current);
        current = line;
      } else {
        current += (current ? "\n" : "") + line;
      }
    }
    if (current) parts.push(current);
  }

  for (const part of parts) {
    try {
      const resp = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text: part, parse_mode: "Markdown" }),
      });
      if (!resp.ok) {
        const body = await resp.text();
        log(`Telegram error: HTTP ${resp.status} - ${body}`);
      }
    } catch (e) {
      log(`Telegram error: ${e}`);
    }
  }

  log("Telegram report sent");
  await sendDiscord(text);
}

// --- Save report ---
function saveReport(reportData: any): void {
  if (!existsSync(REPORTS_DIR)) mkdirSync(REPORTS_DIR, { recursive: true });
  const file = resolve(REPORTS_DIR, `${today()}.json`);
  writeFileSync(file, JSON.stringify(reportData, null, 2));
  log(`Report saved: ${file}`);
}

// --- Main ---
async function main() {
  const args = parseArgs(process.argv);

  if (args.help) {
    console.log(`
DailyReport - Harvest End-of-Day Trading Summary

Usage:
  bun DailyReport.ts              # Generate and send report
  bun DailyReport.ts --dry-run    # Print report, don't send
  bun DailyReport.ts --help

Recommended cron schedule (weekdays at 6 PM CST):
  0 0 * * 2-6 cd /path/to/harvest && bun src/reporting/DailyReport.ts
`);
    process.exit(0);
  }

  const dryRun = !!args["dry-run"];
  log(`Generating daily report (dry-run: ${dryRun})`);

  const { text, reportData } = await buildReport();

  if (dryRun) {
    console.log(text);
    console.log("\n--- Report Data ---");
    console.log(JSON.stringify(reportData, null, 2));
    process.exit(0);
  }

  if (reportData) {
    saveReport(reportData);
  }

  await sendTelegram(text);
  log("Daily report complete.");
}

main().catch((e) => {
  log(`Fatal error: ${e}`);
  process.exit(1);
});
