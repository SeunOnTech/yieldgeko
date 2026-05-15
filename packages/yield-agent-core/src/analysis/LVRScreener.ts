

import {
  conservativeVolatility,
  spearmanCorrelation,
} from './QuantMath';

const SCREEN_TTL_MS      = 15 * 60_000;
const MIN_LVR_RATIO      = 3.0;
const MAX_POSITION_PCT   = 0.02;
const MIN_EPOCH_RATIO    = 1.20;
const MIGRATION_TRIGGER  = 0.70;
const GAS_PER_MIGRATION  = 0.20;
const GAS_FRICTION_CAP   = 0.01;
const DEFAULT_C_AVG      = 3.5;
const EWMA_LAMBDA        = 0.94;
const DEFAULT_CAPITAL    = 10_000;
const MAX_GAS_FRAC       = 0.10;

export interface LVRPool {
  address:         string;
  symbol:          string;
  token0:          string;  
  token1:          string;
  feeTierBps:      number;
  dllamaAPY:       number;
  volume24hUSD:    number;
  tvlUSD:          number;
  cAvg:            number;
  optimalRangePct: number;
  concentrationC:  number;
  adjFeeAPY:       number;
  netAPY:          number;
  sigmaRatioDaily: number;
  epochRatio:      number;
  lvrRatio:        number;
  scoredAt:        number;
}

let _cached:  LVRPool[]            = [];
let _cachedAt = 0;
let _running: Promise<LVRPool[]> | null = null;

export function invalidateLVRCache(): void {
  _cached = []; _cachedAt = 0; _running = null;
}

function dailyReturns(prices: number[]): number[] {
  const r: number[] = [];
  for (let i = 1; i < prices.length; i++) {
    if (prices[i - 1]! > 0) r.push(Math.log(prices[i]! / prices[i - 1]!));
  }
  return r;
}

function ewmaVol(returns: number[]): number {
  if (returns.length < 3) return 0;
  let v = returns[0]! ** 2;
  for (let i = 1; i < returns.length; i++) {
    v = EWMA_LAMBDA * v + (1 - EWMA_LAMBDA) * returns[i]! ** 2;
  }
  return Math.sqrt(v * 365);
}

function rollingVol(returns: number[], w: number): number {
  const r = returns.slice(-w);
  if (r.length < 3) return 0;
  const m = r.reduce((a, b) => a + b, 0) / r.length;
  return Math.sqrt(r.reduce((a, b) => a + (b - m) ** 2, 0) / (r.length - 1) * 365);
}

function consVol(returns: number[]): number {
  return Math.max(rollingVol(returns, 7), rollingVol(returns, 14), rollingVol(returns, 30), ewmaVol(returns));
}

function concentrationC(r: number): number {
  return Math.sqrt(1 + r) / (Math.sqrt(1 + r) - Math.sqrt(1 - r));
}

function v3ValueRatio(p: number, r: number): number {
  const pL = 1 - r, pH = 1 + r;
  const v0 = 2 - Math.sqrt(pL) - 1 / Math.sqrt(pH);
  const v  = p >= pH ? Math.sqrt(pH) - Math.sqrt(pL)
    : p <= pL ? (1 / Math.sqrt(pL) - 1 / Math.sqrt(pH)) * p
      : 2 * Math.sqrt(p) - Math.sqrt(pL) - p / Math.sqrt(pH);
  return v / v0;
}

function rangeMetrics(feeAPY: number, σ: number, r: number, cAvg: number) {
  const C           = concentrationC(r);
  const adjFeeAPY   = feeAPY * (C / cAvg);
  const E_T         = Math.max(0.5, (MIGRATION_TRIGGER * r / σ) ** 2);
  const mpy         = 365 / E_T;
  const gasFraction = mpy * GAS_PER_MIGRATION / DEFAULT_CAPITAL;
  const lvrAPY      = C * σ ** 2 * 365 / 8 * 100;
  const netAPY      = adjFeeAPY - lvrAPY - gasFraction * 100;
  const triggerMove = 1 + MIGRATION_TRIGGER * r;
  const ilPct       = Math.abs(v3ValueRatio(triggerMove, r) - (triggerMove + 1) / 2) * 100;
  const epochFees   = (adjFeeAPY / 100 / 365) * E_T * DEFAULT_CAPITAL;
  const epochIL     = (ilPct / 100) * DEFAULT_CAPITAL;
  const epochRatio  = epochIL > 0 ? epochFees / epochIL : 999;
  return { C, adjFeeAPY, lvrAPY, netAPY, gasFraction, epochFees, epochIL, epochRatio };
}

function computeOptimalRange(feeAPY: number, sigmaDaily: number, cAvg: number) {
  const σ = sigmaDaily / 100;
  let best: { rangePct: number; C: number; adjFeeAPY: number; netAPY: number; epochFees: number; epochIL: number; epochRatio: number } | null = null;

  for (let rPct = 3; rPct <= 50; rPct += 0.5) {
    const r = rPct / 100;
    const m = rangeMetrics(feeAPY, σ, r, cAvg);
    if (m.gasFraction <= GAS_FRICTION_CAP * Math.max(m.netAPY / 100, 0.01) &&
        m.epochRatio  >= MIN_EPOCH_RATIO &&
        m.netAPY      > 0 &&
        (!best || m.netAPY > best.netAPY)) {
      best = { rangePct: rPct, C: m.C, adjFeeAPY: m.adjFeeAPY, netAPY: m.netAPY,
               epochFees: m.epochFees, epochIL: m.epochIL, epochRatio: m.epochRatio };
    }
  }

  if (best) return best;
  const fb = rangeMetrics(feeAPY, σ, 0.20, cAvg);
  return { rangePct: 20, C: fb.C, adjFeeAPY: fb.adjFeeAPY, netAPY: fb.netAPY,
           epochFees: fb.epochFees, epochIL: fb.epochIL, epochRatio: fb.epochRatio };
}

const priceCache    = new Map<string, number[]>();
const priceFetched  = new Map<string, number>();
const PRICE_TTL_MS  = 60 * 60_000;

export function getCachedTokenPrices(address: string): number[] {
  return priceCache.get(address.toLowerCase()) ?? [];
}

export function getCachedAddresses(): string[] {
  return [...priceCache.keys()];
}
const STABLECOINS   = new Set([
  '0xaf88d065e77c8cc2239327c5edb3a432268e5831',
  '0xff970a61a04b1ca14834a43f5de4533ebddb5cc8',
  '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9',
  '0xda10009cbd5d07dd0cecc66161fc93d7c9000da1',
]);

async function fetchPricesForAddresses(addresses: string[]): Promise<void> {
  const now     = Date.now();
  const toFetch = addresses.filter(
    a => !STABLECOINS.has(a) && now - (priceFetched.get(a) ?? 0) > PRICE_TTL_MS,
  );
  for (const a of addresses) {
    if (STABLECOINS.has(a)) priceCache.set(a, Array(30).fill(1));
  }
  if (toFetch.length === 0) return;

  const start = Math.floor(Date.now() / 1000) - 31 * 86400;
  await Promise.allSettled(toFetch.map(async (addr) => {
    try {
      const url = `https://coins.llama.fi/chart/arbitrum:${addr}?start=${start}&span=30&period=1d`;
      const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      if (!res.ok) { priceCache.set(addr, []); return; }
      const json = await res.json() as any;
      const pts  = (json.coins?.[`arbitrum:${addr}`]?.prices ?? []) as { price: number }[];
      priceCache.set(addr, pts.length >= 10 ? pts.map(p => p.price) : []);
      priceFetched.set(addr, now);
    } catch { priceCache.set(addr, []); }
  }));
}

interface RawUniPool {
  symbol: string; address: string; token0: string; token1: string;
  feeTierBps: number; feeAPY: number; volume24hUSD: number;
  tvlUSD: number; cAvg: number;
}

async function discoverUniV3Pools(): Promise<RawUniPool[]> {
  const res  = await fetch('https://yields.llama.fi/pools', { signal: AbortSignal.timeout(20_000) });
  const json = await res.json() as any;
  const minTVL = DEFAULT_CAPITAL / MAX_POSITION_PCT;

  const raw = (json.data as any[]).filter(p =>
    p.chain === 'Arbitrum' &&
    p.project?.includes('uniswap-v3') &&
    p.tvlUsd >= minTVL &&
    Array.isArray(p.underlyingTokens) && p.underlyingTokens.length >= 2 &&
    (p.apy ?? 0) > 0,
  );

  
  const byPair = new Map<string, any>();
  for (const p of raw) {
    const key = [...p.underlyingTokens].map((t: string) => t.toLowerCase()).sort().join('-');
    if (!byPair.has(key) || p.apy > byPair.get(key).apy) byPair.set(key, p);
  }

  return [...byPair.values()].map(p => ({
    symbol:      p.symbol,
    address:     p.pool,
    token0:      p.underlyingTokens[0].toLowerCase(),
    token1:      p.underlyingTokens[1].toLowerCase(),
    
    
    feeTierBps:  p.poolMeta ? Math.round(parseFloat(p.poolMeta.replace(/[^0-9.]/g, '')) * 10_000) : 3000,
    feeAPY:      p.apyBase ?? p.apy ?? 0,
    volume24hUSD: p.volumeUsd1d ?? 0,
    tvlUSD:      p.tvlUsd,
    cAvg:        DEFAULT_C_AVG,
  }));
}

async function _runFullScreen(): Promise<LVRPool[]> {
  const pools = await discoverUniV3Pools();
  if (pools.length === 0) return [];

  const allAddresses = [...new Set(pools.flatMap(p => [p.token0, p.token1]))];
  await fetchPricesForAddresses(allAddresses);

  const results: LVRPool[] = [];

  for (const pool of pools) {
    try {
      const p0    = priceCache.get(pool.token0) ?? [];
      const p1    = priceCache.get(pool.token1) ?? [];
      const n     = Math.min(p0.length, p1.length);

      if (n < 10) continue;

      const r0          = dailyReturns(p0);
      const r1          = dailyReturns(p1);
      const ratioSeries = p0.slice(0, n).map((v, i) => (p1[i]! > 0 ? v / p1[i]! : 1));
      const rRatio      = dailyReturns(ratioSeries);
      const sigma       = consVol(rRatio);                
      const sigmaD      = sigma * 100 / Math.sqrt(365);  
      const corr        = spearmanCorrelation(r0, r1);

      
      
      
      
      const feeTier   = pool.feeTierBps / 10_000 / 100;
      const lvrAtC1   = sigma ** 2 / 8;
      const lvrRatio  = feeTier > 0 ? feeTier / lvrAtC1 : 0;  

      
      const maxPos = pool.tvlUSD * MAX_POSITION_PCT;
      if (maxPos < DEFAULT_CAPITAL) continue;

      
      const opt = computeOptimalRange(pool.feeAPY, sigmaD, pool.cAvg);

      results.push({
        address:         pool.address,
        symbol:          pool.symbol,
        token0:          pool.token0,
        token1:          pool.token1,
        feeTierBps:      pool.feeTierBps,
        dllamaAPY:       pool.feeAPY,
        volume24hUSD:    pool.volume24hUSD,
        tvlUSD:          pool.tvlUSD,
        cAvg:            pool.cAvg,
        optimalRangePct: opt.rangePct,
        concentrationC:  opt.C,
        adjFeeAPY:       opt.adjFeeAPY,
        
        netAPY:          Math.max(0, opt.netAPY),
        sigmaRatioDaily: sigmaD,
        epochRatio:      opt.epochRatio,
        lvrRatio,        
        scoredAt:        Date.now(),
      });
    } catch {
      
    }
  }

  
  results.sort((a, b) =>
    b.netAPY !== a.netAPY ? b.netAPY - a.netAPY : b.lvrRatio - a.lvrRatio,
  );
  console.log(`[LVRScreener] Screened ${pools.length} pools → ${results.length} passed TVL gate (LVR is now a score factor, not a filter)`);
  return results;
}

export async function getTopLVRPools(n = 10): Promise<LVRPool[]> {
  if (Date.now() - _cachedAt < SCREEN_TTL_MS && _cached.length > 0) {
    return _cached.slice(0, n);
  }
  if (!_running) {
    _running = _runFullScreen().then(res => {
      _cached = res; _cachedAt = Date.now(); _running = null;
      return res;
    }).catch(err => {
      console.warn('[LVRScreener] Screen failed (non-fatal):', err.message?.slice(0, 80));
      _running = null;
      return _cached;
    });
  }
  return (await _running).slice(0, n);
}
