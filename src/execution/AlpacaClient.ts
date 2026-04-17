#!/usr/bin/env bun
/**
 * AlpacaClient.ts - Alpaca Trading API Client
 *
 * CLI tool for Alpaca trading operations (paper and live trading).
 * Supports account info, positions, orders, and trade execution.
 *
 * Usage:
 *   bun AlpacaClient.ts account [--live]
 *   bun AlpacaClient.ts positions [--live]
 *   bun AlpacaClient.ts position AAPL [--live]
 *   bun AlpacaClient.ts order --symbol AAPL --qty 100 --side buy --type market [--live]
 *   bun AlpacaClient.ts cancel ORDER-ID [--live]
 *   bun AlpacaClient.ts close AAPL [--live]
 *   bun AlpacaClient.ts close-all [--live]
 */

import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";

// Load .env from project root
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
    } else if (!args._command) {
      args._command = argv[i];
    } else if (!args._arg1) {
      args._arg1 = argv[i];
    }
  }
  return args;
}

// Alpaca API configuration
function getConfig(isLive: boolean = false) {
  if (isLive) {
    const apiKey = process.env.ALPACA_LIVE_API_KEY;
    const apiSecret = process.env.ALPACA_LIVE_API_SECRET;
    if (!apiKey || !apiSecret) {
      console.error('Error: ALPACA_LIVE_API_KEY and ALPACA_LIVE_API_SECRET must be set for live trading');
      process.exit(1);
    }
    return {
      baseUrl: 'https://api.alpaca.markets',
      apiKey,
      apiSecret,
    };
  } else {
    const apiKey = process.env.ALPACA_API_KEY;
    const apiSecret = process.env.ALPACA_API_SECRET;
    const baseUrl = process.env.ALPACA_BASE_URL || 'https://paper-api.alpaca.markets';
    if (!apiKey || !apiSecret) {
      console.error('Error: ALPACA_API_KEY and ALPACA_API_SECRET must be set in .env');
      process.exit(1);
    }
    return { baseUrl, apiKey, apiSecret };
  }
}

// Make authenticated API request
async function apiRequest(endpoint: string, options: RequestInit = {}, isLive: boolean = false) {
  const config = getConfig(isLive);
  const url = `${config.baseUrl}${endpoint}`;

  const headers = {
    'APCA-API-KEY-ID': config.apiKey,
    'APCA-API-SECRET-KEY': config.apiSecret,
    'Content-Type': 'application/json',
    ...options.headers,
  };

  try {
    const response = await fetch(url, { ...options, headers });
    const data = await response.json();

    if (!response.ok) {
      throw new Error(`API Error: ${response.status} - ${JSON.stringify(data)}`);
    }

    return data;
  } catch (error) {
    console.error(`Request failed: ${error}`);
    throw error;
  }
}

// Get account information
async function getAccount(isLive: boolean = false) {
  return await apiRequest('/v2/account', {}, isLive);
}

// Get all positions
async function getPositions(isLive: boolean = false) {
  return await apiRequest('/v2/positions', {}, isLive);
}

// Get specific position
async function getPosition(symbol: string, isLive: boolean = false) {
  return await apiRequest(`/v2/positions/${symbol}`, {}, isLive);
}

// Submit order
interface OrderParams {
  symbol: string;
  qty: string;
  side: 'buy' | 'sell';
  type: 'market' | 'limit' | 'stop' | 'stop_limit';
  time_in_force: 'day' | 'gtc';
  limit_price?: string;
  stop_price?: string;
}

async function submitOrder(params: OrderParams, isLive: boolean = false) {
  return await apiRequest('/v2/orders', {
    method: 'POST',
    body: JSON.stringify(params),
  }, isLive);
}

// Cancel order
async function cancelOrder(orderId: string, isLive: boolean = false) {
  return await apiRequest(`/v2/orders/${orderId}`, {
    method: 'DELETE',
  }, isLive);
}

// Get order
async function getOrder(orderId: string, isLive: boolean = false) {
  return await apiRequest(`/v2/orders/${orderId}`, {}, isLive);
}

// Close position
async function closePosition(symbol: string, isLive: boolean = false) {
  return await apiRequest(`/v2/positions/${symbol}`, {
    method: 'DELETE',
  }, isLive);
}

// Close all positions
async function closeAllPositions(isLive: boolean = false) {
  return await apiRequest('/v2/positions', {
    method: 'DELETE',
  }, isLive);
}

// Show help
function showHelp() {
  console.log(`
Alpaca Trading API Client

Usage:
  bun AlpacaClient.ts <command> [options]

Commands:
  account                           Get account information
  positions                         Get all positions
  position <symbol>                 Get specific position
  order                             Submit an order (requires --symbol, --qty, --side, --type)
  cancel <order-id>                 Cancel an order
  close <symbol>                    Close a position
  close-all                         Close all positions

Options:
  --live                            Use live trading API (default: paper trading)
  --symbol <symbol>                 Stock symbol (e.g., AAPL)
  --qty <quantity>                  Number of shares
  --side <buy|sell>                 Order side
  --type <market|limit|stop|stop_limit>  Order type
  --time-in-force <day|gtc>         Time in force (default: day)
  --limit-price <price>             Limit price (for limit orders)
  --stop-price <price>              Stop price (for stop orders)
  --help                            Show this help message

Examples:
  bun AlpacaClient.ts account
  bun AlpacaClient.ts positions --live
  bun AlpacaClient.ts position AAPL
  bun AlpacaClient.ts order --symbol AAPL --qty 100 --side buy --type market
  bun AlpacaClient.ts cancel abc-123-def
  bun AlpacaClient.ts close AAPL
  bun AlpacaClient.ts close-all

Environment Variables:
  ALPACA_API_KEY                    Paper trading API key
  ALPACA_API_SECRET                 Paper trading API secret
  ALPACA_BASE_URL                   Paper trading base URL (default: https://paper-api.alpaca.markets)
  ALPACA_LIVE_API_KEY               Live trading API key (optional)
  ALPACA_LIVE_API_SECRET            Live trading API secret (optional)
`);
}

// Main execution
async function main() {
  const args = parseArgs(process.argv);

  if (args.help) {
    showHelp();
    process.exit(0);
  }

  const command = args._command as string;
  const isLive = args.live === true;

  if (isLive) {
    console.error('WARNING: LIVE TRADING MODE ENABLED');
  }

  try {
    let result;

    switch (command) {
      case 'account':
        result = await getAccount(isLive);
        break;

      case 'positions':
        result = await getPositions(isLive);
        break;

      case 'position':
        if (!args._arg1) {
          console.error('Error: Symbol required');
          process.exit(1);
        }
        result = await getPosition(args._arg1 as string, isLive);
        break;

      case 'order':
        if (!args.symbol || !args.qty || !args.side || !args.type) {
          console.error('Error: --symbol, --qty, --side, and --type are required');
          process.exit(1);
        }
        const orderParams: OrderParams = {
          symbol: args.symbol as string,
          qty: args.qty as string,
          side: args.side as 'buy' | 'sell',
          type: args.type as 'market' | 'limit' | 'stop' | 'stop_limit',
          time_in_force: (args['time-in-force'] as 'day' | 'gtc') || 'day',
        };
        if (args['limit-price']) orderParams.limit_price = args['limit-price'] as string;
        if (args['stop-price']) orderParams.stop_price = args['stop-price'] as string;
        result = await submitOrder(orderParams, isLive);
        break;

      case 'cancel':
        if (!args._arg1) {
          console.error('Error: Order ID required');
          process.exit(1);
        }
        result = await cancelOrder(args._arg1 as string, isLive);
        break;

      case 'close':
        if (!args._arg1) {
          console.error('Error: Symbol required');
          process.exit(1);
        }
        result = await closePosition(args._arg1 as string, isLive);
        break;

      case 'close-all':
        result = await closeAllPositions(isLive);
        break;

      default:
        console.error(`Unknown command: ${command}`);
        showHelp();
        process.exit(1);
    }

    console.log(JSON.stringify(result, null, 2));
    process.exit(0);

  } catch (error) {
    console.error(`Command failed: ${error}`);
    process.exit(1);
  }
}

main();
