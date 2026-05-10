#!/usr/bin/env -S npx ts-node
/**
 * YieldGeko - High APY / IL-Safe Delta-Neutral Pool Screener
 *
 * New standalone script. It does not modify state or submit transactions.
 *
 * Goal:
 *   Find high-fee UniV3 LP opportunities only when expected fees survive:
 *   - LVR / IL estimate
 *   - rebalance gas
 *   - downside simulation
 *   - passive fallback opportunity cost
 *
 * Usage:
 *   npx ts-node scripts/high-apy-il-safe-pools.ts
 *
 * Useful env overrides:
 *   CAPITAL_USD=10000
 *   PASSIVE_FALLBACK_APY=8
 *   LP_RISK_PREMIUM_APY=10
 *   MIN_TVL_USD=500000
 *   MAX_POOLS=60
 *   TOP_N=10
 *   SIM_PATHS=3000
 *   SIM_DAYS=30
 *   INCLUDE_OUTLIERS=true
 */

import { ethers } from 'ethers';
import * as dotenv from 'dotenv';
import * as path from 'node:path';

dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

const ARB_RPC = process.env.ARB_RPC_URL ?? 'https://arb1.arbitrum.io/rpc';
const provider = new ethers.JsonRpcProvider(ARB_RPC, 42161, { staticNetwork: true });

const UNI_FACTORY = '0x1F98431c8aD98523631AE4a59f267346ea31F984';
const FEE_TIERS = [100, 500, 3000, 10000] as const;
const DAYS_PER_YEAR = 365;
const MIN_DATA_POINTS = 14;

const CAPITAL_USD = envNumber('CAPITAL_USD', 10_000);
const PASSIVE_FALLBACK_APY = envNumber('PASSIVE_FALLBACK_APY', 8);
const LP_RISK_PREMIUM_APY = envNumber('LP_RISK_PREMIUM_APY', 10);
const REQUIRED_NET_APY = PASSIVE_FALLBACK_APY + LP_RISK_PREMIUM_APY;
const MIN_TVL_USD = envNumber('MIN_TVL_USD', 500_000);
const MAX_POOLS = Math.max(1, Math.floor(envNumber('MAX_POOLS', 60)));
const TOP_N = Math.max(1, Math.floor(envNumber('TOP_N', 10)));
const SIM_PATHS = Math.max(250, Math.floor(envNumber('SIM_PATHS', 3_000)));
const SIM_DAYS = Math.max(7, Math.floor(envNumber('SIM_DAYS', 30)));
const SIM_SEED = process.env.SIM_SEED ?? 'yieldgeko-il-safe';
const INCLUDE_OUTLIERS = envBool('INCLUDE_OUTLIERS', envBool('ALLOW_OUTLIERS', true));

const FEE_HAIRCUT = envNumber('FEE_HAIRCUT', 0.70);
const MIN_FEE_LVR_RATIO = envNumber('MIN_FEE_LVR_RATIO', 3);
const MIN_EPOCH_FEE_IL_RATIO = envNumber('MIN_EPOCH_FEE_IL_RATIO', 1.5);
const MIN_PROFIT_PROB = envNumber('MIN_PROFIT_PROB', 0.60);
const MAX_P05_LOSS_PCT = envNumber('MAX_P05_LOSS_PCT', 12);
const OUTLIER_MIN_PROFIT_PROB = envNumber('OUTLIER_MIN_PROFIT_PROB', 0.65);
const OUTLIER_MAX_P05_LOSS_PCT = envNumber('OUTLIER_MAX_P05_LOSS_PCT', 10);
const OUTLIER_MIN_EPOCH_FEE_IL_RATIO = envNumber('OUTLIER_MIN_EPOCH_FEE_IL_RATIO', 1.7);
const OUTLIER_SCORE_PENALTY = envNumber('OUTLIER_SCORE_PENALTY', 15);
const MAX_MIGRATIONS_PER_YEAR = envNumber('MAX_MIGRATIONS_PER_YEAR', 52);
const GAS_PER_MIGRATION_USD = envNumber('GAS_PER_MIGRATION_USD', 0.20);
const MIGRATION_TRIGGER = envNumber('MIGRATION_TRIGGER', 0.70);
const MIN_RANGE_PCT = envNumber('MIN_RANGE_PCT', 3);
const MAX_RANGE_PCT = envNumber('MAX_RANGE_PCT', 45);
const RANGE_STEP_PCT = envNumber('RANGE_STEP_PCT', 0.5);

const STABLECOINS = new Set([
  '0xaf88d065e77c8cc2239327c5edb3a432268e5831', // USDC
  '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9', // USDT
  '0xda10009cbd5d07dd0cecc66161fc93d7c9000da1', // DAI
  '0xff970a61a04b1ca14834a43f5de4533ebddb5cc8', // USDC.e
]);

interface LlamaPool {
  chain: string;
  project: string;
  symbol: string;
  tvlUsd: number;
  apy?: number | null;
  apyBase?: number | null;
  apyBase7d?: number | null;
  apyMean30d?: number | null;
  poolMeta?: string | null;
  underlyingTokens: string[];
  volumeUsd7d?: number | null;
  outlier?: boolean | null;
}

interface CandidatePool {
  symbol: string;
  poolAddress: string;
  token0: string;
  token1: string;
  feeTier: number;
  feeRate: number;
  tvlUSD: number;
  volumeUsd7d: number;
  observedApy: number;
  volumeFeeApy: number;
  modelFeeApy: number;
  outlier: boolean;
  warnings: string[];
}

interface RangeChoice {
  rangePct: number;
  netApy: number;
  lvrApy: number;
  migrationsPerYear: number;
  epochFeesUSD: number;
  epochILUSD: number;
  epochFeeIlRatio: number;
  gasApy: number;
  failedChecks: string[];
}

interface SimResult {
  meanPnL: number;
  netApy: number;
  p05: number;
  p50: number;
  p95: number;
  profitProb: number;
  avgFees: number;
  avgIL: number;
  avgMigrations: number;
}

interface ScreenedPool {
  pool: CandidatePool;
  spreadDailyVolPct: number;
  lvrBaselineApy: number;
  feeLvrRatio: number;
  range: RangeChoice;
  sim: SimResult;
  passed: boolean;
  failedChecks: string[];
  score: number;
}

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw == null) return fallback;
  return ['1', 'true', 'yes', 'y'].includes(raw.toLowerCase());
}

function pct(n: number, digits = 1): string {
  return Number.isFinite(n) ? `${n.toFixed(digits)}%` : 'inf';
}

function usd(n: number, digits = 0): string {
  return `$${n.toLocaleString('en-US', { maximumFractionDigits: digits, minimumFractionDigits: digits })}`;
}

function normaliseAddress(address: string): string {
  return ethers.getAddress(address).toLowerCase();
}

function parseFeeTier(poolMeta?: string | null): number | null {
  if (!poolMeta) return null;
  const match = poolMeta.match(/([0-9]+(?:\.[0-9]+)?)\s*%/);
  if (!match) return null;
  const tier = Math.round(Number(match[1]) * 10_000);
  return FEE_TIERS.includes(tier as typeof FEE_TIERS[number]) ? tier : null;
}

function feeRateFromTier(feeTier: number): number {
  return feeTier / 1_000_000;
}

function firstUsableApy(...values: Array<number | null | undefined>): number {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  }
  return 0;
}

async function fetchJson<T>(url: string, timeoutMs: number): Promise<T> {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return await res.json() as T;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

async function discoverPools(): Promise<CandidatePool[]> {
  const json = await fetchJson<{ data: LlamaPool[] }>('https://yields.llama.fi/pools', 20_000);
  const rows = json.data
    .filter(p =>
      p.chain === 'Arbitrum' &&
      p.project === 'uniswap-v3' &&
      p.tvlUsd >= MIN_TVL_USD &&
      Array.isArray(p.underlyingTokens) &&
      p.underlyingTokens.length >= 2,
    )
    .map(p => ({ ...p, feeTier: parseFeeTier(p.poolMeta) }))
    .filter((p): p is LlamaPool & { feeTier: number } => p.feeTier != null)
    .filter(p => INCLUDE_OUTLIERS || !p.outlier)
    .sort((a, b) => firstUsableApy(b.apyBase7d, b.apyBase, b.apy) - firstUsableApy(a.apyBase7d, a.apyBase, a.apy))
    .slice(0, MAX_POOLS);

  const factory = new ethers.Contract(
    UNI_FACTORY,
    ['function getPool(address,address,uint24) view returns (address)'],
    provider,
  );
  const symbolCache = new Map<string, string>();
  const symbolAbi = ['function symbol() view returns (string)'];

  async function symbolOf(address: string): Promise<string> {
    const key = normaliseAddress(address);
    const cached = symbolCache.get(key);
    if (cached) return cached;
    try {
      const token = new ethers.Contract(key, symbolAbi, provider);
      const symbol = String(await token.symbol());
      symbolCache.set(key, symbol);
      return symbol;
    } catch {
      const fallback = `${key.slice(2, 6)}...${key.slice(-4)}`;
      symbolCache.set(key, fallback);
      return fallback;
    }
  }

  const pools = await mapLimit(rows, 6, async row => {
    const [raw0, raw1] = row.underlyingTokens;
    if (!ethers.isAddress(raw0) || !ethers.isAddress(raw1)) return null;

    const token0 = normaliseAddress(raw0);
    const token1 = normaliseAddress(raw1);
    const poolAddress = normaliseAddress(await factory.getPool(token0, token1, row.feeTier));
    if (poolAddress === ethers.ZeroAddress.toLowerCase()) return null;

    const [sym0, sym1] = await Promise.all([symbolOf(token0), symbolOf(token1)]);
    const observedApy = firstUsableApy(row.apyBase7d, row.apyBase, row.apyMean30d, row.apy);
    const volumeUsd7d = typeof row.volumeUsd7d === 'number' && row.volumeUsd7d > 0 ? row.volumeUsd7d : 0;
    const volumeFeeApy = volumeUsd7d > 0 && row.tvlUsd > 0
      ? (volumeUsd7d / 7 * DAYS_PER_YEAR * feeRateFromTier(row.feeTier) / row.tvlUsd) * 100
      : 0;
    const nonZero = [observedApy, volumeFeeApy].filter(v => v > 0);
    const baseApy = nonZero.length > 0 ? Math.min(...nonZero) : Math.max(observedApy, volumeFeeApy);
    const warnings: string[] = [];
    if (row.outlier) warnings.push('DeFiLlama outlier');
    if (volumeFeeApy === 0) warnings.push('missing volume-derived APY');
    if (observedApy > 0 && volumeFeeApy > 0 && Math.abs(observedApy - volumeFeeApy) > Math.max(10, observedApy * 0.75)) {
      warnings.push('APY diverges from 7d volume estimate');
    }

    return {
      symbol: `${sym0}-${sym1}`,
      poolAddress,
      token0,
      token1,
      feeTier: row.feeTier,
      feeRate: feeRateFromTier(row.feeTier),
      tvlUSD: row.tvlUsd,
      volumeUsd7d,
      observedApy,
      volumeFeeApy,
      modelFeeApy: baseApy * FEE_HAIRCUT,
      outlier: Boolean(row.outlier),
      warnings,
    } satisfies CandidatePool;
  });

  return pools
    .filter((p): p is CandidatePool => p != null)
    .sort((a, b) => b.modelFeeApy - a.modelFeeApy);
}

const returnsCache = new Map<string, number[]>();

async function fetchReturns(address: string): Promise<number[]> {
  const key = normaliseAddress(address);
  const cached = returnsCache.get(key);
  if (cached) return cached;
  if (STABLECOINS.has(key)) {
    const stableReturns = Array(30).fill(0);
    returnsCache.set(key, stableReturns);
    return stableReturns;
  }

  const start = Math.floor(Date.now() / 1000) - 32 * 86_400;
  const url = `https://coins.llama.fi/chart/arbitrum:${key}?start=${start}&span=30&period=1d`;
  try {
    const json = await fetchJson<any>(url, 15_000);
    const points = (json.coins?.[`arbitrum:${key}`]?.prices ?? []) as Array<{ timestamp: number; price: number }>;
    const ordered = points
      .filter(p => Number.isFinite(p.price) && p.price > 0)
      .sort((a, b) => a.timestamp - b.timestamp);
    const returns: number[] = [];
    for (let i = 1; i < ordered.length; i++) {
      returns.push(Math.log(ordered[i].price / ordered[i - 1].price));
    }
    returnsCache.set(key, returns);
    return returns;
  } catch {
    returnsCache.set(key, []);
    return [];
  }
}

function alignSpreadReturns(r0: number[], r1: number[]): number[] {
  const n = Math.min(r0.length, r1.length);
  const spread: number[] = [];
  for (let i = 0; i < n; i++) spread.push(r0[r0.length - n + i] - r1[r1.length - n + i]);
  return spread;
}

function annualVol(returns: number[]): number {
  if (returns.length < 3) return 0;
  const mean = returns.reduce((s, v) => s + v, 0) / returns.length;
  const variance = returns.reduce((s, v) => s + (v - mean) ** 2, 0) / (returns.length - 1);
  return Math.sqrt(Math.max(0, variance) * DAYS_PER_YEAR);
}

function ewmaAnnualVol(returns: number[], lambda = 0.94): number {
  if (returns.length < 3) return 0;
  let variance = returns[0] ** 2;
  for (let i = 1; i < returns.length; i++) {
    variance = lambda * variance + (1 - lambda) * returns[i] ** 2;
  }
  return Math.sqrt(Math.max(0, variance) * DAYS_PER_YEAR);
}

function conservativeDailyVol(spreadReturns: number[]): number {
  const windows = [7, 14, 30]
    .filter(w => spreadReturns.length >= Math.min(w, MIN_DATA_POINTS))
    .map(w => annualVol(spreadReturns.slice(-Math.min(w, spreadReturns.length))));
  return Math.max(annualVol(spreadReturns), ewmaAnnualVol(spreadReturns), ...windows) / Math.sqrt(DAYS_PER_YEAR);
}

function concentrationFactor(rangePct: number): number {
  const r = rangePct / 100;
  return Math.sqrt(1 + r) / (Math.sqrt(1 + r) - Math.sqrt(1 - r));
}

function uniV3Amounts(price: number, lower: number, upper: number, liquidity: number): { amount0: number; amount1: number } {
  const sqrtP = Math.sqrt(price);
  const sqrtL = Math.sqrt(lower);
  const sqrtU = Math.sqrt(upper);
  if (price <= lower) return { amount0: liquidity * (sqrtU - sqrtL) / (sqrtL * sqrtU), amount1: 0 };
  if (price >= upper) return { amount0: 0, amount1: liquidity * (sqrtU - sqrtL) };
  return {
    amount0: liquidity * (sqrtU - sqrtP) / (sqrtP * sqrtU),
    amount1: liquidity * (sqrtP - sqrtL),
  };
}

function lpValueAt(relativePrice: number, capitalUSD: number, rangePct: number): { lpValue: number; hodlValue: number; ilUSD: number } {
  const r = rangePct / 100;
  const lower = Math.max(0.0001, 1 - r);
  const upper = 1 + r;
  const unit = uniV3Amounts(1, lower, upper, 1);
  const unitValue = unit.amount0 + unit.amount1;
  const liquidity = capitalUSD / unitValue;
  const entry0 = unit.amount0 * liquidity;
  const entry1 = unit.amount1 * liquidity;
  const current = uniV3Amounts(relativePrice, lower, upper, liquidity);
  const lpValue = current.amount0 * relativePrice + current.amount1;
  const hodlValue = entry0 * relativePrice + entry1;
  return { lpValue, hodlValue, ilUSD: Math.max(0, hodlValue - lpValue) };
}

function rangeSnapshot(feeApy: number, sigmaDaily: number, rangePct: number): RangeChoice {
  const r = rangePct / 100;
  const expectedDays = sigmaDaily > 1e-9 ? Math.max(0.5, (MIGRATION_TRIGGER * r / sigmaDaily) ** 2) : 90;
  const migrationsPerYear = DAYS_PER_YEAR / expectedDays;
  const gasApy = migrationsPerYear * GAS_PER_MIGRATION_USD / CAPITAL_USD * 100;
  const lvrApy = concentrationFactor(rangePct) * sigmaDaily ** 2 * DAYS_PER_YEAR / 8 * 100;
  const netApy = feeApy - lvrApy - gasApy;
  const triggerValue = lpValueAt(1 + MIGRATION_TRIGGER * r, CAPITAL_USD, rangePct);
  const epochFeesUSD = CAPITAL_USD * feeApy / 100 / DAYS_PER_YEAR * expectedDays;
  const epochILUSD = triggerValue.ilUSD;
  const epochFeeIlRatio = epochILUSD <= 1e-9 ? Infinity : epochFeesUSD / epochILUSD;
  const failedChecks: string[] = [];
  if (netApy < REQUIRED_NET_APY) failedChecks.push(`net APY below fallback+premium (${pct(REQUIRED_NET_APY)})`);
  if (migrationsPerYear > MAX_MIGRATIONS_PER_YEAR) failedChecks.push(`too many rebalances (${migrationsPerYear.toFixed(1)}/yr)`);
  if (epochFeeIlRatio < MIN_EPOCH_FEE_IL_RATIO) failedChecks.push(`epoch fees/IL below ${MIN_EPOCH_FEE_IL_RATIO}x`);
  return { rangePct, netApy, lvrApy, migrationsPerYear, epochFeesUSD, epochILUSD, epochFeeIlRatio, gasApy, failedChecks };
}

function chooseTightestSafeRange(feeApy: number, sigmaDaily: number): RangeChoice {
  let bestFallback: RangeChoice | null = null;
  for (let rangePct = MIN_RANGE_PCT; rangePct <= MAX_RANGE_PCT; rangePct += RANGE_STEP_PCT) {
    const candidate = rangeSnapshot(feeApy, sigmaDaily, rangePct);
    if (candidate.failedChecks.length === 0) return candidate;
    if (!bestFallback || candidate.netApy > bestFallback.netApy) bestFallback = candidate;
  }
  return bestFallback ?? rangeSnapshot(feeApy, sigmaDaily, MAX_RANGE_PCT);
}

interface PositionState {
  centre: number;
  capital: number;
  accruedFees: number;
  totalFees: number;
  totalIL: number;
  migrations: number;
}

function hashSeed(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t += 0x6D2B79F5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(rng: () => number): number {
  const u1 = Math.max(rng(), Number.EPSILON);
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

function quantile(sorted: number[], q: number): number {
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo] ?? 0;
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function simulate(pool: CandidatePool, range: RangeChoice, sigmaDaily: number): SimResult {
  const rng = mulberry32(hashSeed(`${SIM_SEED}:${pool.poolAddress}:${range.rangePct}`));
  const pnls: number[] = [];
  let totalFees = 0;
  let totalIL = 0;
  let totalMigrations = 0;

  for (let p = 0; p < SIM_PATHS; p++) {
    let ratio = 1;
    let state: PositionState = { centre: 1, capital: CAPITAL_USD, accruedFees: 0, totalFees: 0, totalIL: 0, migrations: 0 };
    for (let d = 0; d < SIM_DAYS; d++) {
      ratio *= Math.exp(sigmaDaily * gaussian(rng) - 0.5 * sigmaDaily ** 2);
      const drift = Math.abs(ratio / state.centre - 1) / (range.rangePct / 100);
      const inRange = drift <= 1;
      if (inRange) state.accruedFees += state.capital * pool.modelFeeApy / 100 / DAYS_PER_YEAR;
      if (drift > MIGRATION_TRIGGER) {
        const value = lpValueAt(ratio / state.centre, state.capital, range.rangePct);
        state.totalFees += state.accruedFees;
        state.totalIL += value.ilUSD;
        state.capital = value.lpValue + state.accruedFees - GAS_PER_MIGRATION_USD;
        state.accruedFees = 0;
        state.centre = ratio;
        state.migrations++;
      }
    }
    const final = lpValueAt(ratio / state.centre, state.capital, range.rangePct);
    const finalCapital = final.lpValue + state.accruedFees;
    pnls.push(finalCapital - CAPITAL_USD);
    totalFees += state.totalFees + state.accruedFees;
    totalIL += state.totalIL + final.ilUSD;
    totalMigrations += state.migrations;
  }

  pnls.sort((a, b) => a - b);
  const meanPnL = pnls.reduce((sum, v) => sum + v, 0) / pnls.length;
  return {
    meanPnL,
    netApy: meanPnL / CAPITAL_USD / SIM_DAYS * DAYS_PER_YEAR * 100,
    p05: quantile(pnls, 0.05),
    p50: quantile(pnls, 0.50),
    p95: quantile(pnls, 0.95),
    profitProb: pnls.filter(v => v > 0).length / pnls.length,
    avgFees: totalFees / pnls.length,
    avgIL: totalIL / pnls.length,
    avgMigrations: totalMigrations / pnls.length,
  };
}

async function screenPool(pool: CandidatePool): Promise<ScreenedPool> {
  const [r0, r1] = await Promise.all([fetchReturns(pool.token0), fetchReturns(pool.token1)]);
  const spreadReturns = alignSpreadReturns(r0, r1);
  const failedChecks: string[] = [];
  if (spreadReturns.length < MIN_DATA_POINTS) failedChecks.push('insufficient price history');

  const sigmaDaily = conservativeDailyVol(spreadReturns);
  const lvrBaselineApy = sigmaDaily ** 2 * DAYS_PER_YEAR / 8 * 100;
  const feeLvrRatio = lvrBaselineApy <= 1e-9 ? Infinity : pool.modelFeeApy / lvrBaselineApy;
  if (feeLvrRatio < MIN_FEE_LVR_RATIO) failedChecks.push(`fee/LVR below ${MIN_FEE_LVR_RATIO}x`);
  if (!INCLUDE_OUTLIERS && pool.outlier) failedChecks.push('outlier APY row');

  const range = chooseTightestSafeRange(pool.modelFeeApy, sigmaDaily);
  failedChecks.push(...range.failedChecks);
  const sim = simulate(pool, range, sigmaDaily);

  const minProfitProb = pool.outlier ? OUTLIER_MIN_PROFIT_PROB : MIN_PROFIT_PROB;
  const maxP05LossPct = pool.outlier ? OUTLIER_MAX_P05_LOSS_PCT : MAX_P05_LOSS_PCT;
  const minEpochFeeIlRatio = pool.outlier ? OUTLIER_MIN_EPOCH_FEE_IL_RATIO : MIN_EPOCH_FEE_IL_RATIO;

  if (pool.outlier && range.epochFeeIlRatio < minEpochFeeIlRatio) {
    failedChecks.push(`outlier epoch fees/IL below ${minEpochFeeIlRatio}x`);
  }
  if (sim.netApy < REQUIRED_NET_APY) failedChecks.push(`simulation net APY below ${pct(REQUIRED_NET_APY)}`);
  if (sim.profitProb < minProfitProb) failedChecks.push(`profit probability below ${(minProfitProb * 100).toFixed(0)}%`);
  if (Math.abs(Math.min(sim.p05, 0)) > CAPITAL_USD * maxP05LossPct / 100) {
    failedChecks.push(`P05 loss worse than ${pct(maxP05LossPct)}`);
  }
  if (sim.avgFees <= sim.avgIL) failedChecks.push('simulated IL >= simulated fees');

  const passed = failedChecks.length === 0;
  const downsidePenalty = Math.abs(Math.min(sim.p05, 0)) / CAPITAL_USD * 100;
  const score = passed
    ? pool.modelFeeApy + sim.netApy + feeLvrRatio - downsidePenalty - (pool.outlier ? OUTLIER_SCORE_PENALTY : 0)
    : sim.netApy - downsidePenalty - failedChecks.length * 10;

  return { pool, spreadDailyVolPct: sigmaDaily * 100, lvrBaselineApy, feeLvrRatio, range, sim, passed, failedChecks, score };
}

function printHeader(): void {
  console.log('\nYieldGeko High-APY / IL-Safe Delta-Neutral Screener');
  console.log(`Capital: ${usd(CAPITAL_USD)} | Passive fallback: ${pct(PASSIVE_FALLBACK_APY)} | Risk premium: ${pct(LP_RISK_PREMIUM_APY)} | Required LP net: ${pct(REQUIRED_NET_APY)}`);
  console.log(`Gates: fee/LVR >= ${MIN_FEE_LVR_RATIO}x | epoch fees/IL >= ${MIN_EPOCH_FEE_IL_RATIO}x | P(profit) >= ${(MIN_PROFIT_PROB * 100).toFixed(0)}% | P05 loss <= ${pct(MAX_P05_LOSS_PCT)} | outliers ${INCLUDE_OUTLIERS ? 'included with stricter gates' : 'blocked'}`);
  if (INCLUDE_OUTLIERS) {
    console.log(`Outlier gates: epoch fees/IL >= ${OUTLIER_MIN_EPOCH_FEE_IL_RATIO}x | P(profit) >= ${(OUTLIER_MIN_PROFIT_PROB * 100).toFixed(0)}% | P05 loss <= ${pct(OUTLIER_MAX_P05_LOSS_PCT)} | score penalty ${OUTLIER_SCORE_PENALTY}`);
  }
}

function printResult(result: ScreenedPool, index: number): void {
  const p = result.pool;
  console.log(`\n${index}. ${p.symbol} | ${p.poolAddress}`);
  console.log(`   decision: ${result.passed ? 'DEPLOYABLE' : 'REJECT'} | score ${result.score.toFixed(1)}`);
  console.log(`   fee APY model: ${pct(p.modelFeeApy)} (observed ${pct(p.observedApy)}, volume ${pct(p.volumeFeeApy)}, haircut ${(FEE_HAIRCUT * 100).toFixed(0)}%)`);
  console.log(`   range: +/-${result.range.rangePct.toFixed(1)}% | net model ${pct(result.range.netApy)} | LVR ${pct(result.range.lvrApy)} | fee/LVR ${Number.isFinite(result.feeLvrRatio) ? `${result.feeLvrRatio.toFixed(2)}x` : 'inf'}`);
  console.log(`   epoch: fees ${usd(result.range.epochFeesUSD, 2)} vs IL ${usd(result.range.epochILUSD, 2)} (${Number.isFinite(result.range.epochFeeIlRatio) ? `${result.range.epochFeeIlRatio.toFixed(2)}x` : 'inf'}) | migrations ${result.range.migrationsPerYear.toFixed(1)}/yr`);
  console.log(`   simulation ${SIM_DAYS}d x ${SIM_PATHS}: mean ${usd(result.sim.meanPnL)} (${pct(result.sim.netApy)}) | P05/P50/P95 ${usd(result.sim.p05)}/${usd(result.sim.p50)}/${usd(result.sim.p95)} | P+ ${(result.sim.profitProb * 100).toFixed(0)}%`);
  console.log(`   sim fees ${usd(result.sim.avgFees)} vs IL ${usd(result.sim.avgIL)} | avg migrations ${result.sim.avgMigrations.toFixed(1)}`);
  if (p.warnings.length > 0) console.log(`   warnings: ${p.warnings.join('; ')}`);
  if (!result.passed) console.log(`   failed: ${[...new Set(result.failedChecks)].slice(0, 5).join('; ')}`);
}

async function main(): Promise<void> {
  printHeader();
  console.log('\nFetching UniV3 pool candidates...');
  const pools = await discoverPools();
  console.log(`Matched ${pools.length} exact fee-tier pools after TVL/outlier filters.`);
  if (pools.length === 0) return;

  console.log('Screening pools with LVR/range/simulation gates...');
  const screened = await mapLimit(pools, 6, screenPool);
  const passed = screened.filter(r => r.passed).sort((a, b) => b.score - a.score);
  const rejected = screened.filter(r => !r.passed).sort((a, b) => b.score - a.score);

  console.log(`\nSummary: ${passed.length} deployable | ${rejected.length} rejected`);
  if (passed.length === 0) {
    console.log('Decision: no high-APY LP passed. Agent should use passive fallback.');
  } else {
    console.log(`Decision: top ${Math.min(TOP_N, passed.length)} deployable pools below.`);
    passed.slice(0, TOP_N).forEach(printResult);
  }

  if (rejected.length > 0) {
    console.log('\nBest rejected candidates for manual review:');
    rejected.slice(0, Math.min(5, rejected.length)).forEach((r, i) => printResult(r, i + 1));
  }
}

main().catch(err => {
  console.error('\nFatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});
