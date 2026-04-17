#!/usr/bin/env bun
/**
 * WeeklyReport.ts - Trading Performance Analytics
 *
 * Analyzes closed trades to identify what's working and what's not.
 * Tracks: win rate, avg gain/loss, best/worst sources, R:R ratio, streaks.
 * Sends weekly summary to Telegram and saves to data/reports/.
 *
 * Usage:
 *   bun WeeklyReport.ts              # This week's performance
 *   bun WeeklyReport.ts --all        # All-time performance
 *   bun WeeklyReport.ts --weeks 4    # Last 4 weeks
 *   bun WeeklyReport.ts --dry-run    # Print only, no Telegram
 *   bun WeeklyReport.ts --help
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { sendDiscord } from "../notifications/discord-notify.js";

// --- Paths ---
const PROJECT_ROOT = resolve(dirname(new URL(import.meta.url).pathname), "../..");
const DATA_DIR = resolve(PROJECT_ROOT, "data");
const RECS_FILE = resolve(DATA_DIR, "recommendations.json");
const REPORTS_DIR = resolve(DATA_DIR, "reports");

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
  executedAt?: string;
  closedAt?: string;
  closeReason?: string;
  closePL?: number;
  strength: string;
  sources?: string[];
  qtyOrdered?: number;
}

interface PerformanceMetrics {
  period: string;
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  avgWinPct: number;
  avgLossPct: number;
  totalPLPct: number;
  bestTrade: { ticker: string; plPct: number } | null;
  worstTrade: { ticker: string; plPct: number } | null;
  avgHoldDays: number;
  profitFactor: number;
  bySource: Record<string, { trades: number; wins: number; winRate: number; avgPL: number }>;
  byStrength: Record<string, { trades: number; wins: number; winRate: number; avgPL: number }>;
  recommendations: {
    total: number;
    executed: number;
    rejected: number;
    expired: number;
    pending: number;
  };
}

// --- Helpers ---
const log = (msg: string) => console.error(`[WeeklyReport] ${msg}`);
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

function daysBetween(a: string, b: string): number {
  return Math.floor(
    (new Date(b).getTime() - new Date(a).getTime()) / (1000 * 60 * 60 * 24)
  );
}

// --- Analysis ---
function analyzePerformance(recs: Recommendation[], periodLabel: string): PerformanceMetrics {
  const closed = recs.filter((r) => r.status === "closed" && r.closePL !== undefined);
  const executed = recs.filter((r) => r.status === "executed" || r.status === "closed");

  const wins = closed.filter((r) => (r.closePL || 0) > 0);
  const losses = closed.filter((r) => (r.closePL || 0) <= 0);

  const avgWinPct = wins.length > 0
    ? wins.reduce((sum, r) => sum + (r.closePL || 0), 0) / wins.length
    : 0;

  const avgLossPct = losses.length > 0
    ? losses.reduce((sum, r) => sum + (r.closePL || 0), 0) / losses.length
    : 0;

  const totalPLPct = closed.reduce((sum, r) => sum + (r.closePL || 0), 0);

  const totalWinPct = wins.reduce((sum, r) => sum + (r.closePL || 0), 0);
  const totalLossPct = Math.abs(losses.reduce((sum, r) => sum + (r.closePL || 0), 0));
  const profitFactor = totalLossPct > 0 ? totalWinPct / totalLossPct : totalWinPct > 0 ? Infinity : 0;

  // Best and worst trades
  let bestTrade = null;
  let worstTrade = null;
  if (closed.length > 0) {
    const sorted = [...closed].sort((a, b) => (b.closePL || 0) - (a.closePL || 0));
    bestTrade = { ticker: sorted[0].ticker, plPct: sorted[0].closePL || 0 };
    worstTrade = { ticker: sorted[sorted.length - 1].ticker, plPct: sorted[sorted.length - 1].closePL || 0 };
  }

  // Average hold duration
  const holdDays = closed
    .filter((r) => r.executedAt && r.closedAt)
    .map((r) => daysBetween(r.executedAt!, r.closedAt!));
  const avgHoldDays = holdDays.length > 0
    ? holdDays.reduce((a, b) => a + b, 0) / holdDays.length
    : 0;

  // Performance by source
  const bySource: Record<string, { trades: number; wins: number; totalPL: number }> = {};
  for (const rec of closed) {
    const sources = rec.sources || ["Unknown"];
    for (const source of sources) {
      if (!bySource[source]) bySource[source] = { trades: 0, wins: 0, totalPL: 0 };
      bySource[source].trades++;
      if ((rec.closePL || 0) > 0) bySource[source].wins++;
      bySource[source].totalPL += rec.closePL || 0;
    }
  }

  const bySourceFormatted: Record<string, { trades: number; wins: number; winRate: number; avgPL: number }> = {};
  for (const [source, data] of Object.entries(bySource)) {
    bySourceFormatted[source] = {
      trades: data.trades,
      wins: data.wins,
      winRate: data.trades > 0 ? (data.wins / data.trades) * 100 : 0,
      avgPL: data.trades > 0 ? data.totalPL / data.trades : 0,
    };
  }

  // Performance by signal strength
  const byStrength: Record<string, { trades: number; wins: number; totalPL: number }> = {};
  for (const rec of closed) {
    const strength = rec.strength || "Unknown";
    if (!byStrength[strength]) byStrength[strength] = { trades: 0, wins: 0, totalPL: 0 };
    byStrength[strength].trades++;
    if ((rec.closePL || 0) > 0) byStrength[strength].wins++;
    byStrength[strength].totalPL += rec.closePL || 0;
  }

  const byStrengthFormatted: Record<string, { trades: number; wins: number; winRate: number; avgPL: number }> = {};
  for (const [strength, data] of Object.entries(byStrength)) {
    byStrengthFormatted[strength] = {
      trades: data.trades,
      wins: data.wins,
      winRate: data.trades > 0 ? (data.wins / data.trades) * 100 : 0,
      avgPL: data.trades > 0 ? data.totalPL / data.trades : 0,
    };
  }

  // Recommendation funnel
  const recommendations = {
    total: recs.length,
    executed: recs.filter((r) => r.status === "executed" || r.status === "closed").length,
    rejected: recs.filter((r) => r.status === "rejected").length,
    expired: recs.filter((r) => r.status === "expired").length,
    pending: recs.filter((r) => r.status === "pending").length,
  };

  return {
    period: periodLabel,
    totalTrades: closed.length,
    wins: wins.length,
    losses: losses.length,
    winRate: closed.length > 0 ? (wins.length / closed.length) * 100 : 0,
    avgWinPct,
    avgLossPct,
    totalPLPct,
    bestTrade,
    worstTrade,
    avgHoldDays,
    profitFactor,
    bySource: bySourceFormatted,
    byStrength: byStrengthFormatted,
    recommendations,
  };
}

// --- Report Formatting ---
function formatReport(metrics: PerformanceMetrics): string {
  const lines: string[] = [];

  lines.push(`*Harvest Trading Report* — ${metrics.period}`);
  lines.push(``);

  if (metrics.totalTrades === 0) {
    lines.push(`No closed trades yet for this period.`);
    lines.push(``);
    lines.push(`*Recommendation Funnel:*`);
    lines.push(`- Total: ${metrics.recommendations.total}`);
    lines.push(`- Executed: ${metrics.recommendations.executed}`);
    lines.push(`- Pending: ${metrics.recommendations.pending}`);
    lines.push(`- Rejected: ${metrics.recommendations.rejected}`);
    lines.push(`- Expired: ${metrics.recommendations.expired}`);
    return lines.join("\n");
  }

  // Overview
  lines.push(`*Performance Overview:*`);
  lines.push(`- Trades: ${metrics.totalTrades} (${metrics.wins}W / ${metrics.losses}L)`);
  lines.push(`- Win Rate: ${metrics.winRate.toFixed(1)}%`);
  lines.push(`- Total P&L: ${metrics.totalPLPct > 0 ? "+" : ""}${metrics.totalPLPct.toFixed(2)}%`);
  lines.push(`- Profit Factor: ${metrics.profitFactor === Infinity ? "inf" : metrics.profitFactor.toFixed(2)}`);
  lines.push(`- Avg Hold: ${metrics.avgHoldDays.toFixed(1)} days`);
  lines.push(``);

  // Win/Loss breakdown
  lines.push(`*Win/Loss:*`);
  lines.push(`- Avg Win: +${metrics.avgWinPct.toFixed(2)}%`);
  lines.push(`- Avg Loss: ${metrics.avgLossPct.toFixed(2)}%`);
  if (metrics.bestTrade) {
    lines.push(`- Best: ${metrics.bestTrade.ticker} (+${metrics.bestTrade.plPct.toFixed(1)}%)`);
  }
  if (metrics.worstTrade) {
    lines.push(`- Worst: ${metrics.worstTrade.ticker} (${metrics.worstTrade.plPct.toFixed(1)}%)`);
  }
  lines.push(``);

  // Source performance
  if (Object.keys(metrics.bySource).length > 0) {
    lines.push(`*Signal Source Performance:*`);
    const sorted = Object.entries(metrics.bySource).sort((a, b) => b[1].avgPL - a[1].avgPL);
    for (const [source, data] of sorted) {
      const indicator = data.avgPL > 0 ? "[+]" : "[-]";
      lines.push(`${indicator} ${source}: ${data.winRate.toFixed(0)}% win (${data.trades} trades, avg ${data.avgPL > 0 ? "+" : ""}${data.avgPL.toFixed(2)}%)`);
    }
    lines.push(``);
  }

  // Strength performance
  if (Object.keys(metrics.byStrength).length > 0) {
    lines.push(`*Signal Strength Performance:*`);
    const strengthOrder = ["Very High", "High", "Medium-High", "Medium", "Low"];
    for (const strength of strengthOrder) {
      const data = metrics.byStrength[strength];
      if (!data) continue;
      const indicator = data.avgPL > 0 ? "[+]" : "[-]";
      lines.push(`${indicator} ${strength}: ${data.winRate.toFixed(0)}% win (${data.trades} trades, avg ${data.avgPL > 0 ? "+" : ""}${data.avgPL.toFixed(2)}%)`);
    }
    lines.push(``);
  }

  // Recommendations funnel
  lines.push(`*Recommendation Funnel:*`);
  lines.push(`- Generated: ${metrics.recommendations.total}`);
  lines.push(`- Executed: ${metrics.recommendations.executed}`);
  lines.push(`- Pending: ${metrics.recommendations.pending}`);
  lines.push(`- Rejected: ${metrics.recommendations.rejected}`);
  lines.push(`- Expired: ${metrics.recommendations.expired}`);
  lines.push(``);

  // Tuning suggestions
  lines.push(`*Tuning Suggestions:*`);
  if (metrics.winRate < 50) {
    lines.push(`- Win rate below 50% — consider tightening signal requirements`);
  }
  if (metrics.avgLossPct < -3) {
    lines.push(`- Avg loss above 3% — consider tighter stop-losses`);
  }
  if (metrics.profitFactor < 1.5) {
    lines.push(`- Profit factor below 1.5 — need bigger wins or smaller losses`);
  }

  // Source-specific suggestions
  const worstSource = Object.entries(metrics.bySource)
    .filter(([_, d]) => d.trades >= 3)
    .sort((a, b) => a[1].avgPL - b[1].avgPL)[0];
  if (worstSource && worstSource[1].avgPL < 0) {
    lines.push(`- ${worstSource[0]} signals are losing money — consider removing or reducing weight`);
  }

  const bestSource = Object.entries(metrics.bySource)
    .filter(([_, d]) => d.trades >= 3)
    .sort((a, b) => b[1].avgPL - a[1].avgPL)[0];
  if (bestSource && bestSource[1].avgPL > 0) {
    lines.push(`- ${bestSource[0]} signals are most profitable — consider increasing weight`);
  }

  if (metrics.winRate >= 50 && metrics.profitFactor >= 1.5) {
    lines.push(`- Strategy is performing well — maintain current parameters`);
  }

  return lines.join("\n");
}

// --- Telegram ---
async function sendTelegram(text: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    log("Telegram not configured");
    return;
  }

  // Telegram has a 4096 char limit, split if needed
  const chunks: string[] = [];
  if (text.length > 4000) {
    const lines = text.split("\n");
    let chunk = "";
    for (const line of lines) {
      if (chunk.length + line.length + 1 > 4000) {
        chunks.push(chunk);
        chunk = line;
      } else {
        chunk += (chunk ? "\n" : "") + line;
      }
    }
    if (chunk) chunks.push(chunk);
  } else {
    chunks.push(text);
  }

  for (const chunk of chunks) {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: chunk, parse_mode: "Markdown" }),
    });
  }
  log("Telegram report sent");

  await sendDiscord(text);
}

// --- Help ---
function showHelp() {
  console.log(`
Weekly Trading Report - Performance Analytics

Usage:
  bun WeeklyReport.ts              # This week's performance
  bun WeeklyReport.ts --all        # All-time performance
  bun WeeklyReport.ts --weeks 4    # Last N weeks
  bun WeeklyReport.ts --dry-run    # Print only, no Telegram
  bun WeeklyReport.ts --help

Reports:
  - Win/Loss rate and total P&L
  - Best and worst trades
  - Performance by signal source (Momentum, MeanReversion)
  - Performance by signal strength (Very High to Low)
  - Recommendation funnel (generated to executed to closed)
  - Automated tuning suggestions

Recommended cron:
  # Friday 5 PM EST (22:00 UTC)
  0 22 * * 5 cd /path/to/harvest && bun src/reporting/WeeklyReport.ts
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
  const allTime = !!args.all;
  const weeks = args.weeks ? parseInt(args.weeks as string, 10) : 1;

  // Load recommendations
  let recs: Recommendation[] = [];
  if (existsSync(RECS_FILE)) {
    try {
      recs = JSON.parse(readFileSync(RECS_FILE, "utf-8"));
    } catch {
      recs = [];
    }
  }

  log(`Loaded ${recs.length} total recommendations`);

  // Filter by time period
  let periodLabel: string;
  if (allTime) {
    periodLabel = "All Time";
  } else {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - weeks * 7);
    const cutoffStr = cutoff.toISOString();
    recs = recs.filter((r) => r.createdAt >= cutoffStr);
    periodLabel = weeks === 1 ? `Week of ${today()}` : `Last ${weeks} Weeks`;
  }

  log(`Analyzing ${recs.length} recommendations for period: ${periodLabel}`);

  // Run analysis
  const metrics = analyzePerformance(recs, periodLabel);

  // Format report
  const reportText = formatReport(metrics);

  // Save report
  if (!existsSync(REPORTS_DIR)) mkdirSync(REPORTS_DIR, { recursive: true });
  const reportFile = resolve(REPORTS_DIR, `${today()}-weekly.json`);
  writeFileSync(reportFile, JSON.stringify(metrics, null, 2));
  log(`Report saved: ${reportFile}`);

  if (dryRun) {
    console.log(reportText);
    process.exit(0);
  }

  // Send to Telegram
  await sendTelegram(reportText);

  log("Weekly Report complete.");
}

main().catch((e) => {
  log(`Fatal error: ${e}`);
  process.exit(1);
});
