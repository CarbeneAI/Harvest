#!/usr/bin/env bun
/**
 * ResearchEnricher.ts - Perplexity-powered sentiment scoring for trade recommendations
 *
 * Takes a recommendation + DeepResearch result, sends to Perplexity with a
 * professional trader persona, and returns:
 *   - researchScore (-1 to +1)
 *   - researchSummary (2-3 sentence assessment)
 *   - researchContradictions (conflicts with original thesis)
 *   - convictionAdjustment (+/- integer)
 *
 * Usage:
 *   bun ResearchEnricher.ts --ticker AAPL    # Standalone test (loads cached research)
 *   bun ResearchEnricher.ts --help
 */

import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { loadCached, type ResearchResult } from "./DeepResearch.js";

// --- Paths ---
const PROJECT_ROOT = resolve(dirname(new URL(import.meta.url).pathname), "../..");

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

const log = (msg: string) => console.error(`[ResearchEnricher] ${msg}`);

// --- Interfaces ---
export interface EnrichmentResult {
  researchScore: number; // -1 (bearish) to +1 (bullish)
  researchSummary: string; // 2-3 sentence pro trader assessment
  researchContradictions: string[]; // conflicts with original thesis
  convictionAdjustment: number; // how much conviction changed (+/- integer)
  enrichedAt: string;
}

interface Recommendation {
  id: string;
  ticker: string;
  direction: string;
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  conviction: number;
  thesis: string;
  strength: string;
  sources: string[];
  [key: string]: any;
}

// --- Trader Persona Prompt ---
const TRADER_PERSONA = `You are a professional stock trader with 30+ years of experience across bull and bear markets. You:
- Read trends others miss — identify under-the-radar companies poised for breakout growth
- Follow smart money — track institutional flows and major fund managers
- Are an SEC filing expert — read 10-K/10-Q filings fluently
- Have a risk-first mindset — knowing when NOT to trade is just as important as when to enter
- Recognize macro patterns from decades of experience in both bull and bear markets
- Target 30% annualized return (~0.12% per trading day), exceeding broad market averages`;

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

// --- Build enrichment prompt ---
function buildEnrichmentPrompt(rec: Recommendation, research: ResearchResult): string {
  // Collect all research section content
  const sections: string[] = [];
  for (const [key, section] of Object.entries(research.sections)) {
    if (section.status === "complete" && section.content) {
      sections.push(`### ${section.title}\n${section.content.slice(0, 1500)}`);
    }
  }

  const researchContent = sections.length > 0
    ? sections.join("\n\n")
    : "No research data available.";

  return `${TRADER_PERSONA}

You are evaluating a stock for a swing trade. Analyze the research below and provide your assessment.

## Trade Setup
- **Ticker:** ${rec.ticker} (${research.companyName || rec.ticker})
- **Industry:** ${research.industry || "Unknown"}
- **Direction:** ${rec.direction}
- **Entry Price:** $${rec.entryPrice}
- **Stop Loss:** $${rec.stopLoss}
- **Take Profit:** $${rec.takeProfit}
- **Signal Strength:** ${rec.strength}
- **Signal Sources:** ${rec.sources.join(", ")}
- **Original Thesis:** ${rec.thesis}

## Research Data
${researchContent}

## Your Task
Respond with ONLY valid JSON (no markdown, no code fences) in this exact format:
{
  "score": <number from -1.0 to 1.0 where -1 is very bearish and +1 is very bullish>,
  "summary": "<2-3 sentence assessment as a professional trader>",
  "contradictions": ["<contradiction 1>", "<contradiction 2>"],
  "riskFactors": ["<risk 1>", "<risk 2>"],
  "institutionalInterest": <true or false>
}

Be honest and critical. If the research contradicts the thesis, say so. If there are red flags, call them out.`;
}

// --- Conviction adjustment rules ---
function calculateConvictionAdjustment(score: number): number {
  if (score >= 0.5) return 2;   // Research strongly supports
  if (score >= 0.2) return 1;   // Research supports
  if (score >= -0.1) return 0;  // Neutral
  if (score >= -0.3) return -1; // Mixed signals
  return -3;                     // Research contradicts thesis
}

// --- Main enrichment function ---
export async function enrichRecommendation(
  rec: Recommendation,
  research: ResearchResult
): Promise<EnrichmentResult> {
  const prompt = buildEnrichmentPrompt(rec, research);

  let rawResponse: string;
  try {
    rawResponse = await perplexityQuery(prompt);
  } catch (err: any) {
    log(`Perplexity error for ${rec.ticker}: ${err.message}`);
    return {
      researchScore: 0,
      researchSummary: `Research enrichment failed: ${err.message}`,
      researchContradictions: [],
      convictionAdjustment: 0,
      enrichedAt: new Date().toISOString(),
    };
  }

  // Parse JSON response — handle markdown code fences
  let parsed: any;
  try {
    // Strip code fences if present
    let cleaned = rawResponse.trim();
    if (cleaned.startsWith("```")) {
      cleaned = cleaned.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
    }
    parsed = JSON.parse(cleaned);
  } catch {
    log(`Failed to parse JSON for ${rec.ticker}, extracting manually`);
    // Fallback: try to extract score from text
    const scoreMatch = rawResponse.match(/[-+]?0?\.\d+|[-+]?1\.0?/);
    parsed = {
      score: scoreMatch ? parseFloat(scoreMatch[0]) : 0,
      summary: rawResponse.slice(0, 300),
      contradictions: [],
      riskFactors: [],
      institutionalInterest: null,
    };
  }

  const score = Math.max(-1, Math.min(1, parseFloat(parsed.score) || 0));
  const contradictions: string[] = Array.isArray(parsed.contradictions)
    ? parsed.contradictions.filter((c: any) => typeof c === "string" && c.length > 0)
    : [];

  const institutionalNote = parsed.institutionalInterest === false
    ? "Low institutional interest signal."
    : "";

  const summary = [parsed.summary || "", institutionalNote].filter(Boolean).join(" ");

  return {
    researchScore: score,
    researchSummary: summary,
    researchContradictions: contradictions,
    convictionAdjustment: calculateConvictionAdjustment(score),
    enrichedAt: new Date().toISOString(),
  };
}

// --- CLI mode ---
if (import.meta.main) {
  const args = process.argv.slice(2);

  if (args.includes("--help")) {
    console.log(`
ResearchEnricher - Perplexity-powered sentiment scoring for trade recommendations

Usage:
  bun ResearchEnricher.ts --ticker AAPL    # Score cached research for AAPL
  bun ResearchEnricher.ts --help

Requires:
  - PERPLEXITY_API_KEY in .env
  - Cached DeepResearch result for the ticker (run DeepResearch.ts first)

Scoring:
  +0.5 to +1.0  => conviction +2 (Research strongly supports)
  +0.2 to +0.5  => conviction +1 (Research supports)
  -0.1 to +0.2  => no change (Neutral)
  -0.3 to -0.1  => conviction -1 (Mixed signals)
  -1.0 to -0.3  => conviction -3 (Research contradicts thesis)
`);
    process.exit(0);
  }

  const tickerIdx = args.indexOf("--ticker");
  if (tickerIdx === -1 || !args[tickerIdx + 1]) {
    console.error("Usage: bun ResearchEnricher.ts --ticker AAPL");
    process.exit(1);
  }

  const ticker = args[tickerIdx + 1].toUpperCase();
  log(`Enriching research for ${ticker}...`);

  // Load cached research
  const research = loadCached(ticker);
  if (!research) {
    console.error(`No cached research for ${ticker}. Run: bun DeepResearch.ts --ticker ${ticker}`);
    process.exit(1);
  }

  // Build a mock recommendation for standalone testing
  const mockRec: Recommendation = {
    id: `test-${ticker}`,
    ticker,
    direction: "LONG",
    entryPrice: 100,
    stopLoss: 97,
    takeProfit: 105,
    conviction: 7,
    thesis: "Test thesis — multi-signal confluence",
    strength: "High",
    sources: ["Momentum"],
  };

  const result = await enrichRecommendation(mockRec, research);
  console.log(JSON.stringify(result, null, 2));
}
