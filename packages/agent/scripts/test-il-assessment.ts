#!/usr/bin/env npx ts-node
/**
 * YieldGeko — Production IL Assessment
 *
 * Framework: Loss-Versus-Rebalancing (LVR)
 * ─────────────────────────────────────────
 * Milionis, Moallemi, Roughgarden & Zhang (2022)
 * "Automated Market Making and Loss-Versus-Rebalancing"
 *
 * LVR is the theoretically correct cost metric for LP positions.
 * IL (vs HODL) is misleading — it compares against the wrong benchmark.
 * LVR compares against a continuously rebalancing portfolio (the true
 * opportunity cost), and is the cost that arbitrageurs extract from LPs.
 *
 * Core result: An LP position is profitable iff fee_rate > LVR_rate
 *
 *   LVR_rate = C × σ²_ratio / 8    (per unit capital per unit time)
 *
 * Where:
 *   C        = exact Uniswap V3 concentration factor for range [P_L, P_H]
 *              = √P_H / (√P_H - √P_L)
 *              = √(1+r) / (√(1+r) - √(1-r))   for symmetric ±r range
 *              ≈ 10.47× for ±10% range
 *   σ_ratio  = daily volatility of log(P_A/P_B)  — the PAIR volatility
 *              = √(σ_A² + σ_B² - 2ρσ_Aσ_B)  using Spearman ρ
 *
 * Volatility estimation: EWMA (RiskMetrics, λ=0.94) + multi-window max
 *   σ²_EWMA(t) = 0.94 × σ²_{t-1} + 0.06 × r²_{t-1}
 *   σ²_used    = max(σ²_7d, σ²_14d, σ²_30d, σ²_EWMA_forecast)
 *   Conservative: always uses the worst recent estimate
 *
 * Monte Carlo: 5,000 correlated GBM paths over 30 days
 *   − Cholesky decomposition for Spearman correlation
 *   − Exact V3 LP value formula at each step
 *   − In-range fee accrual tracking
 *   − Reports: E[P&L], P5 (5th percentile), P(profit)
 *
 * Usage:
 *   npx ts-node scripts/test-il-assessment.ts
 */

import { ethers } from 'ethers';
import * as dotenv from 'dotenv';
import * as path   from 'node:path';

dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

const ARB_RPC  = process.env.ARB_RPC_URL ?? 'https://arb1.arbitrum.io/rpc';
const provider = new ethers.JsonRpcProvider(ARB_RPC, 42161, { staticNetwork: true });

// ── Constants ─────────────────────────────────────────────────────────────────

const RANGE_WIDTH    = 0.10;        // ±10% range (our default)
const EWMA_LAMBDA    = 0.94;        // RiskMetrics industry standard
const MC_PATHS       = 5_000;       // Monte Carlo simulations
const MC_DAYS        = 30;          // Holding period
const MIN_TVL        = 500_000;     // $500K minimum TVL

// Exact V3 concentration factor for symmetric ±r range
// C = √(1+r) / (√(1+r) - √(1-r))
const CONCENTRATION_C = Math.sqrt(1 + RANGE_WIDTH) / (Math.sqrt(1 + RANGE_WIDTH) - Math.sqrt(1 - RANGE_WIDTH));

// Rating thresholds on LVR ratio
const THRESHOLD_SAFE     = 3.0;   // fee covers LVR 3×
const THRESHOLD_MODERATE = 1.5;   // fee covers LVR 1.5×
const THRESHOLD_MARGINAL = 1.0;   // fee covers LVR 1×

const STABLECOINS = new Set([
  '0xaf88d065e77c8cc2239327c5edb3a432268e5831',
  '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9',
  '0xda10009cbd5d07dd0cecc66161fc93d7c9000da1',
  '0xff970a61a04b1ca14834a43f5de4533ebddb5cc8',
  '0x93b346b6bc2548da6a1e7d98e9a421b42541425b',
]);

// ── Types ─────────────────────────────────────────────────────────────────────

interface VolStats {
  symbol:       string;
  isStable:     boolean;
  vol7d:        number;    // 7d annualized daily vol
  vol14d:       number;    // 14d annualized daily vol
  vol30d:       number;    // 30d annualized daily vol
  volEWMA:      number;    // EWMA 1-day ahead forecast, annualized
  volConservative: number; // max of all windows — used in LVR calc
  returns:      number[];  // daily log returns (30d)
  ranks:        number[];  // ranks of returns (for Spearman)
}

interface LVRAssessment {
  poolAddress:   string;
  symbol:        string;
  token0:        VolStats;
  token1:        VolStats;
  spearmanCorr:  number;      // robust correlation (on ranks)
  sigmaRatio:    number;      // annualized pair vol σ_ratio
  sigmaRatioDaily: number;    // daily pair vol
  concentrationC: number;     // exact V3 C factor
  lvrRateDaily:  number;      // LVR cost rate per day (% of capital)
  feeRateDaily:  number;      // fee income rate per day (% of capital)
  lvrRatio:      number;      // fee/LVR — key metric
  feeAPY:        number;
  tvlUSD:        number;
  // Monte Carlo results
  mcMeanPnL:     number;      // E[30d P&L] as % of capital
  mcP5PnL:       number;      // 5th percentile 30d P&L
  mcProbProfit:  number;      // P(30d P&L > 0)
  rating:        'SAFE' | 'MODERATE' | 'MARGINAL' | 'RISKY' | 'STABLE_PAIR' | 'NO_DATA';
  note:          string;
}

// ── Math utilities ────────────────────────────────────────────────────────────

function mean(arr: number[]): number {
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function variance(arr: number[]): number {
  const m = mean(arr);
  return arr.reduce((a, b) => a + (b - m) ** 2, 0) / (arr.length - 1);
}

function rollingVol(returns: number[], window: number): number {
  if (returns.length < window) return 0;
  const recent = returns.slice(-window);
  return Math.sqrt(variance(recent) * 365);  // annualized
}

// EWMA volatility — RiskMetrics model (λ=0.94)
// σ²_t = λ × σ²_{t-1} + (1-λ) × r²_{t-1}
// Returns 1-day ahead annualized vol forecast
function ewmaVolForecast(returns: number[]): number {
  if (returns.length < 5) return 0;
  let variance = returns[0] ** 2;
  for (let i = 1; i < returns.length; i++) {
    variance = EWMA_LAMBDA * variance + (1 - EWMA_LAMBDA) * returns[i] ** 2;
  }
  // variance is daily variance; annualise
  return Math.sqrt(variance * 365);
}

// Rank transformation for Spearman correlation
function ranks(arr: number[]): number[] {
  const sorted = [...arr].map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
  const result = new Array(arr.length);
  for (let rank = 0; rank < sorted.length; rank++) {
    result[sorted[rank].i] = rank + 1;
  }
  return result;
}

// Pearson correlation (on ranks = Spearman)
function spearmanCorrelation(a: number[], b: number[]): number {
  const n  = Math.min(a.length, b.length);
  const rA = ranks(a.slice(0, n));
  const rB = ranks(b.slice(0, n));
  const mA = mean(rA), mB = mean(rB);
  let cov = 0, varA = 0, varB = 0;
  for (let i = 0; i < n; i++) {
    const dA = rA[i] - mA, dB = rB[i] - mB;
    cov += dA * dB; varA += dA * dA; varB += dB * dB;
  }
  return cov / Math.sqrt(varA * varB);
}

// Cholesky decomposition for 2×2 correlation matrix [[1, ρ], [ρ, 1]]
// Returns L such that L × Lᵀ = Σ
function cholesky2x2(rho: number): [number, number, number, number] {
  const l11 = 1;
  const l21 = rho;
  const l22 = Math.sqrt(1 - rho ** 2);
  return [l11, 0, l21, l22];
}

// Standard normal sample using Box-Muller
function randn(): number {
  const u1 = Math.random(), u2 = Math.random();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

// ── Exact V3 LP value ────────────────────────────────────────────────────────
//
//  For a balanced V3 position in [P_L, P_H] with initial price P_0:
//  Initial value: V_0 = W (normalised to 1)
//
//  At price P (where p = P/P_0 is the normalised price):
//    If p in [p_L, p_H]:  V = 2√(p × C_adj) / (1 + C_adj^(1/2))  [approx]
//
//  Exact relative value (Milionis et al., Eq. 6):
//    For equal-value initial holdings at P_0:
//
//    V(P) / V(P_0) = [2√(P/P_0) × (√P_H - √P_L)] / [(√P_H + √P_L) × √(P_H × P_L) × ...]
//
//  Simplified for ±r range (symmetric):
//    V_LP(p) / V_LP(1) = 2√p / (1 + p) × (√(1+r)) / (√(1+r) - √(1-r)) × something
//
//  Practical: use the standard IL formula adjusted for concentration.
//  For V3, the effective IL versus V2 is C times larger (near range center).
//  We approximate LP value as:
//
//    V(p) = V_0 × [2√p / (1 + p) × K]     (in-range, K is a range-specific constant)
//    V(p) = V_0 × [p_L^(1/4) / p_L^(1/2)] (below lower tick — all in asset A)
//    V(p) = V_0 × [p_H^(1/2)]              (above upper tick — all in asset B)

/**
 * Normalised V3 LP value ratio — returns 1.0 at P = P_0 = 1.
 *
 * Derivation (USDC-paired, token1 = stable):
 *   In range: V = 2√P - √P_L - P/√P_H      (from virtual reserves)
 *   Below range: V = (1/√P_L - 1/√P_H) × P  (all in token0, value falls with P)
 *   Above range: V = √P_H - √P_L             (all in token1 USDC, constant)
 *   v0 = V(P_0=1) = 2 - √P_L - 1/√P_H
 *   ratio = V(P) / v0  →  returns 1 at P=P_0
 *
 * For non-USDC pairs: call this with ratio = P_A/P_B, then multiply by p1.
 */
function v3LpValueRatio(p: number, pL: number, pH: number): number {
  const v0 = 2 - Math.sqrt(pL) - 1 / Math.sqrt(pH);   // normalising constant: V at p=1

  let v: number;
  if (p >= pH) {
    // Above range: all token1 (stablecoin) — value constant
    v = Math.sqrt(pH) - Math.sqrt(pL);
  } else if (p <= pL) {
    // Below range: all token0 — value falls linearly with price
    v = (1 / Math.sqrt(pL) - 1 / Math.sqrt(pH)) * p;
  } else {
    // In range: exact V3 virtual-reserve formula
    v = 2 * Math.sqrt(p) - Math.sqrt(pL) - p / Math.sqrt(pH);
  }

  return v / v0;   // = 1.0 at p = P_0 = 1
}

// ── Monte Carlo simulation ────────────────────────────────────────────────────

function runMonteCarlo(
  sigma0Daily: number,   // daily vol of token0
  sigma1Daily: number,   // daily vol of token1
  spearman:    number,   // Spearman correlation
  feeAPY:      number,   // annual fee APY (%)
  days:        number,
  paths:       number,
): { meanPnL: number; p5PnL: number; probProfit: number } {
  const pL = 1 - RANGE_WIDTH;
  const pH = 1 + RANGE_WIDTH;
  const feeRateDaily = feeAPY / 100 / 365;
  const [l11, , l21, l22] = cholesky2x2(Math.max(-0.99, Math.min(0.99, spearman)));
  const pnls: number[] = [];

  for (let path = 0; path < paths; path++) {
    let p0 = 1.0, p1 = 1.0;  // token prices, normalised to 1
    let cumulativeFees = 0;
    let daysInRange = 0;

    for (let d = 0; d < days; d++) {
      // Correlated GBM step using Cholesky decomposition
      const z1 = randn(), z2 = randn();
      const w0 = l11 * z1;
      const w1 = l21 * z1 + l22 * z2;

      p0 *= Math.exp(sigma0Daily * w0 - 0.5 * sigma0Daily ** 2);
      p1 *= Math.exp(sigma1Daily * w1 - 0.5 * sigma1Daily ** 2);

      // Normalised price ratio (token0 in terms of token1)
      const ratio = p0 / p1;

      // Fee accrual: only when in range
      if (ratio >= pL && ratio <= pH) {
        cumulativeFees += feeRateDaily;
        daysInRange++;
      }
    }

    // Final LP value in USD (normalised to initial = 1)
    // v3LpValueRatio gives LP value in token1 units (ratio to initial token1 value)
    // Multiplying by p1 converts to USD: LP_usd = LP_in_token1 × (USD_per_token1)
    const finalRatio  = p0 / p1;
    const lpValueUSD  = v3LpValueRatio(finalRatio, pL, pH) * p1;

    // HODL: started 50/50 so initial = 0.5×p0_0 + 0.5×p1_0 = 1
    // After price moves: HODL = 0.5×p0 + 0.5×p1 = (p0+p1)/2
    const hodlValue   = (p0 + p1) / 2;

    const pnl = lpValueUSD + cumulativeFees - hodlValue;
    pnls.push(pnl * 100);  // as %
  }

  pnls.sort((a, b) => a - b);
  const meanPnL   = mean(pnls);
  const p5PnL     = pnls[Math.floor(paths * 0.05)];
  const probProfit = pnls.filter(p => p > 0).length / paths;
  return { meanPnL, p5PnL, probProfit };
}

// ── DeFiLlama price fetch (free, no rate limits, batch support) ───────────────

const priceCache  = new Map<string, VolStats>();

async function fetchVolStatsBatch(addresses: string[]): Promise<void> {
  const toFetch = addresses.map(a => a.toLowerCase()).filter(a => !priceCache.has(a) && !STABLECOINS.has(a));
  if (toFetch.length === 0) return;

  const start = Math.floor(Date.now() / 1000) - 31 * 86400;
  const coins = toFetch.map(a => `arbitrum:${a}`).join(',');
  const url   = `https://coins.llama.fi/chart/${coins}?start=${start}&span=30&period=1d`;

  try {
    const res  = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json() as any;

    for (const addr of toFetch) {
      const entry  = json.coins?.[`arbitrum:${addr}`];
      const prices = (entry?.prices as Array<{timestamp: number; price: number}> ?? []).map(p => p.price);
      const sym    = entry?.symbol ?? addr.slice(2, 8).toUpperCase();

      if (prices.length < 10) {
        priceCache.set(addr, { symbol: sym, isStable: false, vol7d: 0, vol14d: 0, vol30d: 0, volEWMA: 0, volConservative: 0, returns: [], ranks: [] });
        continue;
      }
      const returns: number[] = [];
      for (let i = 1; i < prices.length; i++) {
        if (prices[i-1] > 0) returns.push(Math.log(prices[i] / prices[i-1]));
      }
      const vol7d  = rollingVol(returns, 7);
      const vol14d = rollingVol(returns, 14);
      const vol30d = rollingVol(returns, 30);
      const volEWMA = ewmaVolForecast(returns);
      priceCache.set(addr, { symbol: sym, isStable: false, vol7d, vol14d, vol30d, volEWMA,
        volConservative: Math.max(vol7d, vol14d, vol30d, volEWMA), returns, ranks: ranks(returns) });
    }
  } catch (e: any) {
    console.log(`  ⚠ DeFiLlama price batch failed: ${e.message.slice(0, 60)}`);
  }
}

async function fetchVolStats(address: string): Promise<VolStats> {
  const lower = address.toLowerCase();
  if (priceCache.has(lower)) return priceCache.get(lower)!;

  const isStable = STABLECOINS.has(lower);

  let symbol = lower.slice(2, 8).toUpperCase();
  try {
    const c = new ethers.Contract(address, ['function symbol() view returns (string)'], provider);
    symbol = await c.symbol() as string;
  } catch { /* use address prefix */ }

  if (isStable) {
    const r: VolStats = { symbol, isStable: true, vol7d: 0, vol14d: 0, vol30d: 0, volEWMA: 0, volConservative: 0, returns: Array(30).fill(0), ranks: Array(30).fill(0) };
    priceCache.set(lower, r); return r;
  }

  await fetchVolStatsBatch([lower]);
  if (priceCache.has(lower)) return priceCache.get(lower)!;

  // Already handled in batch — return empty if still missing
  let prices: number[] = [];

  if (prices.length < 10) throw new Error(`Only ${prices.length} price points`);

  // Daily log returns
  const returns: number[] = [];
  for (let i = 1; i < prices.length; i++) {
    if (prices[i - 1] > 0 && prices[i] > 0) returns.push(Math.log(prices[i] / prices[i - 1]));
  }

  const vol7d  = rollingVol(returns, 7);
  const vol14d = rollingVol(returns, 14);
  const vol30d = rollingVol(returns, 30);
  const volEWMA = ewmaVolForecast(returns);
  const volConservative = Math.max(vol7d, vol14d, vol30d, volEWMA);

  const r: VolStats = { symbol, isStable: false, vol7d, vol14d, vol30d, volEWMA, volConservative, returns, ranks: ranks(returns) };
  priceCache.set(lower, r);
  return r;
}

// ── Core LVR assessment ───────────────────────────────────────────────────────

async function assessPool(
  poolAddress: string,
  symbol:      string,
  token0Addr:  string,
  token1Addr:  string,
  feeAPY:      number,
  tvlUSD:      number,
): Promise<LVRAssessment> {
  const base = { poolAddress, symbol, concentrationC: CONCENTRATION_C, feeAPY, tvlUSD };

  const [s0, s1] = await Promise.all([fetchVolStats(token0Addr), fetchVolStats(token1Addr)]);

  // Stable pair — IL ≈ 0
  if (s0.isStable && s1.isStable) {
    return {
      ...base, token0: s0, token1: s1, spearmanCorr: 1,
      sigmaRatio: 0, sigmaRatioDaily: 0, lvrRateDaily: 0,
      feeRateDaily: feeAPY / 100 / 365, lvrRatio: Infinity,
      mcMeanPnL: feeAPY / 365 * 30, mcP5PnL: feeAPY / 365 * 30, mcProbProfit: 1,
      rating: 'STABLE_PAIR', note: 'Both stablecoins — LVR ≈ 0',
    };
  }

  // No data
  if (s0.returns.length < 10 || s1.returns.length < 10) {
    return {
      ...base, token0: s0, token1: s1, spearmanCorr: 0,
      sigmaRatio: 0, sigmaRatioDaily: 0, lvrRateDaily: 0,
      feeRateDaily: feeAPY / 100 / 365, lvrRatio: 0,
      mcMeanPnL: 0, mcP5PnL: 0, mcProbProfit: 0,
      rating: 'NO_DATA', note: 'Insufficient price history',
    };
  }

  // Spearman correlation (robust to outliers)
  const minLen = Math.min(s0.returns.length, s1.returns.length);
  const spearmanCorr = s0.isStable || s1.isStable ? 0 : spearmanCorrelation(s0.returns.slice(-minLen), s1.returns.slice(-minLen));

  // σ_ratio: pair volatility (daily, then annualised)
  const σ0 = s0.volConservative / Math.sqrt(365);  // daily (conservative)
  const σ1 = s1.volConservative / Math.sqrt(365);
  const sigmaRatioDaily = Math.sqrt(σ0 ** 2 + σ1 ** 2 - 2 * spearmanCorr * σ0 * σ1);
  const sigmaRatio = sigmaRatioDaily * Math.sqrt(365);

  // LVR rate: C × σ²_ratio / 8  (per day, as % of capital)
  const lvrRateDaily = CONCENTRATION_C * sigmaRatioDaily ** 2 / 8 * 100;  // in %

  // Fee rate per day
  const feeRateDaily = feeAPY / 365;  // already in %

  // LVR ratio — the key metric
  const lvrRatio = lvrRateDaily > 0 ? feeRateDaily / lvrRateDaily : 0;

  // Monte Carlo — 5,000 paths, 30 days
  const { meanPnL, p5PnL, probProfit } = runMonteCarlo(
    σ0, σ1, spearmanCorr, feeAPY, MC_DAYS, MC_PATHS,
  );

  const rating: LVRAssessment['rating'] =
    lvrRatio >= THRESHOLD_SAFE     ? 'SAFE'     :
    lvrRatio >= THRESHOLD_MODERATE ? 'MODERATE' :
    lvrRatio >= THRESHOLD_MARGINAL ? 'MARGINAL' : 'RISKY';

  const note = `σ_ratio=${(sigmaRatioDaily * 100).toFixed(2)}%/day  LVR=${lvrRateDaily.toFixed(3)}%/day  fees=${feeRateDaily.toFixed(3)}%/day  corr=${spearmanCorr.toFixed(2)}`;

  return {
    ...base, token0: s0, token1: s1,
    spearmanCorr, sigmaRatio, sigmaRatioDaily,
    lvrRateDaily, feeRateDaily, lvrRatio,
    mcMeanPnL: meanPnL, mcP5PnL: p5PnL, mcProbProfit: probProfit,
    rating, note,
  };
}

// ── Pool fetching + address resolution ────────────────────────────────────────

async function fetchUniV3Pools(): Promise<Array<{ address: string; symbol: string; token0: string; token1: string; feeAPY: number; tvlUSD: number }>> {
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), 20_000);
  const res  = await fetch('https://yields.llama.fi/pools', { signal: ctrl.signal });
  const json = await res.json() as any;

  const raw = (json.data as any[]).filter(p =>
    p.chain === 'Arbitrum' && p.project?.includes('uniswap-v3') &&
    p.tvlUsd >= MIN_TVL && Array.isArray(p.underlyingTokens) && p.underlyingTokens.length >= 2
  );

  // Deduplicate by token pair — keep highest APY per pair
  const byPair = new Map<string, any>();
  for (const p of raw) {
    const key = [p.underlyingTokens[0], p.underlyingTokens[1]].map((a: string) => a.toLowerCase()).sort().join('-');
    if (!byPair.has(key) || p.apy > byPair.get(key).apy) byPair.set(key, p);
  }

  const factory = new ethers.Contract('0x1F98431c8aD98523631AE4a59f267346ea31F984', ['function getPool(address,address,uint24) view returns (address)'], provider);
  const results = [];
  for (const p of byPair.values()) {
    for (const fee of [100, 500, 3000, 10000]) {
      try {
        const addr: string = await factory.getPool(p.underlyingTokens[0], p.underlyingTokens[1], fee);
        if (addr !== ethers.ZeroAddress) {
          results.push({ address: addr, symbol: p.symbol, token0: p.underlyingTokens[0].toLowerCase(), token1: p.underlyingTokens[1].toLowerCase(), feeAPY: p.apy ?? 0, tvlUSD: p.tvlUsd });
          break;
        }
      } catch { /* next fee tier */ }
    }
  }
  return results;
}

// ── Report ────────────────────────────────────────────────────────────────────

function section(t: string) { console.log(`\n${'─'.repeat(72)}\n  ${t}\n${'─'.repeat(72)}`); }

const ICON: Record<string, string> = { SAFE: '🟢', MODERATE: '🟡', MARGINAL: '🟠', RISKY: '🔴', STABLE_PAIR: '⚪', NO_DATA: '⬜' };

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n╔══════════════════════════════════════════════════════════════════╗');
  console.log('║  YieldGeko — Production IL Assessment (LVR Framework)          ║');
  console.log('║  Milionis et al. 2022 · EWMA Vol · Spearman · Monte Carlo      ║');
  console.log('╚══════════════════════════════════════════════════════════════════╝');
  console.log(`\n  Model parameters:`);
  console.log(`    Framework:      LVR (Loss-Versus-Rebalancing)`);
  console.log(`    Range:          ±${RANGE_WIDTH * 100}%`);
  console.log(`    Concentration:  C = ${CONCENTRATION_C.toFixed(2)}× (exact V3 formula)`);
  console.log(`    Profitability:  fee_rate > C × σ²/8`);
  console.log(`    Vol model:      EWMA λ=0.94 + max(7d, 14d, 30d) conservatism`);
  console.log(`    Correlation:    Spearman (robust to fat tails)`);
  console.log(`    Monte Carlo:    ${MC_PATHS.toLocaleString()} paths × ${MC_DAYS} days`);

  console.log('\n  Fetching UniV3 pools from DeFiLlama + resolving addresses…');
  const pools = await fetchUniV3Pools();
  console.log(`  ${pools.length} unique token pairs with on-chain addresses`);

  section('ASSESSING POOLS — fetching 30d daily prices (please wait ~15 min)');

  const assessments: LVRAssessment[] = [];
  for (const p of pools) {
    process.stdout.write(`  ${p.symbol.slice(0, 26).padEnd(26)} APY:${p.feeAPY.toFixed(1).padStart(6)}%  `);
    try {
      const a = await assessPool(p.address, p.symbol, p.token0, p.token1, p.feeAPY, p.tvlUSD);
      assessments.push(a);
      const ratioStr = a.lvrRatio === Infinity ? '∞' : a.lvrRatio.toFixed(1) + '×';
      console.log(`${ICON[a.rating]} ${a.rating.padEnd(10)} LVR_ratio:${ratioStr.padStart(6)}  P(profit):${(a.mcProbProfit * 100).toFixed(0)}%`);
    } catch (e: any) {
      console.log(`❌ ${e.message.slice(0, 50)}`);
    }
  }

  // Sort by LVR ratio descending (best first), stable pair separate
  const scored  = assessments.filter(a => a.rating !== 'NO_DATA' && a.rating !== 'STABLE_PAIR');
  const stable  = assessments.filter(a => a.rating === 'STABLE_PAIR');
  const nodata  = assessments.filter(a => a.rating === 'NO_DATA');
  scored.sort((a, b) => (b.lvrRatio === Infinity ? 1 : b.lvrRatio) - (a.lvrRatio === Infinity ? 1 : a.lvrRatio));

  section('FULL RESULTS — sorted by LVR ratio (fee / LVR cost)');
  console.log(`\n  ${'Symbol'.padEnd(22)} ${'FeeAPY'.padEnd(8)} ${'σ_ratio%/d'.padEnd(11)} ${'LVR%/d'.padEnd(9)} ${'LVR_ratio'.padEnd(11)} ${'E[P&L]'.padEnd(8)} ${'P5'.padEnd(8)} ${'P(+)'.padEnd(6)} Rating`);
  console.log('  ' + '─'.repeat(100));

  for (const a of [...scored, ...stable]) {
    const ratioStr   = a.lvrRatio === Infinity ? '∞' : a.lvrRatio.toFixed(1) + '×';
    const sigmaStr   = (a.sigmaRatioDaily * 100).toFixed(2) + '%';
    const lvrStr     = a.lvrRateDaily.toFixed(3) + '%';
    const meanStr    = (a.mcMeanPnL >= 0 ? '+' : '') + a.mcMeanPnL.toFixed(1) + '%';
    const p5Str      = (a.mcP5PnL >= 0 ? '+' : '') + a.mcP5PnL.toFixed(1) + '%';
    const probStr    = (a.mcProbProfit * 100).toFixed(0) + '%';
    console.log(
      `  ${a.symbol.slice(0, 21).padEnd(22)}` +
      ` ${(a.feeAPY.toFixed(1) + '%').padEnd(8)}` +
      ` ${sigmaStr.padEnd(11)}` +
      ` ${lvrStr.padEnd(9)}` +
      ` ${ratioStr.padEnd(11)}` +
      ` ${meanStr.padEnd(8)}` +
      ` ${p5Str.padEnd(8)}` +
      ` ${probStr.padEnd(6)}` +
      ` ${ICON[a.rating]} ${a.rating}`
    );
    if (a.rating !== 'STABLE_PAIR') {
      console.log(`    ${a.token0.symbol}(vol=${a.token0.volConservative.toFixed(0)}%) + ${a.token1.symbol}(vol=${a.token1.volConservative.toFixed(0)}%) spearman=${a.spearmanCorr.toFixed(2)}  [7d:${a.token0.vol7d.toFixed(0)}% 14d:${a.token0.vol14d.toFixed(0)}% 30d:${a.token0.vol30d.toFixed(0)}% EWMA:${a.token0.volEWMA.toFixed(0)}%]`);
    }
  }

  section('DEPLOYMENT RECOMMENDATIONS');
  const byRating = {
    SAFE:        scored.filter(a => a.rating === 'SAFE'),
    MODERATE:    scored.filter(a => a.rating === 'MODERATE'),
    MARGINAL:    scored.filter(a => a.rating === 'MARGINAL'),
    RISKY:       scored.filter(a => a.rating === 'RISKY'),
  };

  console.log(`\n  🟢 SAFE (LVR_ratio ≥ ${THRESHOLD_SAFE}×): ${byRating.SAFE.length} — deploy freely`);
  for (const a of byRating.SAFE) {
    console.log(`     ${a.symbol.padEnd(22)} APY:${a.feeAPY.toFixed(1).padStart(6)}%  ratio:${a.lvrRatio.toFixed(1)}×  P(profit):${(a.mcProbProfit*100).toFixed(0)}%  TVL:$${(a.tvlUSD/1e6).toFixed(0)}M`);
  }

  console.log(`\n  🟡 MODERATE (${THRESHOLD_MODERATE}–${THRESHOLD_SAFE}×): ${byRating.MODERATE.length} — deploy with tighter monitoring`);
  for (const a of byRating.MODERATE) {
    console.log(`     ${a.symbol.padEnd(22)} APY:${a.feeAPY.toFixed(1).padStart(6)}%  ratio:${a.lvrRatio.toFixed(1)}×  P(profit):${(a.mcProbProfit*100).toFixed(0)}%  TVL:$${(a.tvlUSD/1e6).toFixed(0)}M`);
  }

  console.log(`\n  🟠 MARGINAL (${THRESHOLD_MARGINAL}–${THRESHOLD_MODERATE}×): ${byRating.MARGINAL.length} — aggressive tier only, small positions`);
  for (const a of byRating.MARGINAL) {
    console.log(`     ${a.symbol.padEnd(22)} APY:${a.feeAPY.toFixed(1).padStart(6)}%  ratio:${a.lvrRatio.toFixed(1)}×  P(profit):${(a.mcProbProfit*100).toFixed(0)}%`);
  }

  console.log(`\n  🔴 RISKY (<${THRESHOLD_MARGINAL}×): ${byRating.RISKY.length} — DO NOT deploy (LVR cost exceeds fees)`);
  for (const a of byRating.RISKY) {
    console.log(`     ${a.symbol.padEnd(22)} APY:${a.feeAPY.toFixed(1).padStart(6)}%  ratio:${a.lvrRatio.toFixed(1)}×  P(profit):${(a.mcProbProfit*100).toFixed(0)}%`);
  }

  console.log(`\n  ⚪ STABLE_PAIR: ${stable.length} — IL ≈ 0, deploy if APY ≥ minAPY`);
  for (const a of stable) console.log(`     ${a.symbol.padEnd(22)} APY:${a.feeAPY.toFixed(1)}%`);

  if (nodata.length > 0) {
    console.log(`\n  ⬜ NO_DATA: ${nodata.length} — price history unavailable, cannot assess`);
    for (const a of nodata) console.log(`     ${a.symbol}`);
  }

  // Model notes
  section('MODEL NOTES');
  console.log(`  Concentration factor C = ${CONCENTRATION_C.toFixed(4)}× (exact V3: √(1+r)/(√(1+r)-√(1-r)), r=0.10)`);
  console.log(`  LVR_rate = C × σ²_ratio / 8  (Milionis et al. 2022, Theorem 1)`);
  console.log(`  Vol = max(EWMA_forecast, 7d, 14d, 30d realized)  — always conservative`);
  console.log(`  Spearman correlation on daily log returns  — robust to crypto fat tails`);
  console.log(`  Monte Carlo: ${MC_PATHS.toLocaleString()} paths × ${MC_DAYS}d correlated GBM with exact V3 LP value`);
  console.log(`  Position is profitable in expectation iff: fee_rate > C × σ²/8`);

  console.log('\n══════════════════════════════════════════════════════════════════\n');
}

main().catch(err => { console.error('\n❌ Fatal:', err.message); process.exit(1); });
