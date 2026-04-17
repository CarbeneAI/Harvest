#!/usr/bin/env bun
/**
 * PortfolioReview.ts - Friday Portfolio Review with Research-Driven Evaluation
 *
 * Evaluates ALL open positions every Friday, running fresh research + news checks
 * on each, and generating Hold/Sell/Add recommendations. Advisory only (no auto-selling).
 *
 * Usage:
 *   bun PortfolioReview.ts              # Full portfolio review
 *   bun PortfolioReview.ts --dry-run    # Review without saving/notifying
 *   bun PortfolioReview.ts --help
 *
 * Schedule: Friday 4:30 PM EST (21:30 UTC)
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { runDeepResearch, loadCached, type ResearchResult } from "../research/DeepResearch.js";
import { sendDiscord } from "../notifications/discord-notify.js";

// --- Paths ---
const PROJECT_ROOT = resolve(dirname(new URL(import.meta.url).pathname), "../..");
const DATA_DIR = resolve(PROJECT_ROOT, "data");
const REVIEWS_DIR = resolve(DATA_DIR, "reviews");
const RECS_FILE = resolve(DATA_DIR, "recommendations.json");

// Ensure reviews directory exists
if (!existsSync(REVIEWS_DIR)) mkdirSync(REVIEWS_DIR, { recursive: true });

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

const log = (msg: string) => console.error(`[PortfolioReview] ${msg}`);
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

// --- Interfaces ---
interface PositionReview {
  symbol: string;
  entryPrice: number;
  currentPrice: number;
  plPct: number;
  daysHeld: number;
  originalThesis: string;
  action: "HOLD" | "SELL" | "ADD";
  reasoning: string;
  urgency: "low" | "medium" | "high";
  riskFactors: string[];
  upcomingEarnings?: string;
  newsHighlights: string[];
}

interface PortfolioReviewReport {
  date: string;
  timestamp: string;
  positionsReviewed: number;
  reviews: PositionReview[];
  summary: {
    sell: number;
    add: number;
    hold: number;
    portfolioHealth: string;
  };
}

// --- Trader Evaluation Persona ---
const TRADER_PERSONA = `You are a professional stock trader with 30+ years of experience across bull and bear markets. You:
- Read trends others miss — identify under-the-radar companies poised for breakout growth
- Follow smart money — track institutional flows and fund managers
- Are an SEC filing expert — read 10-K/10-Q filings fluently
- Have a risk-first mindset — knowing when NOT to trade is just as important as when to enter
- Recognize macro patterns from decades of experience in both bull and bear markets
- Target 30% annualized return (~0.12% per trading day), exceeding broad market averages`;

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

// --- Perplexity API ---
async function perplexityQuery(prompt: string): Promise<string> {
  const apiKey = process.env.PERPLEXITY_API_KEY;
  if (!apiKey) throw new Error("PERPLEXITY_API_KEY not set");

  const resp = await fetch("https://api.perplexity.ai/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "sonar",
      messages: [{ role: "user", content: prompt }],
      max_tokens: 1500,
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Perplexity API error (${resp.status}): ${errText.slice(0, 300)}`);
  }

  const data = await resp.json();
  return data.choices?.[0]?.message?.content || "";
}

// --- Get research for a position (use cache if < 3 days old) ---
async function getResearchForPosition(ticker: string): Promise<string> {
  // Check cache
  const cached = loadCached(ticker);
  if (cached && cached.status === "complete") {
    const cacheAge = Date.now() - new Date(cached.generatedAt).getTime();
    const threeDays = 3 * 24 * 60 * 60 * 1000;
    if (cacheAge < threeDays) {
      log(`  Using cached research for ${ticker} (${Math.round(cacheAge / (1000 * 60 * 60))}h old)`);
      const sections = Object.values(cached.sections)
        .filter((s) => s.status === "complete" && s.content)
        .map((s) => `### ${s.title}\n${s.content.slice(0, 800)}`)
        .join("\n\n");
      return sections || "No research sections available.";
    }
  }

  // Run fresh research
  log(`  Running fresh research for ${ticker}...`);
  try {
    const research = await runDeepResearch(ticker, true);
    const sections = Object.values(research.sections)
      .filter((s) => s.status === "complete" && s.content)
      .map((s) => `### ${s.title}\n${s.content.slice(0, 800)}`)
      .join("\n\n");
    return sections || "Research completed but no sections available.";
  } catch (err: any) {
    log(`  Research failed for ${ticker}: ${err.message}`);
    return "Research unavailable.";
  }
}

// --- Fetch recent news for a ticker ---
async function fetchRecentNews(ticker: string): Promise<string> {
  try {
    const prompt = `List the top 5 most important news items for stock ticker ${ticker} from the last 3 business days. For each item, include the date and a 1-sentence summary. If there's no significant news, say "No significant news in last 3 days."`;
    return await perplexityQuery(prompt);
  } catch (err: any) {
    log(`  News fetch failed for ${ticker}: ${err.message}`);
    return "News unavailable.";
  }
}

// --- Check upcoming earnings ---
async function checkUpcomingEarnings(ticker: string): Promise<string> {
  try {
    const prompt = `When is the next earnings report date for stock ticker ${ticker}? Reply with ONLY the date (YYYY-MM-DD format) or "none" if not scheduled or unknown.`;
    const result = await perplexityQuery(prompt);
    const cleaned = result.trim().toLowerCase();
    if (cleaned.includes("none") || cleaned.includes("unknown") || cleaned.includes("not")) {
      return "";
    }
    // Try to extract a date
    const dateMatch = result.match(/\d{4}-\d{2}-\d{2}/);
    return dateMatch ? dateMatch[0] : result.trim().slice(0, 50);
  } catch {
    return "";
  }
}

// --- Evaluate a single position ---
async function evaluatePosition(
  position: any,
  originalThesis: string,
  daysHeld: number
): Promise<PositionReview> {
  const symbol = position.symbol;
  const entryPrice = parseFloat(position.avg_entry_price);
  const currentPrice = parseFloat(position.current_price);
  const plPct = parseFloat(position.unrealized_plpc) * 100;

  log(`Evaluating ${symbol} (P&L: ${plPct.toFixed(1)}%, days: ${daysHeld})...`);

  // Fetch research, news, and earnings in parallel
  const [researchSummary, recentNews, upcomingEarnings] = await Promise.all([
    getResearchForPosition(symbol),
    fetchRecentNews(symbol),
    checkUpcomingEarnings(symbol),
  ]);

  // Build evaluation prompt
  const prompt = `${TRADER_PERSONA}

You are conducting a Friday end-of-week portfolio review. Evaluate this position and recommend an action.

## Position Details
- **Symbol:** ${symbol}
- **Entry Price:** $${entryPrice.toFixed(2)}
- **Current Price:** $${currentPrice.toFixed(2)}
- **P&L:** ${plPct.toFixed(2)}%
- **Days Held:** ${daysHeld}
- **Original Thesis:** ${originalThesis || "Technical momentum + mean reversion"}
${upcomingEarnings ? `- **Upcoming Earnings:** ${upcomingEarnings}` : "- **Upcoming Earnings:** None scheduled"}

## Latest Research
${researchSummary.slice(0, 3000)}

## Recent News (Last 3 Days)
${recentNews.slice(0, 1500)}

## Your Task
Respond with ONLY valid JSON (no markdown, no code fences) in this exact format:
{
  "action": "HOLD" or "SELL" or "ADD",
  "reasoning": "<2-3 sentence explanation of your recommendation>",
  "urgency": "low" or "medium" or "high",
  "riskFactors": ["<risk 1>", "<risk 2>"],
  "newsHighlights": ["<key news item 1>", "<key news item 2>"]
}

Consider:
- Swing trade framework (we use strategy-based hold periods)
- Risk/reward ratio at current price
- Whether the original thesis still holds
- Any new information that changes the outlook
- Upcoming earnings risk
- Whether adding to this position would be smart money`;

  try {
    const rawResponse = await perplexityQuery(prompt);

    // Parse JSON response
    let parsed: any;
    try {
      let cleaned = rawResponse.trim();
      if (cleaned.startsWith("```")) {
        cleaned = cleaned.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
      }
      parsed = JSON.parse(cleaned);
    } catch {
      log(`  Failed to parse JSON for ${symbol}, defaulting to HOLD`);
      parsed = {
        action: "HOLD",
        reasoning: "Unable to parse evaluation response. Defaulting to hold.",
        urgency: "low",
        riskFactors: [],
        newsHighlights: [],
      };
    }

    const action = ["HOLD", "SELL", "ADD"].includes(parsed.action?.toUpperCase())
      ? (parsed.action.toUpperCase() as "HOLD" | "SELL" | "ADD")
      : "HOLD";

    return {
      symbol,
      entryPrice,
      currentPrice,
      plPct,
      daysHeld,
      originalThesis: originalThesis || "Multi-signal confluence",
      action,
      reasoning: parsed.reasoning || "No reasoning provided.",
      urgency: ["low", "medium", "high"].includes(parsed.urgency) ? parsed.urgency : "low",
      riskFactors: Array.isArray(parsed.riskFactors) ? parsed.riskFactors : [],
      upcomingEarnings: upcomingEarnings || undefined,
      newsHighlights: Array.isArray(parsed.newsHighlights) ? parsed.newsHighlights : [],
    };
  } catch (err: any) {
    log(`  Evaluation failed for ${symbol}: ${err.message}`);
    return {
      symbol,
      entryPrice,
      currentPrice,
      plPct,
      daysHeld,
      originalThesis: originalThesis || "Multi-signal confluence",
      action: "HOLD",
      reasoning: `Evaluation failed: ${err.message}. Defaulting to hold.`,
      urgency: "low",
      riskFactors: ["Evaluation error"],
      newsHighlights: [],
    };
  }
}

// --- Save review report ---
function saveReport(report: PortfolioReviewReport): string {
  const file = resolve(REVIEWS_DIR, `${today()}-portfolio-review.json`);
  writeFileSync(file, JSON.stringify(report, null, 2));
  log(`Report saved: ${file}`);
  return file;
}

// --- Send Telegram notification ---
async function sendTelegram(report: PortfolioReviewReport): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    log("Telegram not configured");
    return;
  }

  const dashboardPort = process.env.DASHBOARD_PORT || "8083";
  const sellReviews = report.reviews.filter((r) => r.action === "SELL");
  const addReviews = report.reviews.filter((r) => r.action === "ADD");
  const holdReviews = report.reviews.filter((r) => r.action === "HOLD");

  const lines = [
    `*Friday Portfolio Review* — ${today()}`,
    ``,
    `*${report.positionsReviewed} Positions Reviewed*`,
  ];

  if (sellReviews.length > 0) {
    lines.push(``, `*SELL (${sellReviews.length}):*`);
    for (const r of sellReviews) {
      const plSign = r.plPct >= 0 ? "+" : "";
      lines.push(`- *${r.symbol}* — ${plSign}${r.plPct.toFixed(1)}% | ${r.reasoning.slice(0, 80)}`);
    }
  }

  if (addReviews.length > 0) {
    lines.push(``, `*ADD (${addReviews.length}):*`);
    for (const r of addReviews) {
      const plSign = r.plPct >= 0 ? "+" : "";
      lines.push(`- *${r.symbol}* — ${plSign}${r.plPct.toFixed(1)}% | ${r.reasoning.slice(0, 80)}`);
    }
  }

  if (holdReviews.length > 0) {
    lines.push(``, `*HOLD (${holdReviews.length}):*`);
    const holdSymbols = holdReviews.map((r) => r.symbol).join(", ");
    lines.push(`- ${holdSymbols}`);
  }

  lines.push(
    ``,
    `Portfolio Health: ${report.summary.portfolioHealth}`,
    `Dashboard: http://localhost:${dashboardPort}`
  );

  const text = lines.join("\n");

  try {
    const resp = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown" }),
    });

    if (!resp.ok) {
      log(`Telegram error: HTTP ${resp.status}`);
    } else {
      log("Telegram notification sent");
    }
  } catch (e) {
    log(`Telegram error: ${e}`);
  }

  await sendDiscord(text);
}

// --- Help ---
function showHelp() {
  console.log(`
Portfolio Review - Friday End-of-Week Position Evaluation

Usage:
  bun PortfolioReview.ts              # Full portfolio review
  bun PortfolioReview.ts --dry-run    # Review without saving/notifying
  bun PortfolioReview.ts --help

What it does:
  For each open position:
  1. Checks DeepResearch cache (uses if < 3 days old, else runs fresh)
  2. Fetches recent news (last 3 days) via Perplexity
  3. Checks upcoming earnings via Perplexity
  4. Evaluates position with expert trader persona
  5. Recommends: HOLD / SELL / ADD with reasoning and urgency

Output:
  - Review report saved to data/reviews/YYYY-MM-DD-portfolio-review.json
  - Telegram summary grouped by SELL/ADD/HOLD
  - Dashboard shows review badges on positions table

Recommended cron:
  # Friday at 4:30 PM EST (21:30 UTC)
  30 21 * * 5 cd /path/to/harvest && bun src/reporting/PortfolioReview.ts

Environment:
  ALPACA_API_KEY       Alpaca API key (required)
  ALPACA_API_SECRET    Alpaca API secret (required)
  PERPLEXITY_API_KEY   Perplexity API key (required)
  TELEGRAM_BOT_TOKEN   Telegram bot token (optional)
  TELEGRAM_CHAT_ID     Telegram chat ID (optional)
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

  log(`Starting Friday Portfolio Review (dry-run: ${dryRun})`);

  // Fetch open positions
  const positions = await alpacaFetch("/v2/positions");
  if (!positions || !Array.isArray(positions) || positions.length === 0) {
    log("No open positions to review.");
    if (!dryRun) {
      // Send empty review notification
      const emptyReport: PortfolioReviewReport = {
        date: today(),
        timestamp: new Date().toISOString(),
        positionsReviewed: 0,
        reviews: [],
        summary: { sell: 0, add: 0, hold: 0, portfolioHealth: "No positions" },
      };
      saveReport(emptyReport);
      await sendTelegram(emptyReport);
    }
    process.exit(0);
  }

  log(`Found ${positions.length} open positions`);

  // Load recommendations to get original thesis and execution dates
  let recs: any[] = [];
  if (existsSync(RECS_FILE)) {
    try {
      recs = JSON.parse(readFileSync(RECS_FILE, "utf-8"));
    } catch {
      recs = [];
    }
  }

  // Evaluate all positions in parallel
  const reviews: PositionReview[] = [];
  const now = new Date();

  const evaluationResults = await Promise.allSettled(
    positions.map((pos: any) => {
      const rec = recs.find(
        (r: any) => r.ticker === pos.symbol && (r.status === "executed" || r.status === "active")
      );
      const executedDate = rec?.executedAt ? new Date(rec.executedAt) : null;
      const daysHeld = executedDate
        ? Math.floor((now.getTime() - executedDate.getTime()) / (1000 * 60 * 60 * 24))
        : 0;
      const originalThesis = rec?.thesis || "";

      return evaluatePosition(pos, originalThesis, daysHeld);
    })
  );

  for (const result of evaluationResults) {
    if (result.status === "fulfilled") {
      reviews.push(result.value);
    }
  }

  // Build report
  const sellCount = reviews.filter((r) => r.action === "SELL").length;
  const addCount = reviews.filter((r) => r.action === "ADD").length;
  const holdCount = reviews.filter((r) => r.action === "HOLD").length;
  const needsAttention = sellCount + reviews.filter((r) => r.urgency === "high").length;

  let portfolioHealth: string;
  if (needsAttention === 0) {
    portfolioHealth = "Healthy (all positions on track)";
  } else if (needsAttention <= 2) {
    portfolioHealth = `Mixed (${needsAttention} position(s) need attention)`;
  } else {
    portfolioHealth = `Concerning (${needsAttention} positions need attention)`;
  }

  const report: PortfolioReviewReport = {
    date: today(),
    timestamp: new Date().toISOString(),
    positionsReviewed: reviews.length,
    reviews,
    summary: {
      sell: sellCount,
      add: addCount,
      hold: holdCount,
      portfolioHealth,
    },
  };

  // Log results
  log(`\nReview Results:`);
  for (const r of reviews) {
    const tag = r.action === "SELL" ? "[SELL]" : r.action === "ADD" ? "[ADD]" : "[HOLD]";
    const plSign = r.plPct >= 0 ? "+" : "";
    log(`  ${tag} ${r.symbol}: ${plSign}${r.plPct.toFixed(1)}% — ${r.reasoning.slice(0, 100)}`);
  }
  log(`\nPortfolio Health: ${portfolioHealth}`);

  if (dryRun) {
    log("DRY RUN — no saves or notifications");
    console.log(JSON.stringify(report, null, 2));
    process.exit(0);
  }

  // Save and notify
  saveReport(report);
  await sendTelegram(report);

  log("Friday Portfolio Review complete.");
}

main().catch((e) => {
  log(`Fatal error: ${e}`);
  process.exit(1);
});
