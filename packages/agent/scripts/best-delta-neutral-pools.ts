#!/usr/bin/env npx ts-node
/**
 * YieldGeko — Best DELTA_NEUTRAL Pools
 *
 * Screens all Arbitrum UniV3 pools against 4 pre-deployment criteria and
 * returns the top 5 ranked by net APY after LVR costs.
 *
 * The 4 criteria (in order):
 *   1. LVR screen      — fee_rate > σ²_ratio/8  (pool is fundamentally profitable)
 *   2. Min LVR ratio   — fee/LVR ≥ 3×           (conservative safety margin)
 *   3. TVL check       — position ≤ 2% of TVL    (don't move the market)
 *   4. Optimal range   — tightest range where gas friction < 1% of net APY
 *
 * Usage:
 *   npx ts-node scripts/best-delta-neutral-pools.ts
 *
 * Optional env overrides:
 *   CAPITAL_USD=10000   reference position size
 *   MIN_LVR_RATIO=3     minimum fee/LVR ratio
 *   MAX_POSITION_PCT=2  max % of pool TVL
 *   TOP_N=5             number of results to show
 */

import { ethers } from 'ethers';
import * as dotenv from 'dotenv';
import * as path   from 'node:path';

dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

// ── Config ────────────────────────────────────────────────────────────────────

const ARB_RPC          = process.env.ARB_RPC_URL ?? 'https://arb1.arbitrum.io/rpc';
const CAPITAL_USD      = Number(process.env.CAPITAL_USD      ?? 10_000);
const MIN_LVR_RATIO    = Number(process.env.MIN_LVR_RATIO    ?? 3.0);
const MAX_POSITION_PCT = Number(process.env.MAX_POSITION_PCT ?? 2) / 100;
const TOP_N            = Number(process.env.TOP_N            ?? 5);
const MIN_TVL          = CAPITAL_USD / MAX_POSITION_PCT;  // derived

const provider = new ethers.JsonRpcProvider(ARB_RPC, 42161, { staticNetwork: true });

const STABLECOINS = new Set([
  '0xaf88d065e77c8cc2239327c5edb3a432268e5831', // USDC
  '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9', // USDT
  '0xda10009cbd5d07dd0cecc66161fc93d7c9000da1', // DAI
  '0xff970a61a04b1ca14834a43f5de4533ebddb5cc8', // USDC.e
]);

// ── Types ─────────────────────────────────────────────────────────────────────

interface Pool {
  symbol:       string;
  address:      string;
  token0:       string;
  token1:       string;
  feeTierBps:   number;   // e.g. 500 = 0.05%
  feeAPY:       number;   // DeFiLlama APY — what average LP earns (includes C_avg)
  volume24hUSD: number;   // 24h swap volume (0 if unavailable)
  tvlUSD:       number;
  cAvg:         number;   // estimated pool-average concentration factor
}

interface ScreenResult {
  pool:              Pool;
  sigmaRatioDaily:   number;
  spearmanCorr:      number;
  lvrRatio:          number;
  optimalRangePct:   number;
  concentrationC:    number;
  adjustedFeeAPY:    number;  // feeAPY × (C / C_avg) — what we actually earn
  netAPY:            number;
  migrationsPerYear: number;
  epochFeesUSD:      number;
  epochILUSD:        number;
  epochRatio:        number;
  failedCriteria:    string[];
}

// ── Math ──────────────────────────────────────────────────────────────────────

const EWMA_LAMBDA = 0.94;

function dailyReturns(prices: number[]): number[] {
  const r: number[] = [];
  for (let i = 1; i < prices.length; i++) {
    if (prices[i-1] > 0) r.push(Math.log(prices[i] / prices[i-1]));
  }
  return r;
}

function ewmaVol(returns: number[]): number {
  if (returns.length < 3) return 0;
  let v = returns[0] ** 2;
  for (let i = 1; i < returns.length; i++) v = EWMA_LAMBDA * v + (1 - EWMA_LAMBDA) * returns[i] ** 2;
  return Math.sqrt(v * 365);  // annualised
}

function rollingVol(returns: number[], w: number): number {
  const r = returns.slice(-w);
  if (r.length < 3) return 0;
  const m = r.reduce((a, b) => a + b, 0) / r.length;
  return Math.sqrt(r.reduce((a, b) => a + (b - m) ** 2, 0) / (r.length - 1) * 365);
}

function conservativeVol(returns: number[]): number {
  return Math.max(rollingVol(returns, 7), rollingVol(returns, 14), rollingVol(returns, 30), ewmaVol(returns));
}

function spearman(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 5) return 0;
  const rank = (arr: number[]) => {
    const s = arr.slice(0, n).map((v, i) => ({ v, i })).sort((x, y) => x.v - y.v);
    const r = new Array(n);
    s.forEach((x, rank) => { r[x.i] = rank + 1; });
    return r;
  };
  const rA = rank(a), rB = rank(b);
  const mA = rA.reduce((s, v) => s + v, 0) / n, mB = rB.reduce((s, v) => s + v, 0) / n;
  let cov = 0, vA = 0, vB = 0;
  for (let i = 0; i < n; i++) { const dA = rA[i]-mA, dB = rB[i]-mB; cov+=dA*dB; vA+=dA*dA; vB+=dB*dB; }
  return cov / Math.sqrt(vA * vB);
}

// Exact V3 concentration factor for symmetric ±r range
function concentrationC(r: number): number {
  return Math.sqrt(1 + r) / (Math.sqrt(1 + r) - Math.sqrt(1 - r));
}

// V3 LP value at price p (normalised: =1.0 at entry price p=1)
function v3ValueRatio(p: number, r: number): number {
  const pL = 1 - r, pH = 1 + r;
  const v0 = 2 - Math.sqrt(pL) - 1 / Math.sqrt(pH);
  const v   = p >= pH ? Math.sqrt(pH) - Math.sqrt(pL)
            : p <= pL ? (1/Math.sqrt(pL) - 1/Math.sqrt(pH)) * p
            : 2*Math.sqrt(p) - Math.sqrt(pL) - p/Math.sqrt(pH);
  return v / v0;
}

// ── Criteria 4: Optimal range ─────────────────────────────────────────────────
// Tightest range where gas friction < 1% of net APY
// Both fee income and LVR scale with C — net APY scales with C too.
// Tighter range = higher absolute return. Gas friction puts the floor.

const MIGRATION_TRIGGER   = 0.70;  // migrate at 70% drift
const GAS_PER_MIGRATION   = 0.20;  // USD on Arbitrum
const GAS_FRICTION_CAP    = 0.01;  // max 1% of net APY lost to gas
const MIN_EPOCH_FEE_RATIO = 1.20;  // epoch fees must be ≥ 1.2× epoch IL

// DEFAULT_C_AVG: fallback pool-average concentration when volume data is unavailable.
// Empirically, most active Uni V3 pools cluster around ±10–20% effective range → C ≈ 3–5.
const DEFAULT_C_AVG = 3.5;

// Compute metrics at a given range width, accounting for pool-average concentration.
// Key insight: DeFiLlama APY = what the AVERAGE LP earns (at C_avg).
// Our fee income scales as C/C_avg relative to the reported APY.
// LVR cost = C × σ²/8 (unchanged). Net APY now has a true optimum — not always ±50%.
function rangeMetrics(feeAPY: number, σ: number, r: number, cAvg: number): {
  C: number; E_T: number; mpy: number; gasFraction: number;
  adjustedFeeAPY: number; lvrAPY: number; netAPY: number;
  epochFeesUSD: number; epochILUSD: number; epochRatio: number;
} {
  const C              = concentrationC(r);
  const adjustedFeeAPY = feeAPY * (C / cAvg);       // what we actually earn at our concentration
  const E_T            = Math.max(0.5, (MIGRATION_TRIGGER * r / σ) ** 2);
  const mpy            = 365 / E_T;
  const gasFraction    = mpy * GAS_PER_MIGRATION / CAPITAL_USD;
  const lvrAPY         = C * σ**2 * 365 / 8 * 100;  // LVR cost scales with C
  const netAPY         = adjustedFeeAPY - lvrAPY - gasFraction * 100;
  const triggerMove    = 1 + MIGRATION_TRIGGER * r;
  const ilPct          = Math.abs(v3ValueRatio(triggerMove, r) - (triggerMove + 1) / 2) * 100;
  const epochFees      = (adjustedFeeAPY / 100 / 365) * E_T * CAPITAL_USD;
  const epochIL        = (ilPct / 100) * CAPITAL_USD;
  const epochRatio     = epochIL > 0 ? epochFees / epochIL : 999;
  return { C, E_T, mpy, gasFraction, adjustedFeeAPY, lvrAPY, netAPY,
           epochFeesUSD: epochFees, epochILUSD: epochIL, epochRatio };
}

function computeOptimalRange(feeAPY: number, sigmaDaily: number, cAvg: number): {
  rangePct: number; C: number; adjustedFeeAPY: number; netAPY: number;
  migrationsPerYear: number; epochFeesUSD: number; epochILUSD: number; epochRatio: number;
} {
  const σ = sigmaDaily / 100;

  // With C/C_avg scaling, net APY = feeAPY×(C/C_avg) - C×σ²/8×100 - gas(C²).
  // Fee income rises linearly with C; LVR cost also rises linearly; gas rises as C².
  // This creates a genuine interior optimum — scan for highest net APY.

  let best: ReturnType<typeof computeOptimalRange> | null = null;

  for (let rPct = 3; rPct <= 50; rPct += 0.5) {
    const r  = rPct / 100;
    const m  = rangeMetrics(feeAPY, σ, r, cAvg);
    const gasOk   = m.gasFraction <= GAS_FRICTION_CAP * Math.max(m.netAPY / 100, 0.01);
    const epochOk = m.epochRatio >= MIN_EPOCH_FEE_RATIO;
    const netOk   = m.netAPY > 0;

    if (gasOk && epochOk && netOk) {
      if (!best || m.netAPY > best.netAPY) {
        best = { rangePct: rPct, C: m.C, adjustedFeeAPY: m.adjustedFeeAPY,
                 netAPY: m.netAPY, migrationsPerYear: m.mpy,
                 epochFeesUSD: m.epochFeesUSD, epochILUSD: m.epochILUSD, epochRatio: m.epochRatio };
      }
    }
  }

  if (best) return best;

  // No viable range — return ±20% fallback so caller can report failure
  const fallback = rangeMetrics(feeAPY, σ, 0.20, cAvg);
  return { rangePct: 20, C: fallback.C, adjustedFeeAPY: fallback.adjustedFeeAPY,
           netAPY: fallback.netAPY, migrationsPerYear: fallback.mpy,
           epochFeesUSD: fallback.epochFeesUSD, epochILUSD: fallback.epochILUSD, epochRatio: fallback.epochRatio };
}

// ── Price data from DeFiLlama ─────────────────────────────────────────────────

const priceCache = new Map<string, number[]>();

async function fetchPricesParallel(addresses: string[]): Promise<void> {
  const toFetch = addresses.filter(a => !priceCache.has(a) && !STABLECOINS.has(a));

  for (const a of addresses) {
    if (STABLECOINS.has(a)) priceCache.set(a, Array(30).fill(0));
  }

  if (toFetch.length === 0) return;

  const start = Math.floor(Date.now() / 1000) - 31 * 86400;

  await Promise.allSettled(toFetch.map(async (addr) => {
    try {
      const url  = `https://coins.llama.fi/chart/arbitrum:${addr}?start=${start}&span=30&period=1d`;
      const res  = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      if (!res.ok) { priceCache.set(addr, []); return; }
      const json = await res.json() as any;
      const pts  = (json.coins?.[`arbitrum:${addr}`]?.prices ?? []) as Array<{timestamp: number; price: number}>;
      if (pts.length < 10) { priceCache.set(addr, []); return; }
      priceCache.set(addr, pts.map(p => p.price));
    } catch {
      priceCache.set(addr, []);
    }
  }));
}

function getReturns(address: string): number[] {
  const prices = priceCache.get(address) ?? [];
  return dailyReturns(prices);
}

// ── Pool discovery ────────────────────────────────────────────────────────────

async function discoverPools(): Promise<Pool[]> {
  const res  = await fetch('https://yields.llama.fi/pools', { signal: AbortSignal.timeout(20_000) });
  const json = await res.json() as any;

  const raw = (json.data as any[]).filter(p =>
    p.chain === 'Arbitrum' &&
    p.project?.includes('uniswap-v3') &&
    p.tvlUsd >= MIN_TVL &&
    Array.isArray(p.underlyingTokens) &&
    p.underlyingTokens.length >= 2 &&
    (p.apy ?? 0) > 0
  );

  // Deduplicate by token pair — keep highest APY
  const byPair = new Map<string, any>();
  for (const p of raw) {
    const key = [...p.underlyingTokens].map((t: string) => t.toLowerCase()).sort().join('-');
    if (!byPair.has(key) || p.apy > byPair.get(key).apy) byPair.set(key, p);
  }

  const factory = new ethers.Contract(
    '0x1F98431c8aD98523631AE4a59f267346ea31F984',
    ['function getPool(address,address,uint24) view returns (address)'],
    provider,
  );

  const symCache = new Map<string, string>();
  const sym = async (a: string) => {
    if (symCache.has(a)) return symCache.get(a)!;
    try {
      const c = new ethers.Contract(a, ['function symbol() view returns (string)'], provider);
      const s = await c.symbol() as string;
      symCache.set(a, s); return s;
    } catch { return a.slice(2, 8); }
  };

  const pools: Pool[] = [];
  for (const p of byPair.values()) {
    for (const feeTier of [100, 500, 3000, 10000]) {
      try {
        const addr: string = await factory.getPool(p.underlyingTokens[0], p.underlyingTokens[1], feeTier);
        if (addr === ethers.ZeroAddress) continue;
        const [s0, s1] = await Promise.all([sym(p.underlyingTokens[0]), sym(p.underlyingTokens[1])]);

        const volume24hUSD = Number(p.volumeUsd1d ?? 0);
        const tvlUSD       = p.tvlUsd as number;
        const feeAPY       = p.apy as number;

        // C_avg = DeFiLlama_APY / base_APY
        // base_APY = what a full-range (C=1) LP earns = fee_rate × volume / TVL × 365
        // fee_rate = feeTier / 1_000_000 (Uni V3 units)
        const baseAPY = volume24hUSD > 0
          ? (feeTier / 1_000_000) * (volume24hUSD / tvlUSD) * 365 * 100
          : 0;
        const cAvg = baseAPY > 0
          ? Math.max(1.0, Math.min(50, feeAPY / baseAPY))
          : DEFAULT_C_AVG;

        pools.push({
          symbol: `${s0}-${s1}`,
          address: addr,
          token0:  p.underlyingTokens[0].toLowerCase(),
          token1:  p.underlyingTokens[1].toLowerCase(),
          feeTierBps: feeTier,
          feeAPY,
          volume24hUSD,
          tvlUSD,
          cAvg,
        });
        break;
      } catch { /* next fee tier */ }
    }
  }
  return pools;
}

// ── Screen a single pool ──────────────────────────────────────────────────────

function screenPool(pool: Pool): ScreenResult {
  const failed: string[] = [];

  const r0 = getReturns(pool.token0);
  const r1 = getReturns(pool.token1);

  const σ0 = STABLECOINS.has(pool.token0) ? 0 : conservativeVol(r0) / Math.sqrt(365);
  const σ1 = STABLECOINS.has(pool.token1) ? 0 : conservativeVol(r1) / Math.sqrt(365);
  const ρ  = (r0.length < 5 || r1.length < 5 || STABLECOINS.has(pool.token0) || STABLECOINS.has(pool.token1)) ? 0 : spearman(r0, r1);

  const σRatioDaily  = Math.sqrt(Math.max(0, σ0**2 + σ1**2 - 2*ρ*σ0*σ1)) * 100;
  const σRatioAnnual = σRatioDaily * Math.sqrt(365);

  // Criteria 1: LVR screen (fee > σ²/8 at C=1 baseline)
  const lvrBaseline = (σRatioAnnual/100)**2 / 8 * 100;
  const lvrRatio    = lvrBaseline > 0 ? pool.feeAPY / lvrBaseline : 0;

  if (σRatioDaily === 0 && !STABLECOINS.has(pool.token0) && !STABLECOINS.has(pool.token1)) {
    failed.push('no price data');
  }
  if (lvrBaseline > 0 && pool.feeAPY <= lvrBaseline) {
    failed.push(`fee ${pool.feeAPY.toFixed(1)}% ≤ LVR baseline ${lvrBaseline.toFixed(1)}%`);
  }

  // Criteria 2: Min LVR ratio
  if (lvrRatio < MIN_LVR_RATIO && lvrRatio > 0) {
    failed.push(`LVR ratio ${lvrRatio.toFixed(1)}× < required ${MIN_LVR_RATIO}×`);
  }

  // Criteria 3: TVL check
  const maxPositionUSD = pool.tvlUSD * MAX_POSITION_PCT;
  if (CAPITAL_USD > maxPositionUSD) {
    failed.push(`position $${CAPITAL_USD.toLocaleString()} > ${(MAX_POSITION_PCT*100).toFixed(0)}% of TVL $${(maxPositionUSD/1e3).toFixed(0)}K`);
  }

  // Criteria 4 + 5: Optimal range where epoch fees > IL × 1.2
  let optimalRangePct = 10, concentrationC_ = 10.47, adjustedFeeAPY = 0,
      netAPY = 0, migrationsPerYear = 0, epochFeesUSD = 0, epochILUSD = 0, epochRatio = 0;
  if (failed.length === 0) {
    const range    = computeOptimalRange(pool.feeAPY, σRatioDaily, pool.cAvg);
    optimalRangePct   = range.rangePct;
    concentrationC_   = range.C;
    adjustedFeeAPY    = range.adjustedFeeAPY;
    netAPY            = range.netAPY;
    migrationsPerYear = range.migrationsPerYear;
    epochFeesUSD      = range.epochFeesUSD;
    epochILUSD        = range.epochILUSD;
    epochRatio        = range.epochRatio;

    if (netAPY <= 0) failed.push(`net APY ${netAPY.toFixed(1)}% ≤ 0 after LVR + gas`);
    if (epochRatio < MIN_EPOCH_FEE_RATIO) failed.push(`epoch fees $${epochFeesUSD.toFixed(0)} < IL $${epochILUSD.toFixed(0)} × ${MIN_EPOCH_FEE_RATIO} (ratio:${epochRatio.toFixed(2)}×)`);
  }

  return {
    pool, sigmaRatioDaily: σRatioDaily, spearmanCorr: ρ, lvrRatio,
    optimalRangePct, concentrationC: concentrationC_, adjustedFeeAPY, netAPY,
    migrationsPerYear, epochFeesUSD, epochILUSD, epochRatio, failedCriteria: failed,
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n╔══════════════════════════════════════════════════════════════════╗');
  console.log('║  YieldGeko — Best DELTA_NEUTRAL Pools (Top 5)                 ║');
  console.log('╚══════════════════════════════════════════════════════════════════╝\n');
  console.log(`  Criteria:`);
  console.log(`    1. LVR screen      fee > σ²/8  (pool fundamentally profitable)`);
  console.log(`    2. Min LVR ratio   ≥ ${MIN_LVR_RATIO}×  (fees cover LVR ${MIN_LVR_RATIO}× over)`);
  console.log(`    3. TVL check       position ($${CAPITAL_USD.toLocaleString()}) ≤ ${(MAX_POSITION_PCT*100).toFixed(0)}% of pool TVL`);
  console.log(`    4. Optimal range   widest range where epoch fees > IL × ${MIN_EPOCH_FEE_RATIO}`);
  console.log(`    5. IL guard        epoch fees / epoch IL ≥ ${MIN_EPOCH_FEE_RATIO}×  (IL never eats profit)\n`);

  // Step 1: Discover pools
  process.stdout.write('  Fetching pools from DeFiLlama… ');
  const pools = await discoverPools();
  console.log(`${pools.length} pools found (TVL ≥ $${(MIN_TVL/1e6).toFixed(1)}M)\n`);

  // Step 2: Fetch all price data in parallel (one request per token, all concurrent)
  process.stdout.write('  Fetching 30d price data from DeFiLlama… ');
  const allTokens = [...new Set(pools.flatMap(p => [p.token0, p.token1]))];
  await fetchPricesParallel(allTokens);
  const fetched = allTokens.filter(a => (priceCache.get(a)?.length ?? 0) > 0 || STABLECOINS.has(a));
  console.log(`${fetched.length}/${allTokens.length} tokens with price data\n`);

  // Step 3: Screen all pools
  const results = pools.map(screenPool);
  const passed  = results.filter(r => r.failedCriteria.length === 0).sort((a, b) => b.netAPY - a.netAPY);
  const failed  = results.filter(r => r.failedCriteria.length > 0);

  // Step 4: Show top N
  console.log(`  ${'─'.repeat(72)}`);
  console.log(`  ${passed.length} pools PASSED all 4 criteria  |  ${failed.length} pools failed\n`);

  if (passed.length === 0) {
    console.log('  No pools pass all criteria at current market conditions.');
    console.log('  → Agent falls back to Aave/Morpho passive yield\n');
  } else {
    console.log(`  TOP ${Math.min(TOP_N, passed.length)} — ranked by net APY after LVR + gas:\n`);

    for (let i = 0; i < Math.min(TOP_N, passed.length); i++) {
      const r = passed[i];
      const annualNet  = r.netAPY / 100 * CAPITAL_USD;
      const volLabel   = r.pool.volume24hUSD > 0
        ? `vol:$${(r.pool.volume24hUSD/1e3).toFixed(0)}K/d`
        : 'vol:unknown → C_avg estimated';
      console.log(`  ${i+1}. ${r.pool.symbol.padEnd(22)} DeFiLlama:${r.pool.feeAPY.toFixed(1).padStart(6)}%  AdjFee:${r.adjustedFeeAPY.toFixed(1).padStart(6)}%  Net:${r.netAPY.toFixed(1).padStart(6)}%`);
      console.log(`     → $${annualNet.toFixed(0)}/yr on $${CAPITAL_USD.toLocaleString()}  |  C_avg:${r.pool.cAvg.toFixed(1)}×  (${volLabel})`);
      console.log(`     Range: ±${r.optimalRangePct.toFixed(1)}%  C:${r.concentrationC.toFixed(1)}×  LVR_ratio:${r.lvrRatio.toFixed(1)}×  migrations:${r.migrationsPerYear.toFixed(0)}/yr`);
      console.log(`     σ_ratio:${r.sigmaRatioDaily.toFixed(2)}%/day  corr:${r.spearmanCorr.toFixed(2)}`);
      console.log(`     Per epoch — fees:$${r.epochFeesUSD.toFixed(2)}  IL:$${r.epochILUSD.toFixed(2)}  ratio:${r.epochRatio.toFixed(2)}× ✅ fees beat IL`);
      console.log(`     Pool: ${r.pool.address}\n`);
    }
  }

  // Step 5: Why pools failed (brief)
  if (failed.length > 0) {
    console.log(`  ${'─'.repeat(72)}`);
    console.log(`  FAILED — reason summary:\n`);
    const byReason = new Map<string, string[]>();
    for (const r of failed) {
      const reason = r.failedCriteria[0];
      if (!byReason.has(reason)) byReason.set(reason, []);
      byReason.get(reason)!.push(r.pool.symbol);
    }
    for (const [reason, pools_] of byReason) {
      console.log(`  ❌ ${reason}`);
      console.log(`     ${pools_.slice(0,5).join(', ')}${pools_.length > 5 ? ` +${pools_.length-5} more` : ''}`);
    }
  }

  console.log('\n══════════════════════════════════════════════════════════════════\n');
}

main().catch(err => { console.error('\n❌', err.message); process.exit(1); });
