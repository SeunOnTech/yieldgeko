#!/usr/bin/env -S npx ts-node
/**
 * YieldGeko active LP management scout.
 *
 * This is a standalone research/simulation script. It does not submit
 * transactions. Its job is to answer: "which Arbitrum UniV3 pools are worth
 * deeper review, and what range/rebalance assumptions look survivable?"
 *
 * Design principles:
 *   - Match DeFiLlama rows to the exact UniV3 fee tier via poolMeta.
 *   - Use measured fee APY from volume and TVL, with conservative haircuts.
 *   - Compute relative-price volatility directly from token return spreads.
 *   - Account for concentrated LP value using UniV3 liquidity math.
 *   - Report assumptions and warnings instead of pretending APY is guaranteed.
 *
 * Usage:
 *   npx ts-node scripts/test-active-lp-management.ts
 *
 * Useful env overrides:
 *   ARB_RPC_URL=https://...
 *   MIN_TVL_USD=500000
 *   CAPITAL_USD=10000
 *   MAX_POOLS=40
 *   SIM_PATHS=5000
 *   SIM_DAYS=30
 *   SIM_SEED=yieldgeko
 */

import { ethers } from 'ethers';
import * as dotenv from 'dotenv';
import * as path from 'node:path';

dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

const ARB_RPC = process.env.ARB_RPC_URL ?? 'https://arb1.arbitrum.io/rpc';
const provider = new ethers.JsonRpcProvider(ARB_RPC, 42161, { staticNetwork: true });

const UNI_FACTORY = '0x1F98431c8aD98523631AE4a59f267346ea31F984';
const FEE_TIERS = [100, 500, 3000, 10000] as const;
const STABLECOINS = new Set([
  '0xaf88d065e77c8cc2239327c5edb3a432268e5831', // USDC
  '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9', // USDT
  '0xda10009cbd5d07dd0cecc66161fc93d7c9000da1', // DAI
  '0xff970a61a04b1ca14834a43f5de4533ebddb5cc8', // bridged USDC.e
]);

const MIN_TVL_USD = envNumber('MIN_TVL_USD', 500_000);
const CAPITAL_USD = envNumber('CAPITAL_USD', 10_000);
const MAX_POOLS = Math.max(1, Math.floor(envNumber('MAX_POOLS', 40)));
const SIM_PATHS = Math.max(100, Math.floor(envNumber('SIM_PATHS', 5_000)));
const SIM_DAYS = Math.max(1, Math.floor(envNumber('SIM_DAYS', 30)));
const SIM_SEED = process.env.SIM_SEED ?? 'yieldgeko';

const EWMA_LAMBDA = 0.94;
const MIGRATION_TRIGGER = 0.70;
const GAS_PER_MIGRATION_USD = envNumber('GAS_PER_MIGRATION_USD', 0.20);
const GAS_FRICTION_CAP = 0.01;
const FEE_HAIRCUT = envNumber('FEE_HAIRCUT', 0.70);
const MIN_RANGE_PCT = envNumber('MIN_RANGE_PCT', 3);
const MAX_RANGE_PCT = envNumber('MAX_RANGE_PCT', 45);
const RANGE_STEP_PCT = envNumber('RANGE_STEP_PCT', 0.5);
const MIN_NET_APY_PCT = envNumber('MIN_NET_APY_PCT', 2);
const MIN_EPOCH_FEE_IL_RATIO = envNumber('MIN_EPOCH_FEE_IL_RATIO', 1.15);
const MAX_MIGRATIONS_PER_YEAR = envNumber('MAX_MIGRATIONS_PER_YEAR', 52);
const MIN_DATA_POINTS = 14;
const DAYS_PER_YEAR = 365;

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
  volumeUsd1d?: number | null;
  volumeUsd7d?: number | null;
  ilRisk?: string | null;
  outlier?: boolean | null;
}

interface DiscoveredPool {
  poolAddress: string;
  symbol: string;
  token0: string;
  token1: string;
  canonicalToken0: string;
  canonicalToken1: string;
  feeTier: number;
  feeRate: number;
  observedApy: number;
  volumeFeeApy: number;
  modelFeeApy: number;
  tvlUSD: number;
  volumeUsd7d: number;
  token0Stable: boolean;
  token1Stable: boolean;
  warnings: string[];
}

interface TokenReturns {
  address: string;
  returns: number[];
  source: 'stable-assumption' | 'defillama';
  ok: boolean;
}

interface LVRResult {
  spreadDailyVolPct: number;
  spreadAnnualVolPct: number;
  lvrRateAnnualPct: number;
  feeToLvrRatio: number;
  profitable: boolean;
  dataPoints: number;
  warnings: string[];
}

interface RangeResult {
  rangePct: number;
  concentration: number;
  expectedDaysPerEpoch: number;
  migrationsPerYear: number;
  gasFrictionPct: number;
  grossFeeApyPct: number;
  lvrCostApyPct: number;
  netApyPct: number;
  ilAtTriggerPct: number;
  epochFeesUSD: number;
  epochILUSD: number;
  viable: boolean;
  failedChecks: string[];
  warnings: string[];
}

interface PositionState {
  centreRatio: number;
  rangePct: number;
  capitalUSD: number;
  accruedFeesUSD: number;
  totalFeesUSD: number;
  totalILUSD: number;
  totalGasUSD: number;
  migrations: number;
  daysActive: number;
  status: 'IN_RANGE' | 'DRIFTING' | 'NEEDS_REBALANCE';
  driftPctOfRange: number;
}

interface SimResult {
  strategy: string;
  finalCapital: number;
  netPnL: number;
  netAPY: number;
  migrations: number;
  totalFees: number;
  totalIL: number;
  totalGas: number;
  probProfit: number;
  p05: number;
  p50: number;
  p95: number;
}

interface RankedPool extends DiscoveredPool {
  lvr: LVRResult;
  range: RangeResult;
  score: number;
}

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function pct(n: number, digits = 1): string {
  if (!Number.isFinite(n)) return 'n/a';
  return `${n.toFixed(digits)}%`;
}

function usd(n: number, digits = 0): string {
  if (!Number.isFinite(n)) return '$n/a';
  return `$${n.toLocaleString('en-US', { maximumFractionDigits: digits, minimumFractionDigits: digits })}`;
}

function section(title: string): void {
  console.log(`\n${'='.repeat(78)}`);
  console.log(`  ${title}`);
  console.log('='.repeat(78));
}

function sub(title: string): void {
  console.log(`\n  ${'-'.repeat(72)}`);
  console.log(`  ${title}`);
  console.log(`  ${'-'.repeat(72)}`);
}

function isAddressLike(value: unknown): value is string {
  return typeof value === 'string' && /^0x[a-fA-F0-9]{40}$/.test(value);
}

function normaliseAddress(value: string): string {
  return ethers.getAddress(value).toLowerCase();
}

function parseFeeTier(poolMeta?: string | null): number | null {
  if (!poolMeta) return null;
  const match = poolMeta.match(/([0-9]+(?:\.[0-9]+)?)\s*%/);
  if (!match) return null;
  const bps = Number(match[1]) * 10_000;
  const tier = Math.round(bps);
  return FEE_TIERS.includes(tier as typeof FEE_TIERS[number]) ? tier : null;
}

function feeRateFromTier(feeTier: number): number {
  return feeTier / 1_000_000;
}

function safeApy(...values: Array<number | null | undefined>): number {
  for (const v of values) {
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return v;
  }
  return 0;
}

async function fetchJson<T>(url: string, timeoutMs: number): Promise<T> {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return await res.json() as T;
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

async function discoverPools(): Promise<DiscoveredPool[]> {
  console.log('  Fetching Arbitrum UniV3 rows from DeFiLlama...');
  const json = await fetchJson<{ data: LlamaPool[] }>('https://yields.llama.fi/pools', 20_000);

  const llamaPools = json.data
    .filter(p =>
      p.chain === 'Arbitrum' &&
      p.project === 'uniswap-v3' &&
      p.tvlUsd >= MIN_TVL_USD &&
      Array.isArray(p.underlyingTokens) &&
      p.underlyingTokens.length >= 2,
    )
    .map(p => ({ ...p, feeTier: parseFeeTier(p.poolMeta) }))
    .filter((p): p is LlamaPool & { feeTier: number } => p.feeTier != null)
    .sort((a, b) => safeApy(b.apyBase, b.apy) - safeApy(a.apyBase, a.apy))
    .slice(0, MAX_POOLS);

  const factory = new ethers.Contract(UNI_FACTORY, [
    'function getPool(address,address,uint24) view returns (address)',
  ], provider);
  const poolReadAbi = [
    'function token0() view returns (address)',
    'function token1() view returns (address)',
  ];
  const erc20Abi = ['function symbol() view returns (string)'];
  const symbolCache = new Map<string, string>();

  async function symbolOf(address: string): Promise<string> {
    const key = normaliseAddress(address);
    const cached = symbolCache.get(key);
    if (cached) return cached;
    try {
      const token = new ethers.Contract(address, erc20Abi, provider);
      const s = String(await token.symbol());
      symbolCache.set(key, s);
      return s;
    } catch {
      const short = `${key.slice(2, 6)}...${key.slice(-4)}`;
      symbolCache.set(key, short);
      return short;
    }
  }

  const discovered = await mapLimit(llamaPools, 6, async p => {
    const warnings: string[] = [];
    const [raw0, raw1] = p.underlyingTokens;
    if (!isAddressLike(raw0) || !isAddressLike(raw1)) return null;

    const tokenA = normaliseAddress(raw0);
    const tokenB = normaliseAddress(raw1);
    const poolAddress = normaliseAddress(await factory.getPool(tokenA, tokenB, p.feeTier));
    if (poolAddress === ethers.ZeroAddress.toLowerCase()) return null;

    const pool = new ethers.Contract(poolAddress, poolReadAbi, provider);
    const [canonical0, canonical1, s0, s1] = await Promise.all([
      pool.token0() as Promise<string>,
      pool.token1() as Promise<string>,
      symbolOf(tokenA),
      symbolOf(tokenB),
    ]);

    const observedApy = safeApy(p.apyBase7d, p.apyBase, p.apyMean30d, p.apy);
    const volumeUsd7d = typeof p.volumeUsd7d === 'number' && p.volumeUsd7d > 0 ? p.volumeUsd7d : 0;
    const volumeFeeApy = p.tvlUsd > 0 && volumeUsd7d > 0
      ? (volumeUsd7d / 7 * DAYS_PER_YEAR * feeRateFromTier(p.feeTier) / p.tvlUsd) * 100
      : 0;

    let modelFeeApy = Math.min(nonZeroOrInfinity(observedApy), nonZeroOrInfinity(volumeFeeApy));
    if (!Number.isFinite(modelFeeApy)) modelFeeApy = Math.max(observedApy, volumeFeeApy);
    modelFeeApy *= FEE_HAIRCUT;

    if (p.outlier) warnings.push('DeFiLlama marks this APY row as an outlier');
    if (volumeFeeApy === 0) warnings.push('missing 7d volume; fee APY uses DeFiLlama APY only');
    if (Math.abs(observedApy - volumeFeeApy) > Math.max(10, observedApy * 0.75)) {
      warnings.push('observed APY and volume-derived APY diverge materially');
    }

    return {
      poolAddress,
      symbol: `${s0}-${s1}`,
      token0: tokenA,
      token1: tokenB,
      canonicalToken0: normaliseAddress(canonical0),
      canonicalToken1: normaliseAddress(canonical1),
      feeTier: p.feeTier,
      feeRate: feeRateFromTier(p.feeTier),
      observedApy,
      volumeFeeApy,
      modelFeeApy,
      tvlUSD: p.tvlUsd,
      volumeUsd7d,
      token0Stable: STABLECOINS.has(tokenA),
      token1Stable: STABLECOINS.has(tokenB),
      warnings,
    } satisfies DiscoveredPool;
  });

  const valid = discovered.filter((p): p is DiscoveredPool => p != null);
  const unique = new Map<string, DiscoveredPool>();
  for (const p of valid) {
    const key = `${p.poolAddress}-${p.feeTier}`;
    const prev = unique.get(key);
    if (!prev || p.modelFeeApy > prev.modelFeeApy) unique.set(key, p);
  }

  const results = [...unique.values()].sort((a, b) => b.modelFeeApy - a.modelFeeApy);
  console.log(`  Matched ${results.length} exact fee-tier pools on-chain`);
  return results;
}

function nonZeroOrInfinity(n: number): number {
  return n > 0 ? n : Infinity;
}

const returnsCache = new Map<string, TokenReturns>();

async function fetchTokenReturns(address: string): Promise<TokenReturns> {
  const key = normaliseAddress(address);
  const cached = returnsCache.get(key);
  if (cached) return cached;

  if (STABLECOINS.has(key)) {
    const stable = { address: key, returns: Array(30).fill(0), source: 'stable-assumption', ok: true } satisfies TokenReturns;
    returnsCache.set(key, stable);
    return stable;
  }

  const start = Math.floor(Date.now() / 1000) - 32 * 86_400;
  const url = `https://coins.llama.fi/chart/arbitrum:${key}?start=${start}&span=30&period=1d`;
  try {
    const json = await fetchJson<any>(url, 15_000);
    const pts = (json.coins?.[`arbitrum:${key}`]?.prices ?? []) as Array<{ timestamp: number; price: number }>;
    const ordered = pts
      .filter(p => Number.isFinite(p.price) && p.price > 0)
      .sort((a, b) => a.timestamp - b.timestamp);
    const returns: number[] = [];
    for (let i = 1; i < ordered.length; i++) {
      returns.push(Math.log(ordered[i].price / ordered[i - 1].price));
    }
    const result = {
      address: key,
      returns,
      source: 'defillama',
      ok: returns.length >= MIN_DATA_POINTS,
    } satisfies TokenReturns;
    returnsCache.set(key, result);
    return result;
  } catch {
    const result = { address: key, returns: [], source: 'defillama', ok: false } satisfies TokenReturns;
    returnsCache.set(key, result);
    return result;
  }
}

async function prefetchReturns(pools: DiscoveredPool[]): Promise<void> {
  const tokens = [...new Set(pools.flatMap(p => [p.token0, p.token1]))];
  await mapLimit(tokens, 8, async token => { await fetchTokenReturns(token); });
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

function ewmaAnnualVol(returns: number[], lambda = EWMA_LAMBDA): number {
  if (returns.length < 3) return 0;
  let variance = returns[0] ** 2;
  for (let i = 1; i < returns.length; i++) {
    variance = lambda * variance + (1 - lambda) * returns[i] ** 2;
  }
  return Math.sqrt(Math.max(0, variance) * DAYS_PER_YEAR);
}

function conservativeDailyVol(spread: number[]): number {
  const windows = [7, 14, 30]
    .filter(w => spread.length >= Math.min(w, MIN_DATA_POINTS))
    .map(w => annualVol(spread.slice(-Math.min(w, spread.length))));
  const volAnnual = Math.max(ewmaAnnualVol(spread), annualVol(spread), ...windows);
  return volAnnual / Math.sqrt(DAYS_PER_YEAR);
}

function lvrAssess(spreadReturns: number[], feeApyPct: number, concentration = 1): LVRResult {
  const warnings: string[] = [];
  if (spreadReturns.length < MIN_DATA_POINTS) warnings.push('insufficient price history');
  const sigmaDaily = conservativeDailyVol(spreadReturns);
  const lvrAnnualPct = concentration * sigmaDaily ** 2 * DAYS_PER_YEAR / 8 * 100;
  const ratio = lvrAnnualPct <= 1e-9
    ? (feeApyPct > 0 ? Infinity : 0)
    : feeApyPct / lvrAnnualPct;
  return {
    spreadDailyVolPct: sigmaDaily * 100,
    spreadAnnualVolPct: sigmaDaily * Math.sqrt(DAYS_PER_YEAR) * 100,
    lvrRateAnnualPct: lvrAnnualPct,
    feeToLvrRatio: ratio,
    profitable: spreadReturns.length >= MIN_DATA_POINTS && ratio >= 1.25,
    dataPoints: spreadReturns.length,
    warnings,
  };
}

function concentrationFactor(rangePct: number): number {
  const r = rangePct / 100;
  return Math.sqrt(1 + r) / (Math.sqrt(1 + r) - Math.sqrt(1 - r));
}

function uniV3Amounts(price: number, lower: number, upper: number, liquidity: number): { amount0: number; amount1: number } {
  const sqrtP = Math.sqrt(price);
  const sqrtL = Math.sqrt(lower);
  const sqrtU = Math.sqrt(upper);
  if (price <= lower) {
    return { amount0: liquidity * (sqrtU - sqrtL) / (sqrtL * sqrtU), amount1: 0 };
  }
  if (price >= upper) {
    return { amount0: 0, amount1: liquidity * (sqrtU - sqrtL) };
  }
  return {
    amount0: liquidity * (sqrtU - sqrtP) / (sqrtP * sqrtU),
    amount1: liquidity * (sqrtP - sqrtL),
  };
}

function initialLiquidityForCapital(capitalUSD: number, lower: number, upper: number): {
  liquidity: number;
  entryAmount0: number;
  entryAmount1: number;
} {
  const unit = uniV3Amounts(1, lower, upper, 1);
  const unitValue = unit.amount0 + unit.amount1;
  const liquidity = capitalUSD / unitValue;
  return {
    liquidity,
    entryAmount0: unit.amount0 * liquidity,
    entryAmount1: unit.amount1 * liquidity,
  };
}

function lpValueAt(relativePrice: number, capitalUSD: number, rangePct: number): {
  lpValue: number;
  hodlValue: number;
  ilPct: number;
} {
  const r = rangePct / 100;
  const lower = Math.max(0.0001, 1 - r);
  const upper = 1 + r;
  const init = initialLiquidityForCapital(capitalUSD, lower, upper);
  const amounts = uniV3Amounts(relativePrice, lower, upper, init.liquidity);
  const lpValue = amounts.amount0 * relativePrice + amounts.amount1;
  const hodlValue = init.entryAmount0 * relativePrice + init.entryAmount1;
  const ilPct = hodlValue > 0 ? (lpValue / hodlValue - 1) * 100 : 0;
  return { lpValue, hodlValue, ilPct };
}

function computeOptimalRange(feeApyPct: number, sigmaDailyPct: number, capitalUSD: number): RangeResult {
  const sigma = sigmaDailyPct / 100;
  const warnings: string[] = [];
  if (sigma <= 1e-9) warnings.push('near-zero relative volatility; range result is stable-pair heuristic');

  let bestFallback: RangeResult | null = null;
  for (let rangePct = MIN_RANGE_PCT; rangePct <= MAX_RANGE_PCT; rangePct += RANGE_STEP_PCT) {
    const candidate = computeRangeSnapshot(feeApyPct, sigma, capitalUSD, rangePct);
    candidate.warnings.push(...warnings);
    candidate.failedChecks = rangeViabilityFailures(candidate);
    candidate.viable = candidate.failedChecks.length === 0;

    // Tightest viable range wins. This deliberately prefers capital efficiency
    // once the risk gates pass, rather than chasing the widest max-net-APY range.
    if (candidate.viable) return candidate;
    if (!bestFallback || candidate.netApyPct > bestFallback.netApyPct) bestFallback = candidate;
  }

  const fallback = bestFallback ?? computeRangeSnapshot(feeApyPct, sigma, capitalUSD, sigma <= 1e-9 ? 20 : 10);
  fallback.viable = false;
  fallback.failedChecks = fallback.failedChecks.length > 0 ? fallback.failedChecks : rangeViabilityFailures(fallback);
  fallback.warnings.push('no tight range passed all safety gates; showing best fallback only');
  return fallback;
}

function computeRangeSnapshot(feeApyPct: number, sigma: number, capitalUSD: number, rangePct: number): RangeResult {
  const range = rangePct / 100;
  const concentration = concentrationFactor(rangePct);
  const expectedDays = sigma > 1e-9 ? Math.max(0.5, (MIGRATION_TRIGGER * range / sigma) ** 2) : 90;
  const migrationsPerYear = DAYS_PER_YEAR / expectedDays;
  const gasFrictionPct = migrationsPerYear * GAS_PER_MIGRATION_USD / capitalUSD * 100;
  const lvrCostApyPct = concentration * sigma ** 2 * DAYS_PER_YEAR / 8 * 100;
  const triggerPrice = 1 + MIGRATION_TRIGGER * range;
  const atTrigger = lpValueAt(triggerPrice, capitalUSD, rangePct);
  return {
    rangePct,
    concentration,
    expectedDaysPerEpoch: expectedDays,
    migrationsPerYear,
    gasFrictionPct,
    grossFeeApyPct: feeApyPct,
    lvrCostApyPct,
    netApyPct: feeApyPct - lvrCostApyPct - gasFrictionPct,
    ilAtTriggerPct: Math.abs(Math.min(atTrigger.ilPct, 0)),
    epochFeesUSD: capitalUSD * feeApyPct / 100 / DAYS_PER_YEAR * expectedDays,
    epochILUSD: Math.max(0, atTrigger.hodlValue - atTrigger.lpValue),
    viable: false,
    failedChecks: [],
    warnings: [],
  };
}

function rangeViabilityFailures(range: RangeResult): string[] {
  const failures: string[] = [];
  if (range.netApyPct < MIN_NET_APY_PCT) {
    failures.push(`net APY < ${MIN_NET_APY_PCT}%`);
  }
  if (range.gasFrictionPct > GAS_FRICTION_CAP * Math.max(Math.abs(range.netApyPct), 1)) {
    failures.push('gas friction too high');
  }
  if (range.migrationsPerYear > MAX_MIGRATIONS_PER_YEAR) {
    failures.push(`too many rebalances > ${MAX_MIGRATIONS_PER_YEAR}/yr`);
  }
  const feeIlRatio = range.epochILUSD <= 1e-9 ? Infinity : range.epochFeesUSD / range.epochILUSD;
  if (feeIlRatio < MIN_EPOCH_FEE_IL_RATIO) {
    failures.push(`epoch fees/IL < ${MIN_EPOCH_FEE_IL_RATIO}x`);
  }
  return failures;
}

function initPosition(capitalUSD: number, rangePct: number): PositionState {
  return {
    centreRatio: 1,
    rangePct,
    capitalUSD,
    accruedFeesUSD: 0,
    totalFeesUSD: 0,
    totalILUSD: 0,
    totalGasUSD: 0,
    migrations: 0,
    daysActive: 0,
    status: 'IN_RANGE',
    driftPctOfRange: 0,
  };
}

function tickPosition(pos: PositionState, ratio: number, feeApyPct: number): PositionState {
  const range = pos.rangePct / 100;
  const drift = Math.abs(ratio / pos.centreRatio - 1) / range;
  const inRange = drift <= 1;
  const status = drift > MIGRATION_TRIGGER ? 'NEEDS_REBALANCE' : drift > 0.5 ? 'DRIFTING' : 'IN_RANGE';
  const dailyFees = inRange ? pos.capitalUSD * feeApyPct / 100 / DAYS_PER_YEAR : 0;
  return {
    ...pos,
    accruedFeesUSD: pos.accruedFeesUSD + dailyFees,
    daysActive: pos.daysActive + 1,
    driftPctOfRange: drift,
    status,
  };
}

function migrate(pos: PositionState, ratio: number): { pos: PositionState; log: string } {
  const relativePrice = ratio / pos.centreRatio;
  const value = lpValueAt(relativePrice, pos.capitalUSD, pos.rangePct);
  const ilUSD = Math.max(0, value.hodlValue - value.lpValue);
  const newCapital = value.lpValue + pos.accruedFeesUSD - GAS_PER_MIGRATION_USD;
  const next: PositionState = {
    ...pos,
    centreRatio: ratio,
    capitalUSD: newCapital,
    accruedFeesUSD: 0,
    totalFeesUSD: pos.totalFeesUSD + pos.accruedFeesUSD,
    totalILUSD: pos.totalILUSD + ilUSD,
    totalGasUSD: pos.totalGasUSD + GAS_PER_MIGRATION_USD,
    migrations: pos.migrations + 1,
    status: 'IN_RANGE',
    driftPctOfRange: 0,
  };
  return {
    pos: next,
    log: `Day ${pos.daysActive}: migrate drift=${(pos.driftPctOfRange * 100).toFixed(0)}% fees=${usd(pos.accruedFeesUSD, 2)} IL=${usd(ilUSD, 2)} gas=${usd(GAS_PER_MIGRATION_USD, 2)} capital=${usd(next.capitalUSD, 2)}`,
  };
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
  if (sorted.length === 0) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function runSimulation(
  feeApyPct: number,
  sigmaDailyPct: number,
  rangePct: number,
  capitalUSD: number,
  days: number,
  paths: number,
  label: string,
  seedLabel: string,
  migrationLogs: string[] = [],
): SimResult {
  const sigma = sigmaDailyPct / 100;
  const rng = mulberry32(hashSeed(`${SIM_SEED}:${seedLabel}:${label}`));
  const pnls: number[] = [];
  let totalMigrations = 0;
  let totalFees = 0;
  let totalIL = 0;
  let totalGas = 0;

  for (let pathIndex = 0; pathIndex < paths; pathIndex++) {
    let pos = initPosition(capitalUSD, rangePct);
    let ratio = 1;
    const logs: string[] = [];

    for (let day = 0; day < days; day++) {
      ratio *= Math.exp(sigma * gaussian(rng) - 0.5 * sigma ** 2);
      pos = tickPosition(pos, ratio, feeApyPct);
      if (pos.status === 'NEEDS_REBALANCE') {
        const migrated = migrate(pos, ratio);
        if (pathIndex === 0) logs.push(migrated.log);
        pos = migrated.pos;
      }
    }

    const finalValue = lpValueAt(ratio / pos.centreRatio, pos.capitalUSD, pos.rangePct);
    const finalIL = Math.max(0, finalValue.hodlValue - finalValue.lpValue);
    const finalCapital = finalValue.lpValue + pos.accruedFeesUSD;
    pnls.push(finalCapital - capitalUSD);
    totalMigrations += pos.migrations;
    totalFees += pos.totalFeesUSD + pos.accruedFeesUSD;
    totalIL += pos.totalILUSD + finalIL;
    totalGas += pos.totalGasUSD;

    if (pathIndex === 0) migrationLogs.push(...logs);
  }

  pnls.sort((a, b) => a - b);
  const meanPnL = pnls.reduce((s, v) => s + v, 0) / paths;
  return {
    strategy: label,
    finalCapital: capitalUSD + meanPnL,
    netPnL: meanPnL,
    netAPY: meanPnL / capitalUSD / days * DAYS_PER_YEAR * 100,
    migrations: totalMigrations / paths,
    totalFees: totalFees / paths,
    totalIL: totalIL / paths,
    totalGas: totalGas / paths,
    probProfit: pnls.filter(v => v > 0).length / paths,
    p05: quantile(pnls, 0.05),
    p50: quantile(pnls, 0.50),
    p95: quantile(pnls, 0.95),
  };
}

async function screenPools(pools: DiscoveredPool[]): Promise<RankedPool[]> {
  await prefetchReturns(pools);
  const ranked: RankedPool[] = [];

  for (const pool of pools) {
    const r0 = await fetchTokenReturns(pool.token0);
    const r1 = await fetchTokenReturns(pool.token1);
    const spread = alignSpreadReturns(r0.returns, r1.returns);
    const warnings = [...pool.warnings];
    if (!r0.ok && !pool.token0Stable) warnings.push(`weak price data for ${pool.token0.slice(0, 8)}`);
    if (!r1.ok && !pool.token1Stable) warnings.push(`weak price data for ${pool.token1.slice(0, 8)}`);

    const lvr = lvrAssess(spread, pool.modelFeeApy, 1);
    lvr.warnings.push(...warnings);
    if (!lvr.profitable) continue;

    const range = computeOptimalRange(pool.modelFeeApy, lvr.spreadDailyVolPct, CAPITAL_USD);
    const warningPenalty = Math.min(0.35, lvr.warnings.length * 0.06 + range.warnings.length * 0.04);
    const score = Math.max(0, range.netApyPct) * Math.min(3, lvr.feeToLvrRatio) * (1 - warningPenalty);
    ranked.push({ ...pool, lvr, range, score });
  }

  return ranked.sort((a, b) => b.score - a.score);
}

function printDiscovery(pools: DiscoveredPool[]): void {
  for (const p of pools.slice(0, 8)) {
    console.log(
      `  ${p.symbol.padEnd(18)} fee:${(p.feeRate * 100).toFixed(2).padStart(5)}%` +
      ` TVL:${usd(p.tvlUSD / 1_000_000, 1)}M` +
      ` modelFee:${pct(p.modelFeeApy).padStart(7)}` +
      ` pool:${p.poolAddress.slice(0, 10)}...`,
    );
  }
  if (pools.length > 8) console.log(`  ... ${pools.length - 8} more candidates`);
}

function printRanked(ranked: RankedPool[]): void {
  for (const p of ranked.slice(0, 10)) {
    const ratio = Number.isFinite(p.lvr.feeToLvrRatio) ? `${p.lvr.feeToLvrRatio.toFixed(2)}x` : 'inf';
    console.log(
      `  ${p.symbol.padEnd(18)} range: +/-${p.range.rangePct.toFixed(1).padStart(4)}%` +
      ` ${p.range.viable ? 'tight-ok' : 'fallback'}` +
      ` net:${pct(p.range.netApyPct).padStart(8)}` +
      ` fee:${pct(p.modelFeeApy).padStart(8)}` +
      ` LVR:${pct(p.lvr.lvrRateAnnualPct).padStart(8)}` +
      ` ratio:${ratio.padStart(7)}` +
      ` mig/yr:${p.range.migrationsPerYear.toFixed(1).padStart(6)}`,
    );
    if (!p.range.viable && p.range.failedChecks.length > 0) {
      console.log(`    failed range gates: ${p.range.failedChecks.slice(0, 3).join('; ')}`);
    }
    if (p.lvr.warnings.length > 0) {
      console.log(`    warnings: ${p.lvr.warnings.slice(0, 2).join('; ')}`);
    }
  }
}

function printSimulation(pool: RankedPool): void {
  sub(`${pool.symbol} | ${pct(pool.modelFeeApy)} model fee APY | ${pct(pool.lvr.spreadDailyVolPct, 2)}/day relative vol`);
  const logs: string[] = [];
  const active = runSimulation(
    pool.modelFeeApy,
    pool.lvr.spreadDailyVolPct,
    pool.range.rangePct,
    CAPITAL_USD,
    SIM_DAYS,
    SIM_PATHS,
    `Active +/-${pool.range.rangePct.toFixed(1)}%`,
    pool.poolAddress,
    logs,
  );
  const passive = runSimulation(
    pool.modelFeeApy,
    pool.lvr.spreadDailyVolPct,
    10,
    CAPITAL_USD,
    SIM_DAYS,
    SIM_PATHS,
    'Passive +/-10%',
    pool.poolAddress,
  );

  console.log(`\n  ${'Strategy'.padEnd(18)} ${'Net APY'.padEnd(10)} ${'Mean PnL'.padEnd(11)} ${'P05/P50/P95'.padEnd(24)} ${'Mig'.padEnd(7)} ${'Fees'.padEnd(9)} ${'IL'.padEnd(9)} P+`);
  console.log(`  ${'-'.repeat(103)}`);
  for (const r of [active, passive]) {
    console.log(
      `  ${r.strategy.padEnd(18)}` +
      ` ${pct(r.netAPY).padEnd(10)}` +
      ` ${usd(r.netPnL).padEnd(11)}` +
      ` ${(usd(r.p05) + '/' + usd(r.p50) + '/' + usd(r.p95)).padEnd(24)}` +
      ` ${r.migrations.toFixed(1).padEnd(7)}` +
      ` ${usd(r.totalFees).padEnd(9)}` +
      ` ${usd(r.totalIL).padEnd(9)}` +
      ` ${(r.probProfit * 100).toFixed(0)}%`,
    );
  }
  console.log(`  ${'HODL baseline'.padEnd(18)} ${'0.0%'.padEnd(10)} ${usd(0).padEnd(11)} ${`${usd(0)}/${usd(0)}/${usd(0)}`.padEnd(24)} ${'0.0'.padEnd(7)} ${usd(0).padEnd(9)} ${usd(0).padEnd(9)} 50%`);

  if (logs.length > 0) {
    console.log('\n  Sample first-path migrations:');
    for (const log of logs.slice(0, 5)) console.log(`    ${log}`);
    if (logs.length > 5) console.log(`    ... ${logs.length - 5} more`);
  }
}

function printIntegrationNotes(): void {
  section('Production Integration Notes');
  console.log(`
  This script is decision support only. A production rebalance still needs:

  1. Pool state:
     - Read slot0().tick from the exact pool address.
     - Store centreTick, halfRangeTicks, tokenId, feeTier, and lastRebalanceAt.

  2. Rebalance trigger:
     - Convert price range to ticks using UniV3 tick spacing for the fee tier.
     - Trigger only after drift > 70% of half-range and after cooldown/gas checks.

  3. On-chain path:
     - executeHarvest(user, USDC, [positionMgr, optionalSwapRouter], [...], hash)
       for accrued fees/rewards.
     - executeWithdrawMulti or executeBatchMulti for remove/normalise/re-mint.
     - Never rely on this script's simulated APY as the accounting source.

  4. User UX:
     - Show USD NAV, fees earned, IL vs HODL, gas spent/sponsored, and range status.
     - Label APY as estimated/backtested, not guaranteed.
  `);
}

async function main(): Promise<void> {
  console.log('\nYieldGeko Active LP Management Scout');
  console.log(`Arbitrum | capital=${usd(CAPITAL_USD)} | minTVL=${usd(MIN_TVL_USD)} | pools=${MAX_POOLS} | paths=${SIM_PATHS} | seed=${SIM_SEED}`);
  console.log(`Assumptions: fee haircut=${(FEE_HAIRCUT * 100).toFixed(0)}%, migration gas=${usd(GAS_PER_MIGRATION_USD, 2)}, trigger=${(MIGRATION_TRIGGER * 100).toFixed(0)}% of range`);
  console.log(`Range policy: choose tightest viable range from +/-${MIN_RANGE_PCT}% to +/-${MAX_RANGE_PCT}% | min net=${pct(MIN_NET_APY_PCT)} | max rebalance=${MAX_MIGRATIONS_PER_YEAR}/yr | min fees/IL=${MIN_EPOCH_FEE_IL_RATIO}x`);

  section('1. Pool Discovery');
  const pools = await discoverPools();
  printDiscovery(pools);
  if (pools.length === 0) {
    console.log('  No matching pools found.');
    return;
  }

  section('2. LVR Screening + Range Optimisation');
  const ranked = await screenPools(pools);
  if (ranked.length === 0) {
    console.log('  No pools passed the conservative LVR screen.');
    console.log('  Suggested fallback: route users to lower-risk lending/stable strategies.');
    return;
  }
  printRanked(ranked);

  section(`3. Monte Carlo Simulation (${SIM_DAYS} days x ${SIM_PATHS} paths)`);
  for (const pool of ranked.slice(0, 3)) printSimulation(pool);

  printIntegrationNotes();
}

main().catch(err => {
  console.error('\nFatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});
