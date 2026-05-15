

import { ethers } from 'ethers';
import { resolveSwapRoute, type SwapRoute } from './swapRouter';

const SCREEN_TTL_MS    = 15 * 60_000;
const MIN_LVR_RATIO    = 3.0;
const MAX_POSITION_PCT = 0.02;        
const MIN_EPOCH_RATIO  = 1.20;
const MIGRATION_TRIGGER = 0.70;
const GAS_PER_MIGRATION = 0.20;       
const GAS_FRICTION_CAP  = 0.01;
const DEFAULT_C_AVG     = 3.5;
const EWMA_LAMBDA       = 0.94;
const DEFAULT_CAPITAL   = 10_000;     

export const MIN_DELTA_NEUTRAL_USD = Number(process.env.MIN_DELTA_NEUTRAL_USD ?? 0);

const MAX_GAS_FRACTION_OF_PROFIT = 0.10;

const UNI_FACTORY = '0x1F98431c8aD98523631AE4a59f267346ea31F984';

const STABLECOINS = new Set([
  '0xaf88d065e77c8cc2239327c5edb3a432268e5831',
  '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9',
  '0xda10009cbd5d07dd0cecc66161fc93d7c9000da1',
  '0xff970a61a04b1ca14834a43f5de4533ebddb5cc8',
]);

export interface ScreenedPool {
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
  
  
  swapRoute0:      SwapRoute | null | undefined;
  swapRoute1:      SwapRoute | null | undefined;
}

let cachedPools: ScreenedPool[] = [];
let cachedAt = 0;
let runningScreen: Promise<ScreenedPool[]> | null = null;

export function invalidateScreenerCache(): void {
  cachedAt    = 0;
  cachedPools = [];
  runningScreen = null;
}

export async function getTopScreenedPools(
  n = 10,
  provider?: ethers.JsonRpcProvider,
): Promise<ScreenedPool[]> {
  if (Date.now() - cachedAt < SCREEN_TTL_MS && cachedPools.length > 0) {
    return cachedPools.slice(0, n);
  }
  
  if (!runningScreen) {
    runningScreen = _runFullScreen(provider).finally(() => { runningScreen = null; });
  }
  const result = await runningScreen;
  return result.slice(0, n);
}

function dailyReturns(prices: number[]): number[] {
  const r: number[] = [];
  for (let i = 1; i < prices.length; i++) {
    if (prices[i - 1] > 0) r.push(Math.log(prices[i] / prices[i - 1]));
  }
  return r;
}

function ewmaVol(returns: number[]): number {
  if (returns.length < 3) return 0;
  let v = returns[0] ** 2;
  for (let i = 1; i < returns.length; i++) v = EWMA_LAMBDA * v + (1 - EWMA_LAMBDA) * returns[i] ** 2;
  return Math.sqrt(v * 365);
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
  const mA = rA.reduce((s, v) => s + v, 0) / n;
  const mB = rB.reduce((s, v) => s + v, 0) / n;
  let cov = 0, vA = 0, vB = 0;
  for (let i = 0; i < n; i++) {
    const dA = rA[i] - mA, dB = rB[i] - mB;
    cov += dA * dB; vA += dA * dA; vB += dB * dB;
  }
  return cov / Math.sqrt(vA * vB);
}

function concentrationC(r: number): number {
  return Math.sqrt(1 + r) / (Math.sqrt(1 + r) - Math.sqrt(1 - r));
}

function v3ValueRatio(p: number, r: number): number {
  const pL = 1 - r, pH = 1 + r;
  const v0 = 2 - Math.sqrt(pL) - 1 / Math.sqrt(pH);
  const v = p >= pH ? Math.sqrt(pH) - Math.sqrt(pL)
    : p <= pL ? (1 / Math.sqrt(pL) - 1 / Math.sqrt(pH)) * p
      : 2 * Math.sqrt(p) - Math.sqrt(pL) - p / Math.sqrt(pH);
  return v / v0;
}

function rangeMetrics(feeAPY: number, σ: number, r: number, cAvg: number) {
  const C             = concentrationC(r);
  const adjFeeAPY     = feeAPY * (C / cAvg);
  const E_T           = Math.max(0.5, (MIGRATION_TRIGGER * r / σ) ** 2);
  const mpy           = 365 / E_T;
  const gasFraction   = mpy * GAS_PER_MIGRATION / DEFAULT_CAPITAL;
  const lvrAPY        = C * σ ** 2 * 365 / 8 * 100;
  const netAPY        = adjFeeAPY - lvrAPY - gasFraction * 100;
  const triggerMove   = 1 + MIGRATION_TRIGGER * r;
  const ilPct         = Math.abs(v3ValueRatio(triggerMove, r) - (triggerMove + 1) / 2) * 100;
  const epochFees     = (adjFeeAPY / 100 / 365) * E_T * DEFAULT_CAPITAL;
  const epochIL       = (ilPct / 100) * DEFAULT_CAPITAL;
  const epochRatio    = epochIL > 0 ? epochFees / epochIL : 999;
  return { C, adjFeeAPY, lvrAPY, netAPY, mpy, gasFraction, epochFees, epochIL, epochRatio };
}

function computeOptimalRange(feeAPY: number, sigmaDaily: number, cAvg: number) {
  const σ = sigmaDaily / 100;
  let best: { rangePct: number; C: number; adjFeeAPY: number; netAPY: number; mpy: number; epochFees: number; epochIL: number; epochRatio: number } | null = null;

  for (let rPct = 3; rPct <= 50; rPct += 0.5) {
    const r = rPct / 100;
    const m = rangeMetrics(feeAPY, σ, r, cAvg);
    const gasOk   = m.gasFraction <= GAS_FRICTION_CAP * Math.max(m.netAPY / 100, 0.01);
    const epochOk = m.epochRatio >= MIN_EPOCH_RATIO;
    const netOk   = m.netAPY > 0;
    if (gasOk && epochOk && netOk && (!best || m.netAPY > best.netAPY)) {
      best = { rangePct: rPct, C: m.C, adjFeeAPY: m.adjFeeAPY, netAPY: m.netAPY, mpy: m.mpy,
               epochFees: m.epochFees, epochIL: m.epochIL, epochRatio: m.epochRatio };
    }
  }

  if (best) return best;
  const fallback = rangeMetrics(feeAPY, σ, 0.20, cAvg);
  return { rangePct: 20, C: fallback.C, adjFeeAPY: fallback.adjFeeAPY, netAPY: fallback.netAPY,
           mpy: fallback.mpy, epochFees: fallback.epochFees, epochIL: fallback.epochIL, epochRatio: fallback.epochRatio };
}

const priceCache = new Map<string, number[]>();
const priceFetchedAt = new Map<string, number>();
const PRICE_TTL_MS = 60 * 60_000; 

async function fetchPricesParallel(addresses: string[]): Promise<void> {
  const now = Date.now();
  const toFetch = addresses.filter(a =>
    !STABLECOINS.has(a) &&
    (now - (priceFetchedAt.get(a) ?? 0) > PRICE_TTL_MS)
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
      const pts  = (json.coins?.[`arbitrum:${addr}`]?.prices ?? []) as Array<{ timestamp: number; price: number }>;
      if (pts.length < 10) { priceCache.set(addr, []); return; }
      priceCache.set(addr, pts.map(p => p.price));
      priceFetchedAt.set(addr, Date.now());
    } catch {
      priceCache.set(addr, []);
    }
  }));
}

async function discoverPools(provider?: ethers.JsonRpcProvider): Promise<Array<{
  symbol: string; address: string; token0: string; token1: string;
  feeTierBps: number; feeAPY: number; volume24hUSD: number; tvlUSD: number; cAvg: number;
}>> {
  const res  = await fetch('https://yields.llama.fi/pools', { signal: AbortSignal.timeout(20_000) });
  const json = await res.json() as any;

  const minTVL = DEFAULT_CAPITAL / MAX_POSITION_PCT;
  const raw = (json.data as any[]).filter(p =>
    p.chain === 'Arbitrum' &&
    p.project?.includes('uniswap-v3') &&
    p.tvlUsd >= minTVL &&
    Array.isArray(p.underlyingTokens) &&
    p.underlyingTokens.length >= 2 &&
    (p.apy ?? 0) > 0,
  );

  
  const byPair = new Map<string, any>();
  for (const p of raw) {
    const key = [...p.underlyingTokens].map((t: string) => t.toLowerCase()).sort().join('-');
    if (!byPair.has(key) || p.apy > byPair.get(key).apy) byPair.set(key, p);
  }

  const factory = provider
    ? new ethers.Contract(UNI_FACTORY, ['function getPool(address,address,uint24) view returns (address)'], provider)
    : null;

  const symCache = new Map<string, string>();
  const sym = async (a: string) => {
    if (symCache.has(a)) return symCache.get(a)!;
    if (!provider) return a.slice(2, 8);
    try {
      const c = new ethers.Contract(a, ['function symbol() view returns (string)'], provider);
      const s = await c.symbol() as string;
      symCache.set(a, s); return s;
    } catch { return a.slice(2, 8); }
  };

  const pools: Array<{
    symbol: string; address: string; token0: string; token1: string;
    feeTierBps: number; feeAPY: number; volume24hUSD: number; tvlUSD: number; cAvg: number;
  }> = [];

  for (const p of byPair.values()) {
    
    
    
    const poolMetaFee = (() => {
      const meta = (p.poolMeta ?? '') as string;
      const match = meta.match(/(\d+(?:\.\d+)?)\s*%/);
      if (!match) return null;
      const tier = Math.round(parseFloat(match[1]) * 10_000);
      return [100, 500, 3000, 10000].includes(tier) ? tier : null;
    })();
    const feeTiersToTry = poolMetaFee ? [poolMetaFee] : [100, 500, 3000, 10000];

    for (const feeTier of feeTiersToTry) {
      try {
        let addr: string;
        if (factory) {
          addr = await factory.getPool(p.underlyingTokens[0], p.underlyingTokens[1], feeTier) as string;
          if (addr === ethers.ZeroAddress) continue;
        } else {
          
          addr = p.pool as string;
          if (!/^0x[a-fA-F0-9]{40}$/.test(addr)) continue;
        }

        const [s0, s1] = await Promise.all([sym(p.underlyingTokens[0]), sym(p.underlyingTokens[1])]);
        const volume24hUSD = Number(p.volumeUsd1d ?? 0);
        const tvlUSD       = p.tvlUsd as number;
        const feeAPY       = p.apy as number;
        const baseAPY      = volume24hUSD > 0
          ? (feeTier / 1_000_000) * (volume24hUSD / tvlUSD) * 365 * 100
          : 0;
        const cAvg = baseAPY > 0
          ? Math.max(1.0, Math.min(50, feeAPY / baseAPY))
          : DEFAULT_C_AVG;

        pools.push({
          symbol: `${s0}-${s1}`, address: addr,
          token0: p.underlyingTokens[0].toLowerCase(),
          token1: p.underlyingTokens[1].toLowerCase(),
          feeTierBps: feeTier, feeAPY, volume24hUSD, tvlUSD, cAvg,
        });
        break;
      } catch {  }
    }
  }
  return pools;
}

async function _runFullScreen(provider?: ethers.JsonRpcProvider): Promise<ScreenedPool[]> {
  try {
    const pools = await discoverPools(provider);

    
    const allTokens = [...new Set(pools.flatMap(p => [p.token0, p.token1]))];
    await fetchPricesParallel(allTokens);

    const results: ScreenedPool[] = [];
    const minTVL = DEFAULT_CAPITAL / MAX_POSITION_PCT;

    for (const pool of pools) {
      
      
      
      
      
      if (STABLECOINS.has(pool.token0) && STABLECOINS.has(pool.token1)) continue;

      const r0 = dailyReturns(priceCache.get(pool.token0) ?? []);
      const r1 = dailyReturns(priceCache.get(pool.token1) ?? []);

      const σ0 = STABLECOINS.has(pool.token0) ? 0 : conservativeVol(r0) / Math.sqrt(365);
      const σ1 = STABLECOINS.has(pool.token1) ? 0 : conservativeVol(r1) / Math.sqrt(365);
      const ρ  = (r0.length >= 5 && r1.length >= 5 &&
                  !STABLECOINS.has(pool.token0) && !STABLECOINS.has(pool.token1))
        ? spearman(r0, r1) : 0;

      const σRatioDaily  = Math.sqrt(Math.max(0, σ0 ** 2 + σ1 ** 2 - 2 * ρ * σ0 * σ1)) * 100;
      const σRatioAnnual = σRatioDaily * Math.sqrt(365);

      
      const lvrBaseline = (σRatioAnnual / 100) ** 2 / 8 * 100;
      const lvrRatio    = lvrBaseline > 0 ? pool.feeAPY / lvrBaseline : 999;

      
      if (σRatioDaily === 0 && !STABLECOINS.has(pool.token0) && !STABLECOINS.has(pool.token1)) continue;
      if (lvrBaseline > 0 && pool.feeAPY <= lvrBaseline) continue;

      
      if (lvrRatio < MIN_LVR_RATIO && lvrRatio < 999) continue;

      
      if (pool.tvlUSD < minTVL) continue;

      
      const opt = computeOptimalRange(pool.feeAPY, σRatioDaily, pool.cAvg);

      if (opt.netAPY <= 0) continue;
      if (opt.epochRatio < MIN_EPOCH_RATIO) continue;

      
      
      
      const USDC_ADDR = '0xaf88d065e77c8cc2239327c5edb3a432268e5831';
      let swapRoute0: SwapRoute | null | undefined;
      let swapRoute1: SwapRoute | null | undefined;
      if (provider) {
        const [r0, r1] = await Promise.all([
          pool.token0 === USDC_ADDR ? Promise.resolve(null) : resolveSwapRoute(pool.token0, provider),
          pool.token1 === USDC_ADDR ? Promise.resolve(null) : resolveSwapRoute(pool.token1, provider),
        ]);
        
        
        
        const t0NeedsSwap = pool.token0 !== USDC_ADDR;
        const t1NeedsSwap = pool.token1 !== USDC_ADDR;
        if (t0NeedsSwap && r0 === null) {
          console.warn(`[UniV3Screener] No swap route for ${pool.symbol} token0=${pool.token0} — skipping pool`);
          continue;
        }
        if (t1NeedsSwap && r1 === null) {
          console.warn(`[UniV3Screener] No swap route for ${pool.symbol} token1=${pool.token1} — skipping pool`);
          continue;
        }
        swapRoute0 = r0;
        swapRoute1 = r1;
      }

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
        netAPY:          opt.netAPY,
        sigmaRatioDaily: σRatioDaily,
        epochRatio:      opt.epochRatio,
        lvrRatio,
        scoredAt:        Date.now(),
        swapRoute0,
        swapRoute1,
      });
    }

    
    results.sort((a, b) => b.netAPY - a.netAPY);
    cachedPools = results;
    cachedAt    = Date.now();
    return results;
  } catch (err: any) {
    console.warn('[UniV3Screener] Screen failed:', err.message);
    return cachedPools; 
  }
}

export function adjustPoolForCapital(
  pool:       ScreenedPool,
  capitalUSD: number,
): { rangePct: number; netAPY: number; viable: boolean } | null {
  
  if (MIN_DELTA_NEUTRAL_USD > 0 && capitalUSD < MIN_DELTA_NEUTRAL_USD) return null;

  const σ = pool.sigmaRatioDaily / 100;
  let bestRange: { rangePct: number; netAPY: number } | null = null;
  let widestViable: { rangePct: number; netAPY: number } | null = null;

  for (let rPct = 3; rPct <= 50; rPct += 0.5) {
    const r          = rPct / 100;
    const C          = Math.sqrt(1 + r) / (Math.sqrt(1 + r) - Math.sqrt(1 - r));
    const adjFeeAPY  = pool.dllamaAPY * (C / pool.cAvg);
    const E_T        = Math.max(0.5, (0.70 * r / (σ || 0.001)) ** 2);
    const mpy        = 365 / E_T;
    const gasPerYear = mpy * GAS_PER_MIGRATION;
    const lvrAPY     = C * σ ** 2 * 365 / 8 * 100;
    const netAPY     = adjFeeAPY - lvrAPY - (gasPerYear / Math.max(capitalUSD, 0.01)) * 100;

    
    if (netAPY > 0) widestViable = { rangePct: rPct, netAPY };

    
    const annualProfit = (netAPY / 100) * capitalUSD;
    const gasOk = annualProfit > 0 && gasPerYear <= MAX_GAS_FRACTION_OF_PROFIT * annualProfit;
    if (gasOk && netAPY > 0 && (!bestRange || netAPY > bestRange.netAPY)) {
      bestRange = { rangePct: rPct, netAPY };
    }
  }

  
  
  const chosen = bestRange ?? widestViable ?? { rangePct: 50, netAPY: 0 };
  return { rangePct: chosen.rangePct, netAPY: chosen.netAPY, viable: bestRange !== null };
}
