#!/usr/bin/env bun
/**
 * DeepResearch.ts - Deep stock research via Perplexity API
 *
 * Performs parallel web-grounded research queries for a given ticker:
 *   1. Industry Momentum Analysis
 *   2. Competitive Teardown
 *   3. Policy & Regulation Radar
 *   4. SEC Filing Analysis
 *   5. Technical Analysis
 *
 * Results are cached per ticker per day in data/research/{TICKER}-{YYYY-MM-DD}.json
 *
 * Usage:
 *   bun DeepResearch.ts --ticker AAPL
 *   bun DeepResearch.ts --ticker MSFT --force  # bypass cache
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, resolve, dirname } from "path";
import { analyzeSECFiling } from "./SECFilingAnalyzer.js";
import { runTechnicalAnalysis } from "../analysis/TechnicalAnalysis.js";

const PROJECT_ROOT = resolve(dirname(new URL(import.meta.url).pathname), "../..");
const RESEARCH_DIR = join(PROJECT_ROOT, "data", "research");
const TICKER_INFO_FILE = join(RESEARCH_DIR, "ticker-info.json");

// Ensure research directory exists
if (!existsSync(RESEARCH_DIR)) {
  mkdirSync(RESEARCH_DIR, { recursive: true });
}

// Load .env
const ENV_FILE = join(PROJECT_ROOT, ".env");
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

function getPerplexityKey(): string {
  const key = process.env.PERPLEXITY_API_KEY;
  if (!key) throw new Error("PERPLEXITY_API_KEY not set in .env");
  return key;
}

interface TickerInfo {
  ticker: string;
  companyName: string;
  industry: string;
  resolvedAt: string;
}

interface ResearchSection {
  title: string;
  content: string;
  status: "pending" | "complete" | "error";
  error?: string;
}

export interface ResearchResult {
  ticker: string;
  companyName: string;
  industry: string;
  status: "not_found" | "in_progress" | "complete" | "error";
  sections: {
    industryMomentum: ResearchSection;
    competitiveTeardown: ResearchSection;
    policyRadar: ResearchSection;
    secFiling: ResearchSection;
    technicalAnalysis: ResearchSection;
  };
  generatedAt: string;
  cacheKey: string;
}

// Perplexity API call
async function perplexityQuery(prompt: string): Promise<string> {
  const resp = await fetch("https://api.perplexity.ai/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${getPerplexityKey()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "sonar",
      messages: [{ role: "user", content: prompt }],
      max_tokens: 2048,
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Perplexity API error (${resp.status}): ${errText.slice(0, 300)}`);
  }

  const data = await resp.json();
  return data.choices?.[0]?.message?.content || "No response from Perplexity.";
}

// Resolve ticker to company name + industry
async function resolveTickerInfo(ticker: string): Promise<TickerInfo> {
  // Check cache
  let cache: Record<string, TickerInfo> = {};
  if (existsSync(TICKER_INFO_FILE)) {
    try {
      cache = JSON.parse(readFileSync(TICKER_INFO_FILE, "utf-8"));
    } catch {
      cache = {};
    }
  }

  if (cache[ticker]) return cache[ticker];

  const prompt = `What company trades under the stock ticker symbol "${ticker}"? Reply with ONLY two lines:
Line 1: Company full name
Line 2: Primary industry/sector
Do not include any other text.`;

  const result = await perplexityQuery(prompt);
  const lines = result.trim().split("\n").filter(Boolean);

  const info: TickerInfo = {
    ticker,
    companyName: lines[0]?.replace(/^(company|name|1[.):]\s*)/i, "").trim() || ticker,
    industry: lines[1]?.replace(/^(industry|sector|2[.):]\s*)/i, "").trim() || "Unknown",
    resolvedAt: new Date().toISOString(),
  };

  cache[ticker] = info;
  writeFileSync(TICKER_INFO_FILE, JSON.stringify(cache, null, 2));
  return info;
}

// Cache key for today
function cacheKey(ticker: string): string {
  const today = new Date().toISOString().slice(0, 10);
  return `${ticker.toUpperCase()}-${today}`;
}

function cachePath(key: string): string {
  return join(RESEARCH_DIR, `${key}.json`);
}

// Load cached result
export function loadCached(ticker: string): ResearchResult | null {
  const key = cacheKey(ticker.toUpperCase());
  const path = cachePath(key);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

// Save result (partial or complete)
function saveResult(result: ResearchResult): void {
  const path = cachePath(result.cacheKey);
  writeFileSync(path, JSON.stringify(result, null, 2));
}

// Build research prompts
function buildPrompts(ticker: string, companyName: string, industry: string) {
  return {
    industryMomentum: `Analyze the industry momentum for ${companyName} (${ticker}) in the ${industry} sector over the last 90 days. Cover:
- Major announcements, product launches, or pivots
- Funding rounds or M&A activity in the sector
- Emerging patterns or trends affecting the industry
- Key metrics or data points that signal momentum (positive or negative)
- How ${companyName} specifically is positioned relative to these trends

Focus on concrete, recent events with dates where possible. Write in clear, analytical markdown with headers and bullet points.`,

    competitiveTeardown: `Provide a competitive teardown of ${companyName} (${ticker}). Cover:
- Revenue model and key revenue drivers
- Customer acquisition strategy and market positioning
- Product roadmap signals (recent announcements, patents, job postings)
- Top 3-5 direct competitors and how ${companyName} compares
- Key weaknesses or vulnerabilities in their business model
- Likely next moves based on recent signals

Write in clear, analytical markdown with headers and bullet points. Focus on actionable intelligence for a trader evaluating this stock.`,

    policyRadar: `Analyze the policy and regulatory landscape affecting ${companyName} (${ticker}) in the ${industry} sector. Cover:
- Proposed or recently enacted legislation that could impact the company
- Pending court cases or regulatory actions
- International regulatory comparison (US vs EU vs Asia)
- How ${companyName} is positioned to comply with or benefit from regulations
- Regulatory risks that could affect stock price
- Any government contracts, subsidies, or incentive programs relevant to the company

Write in clear, analytical markdown with headers and bullet points. Focus on what matters for a short-term trader (5-day swing window).`,
  };
}

// Main research function - runs sections in parallel, saves partial results
export async function runDeepResearch(
  ticker: string,
  force = false
): Promise<ResearchResult> {
  const normalizedTicker = ticker.toUpperCase();
  const key = cacheKey(normalizedTicker);

  // Check cache unless forced
  if (!force) {
    const cached = loadCached(normalizedTicker);
    if (cached && cached.status === "complete") return cached;
  }

  // Resolve ticker info
  const info = await resolveTickerInfo(normalizedTicker);

  // Initialize result with pending sections
  const result: ResearchResult = {
    ticker: normalizedTicker,
    companyName: info.companyName,
    industry: info.industry,
    status: "in_progress",
    sections: {
      industryMomentum: { title: "Industry Momentum Analysis", content: "", status: "pending" },
      competitiveTeardown: { title: "Competitive Teardown", content: "", status: "pending" },
      policyRadar: { title: "Policy & Regulation Radar", content: "", status: "pending" },
      secFiling: { title: "SEC Filing Analysis", content: "", status: "pending" },
      technicalAnalysis: { title: "Technical Analysis", content: "", status: "pending" },
    },
    generatedAt: new Date().toISOString(),
    cacheKey: key,
  };

  // Save initial state
  saveResult(result);

  const prompts = buildPrompts(normalizedTicker, info.companyName, info.industry);

  // Run all sections in parallel, saving as each completes
  await Promise.all([
    // 1. Industry Momentum (Perplexity)
    (async () => {
      try {
        result.sections.industryMomentum.content = await perplexityQuery(prompts.industryMomentum);
        result.sections.industryMomentum.status = "complete";
      } catch (err: any) {
        result.sections.industryMomentum.status = "error";
        result.sections.industryMomentum.error = err.message || String(err);
      }
      saveResult(result);
    })(),

    // 2. Competitive Teardown (Perplexity)
    (async () => {
      try {
        result.sections.competitiveTeardown.content = await perplexityQuery(prompts.competitiveTeardown);
        result.sections.competitiveTeardown.status = "complete";
      } catch (err: any) {
        result.sections.competitiveTeardown.status = "error";
        result.sections.competitiveTeardown.error = err.message || String(err);
      }
      saveResult(result);
    })(),

    // 3. Policy & Regulation Radar (Perplexity)
    (async () => {
      try {
        result.sections.policyRadar.content = await perplexityQuery(prompts.policyRadar);
        result.sections.policyRadar.status = "complete";
      } catch (err: any) {
        result.sections.policyRadar.status = "error";
        result.sections.policyRadar.error = err.message || String(err);
      }
      saveResult(result);
    })(),

    // 4. SEC Filing Analysis (EDGAR + Perplexity)
    (async () => {
      try {
        const secResult = await analyzeSECFiling(normalizedTicker);
        if (secResult.status === "complete") {
          const header = `**Filing:** ${secResult.filingType} (${secResult.filingDate}) | Risk Factors: ${secResult.riskFactorsLength.toLocaleString()} chars | MD&A: ${secResult.mdnaLength.toLocaleString()} chars\n\n`;
          result.sections.secFiling.content = header + secResult.analysis;
          result.sections.secFiling.status = "complete";
        } else {
          result.sections.secFiling.content = secResult.analysis || secResult.error || "No filing data available.";
          result.sections.secFiling.status = secResult.status === "no_filing" ? "complete" : "error";
          result.sections.secFiling.error = secResult.error;
        }
      } catch (err: any) {
        result.sections.secFiling.status = "error";
        result.sections.secFiling.error = err.message || String(err);
      }
      saveResult(result);
    })(),

    // 5. Technical Analysis (Alpaca data)
    (async () => {
      try {
        const techResult = await runTechnicalAnalysis(normalizedTicker);
        if (techResult.status === "complete") {
          result.sections.technicalAnalysis.content = techResult.summary;
          result.sections.technicalAnalysis.status = "complete";
        } else {
          result.sections.technicalAnalysis.status = "error";
          result.sections.technicalAnalysis.error = techResult.error;
        }
      } catch (err: any) {
        result.sections.technicalAnalysis.status = "error";
        result.sections.technicalAnalysis.error = err.message || String(err);
      }
      saveResult(result);
    })(),
  ]);

  // Determine overall status
  const allSectionKeys = Object.keys(result.sections) as Array<keyof typeof result.sections>;
  const allComplete = allSectionKeys.every((k) => result.sections[k].status === "complete");
  const anyError = allSectionKeys.some((k) => result.sections[k].status === "error");
  result.status = allComplete ? "complete" : anyError ? "error" : "in_progress";
  saveResult(result);

  return result;
}

// CLI mode
if (import.meta.main) {
  const args = process.argv.slice(2);
  const tickerIdx = args.indexOf("--ticker");
  const force = args.includes("--force");

  if (tickerIdx === -1 || !args[tickerIdx + 1]) {
    console.error("Usage: bun DeepResearch.ts --ticker AAPL [--force]");
    process.exit(1);
  }

  const ticker = args[tickerIdx + 1];
  console.log(`Researching ${ticker.toUpperCase()}...`);

  try {
    const result = await runDeepResearch(ticker, force);
    console.log(`\nStatus: ${result.status}`);
    console.log(`Company: ${result.companyName} (${result.industry})`);
    console.log(`Cache: ${result.cacheKey}`);

    for (const [key, section] of Object.entries(result.sections)) {
      console.log(`\n${"=".repeat(60)}`);
      console.log(`${section.title} [${section.status}]`);
      console.log("=".repeat(60));
      if (section.status === "complete") {
        console.log(section.content);
      } else if (section.status === "error") {
        console.error(`Error: ${section.error}`);
      }
    }
  } catch (err: any) {
    console.error(`Research failed: ${err.message}`);
    process.exit(1);
  }
}
