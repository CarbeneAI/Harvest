# Strategy Documentation

Harvest runs two complementary trading strategies simultaneously. Each strategy has its own entry criteria, exit rules, position sizing, and universe of stocks.

## Market Regime Filter

Before scanning, Harvest checks the market regime using SPY (S&P 500 ETF):

| Regime | Condition | Effect |
|--------|-----------|--------|
| BULL | SPY > 200 SMA | Full position sizes for both strategies |
| CAUTION | SPY between 50 SMA and 200 SMA | Half position sizes |
| BEAR | SPY < 50 SMA | Mean reversion only, quarter position sizes |

This prevents buying momentum longs into a downtrend — one of the most common causes of trading losses.

---

## Strategy 1: Momentum Trend Following

### Concept

Buy stocks that are already trending up with institutional momentum behind them. Ride the trend until technical signals indicate it's breaking down.

Inspired by: Jegadeesh-Titman (1993) momentum research, multi-timeframe momentum weighting.

### Universe

~80 liquid large-cap stocks. Screened for:
- Sufficient volume (100k+ shares/day average)
- Price > $10
- Not in bear regime

### Entry Criteria (all must pass)

| Indicator | Requirement | Rationale |
|-----------|-------------|-----------|
| Price vs SMA | Price > 20 SMA > 50 SMA | Uptrend structure |
| RSI (14) | 40-70 | Momentum but not overbought |
| MACD | Line > Signal | Bullish momentum |
| ADX (14) | > 20 | Trend is strong, not choppy |
| Volume | Above 20-day average | Institutional participation |
| Multi-TF Momentum | Positive composite | 1m/3m/6m weighted score |

### Scoring (7 components, 0-7)

1. Price above 20 SMA
2. 20 SMA above 50 SMA (higher timeframe trend)
3. RSI in 40-70 range
4. MACD bullish crossover or positive histogram
5. Volume above average
6. ADX > 20
7. Multi-timeframe momentum composite positive

### Exit Rules

| Condition | Action |
|-----------|--------|
| Trailing stop hit (2x ATR below high) | Sell immediately |
| Price closes below 20 SMA for 2 consecutive days | Sell |
| Max hold (40 trading days) reached | Sell |
| Portfolio review recommends SELL | Manual review |

### Position Sizing

Base: 5% of portfolio equity

Volatility adjustment:
- Annual vol < 15%: 6% max (increase for low-vol quality stocks)
- Annual vol 15-30%: 5% (standard)
- Annual vol 30-50%: 4% (reduce for high-vol)
- Annual vol > 50%: 3% (heavily reduce for very high-vol)

Correlation adjustment (applied after volatility):
- Average portfolio correlation > 0.8: multiply by 0.65
- Average portfolio correlation > 0.6: multiply by 0.80
- Average portfolio correlation > 0.4: multiply by 0.90

---

## Strategy 2: Mean Reversion on Quality

### Concept

Buy temporary dips in high-quality, "moat" businesses. These companies have durable competitive advantages, so temporary overselling creates a buying opportunity.

Inspired by: Buffett's quality-at-a-discount framework, Bollinger Band reversion, Z-score statistical methods.

### Universe

~20 moat stocks. Curated list of companies with durable competitive advantages:
- Wide economic moat (brand, network effect, switching costs, cost advantage)
- Strong balance sheet
- Consistent free cash flow
- Not cyclical or speculative

### Entry Criteria

| Indicator | Requirement | Rationale |
|-----------|-------------|-----------|
| Price vs 200 SMA | Price above 200 SMA | Long-term uptrend intact |
| RSI (14) | < 35 | Oversold |
| OR Z-score | < -2 | Statistically oversold (2+ standard deviations below mean) |
| Bollinger Band | Price at/below lower band | Extreme deviation |
| Hurst Exponent | < 0.5 | Confirms mean-reverting behavior (not trending) |

The Z-score condition is an alternative to RSI < 35. Either triggers an entry scan.

### Scoring (6 components, 0-6)

1. Price above 200 SMA
2. RSI < 35 (OR Z-score < -2)
3. Price at or below lower Bollinger Band
4. Hurst exponent < 0.5 (mean-reverting)
5. RSI actually below 35 (bonus vs Z-score-only trigger)
6. Z-score below -2 (bonus vs RSI-only trigger)

### Exit Rules

| Condition | Action |
|-----------|--------|
| RSI recovers above 50 | Sell (reversal complete) |
| Price reaches 20 SMA | Sell (mean reversion complete) |
| Max hold (15 trading days) reached | Sell |
| Portfolio review recommends SELL | Manual review |

### Position Sizing

Base: 4% of portfolio equity (slightly smaller than momentum, as MR can take longer to play out)

Same volatility and correlation adjustments as momentum strategy.

---

## Fundamental Quality Gate

After scanning, each recommendation goes through a fundamental quality check using Yahoo Finance data.

### Metrics Evaluated

| Metric | Source | Scoring |
|--------|--------|---------|
| Return on Equity | Yahoo Finance | > 15% = pass |
| Gross Margin | Yahoo Finance | > 30% = pass |
| Debt-to-Equity | Yahoo Finance | < 1.5 = pass |
| Free Cash Flow Yield | Yahoo Finance | > 0 = pass |

### Verdicts

| Verdict | Condition | Effect on Conviction |
|---------|-----------|---------------------|
| SKIP | Multiple red flags | Remove from recommendations |
| DAMPEN | Some concerns | Reduce conviction by -2 |
| NEUTRAL | Mixed fundamentals | No change |
| AMPLIFY | Strong fundamentals | Increase conviction by +1 |

---

## Research Pipeline

Each recommendation can be enriched with Perplexity-powered deep research:

### DeepResearch Sections (parallel execution)

1. **Industry Momentum Analysis** — Is the sector accelerating or decelerating?
2. **Competitive Teardown** — Market share, competitive moat, recent news
3. **Policy & Regulation Radar** — Government policy, regulatory risk, subsidies
4. **SEC Filing Analysis** — 10-K/10-Q key findings, risks, management discussion
5. **Technical Analysis** — Price action, trend, key levels

### Conviction Adjustment

| Research Score | Conviction Change |
|---------------|------------------|
| +0.5 to +1.0 | +2 (strongly supports) |
| +0.2 to +0.5 | +1 (supports) |
| -0.1 to +0.2 | 0 (neutral) |
| -0.3 to -0.1 | -1 (mixed signals) |
| -1.0 to -0.3 | -3 (contradicts thesis) |

---

## Conviction Scoring

Overall conviction is a composite of signals:

**Momentum scoring (0-10):**
- 7 technical components (1 point each)
- Fundamental gate adjustment (-2 to +1)
- Research enrichment (-3 to +2)

**Auto-execution threshold:** >= 7

Recommendations below 7 are held pending but not auto-executed. They can be manually approved from the dashboard.

---

## Performance Targets

- Target annualized return: ~30% (~0.12% per trading day)
- Maximum drawdown target: < 15%
- Win rate target: > 55%
- Profit factor target: > 1.5

---

## What Harvest Does NOT Do

- Options trading
- Short selling
- High-frequency trading
- Earnings plays
- Congressional trading signals (removed — data subscription required)
- Dark pool signals (removed — data subscription required)
- Leveraged positions
- Fractional shares
