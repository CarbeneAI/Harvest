#!/usr/bin/env bun
/**
 * SentimentAnalyzer.ts - Sentiment Scoring Tool
 *
 * Analyzes text content for bullish/bearish sentiment using keyword analysis.
 * Produces normalized sentiment score from -1.0 (bearish) to 1.0 (bullish).
 *
 * Usage:
 *   bun SentimentAnalyzer.ts --ticker AAPL --text "earnings beat expectations"
 *   bun SentimentAnalyzer.ts --ticker AAPL --file news.txt
 *   echo "stock surging on good news" | bun SentimentAnalyzer.ts --ticker AAPL
 */

import { readFileSync } from 'fs';

// Parse command line arguments
function parseArgs(argv: string[]): Record<string, string | boolean> {
  const args: Record<string, string | boolean> = {};
  for (let i = 2; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      const nextValue = argv[i + 1];
      if (nextValue && !nextValue.startsWith('--')) {
        args[key] = nextValue;
        i++;
      } else {
        args[key] = true;
      }
    }
  }
  return args;
}

// Sentiment keywords
const BULLISH_KEYWORDS = [
  'surge', 'surging', 'beat', 'beats', 'upgrade', 'upgraded', 'upgrades',
  'breakout', 'rally', 'rallying', 'bullish', 'growth', 'growing',
  'record', 'strong', 'strength', 'exceeds', 'exceeded', 'outperform',
  'outperforming', 'gain', 'gains', 'up', 'rise', 'rising', 'positive',
  'momentum', 'buy', 'buying', 'accumulate', 'accumulating'
];

const BEARISH_KEYWORDS = [
  'crash', 'crashing', 'miss', 'misses', 'downgrade', 'downgraded', 'downgrades',
  'breakdown', 'sell-off', 'selloff', 'bearish', 'decline', 'declining',
  'weak', 'weakness', 'cuts', 'cutting', 'disappoints', 'disappointed',
  'underperform', 'underperforming', 'loss', 'losses', 'down', 'fall',
  'falling', 'negative', 'sell', 'selling', 'avoid', 'distribute'
];

const AMPLIFIERS = [
  'very', 'extremely', 'significantly', 'massively', 'huge', 'tremendous'
];

// Calculate sentiment score
function analyzeSentiment(text: string): {
  score: number;
  sentiment: 'bullish' | 'bearish' | 'neutral';
  bullishKeywords: string[];
  bearishKeywords: string[];
  amplifiers: string[];
} {
  const lowerText = text.toLowerCase();

  let score = 0;
  const foundBullish: string[] = [];
  const foundBearish: string[] = [];
  const foundAmplifiers: string[] = [];

  // Check for bullish keywords
  for (const keyword of BULLISH_KEYWORDS) {
    const regex = new RegExp(`\\b${keyword}\\b`, 'gi');
    const matches = lowerText.match(regex);
    if (matches) {
      score += 0.1 * matches.length;
      if (!foundBullish.includes(keyword)) {
        foundBullish.push(keyword);
      }
    }
  }

  // Check for bearish keywords
  for (const keyword of BEARISH_KEYWORDS) {
    const regex = new RegExp(`\\b${keyword}\\b`, 'gi');
    const matches = lowerText.match(regex);
    if (matches) {
      score -= 0.1 * matches.length;
      if (!foundBearish.includes(keyword)) {
        foundBearish.push(keyword);
      }
    }
  }

  // Check for amplifiers
  for (const amplifier of AMPLIFIERS) {
    const regex = new RegExp(`\\b${amplifier}\\b`, 'gi');
    const matches = lowerText.match(regex);
    if (matches) {
      score *= 1.5;
      if (!foundAmplifiers.includes(amplifier)) {
        foundAmplifiers.push(amplifier);
      }
    }
  }

  // Normalize to -1.0 to 1.0
  score = Math.max(-1.0, Math.min(1.0, score));

  // Determine sentiment label
  let sentiment: 'bullish' | 'bearish' | 'neutral';
  if (score > 0.1) {
    sentiment = 'bullish';
  } else if (score < -0.1) {
    sentiment = 'bearish';
  } else {
    sentiment = 'neutral';
  }

  return {
    score: parseFloat(score.toFixed(3)),
    sentiment,
    bullishKeywords: foundBullish,
    bearishKeywords: foundBearish,
    amplifiers: foundAmplifiers,
  };
}

// Read from stdin
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

// Show help
function showHelp() {
  console.log(`
Sentiment Analyzer

Usage:
  bun SentimentAnalyzer.ts --ticker <symbol> [options]

Options:
  --ticker <symbol>      Stock ticker symbol
  --text <text>          Text to analyze
  --file <path>          Read text from file
  --help                 Show this help message

Examples:
  bun SentimentAnalyzer.ts --ticker AAPL --text "earnings beat expectations"
  bun SentimentAnalyzer.ts --ticker AAPL --file news.txt
  echo "stock surging" | bun SentimentAnalyzer.ts --ticker AAPL

Output:
  JSON object with:
  - ticker: Stock symbol
  - score: Sentiment score (-1.0 to 1.0)
  - sentiment: Label (bullish/bearish/neutral)
  - bullishKeywords: Bullish keywords found
  - bearishKeywords: Bearish keywords found
  - amplifiers: Amplifier words found
  - inputLength: Number of characters analyzed

Scoring:
  - Each bullish keyword: +0.1
  - Each bearish keyword: -0.1
  - Amplifier multiplier: 1.5x
  - Final score normalized to -1.0 to 1.0 range
`);
}

// Main execution
async function main() {
  const args = parseArgs(process.argv);

  if (args.help) {
    showHelp();
    process.exit(0);
  }

  if (!args.ticker) {
    console.error('Error: --ticker is required');
    showHelp();
    process.exit(1);
  }

  const ticker = (args.ticker as string).toUpperCase();
  let text = '';

  if (args.text) {
    text = args.text as string;
  } else if (args.file) {
    try {
      text = readFileSync(args.file as string, 'utf-8');
    } catch (error) {
      console.error(`Error reading file: ${error}`);
      process.exit(1);
    }
  } else if (!process.stdin.isTTY) {
    // Read from stdin
    text = await readStdin();
  } else {
    console.error('Error: Must provide --text, --file, or pipe input via stdin');
    showHelp();
    process.exit(1);
  }

  if (!text.trim()) {
    console.error('Error: No text to analyze');
    process.exit(1);
  }

  const analysis = analyzeSentiment(text);

  const result = {
    ticker,
    ...analysis,
    inputLength: text.length,
  };

  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}

main();
