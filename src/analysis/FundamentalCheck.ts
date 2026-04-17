#!/usr/bin/env bun
/**
 * FundamentalCheck.ts - Buffett-Inspired Fundamental Quality Screen
 *
 * Fetches fundamental data and scores stocks against quality thresholds.
 *
 * Required metrics (all must pass):
 *   - ROE > 15%
 *   - Gross Margin > 30%
 *   - Debt-to-Equity < 1.0
 *   - Free Cash Flow positive (trailing)
 *
 * Bonus metrics:
 *   - Net Income Margin > 10%
 *   - Current Ratio > 1.2
 *
 * Valuation checks:
 *   - P/E vs sector average
 *   - Price vs 200-day MA
 *
 * Quality Score -> Signal Adjustment:
 *   1.0  All Required + 2 Bonus  -> signal +0.15 (STRONG AMPLIFY)
 *   0.8  All Required + 1 Bonus  -> signal +0.10 (AMPLIFY)
 *   0.6  All Required only       -> signal unchanged (NEUTRAL)
 *   0.3  Missing 1 Required      -> signal -0.10 (DAMPEN)
 *   0.0  Missing 2+ Required     -> DO NOT TRADE (SKIP)
 *
 * Usage:
 *   bun FundamentalCheck.ts --ticker AAPL
 *   bun FundamentalCheck.ts --ticker AAPL --json
 *   bun FundamentalCheck.ts --tickers AAPL,MSFT,KO
 *   bun FundamentalCheck.ts --help
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";

// --- Paths & Env ---
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

const log = (msg: string) => console.error(`[FundamentalCheck] ${msg}`);

// --- Interfaces ---

interface FundamentalData {
  ticker: string;
  companyName: string;
  sector: string;
  industry: string;
  currentPrice: number;
  returnOnEquity: number | null;
  grossMargin: number | null;
  netMargin: number | null;
  debtToEquity: number | null;
  freeCashFlow: number | null;
  currentRatio: number | null;
  trailingPE: number | null;
  forwardPE: number | null;
  priceToBook: number | null;
  sma200: number | null;
  pctFrom200DMA: number | null;
}

interface QualityMetric {
  name: string;
  value: number | null;
  threshold: string;
  pass: boolean;
  required: boolean;
  display: string;
}

export interface QualityScore {
  score: number;
  signalAdjustment: number;
  verdict: "SKIP" | "DAMPEN" | "NEUTRAL" | "AMPLIFY" | "STRONG_AMPLIFY";
  requiredPassed: number;
  requiredTotal: number;
  bonusPassed: number;
  bonusTotal: number;
  metrics: QualityMetric[];
}

interface ValuationCheck {
  peVsSector: "overvalued" | "fair" | "undervalued" | "unknown";
  sectorAvgPE: number | null;
  peRatioToSector: number | null;
  priceVs200DMA: "overvalued" | "fair" | "undervalued" | "unknown";
  pctFrom200DMA: number | null;
  overvaluedFlags: number;
  entryAdjustment: string;
}

type MoatType = "brand" | "network" | "switching" | "cost" | "regulatory" | "none";

interface MoatClassification {
  hasMoat: boolean;
  moatType: MoatType;
  moatLabel: string;
}

export interface FundamentalResult {
  ticker: string;
  companyName: string;
  sector: string;
  fundamentals: FundamentalData;
  quality: QualityScore;
  valuation: ValuationCheck;
  moat: MoatClassification;
  summary: string;
  status: "complete" | "error" | "etf_exempt";
  error?: string;
}

// --- Moat Watchlist ---

const MOAT_WATCHLIST: Record<string, { type: MoatType; label: string }> = {
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
  GOOG: { type: "network", label: "Search + Ad Network" },
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

// --- ETF Detection ---

const COMMON_ETFS = new Set([
  "SPY", "QQQ", "IWM", "DIA", "VOO", "VTI", "VXUS", "BND", "VEA", "VWO",
  "XLF", "XLE", "XLK", "XLV", "XLI", "XLU", "XLP", "XLY", "XLB", "XLRE",
  "ARKK", "ARKW", "ARKF", "ARKG", "ARKQ",
  "IVV", "ITOT", "SCHB", "SCHX", "SCHA",
  "GLD", "SLV", "USO", "UNG",
  "TLT", "HYG", "LQD", "AGG",
  "UVXY", "VXX", "SQQQ", "TQQQ", "SPXL", "SPXS",
  "QQQM", "SCHD", "VIG", "DGRO",
]);

function isETF(ticker: string): boolean {
  return COMMON_ETFS.has(ticker.toUpperCase());
}

// --- Sector Average P/E Ratios ---

const SECTOR_PE: Record<string, number> = {
  "Technology": 28,
  "Communication Services": 22,
  "Consumer Cyclical": 22,
  "Consumer Defensive": 23,
  "Financial Services": 14,
  "Healthcare": 22,
  "Industrials": 20,
  "Energy": 12,
  "Basic Materials": 16,
  "Real Estate": 35,
  "Utilities": 18,
};

function getSectorPE(sector: string): number | null {
  if (!sector) return null;
  if (SECTOR_PE[sector]) return SECTOR_PE[sector];
  for (const [key, pe] of Object.entries(SECTOR_PE)) {
    if (sector.toLowerCase().includes(key.toLowerCase()) ||
        key.toLowerCase().includes(sector.toLowerCase())) {
      return pe;
    }
  }
  return null;
}

// --- Yahoo Finance API ---

interface YahooQuoteSummary {
  financialData?: Record<string, any>;
  defaultKeyStatistics?: Record<string, any>;
  price?: Record<string, any>;
  summaryProfile?: Record<string, any>;
}

const CRUMB_CACHE_FILE = "/tmp/yahoo-finance-crumb.json";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

interface CrumbCache {
  crumb: string;
  cookies: string;
  timestamp: number;
}

function loadCrumbCache(): CrumbCache | null {
  if (!existsSync(CRUMB_CACHE_FILE)) return null;
  try {
    const data = JSON.parse(readFileSync(CRUMB_CACHE_FILE, "utf-8")) as CrumbCache;
    if (Date.now() - data.timestamp < 3600000 && data.crumb && data.cookies) {
      return data;
    }
  } catch {}
  return null;
}

function saveCrumbCache(crumb: string, cookies: string): void {
  try {
    writeFileSync(CRUMB_CACHE_FILE, JSON.stringify({
      crumb, cookies, timestamp: Date.now(),
    }));
  } catch {}
}

async function getYahooCrumb(): Promise<{ crumb: string; cookies: string } | null> {
  const cached = loadCrumbCache();
  if (cached) {
    log("Using cached Yahoo Finance crumb");
    return { crumb: cached.crumb, cookies: cached.cookies };
  }

  log("Fetching new Yahoo Finance crumb...");

  try {
    const consentResp = await fetch("https://fc.yahoo.com", {
      headers: { "User-Agent": UA },
      redirect: "manual",
    });

    const setCookies = consentResp.headers.getSetCookie?.() || [];
    const cookieStr = setCookies
      .map((c: string) => c.split(";")[0])
      .join("; ");

    if (!cookieStr) {
      log("No cookies received from fc.yahoo.com");
      return null;
    }

    const crumbResp = await fetch("https://query2.finance.yahoo.com/v1/test/getcrumb", {
      headers: {
        "User-Agent": UA,
        Cookie: cookieStr,
      },
    });

    if (!crumbResp.ok) {
      log(`Crumb endpoint returned ${crumbResp.status}`);
      return null;
    }

    const crumb = await crumbResp.text();
    if (!crumb || crumb.includes("Too Many") || crumb.length > 50) {
      log(`Invalid crumb received: ${crumb.slice(0, 30)}`);
      return null;
    }

    saveCrumbCache(crumb, cookieStr);
    log(`Got crumb: ${crumb.slice(0, 8)}...`);
    return { crumb, cookies: cookieStr };
  } catch (err: any) {
    log(`Crumb fetch error: ${err.message}`);
    return null;
  }
}

async function fetchYahooFundamentals(ticker: string): Promise<YahooQuoteSummary | null> {
  const modules = "financialData,defaultKeyStatistics,price,summaryProfile";

  const auth = await getYahooCrumb();
  if (auth) {
    try {
      const url = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${ticker}?modules=${modules}&crumb=${encodeURIComponent(auth.crumb)}`;
      const resp = await fetch(url, {
        headers: {
          "User-Agent": UA,
          Cookie: auth.cookies,
        },
      });

      if (resp.ok) {
        const data = await resp.json();
        const result = data?.quoteSummary?.result?.[0];
        if (result) return result as YahooQuoteSummary;
      } else {
        log(`Yahoo quoteSummary returned ${resp.status} for ${ticker}`);
        if (resp.status === 401 || resp.status === 403) {
          try {
            const { unlinkSync } = await import("fs");
            unlinkSync(CRUMB_CACHE_FILE);
          } catch {}
        }
      }
    } catch (err: any) {
      log(`Yahoo quoteSummary error: ${err.message}`);
    }
  }

  // Fallback: try query1 without crumb
  try {
    const url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${ticker}?modules=${modules}`;
    const resp = await fetch(url, {
      headers: { "User-Agent": UA },
    });

    if (resp.ok) {
      const data = await resp.json();
      const result = data?.quoteSummary?.result?.[0];
      if (result) return result as YahooQuoteSummary;
    }
  } catch {}

  log(`All Yahoo Finance methods failed for ${ticker}`);
  return null;
}

function extractRaw(obj: any): number | null {
  if (obj === undefined || obj === null) return null;
  if (typeof obj === "number") return obj;
  if (typeof obj === "object" && "raw" in obj) return obj.raw;
  return null;
}

// --- Alpaca API for 200-day SMA ---

async function fetch200DaySMA(ticker: string): Promise<number | null> {
  const key = process.env.ALPACA_API_KEY || "";
  const secret = process.env.ALPACA_API_SECRET || "";
  if (!key || !secret) return null;

  const end = new Date();
  const start = new Date(end.getTime() - 300 * 24 * 60 * 60 * 1000);
  const url = `https://data.alpaca.markets/v2/stocks/${ticker}/bars?timeframe=1Day&start=${start.toISOString().slice(0, 10)}&limit=250`;

  try {
    const resp = await fetch(url, {
      headers: {
        "APCA-API-KEY-ID": key,
        "APCA-API-SECRET-KEY": secret,
      },
    });

    if (!resp.ok) return null;

    const data = await resp.json();
    const bars = data.bars || [];
    if (bars.length < 200) return null;

    const closes = bars.slice(-200).map((b: any) => b.c);
    const sum = closes.reduce((a: number, b: number) => a + b, 0);
    return sum / 200;
  } catch {
    return null;
  }
}

// --- Parse Fundamentals ---

function parseFundamentals(ticker: string, yahoo: YahooQuoteSummary, sma200: number | null): FundamentalData {
  const fd = yahoo.financialData || {};
  const ks = yahoo.defaultKeyStatistics || {};
  const price = yahoo.price || {};
  const profile = yahoo.summaryProfile || {};

  const currentPrice = extractRaw(fd.currentPrice) ?? extractRaw(price.regularMarketPrice) ?? 0;
  const trailingPEfromPrice = price.trailingPE?.raw ?? price.trailingPE ?? null;

  const result: FundamentalData = {
    ticker,
    companyName: price.shortName || price.longName || ticker,
    sector: profile.sector || "",
    industry: profile.industry || "",
    currentPrice,
    returnOnEquity: extractRaw(fd.returnOnEquity),
    grossMargin: extractRaw(fd.grossMargins),
    netMargin: extractRaw(fd.profitMargins),
    debtToEquity: extractRaw(fd.debtToEquity),
    freeCashFlow: extractRaw(fd.freeCashflow),
    currentRatio: extractRaw(fd.currentRatio),
    trailingPE: extractRaw(ks.trailingPE) ?? extractRaw(fd.trailingPE) ?? (typeof trailingPEfromPrice === "number" ? trailingPEfromPrice : null),
    forwardPE: extractRaw(ks.forwardPE) ?? extractRaw(fd.forwardPE) ?? extractRaw(price.forwardPE),
    priceToBook: extractRaw(ks.priceToBook),
    sma200,
    pctFrom200DMA: sma200 && currentPrice ? ((currentPrice - sma200) / sma200) * 100 : null,
  };

  // Yahoo debtToEquity comes as percentage (e.g., 150 for 1.5x) — normalize to ratio
  if (result.debtToEquity !== null && result.debtToEquity > 10) {
    result.debtToEquity = result.debtToEquity / 100;
  }

  return result;
}

// --- Quality Scoring ---

function scoreQuality(fd: FundamentalData): QualityScore {
  const metrics: QualityMetric[] = [];

  const roeVal = fd.returnOnEquity;
  const roePct = roeVal !== null ? roeVal * 100 : null;
  metrics.push({
    name: "ROE", value: roePct, threshold: "> 15%",
    pass: roePct !== null && roePct > 15, required: true,
    display: roePct !== null ? `${roePct.toFixed(1)}%` : "N/A",
  });

  const gmVal = fd.grossMargin;
  const gmPct = gmVal !== null ? gmVal * 100 : null;
  metrics.push({
    name: "Gross Margin", value: gmPct, threshold: "> 30%",
    pass: gmPct !== null && gmPct > 30, required: true,
    display: gmPct !== null ? `${gmPct.toFixed(1)}%` : "N/A",
  });

  const deVal = fd.debtToEquity;
  metrics.push({
    name: "Debt/Equity", value: deVal, threshold: "< 1.0",
    pass: deVal !== null && deVal < 1.0, required: true,
    display: deVal !== null ? `${deVal.toFixed(2)}` : "N/A",
  });

  const fcfVal = fd.freeCashFlow;
  metrics.push({
    name: "Free Cash Flow", value: fcfVal, threshold: "> 0",
    pass: fcfVal !== null && fcfVal > 0, required: true,
    display: fcfVal !== null ? `$${(fcfVal / 1e9).toFixed(2)}B` : "N/A",
  });

  const nmVal = fd.netMargin;
  const nmPct = nmVal !== null ? nmVal * 100 : null;
  metrics.push({
    name: "Net Margin", value: nmPct, threshold: "> 10%",
    pass: nmPct !== null && nmPct > 10, required: false,
    display: nmPct !== null ? `${nmPct.toFixed(1)}%` : "N/A",
  });

  const crVal = fd.currentRatio;
  metrics.push({
    name: "Current Ratio", value: crVal, threshold: "> 1.2",
    pass: crVal !== null && crVal > 1.2, required: false,
    display: crVal !== null ? `${crVal.toFixed(2)}` : "N/A",
  });

  const requiredMetrics = metrics.filter((m) => m.required);
  const bonusMetrics = metrics.filter((m) => !m.required);
  const requiredPassed = requiredMetrics.filter((m) => m.pass).length;
  const bonusPassed = bonusMetrics.filter((m) => m.pass).length;

  let score: number;
  let signalAdjustment: number;
  let verdict: QualityScore["verdict"];

  if (requiredPassed <= 2) {
    score = 0.0; signalAdjustment = 0; verdict = "SKIP";
  } else if (requiredPassed === 3) {
    score = 0.3; signalAdjustment = -0.10; verdict = "DAMPEN";
  } else if (requiredPassed === 4 && bonusPassed === 0) {
    score = 0.6; signalAdjustment = 0; verdict = "NEUTRAL";
  } else if (requiredPassed === 4 && bonusPassed === 1) {
    score = 0.8; signalAdjustment = 0.10; verdict = "AMPLIFY";
  } else {
    score = 1.0; signalAdjustment = 0.15; verdict = "STRONG_AMPLIFY";
  }

  return { score, signalAdjustment, verdict, requiredPassed, requiredTotal: requiredMetrics.length, bonusPassed, bonusTotal: bonusMetrics.length, metrics };
}

// --- Valuation Check ---

function checkValuation(fd: FundamentalData): ValuationCheck {
  let overvaluedFlags = 0;

  const sectorPE = getSectorPE(fd.sector);
  const effectivePE = fd.trailingPE ?? fd.forwardPE;
  let peVsSector: ValuationCheck["peVsSector"] = "unknown";
  let peRatioToSector: number | null = null;

  if (effectivePE && sectorPE) {
    peRatioToSector = effectivePE / sectorPE;
    if (peRatioToSector > 1.5) { peVsSector = "overvalued"; overvaluedFlags++; }
    else if (peRatioToSector < 0.8) { peVsSector = "undervalued"; }
    else { peVsSector = "fair"; }
  }

  let priceVs200DMA: ValuationCheck["priceVs200DMA"] = "unknown";
  if (fd.pctFrom200DMA !== null) {
    if (fd.pctFrom200DMA > 20) { priceVs200DMA = "overvalued"; overvaluedFlags++; }
    else if (fd.pctFrom200DMA < -10) { priceVs200DMA = "undervalued"; }
    else { priceVs200DMA = "fair"; }
  }

  let entryAdjustment: string;
  if (overvaluedFlags >= 2) {
    entryAdjustment = "STRICT: Require signal >= 0.8, reduce position 50%";
  } else if (overvaluedFlags === 1) {
    entryAdjustment = "CAUTION: Consider reducing position size";
  } else if (priceVs200DMA === "undervalued" || peVsSector === "undervalued") {
    entryAdjustment = "OPPORTUNITY: Signal >= 0.5 sufficient, full position allowed";
  } else {
    entryAdjustment = "NORMAL: Standard entry rules apply";
  }

  return { peVsSector, sectorAvgPE: sectorPE, peRatioToSector, priceVs200DMA, pctFrom200DMA: fd.pctFrom200DMA, overvaluedFlags, entryAdjustment };
}

// --- Moat Classification ---

function classifyMoat(ticker: string): MoatClassification {
  const entry = MOAT_WATCHLIST[ticker.toUpperCase()];
  if (entry) return { hasMoat: true, moatType: entry.type, moatLabel: entry.label };
  return { hasMoat: false, moatType: "none", moatLabel: "No identified moat" };
}

// --- Report Generation ---

function generateReport(result: FundamentalResult): string {
  const { ticker, companyName, fundamentals: fd, quality, valuation, moat } = result;
  const lines: string[] = [];

  lines.push(`## Fundamental Check: ${ticker} (${companyName})`);
  lines.push(`**Sector:** ${fd.sector || "Unknown"} | **Industry:** ${fd.industry || "Unknown"}`);
  lines.push(`**Price:** $${fd.currentPrice.toFixed(2)}`);
  lines.push("");

  const verdictLabel: Record<string, string> = {
    SKIP: "SKIP", DAMPEN: "DAMPEN", NEUTRAL: "NEUTRAL",
    AMPLIFY: "AMPLIFY", STRONG_AMPLIFY: "STRONG AMPLIFY",
  };

  lines.push(`### Quality Score: ${quality.score.toFixed(1)} — ${verdictLabel[quality.verdict]}`);
  lines.push(`Signal adjustment: ${quality.signalAdjustment >= 0 ? "+" : ""}${quality.signalAdjustment.toFixed(2)}`);
  lines.push("");
  lines.push("| Metric | Value | Threshold | Result |");
  lines.push("|--------|-------|-----------|--------|");

  for (const m of quality.metrics) {
    const tag = m.required ? "Required" : "Bonus";
    const icon = m.pass ? "PASS" : (m.value === null ? "N/A" : "FAIL");
    lines.push(`| **${m.name}** (${tag}) | ${m.display} | ${m.threshold} | ${icon} |`);
  }

  lines.push("");
  lines.push(`Required: ${quality.requiredPassed}/${quality.requiredTotal} | Bonus: ${quality.bonusPassed}/${quality.bonusTotal}`);
  lines.push("");
  lines.push("### Valuation Check");
  lines.push("");
  lines.push("| Check | Status | Detail |");
  lines.push("|-------|--------|--------|");

  if (valuation.peVsSector !== "unknown") {
    const usedPE = fd.trailingPE ?? fd.forwardPE;
    const peType = fd.trailingPE ? "trailing" : "forward";
    lines.push(`| P/E vs Sector | ${valuation.peVsSector.toUpperCase()} | ${peType} P/E ${usedPE?.toFixed(1) || "?"} vs sector avg ${valuation.sectorAvgPE} (${valuation.peRatioToSector?.toFixed(2)}x) |`);
  } else {
    lines.push(`| P/E vs Sector | UNKNOWN | P/E: ${(fd.trailingPE ?? fd.forwardPE)?.toFixed(1) || "N/A"} (sector avg unavailable) |`);
  }

  if (valuation.priceVs200DMA !== "unknown") {
    lines.push(`| Price vs 200 MA | ${valuation.priceVs200DMA.toUpperCase()} | ${valuation.pctFrom200DMA! > 0 ? "+" : ""}${valuation.pctFrom200DMA!.toFixed(1)}% from 200-day MA ($${fd.sma200?.toFixed(2)}) |`);
  } else {
    lines.push(`| Price vs 200 MA | UNKNOWN | Insufficient price history |`);
  }

  lines.push("");
  lines.push(`**Overvalued flags:** ${valuation.overvaluedFlags}/2`);
  lines.push(`**Entry adjustment:** ${valuation.entryAdjustment}`);
  lines.push("");

  if (moat.hasMoat) {
    lines.push(`### Moat: ${moat.moatType.toUpperCase()} — ${moat.moatLabel}`);
  } else {
    lines.push("### Moat: None identified");
  }

  lines.push("");
  lines.push("### Verdict");
  lines.push("");

  if (quality.verdict === "SKIP") {
    const failedMetrics = quality.metrics.filter((m) => m.required && !m.pass);
    lines.push(`**DO NOT TRADE** — Failed ${quality.requiredTotal - quality.requiredPassed} required checks.`);
    lines.push(`Failed: ${failedMetrics.map((m) => `${m.name} (${m.display})`).join(", ")}`);
  } else if (quality.verdict === "DAMPEN") {
    const failedMetric = quality.metrics.find((m) => m.required && !m.pass);
    lines.push("**PROCEED WITH CAUTION** — Missing 1 required metric. Signal dampened by -0.10.");
    if (failedMetric) lines.push(`Missing: ${failedMetric.name} (${failedMetric.display})`);
  } else if (quality.verdict === "STRONG_AMPLIFY") {
    lines.push("**HIGH QUALITY** — All metrics pass. Signal amplified by +0.15.");
  } else if (quality.verdict === "AMPLIFY") {
    lines.push("**GOOD QUALITY** — All required + 1 bonus pass. Signal amplified by +0.10.");
  } else {
    lines.push("**ACCEPTABLE** — All required metrics pass. Signal unchanged.");
  }

  return lines.join("\n");
}

// --- Main exported function ---

export async function runFundamentalCheck(ticker: string): Promise<FundamentalResult> {
  const normalizedTicker = ticker.toUpperCase();

  if (isETF(normalizedTicker)) {
    return {
      ticker: normalizedTicker, companyName: normalizedTicker, sector: "ETF",
      fundamentals: {
        ticker: normalizedTicker, companyName: normalizedTicker, sector: "ETF",
        industry: "ETF", currentPrice: 0,
        returnOnEquity: null, grossMargin: null, netMargin: null,
        debtToEquity: null, freeCashFlow: null, currentRatio: null,
        trailingPE: null, forwardPE: null, priceToBook: null,
        sma200: null, pctFrom200DMA: null,
      },
      quality: { score: 1.0, signalAdjustment: 0, verdict: "NEUTRAL", requiredPassed: 0, requiredTotal: 0, bonusPassed: 0, bonusTotal: 0, metrics: [] },
      valuation: { peVsSector: "unknown", sectorAvgPE: null, peRatioToSector: null, priceVs200DMA: "unknown", pctFrom200DMA: null, overvaluedFlags: 0, entryAdjustment: "ETF EXEMPT: Fundamental quality gate skipped" },
      moat: { hasMoat: false, moatType: "none", moatLabel: "ETF - exempt from quality screen" },
      summary: `## Fundamental Check: ${normalizedTicker}\n\n**ETF EXEMPT** — Quality gate does not apply to ETFs.`,
      status: "etf_exempt",
    };
  }

  try {
    const [yahoo, sma200] = await Promise.all([
      fetchYahooFundamentals(normalizedTicker),
      fetch200DaySMA(normalizedTicker),
    ]);

    if (!yahoo) {
      return {
        ticker: normalizedTicker, companyName: normalizedTicker, sector: "Unknown",
        fundamentals: { ticker: normalizedTicker, companyName: normalizedTicker, sector: "Unknown", industry: "Unknown", currentPrice: 0, returnOnEquity: null, grossMargin: null, netMargin: null, debtToEquity: null, freeCashFlow: null, currentRatio: null, trailingPE: null, forwardPE: null, priceToBook: null, sma200: null, pctFrom200DMA: null },
        quality: { score: 0.6, signalAdjustment: 0, verdict: "NEUTRAL", requiredPassed: 0, requiredTotal: 4, bonusPassed: 0, bonusTotal: 2, metrics: [] },
        valuation: { peVsSector: "unknown", sectorAvgPE: null, peRatioToSector: null, priceVs200DMA: "unknown", pctFrom200DMA: null, overvaluedFlags: 0, entryAdjustment: "DATA UNAVAILABLE: Proceed with caution" },
        moat: classifyMoat(normalizedTicker),
        summary: `## Fundamental Check: ${normalizedTicker}\n\n**DATA UNAVAILABLE** — Could not fetch fundamental data. Proceed with signal-only rules.`,
        status: "error", error: "Yahoo Finance data unavailable",
      };
    }

    const fundamentals = parseFundamentals(normalizedTicker, yahoo, sma200);
    const quality = scoreQuality(fundamentals);
    const valuation = checkValuation(fundamentals);
    const moat = classifyMoat(normalizedTicker);

    const result: FundamentalResult = {
      ticker: normalizedTicker, companyName: fundamentals.companyName, sector: fundamentals.sector,
      fundamentals, quality, valuation, moat, summary: "", status: "complete",
    };

    result.summary = generateReport(result);
    return result;
  } catch (err: any) {
    return {
      ticker: normalizedTicker, companyName: normalizedTicker, sector: "Unknown",
      fundamentals: { ticker: normalizedTicker, companyName: normalizedTicker, sector: "Unknown", industry: "Unknown", currentPrice: 0, returnOnEquity: null, grossMargin: null, netMargin: null, debtToEquity: null, freeCashFlow: null, currentRatio: null, trailingPE: null, forwardPE: null, priceToBook: null, sma200: null, pctFrom200DMA: null },
      quality: { score: 0.6, signalAdjustment: 0, verdict: "NEUTRAL", requiredPassed: 0, requiredTotal: 4, bonusPassed: 0, bonusTotal: 2, metrics: [] },
      valuation: { peVsSector: "unknown", sectorAvgPE: null, peRatioToSector: null, priceVs200DMA: "unknown", pctFrom200DMA: null, overvaluedFlags: 0, entryAdjustment: "ERROR: Proceed with signal-only rules" },
      moat: classifyMoat(normalizedTicker),
      summary: `## Fundamental Check: ${normalizedTicker}\n\n**ERROR** — ${err.message}`,
      status: "error", error: err.message || String(err),
    };
  }
}

// --- CLI ---

if (import.meta.main) {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    console.log(`
FundamentalCheck - Buffett-Inspired Quality Screen for Swing Trading

Usage:
  bun FundamentalCheck.ts --ticker AAPL
  bun FundamentalCheck.ts --ticker AAPL --json
  bun FundamentalCheck.ts --tickers AAPL,MSFT,KO
  bun FundamentalCheck.ts --help

Quality Thresholds (all Required must pass to trade):
  Required: ROE > 15% | Gross Margin > 30% | Debt/Equity < 1.0 | FCF > 0
  Bonus:    Net Margin > 10% | Current Ratio > 1.2

ETFs are exempt from quality screening.
`);
    process.exit(0);
  }

  const jsonOutput = args.includes("--json");
  let tickers: string[] = [];

  const tickerIdx = args.indexOf("--ticker");
  const tickersIdx = args.indexOf("--tickers");

  if (tickerIdx !== -1 && args[tickerIdx + 1]) {
    tickers = [args[tickerIdx + 1].toUpperCase()];
  } else if (tickersIdx !== -1 && args[tickersIdx + 1]) {
    tickers = args[tickersIdx + 1].toUpperCase().split(",").map((t) => t.trim()).filter(Boolean);
  }

  if (tickers.length === 0) {
    console.error("Usage: bun FundamentalCheck.ts --ticker AAPL");
    process.exit(1);
  }

  log(`Checking ${tickers.length} ticker(s): ${tickers.join(", ")}`);

  const results: FundamentalResult[] = [];

  for (const ticker of tickers) {
    log(`Analyzing ${ticker}...`);
    const result = await runFundamentalCheck(ticker);
    results.push(result);

    if (!jsonOutput) {
      console.log(result.summary);
      console.log("\n---\n");
    }
  }

  if (jsonOutput) {
    console.log(JSON.stringify(results.length === 1 ? results[0] : results, null, 2));
  }

  if (!jsonOutput && results.length > 1) {
    console.log("## Summary");
    console.log("| Ticker | Quality | Adj | Verdict | Moat | Valuation |");
    console.log("|--------|---------|-----|---------|------|-----------|");
    for (const r of results) {
      const adj = r.quality.signalAdjustment >= 0 ? `+${r.quality.signalAdjustment.toFixed(2)}` : r.quality.signalAdjustment.toFixed(2);
      const moatStr = r.moat.hasMoat ? r.moat.moatType : "-";
      const valStr = r.valuation.overvaluedFlags > 0 ? `${r.valuation.overvaluedFlags} flags` : "OK";
      console.log(`| ${r.ticker} | ${r.quality.score.toFixed(1)} | ${adj} | ${r.quality.verdict} | ${moatStr} | ${valStr} |`);
    }
  }
}
