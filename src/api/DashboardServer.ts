#!/usr/bin/env bun
/**
 * DashboardServer.ts - Harvest Trading Dashboard Server
 *
 * Single Bun HTTP server serving static dashboard + API routes.
 * Proxies Alpaca API for portfolio data and manages recommendations.
 *
 * Usage:
 *   bun DashboardServer.ts [--port 8083]
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, resolve, dirname } from "path";
import { runDeepResearch, loadCached } from "../research/DeepResearch.js";

const PORT = parseInt(process.env.DASHBOARD_PORT || "8083");
const PROJECT_ROOT = resolve(dirname(new URL(import.meta.url).pathname), "../..");
const DASHBOARD_DIR = join(PROJECT_ROOT, "dashboard");
const DATA_DIR = join(PROJECT_ROOT, "data");
const RECOMMENDATIONS_FILE = join(DATA_DIR, "recommendations.json");
const LEARNINGS_FILE = join(DATA_DIR, "learnings.md");
const JOURNAL_DIR = join(DATA_DIR, "journal");
const REVIEWS_DIR = join(DATA_DIR, "reviews");

// --- Load .env ---
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

// Alpaca config
function getAlpacaConfig() {
  const apiKey = process.env.ALPACA_API_KEY || "";
  const apiSecret = process.env.ALPACA_API_SECRET || "";
  const baseUrl = process.env.ALPACA_BASE_URL || "https://paper-api.alpaca.markets";
  return { apiKey, apiSecret, baseUrl };
}

async function alpacaFetch(endpoint: string, options: RequestInit = {}) {
  const config = getAlpacaConfig();
  if (!config.apiKey || !config.apiSecret) {
    return { error: "Alpaca API keys not configured. Set ALPACA_API_KEY and ALPACA_API_SECRET in .env" };
  }
  const url = `${config.baseUrl}${endpoint}`;
  const resp = await fetch(url, {
    ...options,
    headers: {
      "APCA-API-KEY-ID": config.apiKey,
      "APCA-API-SECRET-KEY": config.apiSecret,
      "Content-Type": "application/json",
      ...options.headers,
    },
  });
  const text = await resp.text();
  try {
    return JSON.parse(text);
  } catch {
    return { error: `Alpaca returned non-JSON (${resp.status}): ${text.slice(0, 200)}` };
  }
}

// Recommendations CRUD
function loadRecommendations(): any[] {
  if (!existsSync(RECOMMENDATIONS_FILE)) return [];
  try {
    return JSON.parse(readFileSync(RECOMMENDATIONS_FILE, "utf-8"));
  } catch {
    return [];
  }
}

function saveRecommendations(recs: any[]) {
  writeFileSync(RECOMMENDATIONS_FILE, JSON.stringify(recs, null, 2));
}

// Parse learnings.md into JSON
function parseLearnings(): any[] {
  if (!existsSync(LEARNINGS_FILE)) return [];
  try {
    const content = readFileSync(LEARNINGS_FILE, "utf-8");
    const entries: any[] = [];
    const blocks = content.split(/^## /m).filter(Boolean);
    for (const block of blocks) {
      const lines = block.trim().split("\n");
      const title = lines[0]?.trim() || "";
      const body = lines.slice(1).join("\n").trim();
      // Extract salience score if present
      const salienceMatch = body.match(/salience[:\s]*([0-9.]+)/i);
      entries.push({
        title,
        body,
        salience: salienceMatch ? parseFloat(salienceMatch[1]) : 0.5,
      });
    }
    return entries.sort((a, b) => b.salience - a.salience);
  } catch {
    return [];
  }
}

// Parse journal entries
function parseJournal(): any[] {
  if (!existsSync(JOURNAL_DIR)) return [];
  try {
    const { readdirSync } = require("fs");
    const files = readdirSync(JOURNAL_DIR)
      .filter((f: string) => f.endsWith(".md"))
      .sort()
      .reverse()
      .slice(0, 20);
    return files.map((f: string) => {
      const content = readFileSync(join(JOURNAL_DIR, f), "utf-8");
      const lines = content.split("\n");
      const title = lines[0]?.replace(/^#+\s*/, "") || f;
      return { file: f, title, content: content.slice(0, 500) };
    });
  } catch {
    return [];
  }
}

// Compute daily P&L from account
function computeDailyPL(account: any) {
  const equity = parseFloat(account.equity || "0");
  const lastEquity = parseFloat(account.last_equity || "0");
  const pl = equity - lastEquity;
  const plPct = lastEquity > 0 ? (pl / lastEquity) * 100 : 0;
  return { pl: pl.toFixed(2), plPct: plPct.toFixed(2), equity, lastEquity };
}

// Track in-progress research to prevent duplicate runs
const researchInProgress = new Set<string>();

const json = (data: any) =>
  new Response(JSON.stringify(data), {
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  });

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    // CORS preflight
    if (req.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        },
      });
    }

    // API routes
    if (path === "/api/account") return json(await alpacaFetch("/v2/account"));
    if (path === "/api/positions") return json(await alpacaFetch("/v2/positions"));
    if (path === "/api/orders") return json(await alpacaFetch("/v2/orders?status=all&limit=50"));
    if (path === "/api/daily-pl") {
      const account = await alpacaFetch("/v2/account");
      if (account.error) return json(account);
      return json(computeDailyPL(account));
    }
    if (path === "/api/recommendations") return json(loadRecommendations());
    if (path === "/api/learnings") return json(parseLearnings());
    if (path === "/api/journal") return json(parseJournal());

    // Portfolio review - returns latest review report
    if (path === "/api/portfolio-review") {
      try {
        if (!existsSync(REVIEWS_DIR)) return json({ reviews: [], date: null });
        const { readdirSync } = require("fs");
        const files = readdirSync(REVIEWS_DIR)
          .filter((f: string) => f.endsWith("-portfolio-review.json"))
          .sort()
          .reverse();
        if (files.length === 0) return json({ reviews: [], date: null });
        const latest = JSON.parse(readFileSync(join(REVIEWS_DIR, files[0]), "utf-8"));
        return json(latest);
      } catch {
        return json({ reviews: [], date: null, error: "Failed to load review" });
      }
    }

    // Manual trade approval disabled — pipeline executes autonomously via AutoExecute.ts
    const manualTradeMatch = path.match(/^\/api\/recommendations\/(.+)\/(approve|reject|reconsider)$/);
    if (manualTradeMatch && req.method === "POST") {
      return json({ error: "Manual trade approval disabled. Harvest executes autonomously via AutoExecute.ts." });
    }

    // GET /api/research/:ticker - Return cached or in-progress research
    const researchGetMatch = path.match(/^\/api\/research\/([A-Za-z]+)$/);
    if (researchGetMatch && req.method === "GET") {
      const ticker = researchGetMatch[1].toUpperCase();
      const cached = loadCached(ticker);
      if (cached) return json(cached);
      if (researchInProgress.has(ticker)) {
        return json({ ticker, status: "in_progress" });
      }
      return json({ ticker, status: "not_found" });
    }

    // POST /api/research/:ticker - Kick off research async
    const researchPostMatch = path.match(/^\/api\/research\/([A-Za-z]+)$/);
    if (researchPostMatch && req.method === "POST") {
      const ticker = researchPostMatch[1].toUpperCase();

      // Already running?
      if (researchInProgress.has(ticker)) {
        return json({ ticker, status: "in_progress", message: "Research already running" });
      }

      // Already cached today?
      const cached = loadCached(ticker);
      if (cached && cached.status === "complete") {
        return json(cached);
      }

      // Kick off async
      researchInProgress.add(ticker);
      runDeepResearch(ticker)
        .then(() => researchInProgress.delete(ticker))
        .catch(() => researchInProgress.delete(ticker));

      return json({ ticker, status: "in_progress", message: "Research started" });
    }

    // Static files
    let filePath = path === "/" ? "/index.html" : path;
    const fullPath = join(DASHBOARD_DIR, filePath);
    const file = Bun.file(fullPath);
    if (await file.exists()) {
      const headers: Record<string, string> = {};
      if (filePath.endsWith(".html")) {
        headers["Cache-Control"] = "no-cache, no-store, must-revalidate";
        headers["Pragma"] = "no-cache";
        headers["Expires"] = "0";
      }
      return new Response(file, { headers });
    }

    return new Response("Not Found", { status: 404 });
  },
});

console.log(`Harvest Trading Dashboard running on http://localhost:${PORT}`);
