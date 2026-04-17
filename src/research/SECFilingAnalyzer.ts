#!/usr/bin/env bun
/**
 * SECFilingAnalyzer.ts - SEC EDGAR Filing Analyzer
 *
 * Fetches latest 10-K/10-Q filings from SEC EDGAR, extracts Risk Factors
 * and MD&A sections, and analyzes them via Perplexity for trading signals.
 *
 * No API key needed for EDGAR - it is free and public.
 * Rate limit: 10 requests/second (SEC fair access policy).
 *
 * Usage:
 *   bun SECFilingAnalyzer.ts --ticker AAPL
 *   bun SECFilingAnalyzer.ts --ticker MORN --form 10-Q
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, resolve, dirname } from "path";

const PROJECT_ROOT = resolve(dirname(new URL(import.meta.url).pathname), "../..");
const CACHE_DIR = join(PROJECT_ROOT, "data", "research");
const TICKERS_CACHE = join(CACHE_DIR, "sec-tickers.json");
const USER_AGENT = "Harvest/1.0 (contact@carbene.ai)";
const SEC_DELAY_MS = 150; // Stay well under 10 req/s

if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });

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

async function secFetch(url: string): Promise<string> {
  await new Promise((r) => setTimeout(r, SEC_DELAY_MS));
  const resp = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/json" },
  });
  if (!resp.ok) throw new Error(`SEC ${resp.status}: ${url}`);
  return resp.text();
}

// --- Ticker to CIK mapping ---

interface TickerMap {
  [ticker: string]: { cik: string; name: string };
}

async function loadTickerMap(): Promise<TickerMap> {
  // Cache for 24 hours
  if (existsSync(TICKERS_CACHE)) {
    const stat = Bun.file(TICKERS_CACHE);
    const age = Date.now() - (await stat.lastModified);
    if (age < 86400000) {
      return JSON.parse(readFileSync(TICKERS_CACHE, "utf-8"));
    }
  }

  const raw = await secFetch("https://www.sec.gov/files/company_tickers.json");
  const data = JSON.parse(raw);
  const map: TickerMap = {};
  for (const entry of Object.values(data) as any[]) {
    map[entry.ticker] = {
      cik: String(entry.cik_str).padStart(10, "0"),
      name: entry.title,
    };
  }
  writeFileSync(TICKERS_CACHE, JSON.stringify(map));
  return map;
}

async function tickerToCIK(ticker: string): Promise<{ cik: string; name: string }> {
  const map = await loadTickerMap();
  const info = map[ticker.toUpperCase()];
  if (!info) throw new Error(`Ticker ${ticker} not found in SEC EDGAR`);
  return info;
}

// --- Filing discovery ---

interface FilingInfo {
  form: string;
  filingDate: string;
  accessionNumber: string;
  primaryDocument: string;
}

async function getLatestFiling(
  cik: string,
  formType: "10-K" | "10-Q" = "10-K"
): Promise<FilingInfo | null> {
  const url = `https://data.sec.gov/submissions/CIK${cik}.json`;
  const raw = await secFetch(url);
  const data = JSON.parse(raw);
  const recent = data.filings.recent;

  for (let i = 0; i < recent.form.length; i++) {
    if (recent.form[i] === formType) {
      return {
        form: recent.form[i],
        filingDate: recent.filingDate[i],
        accessionNumber: recent.accessionNumber[i],
        primaryDocument: recent.primaryDocument[i],
      };
    }
  }
  return null;
}

// --- Filing content extraction ---

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&#\d+;/g, " ")
    .replace(/&[a-z]+;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractSection(text: string, startPattern: RegExp, endPattern: RegExp): string {
  const startMatch = text.match(startPattern);
  if (!startMatch || startMatch.index === undefined) return "";

  // Find the first substantial match (skip table-of-contents entries which are short)
  let bestStart = -1;
  let searchFrom = 0;
  while (true) {
    const idx = text.slice(searchFrom).search(startPattern);
    if (idx === -1) break;
    const absIdx = searchFrom + idx;
    // Check if the content after this match is substantial (>500 chars before next Item)
    const nextItem = text.slice(absIdx + 50).search(/Item\s*\d/i);
    if (nextItem > 500) {
      bestStart = absIdx;
      break;
    }
    searchFrom = absIdx + 50;
    if (bestStart === -1) bestStart = absIdx;
  }

  if (bestStart === -1) return "";

  const afterStart = text.slice(bestStart);
  const endIdx = afterStart.search(endPattern);
  const section = endIdx > 0 ? afterStart.slice(0, endIdx) : afterStart.slice(0, 20000);

  return section.trim();
}

async function fetchFilingContent(
  cik: string,
  filing: FilingInfo
): Promise<{ riskFactors: string; mdna: string; filingDate: string }> {
  const accNoDash = filing.accessionNumber.replace(/-/g, "");
  const cikNum = cik.replace(/^0+/, "");
  const url = `https://www.sec.gov/Archives/edgar/data/${cikNum}/${accNoDash}/${filing.primaryDocument}`;

  const html = await secFetch(url);
  const text = stripHtml(html);

  // Extract Risk Factors (Item 1A → Item 1B or Item 1C)
  const riskFactors = extractSection(
    text,
    /Item\s*1A[\.\s]*Risk\s*Factors/i,
    /Item\s*1[BC][\.\s]/i
  );

  // Extract MD&A (Item 7 → Item 7A or Item 8)
  const mdna = extractSection(
    text,
    /Item\s*7[\.\s]*Management/i,
    /Item\s*7A[\.\s]|Item\s*8[\.\s]/i
  );

  return {
    riskFactors: riskFactors.slice(0, 12000), // Cap at ~12K chars for API limits
    mdna: mdna.slice(0, 12000),
    filingDate: filing.filingDate,
  };
}

// --- AI Analysis ---

async function perplexityAnalyze(prompt: string): Promise<string> {
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
  if (!resp.ok) throw new Error(`Perplexity ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
  const data = await resp.json();
  return data.choices?.[0]?.message?.content || "No response";
}

export interface SECAnalysisResult {
  ticker: string;
  companyName: string;
  filingType: string;
  filingDate: string;
  riskFactorsLength: number;
  mdnaLength: number;
  analysis: string;
  status: "complete" | "error" | "no_filing";
  error?: string;
}

export async function analyzeSECFiling(
  ticker: string,
  formType: "10-K" | "10-Q" = "10-K"
): Promise<SECAnalysisResult> {
  const normalizedTicker = ticker.toUpperCase();

  try {
    // Step 1: Resolve CIK
    const { cik, name } = await tickerToCIK(normalizedTicker);

    // Step 2: Find latest filing
    const filing = await getLatestFiling(cik, formType);
    if (!filing) {
      // Try the other form type
      const altType = formType === "10-K" ? "10-Q" : "10-K";
      const altFiling = await getLatestFiling(cik, altType);
      if (!altFiling) {
        return {
          ticker: normalizedTicker,
          companyName: name,
          filingType: formType,
          filingDate: "",
          riskFactorsLength: 0,
          mdnaLength: 0,
          analysis: `No ${formType} or ${altType} filing found for ${name} in SEC EDGAR.`,
          status: "no_filing",
        };
      }
      // Use alternative filing
      return analyzeSECFiling(normalizedTicker, altType);
    }

    // Step 3: Fetch and extract sections
    const content = await fetchFilingContent(cik, filing);

    if (!content.riskFactors && !content.mdna) {
      return {
        ticker: normalizedTicker,
        companyName: name,
        filingType: filing.form,
        filingDate: filing.filingDate,
        riskFactorsLength: 0,
        mdnaLength: 0,
        analysis: `Filing found (${filing.form} dated ${filing.filingDate}) but could not extract Risk Factors or MD&A sections. The filing may use a non-standard format.`,
        status: "error",
        error: "Section extraction failed",
      };
    }

    // Step 4: Analyze with Perplexity
    const sections: string[] = [];
    if (content.riskFactors) {
      sections.push(`RISK FACTORS (first 12,000 chars):\n${content.riskFactors}`);
    }
    if (content.mdna) {
      sections.push(`MD&A - MANAGEMENT DISCUSSION & ANALYSIS (first 12,000 chars):\n${content.mdna}`);
    }

    const prompt = `You are analyzing SEC filing data for ${name} (${normalizedTicker}), from their ${filing.form} filed on ${filing.filingDate}. Below are extracted sections from the filing.

Analyze this for a swing trader holding for 5 days. Provide:

1. **Key Risk Summary** - The top 5 most material risks, ranked by likelihood of near-term stock impact
2. **Management Outlook Signals** - What management is signaling about growth, margins, and strategy (from MD&A if available)
3. **Red Flags** - Any language suggesting deterioration, investigations, or material weaknesses
4. **Bullish Signals** - Any language suggesting accelerating growth, expanding margins, or new opportunities
5. **Trading Implications** - Specific, actionable takeaways for a 5-day swing trade

Use markdown with headers and bullet points. Be concise and focus on what matters for trading.

${sections.join("\n\n---\n\n")}`;

    const analysis = await perplexityAnalyze(prompt);

    return {
      ticker: normalizedTicker,
      companyName: name,
      filingType: filing.form,
      filingDate: filing.filingDate,
      riskFactorsLength: content.riskFactors.length,
      mdnaLength: content.mdna.length,
      analysis,
      status: "complete",
    };
  } catch (err: any) {
    return {
      ticker: normalizedTicker,
      companyName: "",
      filingType: formType,
      filingDate: "",
      riskFactorsLength: 0,
      mdnaLength: 0,
      analysis: "",
      status: "error",
      error: err.message || String(err),
    };
  }
}

// --- CLI ---

if (import.meta.main) {
  const args = process.argv.slice(2);
  const tickerIdx = args.indexOf("--ticker");
  const formIdx = args.indexOf("--form");

  if (tickerIdx === -1 || !args[tickerIdx + 1]) {
    console.error("Usage: bun SECFilingAnalyzer.ts --ticker AAPL [--form 10-K|10-Q]");
    process.exit(1);
  }

  const ticker = args[tickerIdx + 1];
  const form = (formIdx !== -1 && args[formIdx + 1]) as "10-K" | "10-Q" || "10-K";

  console.log(`Analyzing ${ticker.toUpperCase()} SEC ${form} filing...`);

  const result = await analyzeSECFiling(ticker, form);
  console.log(`\nCompany: ${result.companyName}`);
  console.log(`Filing: ${result.filingType} (${result.filingDate})`);
  console.log(`Risk Factors: ${result.riskFactorsLength} chars extracted`);
  console.log(`MD&A: ${result.mdnaLength} chars extracted`);
  console.log(`Status: ${result.status}`);
  if (result.error) console.error(`Error: ${result.error}`);
  console.log(`\n${"=".repeat(60)}`);
  console.log(result.analysis);
}
