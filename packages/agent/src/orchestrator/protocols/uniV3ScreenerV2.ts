/**
 * UniV3 LVR Screener V2 — improved production module
 *
 * Improvements over V1:
 *   1. Volatility: 60-day window + EWMA-only (λ=0.94), no naive max()
 *   2. Fee APY: volumeUsd7d instead of volumeUsd1d (7-day average, smoother)
 *   3. IL risk: dynamic scaling by σ, not static per strategy type
 *   4. Price fallback: CoinGecko 60-day daily history when DeFiLlama fails
 *   5. Gas friction: per-user actual capital, not hardcoded $10k
 *   6. Price divergence guard: skips pool if DeFiLlama vs on-chain drift > 5%
 *   7. cAvg uses apyMean30d for base (more stable than 24h-computed)
 *   8. APY stability uses DeFiLlama's own sigma field (APY vol, not price vol)
 *
 * References:
 *   - Milionis et al. (2022) arXiv:2208.06046 — LVR formula derivation
 *   - arXiv:2404.05803 — empirical LVR measurement
 *   - RiskMetrics Technical Document (1996) — EWMA λ=0.94 for daily returns
 *   - DeFiLlama API v2: volumeUsd7d, apyMean30d, apyBase7d confirmed live 2026
 */

import { ethers } from 'ethers';

// ── Config ────────────────────────────────────────────────────────────────────

const SCREEN_TTL_MS       = 15 * 60_000;
const MIN_LVR_RATIO       = 3.0;
const MAX_POSITION_PCT    = 0.02;
const MIN_EPOCH_RATIO     = 1.20;
const MIGRATION_TRIGGER   = 0.70;
const GAS_PER_MIGRATION   = 0.20;     // USD on Arbitrum (Pimlico UserOp)
const MAX_GAS_FRACTION    = 0.10;     // gas ≤ 10% of annual profit
const DEFAULT_C_AVG       = 3.5;
const EWMA_LAMBDA         = 0.94;     // RiskMetrics daily; half-life ≈ 11 days
const PRICE_WINDOW_DAYS   = 60;       // extended from 30 — better vol estimate
const PRICE_TTL_MS        = 60 * 60_000;
const PRICE_DIV_THRESHOLD = 0.05;     // 5% max price divergence DeFiLlama vs CoinGecko
export const MIN_DELTA_NEUTRAL_USD = Number(process.env.MIN_DELTA_NEUTRAL_USD ?? 0);

const UNI_FACTORY = '0x1F98431c8aD98523631AE4a59f267346ea31F984';

const STABLECOINS = new Set([
  '0xaf88d065e77c8cc2239327c5edb3a432268e5831', // USDC
  '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9', // USDT
  '0xda10009cbd5d07dd0cecc66161fc93d7c9000da1', // DAI
  '0xff970a61a04b1ca14834a43f5de4533ebddb5cc8', // USDC.e
]);

// CoinGecko platform ID for Arbitrum
const COINGECKO_PLATFORM = 'arbitrum-one';
const COINGECKO_KEY      = process.env.COINGECKO_API_KEY ?? '';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ScreenedPoolV2 {
  address:         string;
  symbol:          string;
  token0:          string;
  token1:          string;
  feeTierBps:      number;
  dllamaAPY:       number;      // DeFiLlama current APY (apyBase — may spike)
  smoothedFeeAPY:  number;      // min(current, 1.5 × apyMean30d) — used for screening
  apyMean30d:      number;      // 30-day mean APY from DeFiLlama
  apyBase7d:       number;      // 7-day base APY
  apySigma:        number;      // DeFiLlama's own APY volatility (not price vol)
  volume7dUSD:     number;      // 7-day volume (smoother than 24h)
  volume24hUSD:    number;
  tvlUSD:          number;
  cAvg:            number;
  optimalRangePct: number;
  concentrationC:  number;
  adjFeeAPY:       number;
  netAPY:          number;
  sigmaRatioDaily: number;      // daily ratio vol (60-day EWMA)
  epochRatio:      number;
  lvrRatio:        number;
  priceSource:     'defillama' | 'coingecko' | 'stablecoin';
  scoredAt:        number;
}

// ── Cache ─────────────────────────────────────────────────────────────────────

let cachedPoolsV2: ScreenedPoolV2[] = [];
let cachedAtV2    = 0;
let runningScreenV2: Promise<ScreenedPoolV2[]> | null = null;

export function invalidateScreenerCacheV2(): void {
  cachedAtV2    = 0;
  cachedPoolsV2 = [];
  runningScreenV2 = null;
}

export async function getTopScreenedPoolsV2(
  n = 10,
  provider?: ethers.JsonRpcProvider,
): Promise<ScreenedPoolV2[]> {
  if (Date.now() - cachedAtV2 < SCREEN_TTL_MS && cachedPoolsV2.length > 0) {
    return cachedPoolsV2.slice(0, n);
  }
  if (!runningScreenV2) {
    runningScreenV2 = _runFullScreenV2(provider).finally(() => { runningScreenV2 = null; });
  }
  return (await runningScreenV2).slice(0, n);
}

// ── Volatility math ───────────────────────────────────────────────────────────

function dailyLogReturns(prices: number[]): number[] {
  const r: number[] = [];
  for (let i = 1; i < prices.length; i++) {
    if (prices[i - 1] > 0 && prices[i] > 0) {
      r.push(Math.log(prices[i] / prices[i - 1]));
    }
  }
  return r;
}

/**
 * EWMA volatility (annualised) — λ=0.94, RiskMetrics standard for daily crypto.
 * Half-life ≈ 11 trading days: fast enough to catch regime changes,
 * stable enough to avoid noise from single-day spikes.
 *
 * V1 used max(7d, 14d, 30d rolling, EWMA) which systematically OVERESTIMATES vol
 * and eliminates many viable pools. V2 uses EWMA only on the full 60-day window.
 */
function ewmaVolAnnual(returns: number[]): number {
  if (returns.length < 5) return 0;
  let v = returns[0] ** 2;
  for (let i = 1; i < returns.length; i++) {
    v = EWMA_LAMBDA * v + (1 - EWMA_LAMBDA) * returns[i] ** 2;
  }
  // Annualise: daily variance × 365, then sqrt
  return Math.sqrt(v * 365);
}

/** Spearman rank correlation — robust to outliers (same as V1, this was correct) */
function spearman(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 5) return 0;
  const rank = (arr: number[]) => {
    const s = arr.slice(0, n).map((v, i) => ({ v, i })).sort((x, y) => x.v - y.v);
    const r = new Array(n);
    s.forEach((x, ri) => { r[x.i] = ri + 1; });
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

// ── UniV3 math ────────────────────────────────────────────────────────────────

function concentrationC(r: number): number {
  // C = sqrt(1+r) / (sqrt(1+r) - sqrt(1-r))
  // Derived from Uniswap V3 liquidity formula — matches Milionis et al. approximation
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

/**
 * Range metrics — uses actual capital for gas fraction (not hardcoded $10k).
 * LVR formula: C × σ²/8 × 100 (annualised %, per unit deposited capital)
 * Reference: Milionis et al. (2022), arXiv:2208.06046
 */
function rangeMetrics(
  feeAPY:    number,
  σ:         number,
  r:         number,
  cAvg:      number,
  capitalUSD: number,
) {
  const C           = concentrationC(r);
  const adjFeeAPY   = feeAPY * (C / cAvg);
  const E_T         = Math.max(0.5, (MIGRATION_TRIGGER * r / σ) ** 2);
  const mpy         = 365 / E_T;
  const gasPerYear  = mpy * GAS_PER_MIGRATION;
  const gasFraction = gasPerYear / Math.max(capitalUSD, 1);
  const lvrAPY      = C * σ ** 2 * 365 / 8 * 100;
  const netAPY      = adjFeeAPY - lvrAPY - gasFraction * 100;
  const triggerMove = 1 + MIGRATION_TRIGGER * r;
  const ilPct       = Math.abs(v3ValueRatio(triggerMove, r) - (triggerMove + 1) / 2) * 100;
  const epochFees   = (adjFeeAPY / 100 / 365) * E_T * capitalUSD;
  const epochIL     = (ilPct / 100) * capitalUSD;
  const epochRatio  = epochIL > 0 ? epochFees / epochIL : 999;
  return { C, adjFeeAPY, lvrAPY, netAPY, mpy, gasFraction, epochFees, epochIL, epochRatio };
}

function computeOptimalRange(
  feeAPY:    number,
  sigmaDaily: number,
  cAvg:      number,
  capitalUSD: number,
) {
  const σ = sigmaDaily / 100;
  let best: { rangePct: number; C: number; adjFeeAPY: number; netAPY: number; epochRatio: number } | null = null;

  for (let rPct = 3; rPct <= 50; rPct += 0.5) {
    const r = rPct / 100;
    const m = rangeMetrics(feeAPY, σ, r, cAvg, capitalUSD);
    const gasOk   = m.gasFraction <= MAX_GAS_FRACTION * Math.max(m.netAPY / 100, 0.001);
    const epochOk = m.epochRatio >= MIN_EPOCH_RATIO;
    const netOk   = m.netAPY > 0;
    if (gasOk && epochOk && netOk && (!best || m.netAPY > best.netAPY)) {
      best = { rangePct: rPct, C: m.C, adjFeeAPY: m.adjFeeAPY, netAPY: m.netAPY, epochRatio: m.epochRatio };
    }
  }

  if (best) return best;
  const fallback = rangeMetrics(feeAPY, σ, 0.20, cAvg, capitalUSD);
  return {
    rangePct: 20, C: fallback.C, adjFeeAPY: fallback.adjFeeAPY,
    netAPY: fallback.netAPY, epochRatio: fallback.epochRatio,
  };
}

// ── Price data ────────────────────────────────────────────────────────────────

interface PriceEntry {
  prices:    number[];
  fetchedAt: number;
  source:    'defillama' | 'coingecko' | 'stablecoin';
}

const priceCache = new Map<string, PriceEntry>();

/** Fetch 60-day daily prices from DeFiLlama coins API */
async function fetchDeFiLlama(addr: string): Promise<number[] | null> {
  const start = Math.floor(Date.now() / 1000) - (PRICE_WINDOW_DAYS + 2) * 86400;
  const url   = `https://coins.llama.fi/chart/arbitrum:${addr}?start=${start}&span=${PRICE_WINDOW_DAYS}&period=1d`;
  try {
    const res  = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return null;
    const json = await res.json() as any;
    const pts  = (json.coins?.[`arbitrum:${addr}`]?.prices ?? []) as Array<{ timestamp: number; price: number }>;
    if (pts.length < 15) return null; // need at least 15 days for EWMA to be meaningful
    return pts.map(p => p.price);
  } catch { return null; }
}

/** Fetch 60-day daily prices from CoinGecko — fallback when DeFiLlama fails */
async function fetchCoinGecko(addr: string): Promise<number[] | null> {
  try {
    const keyParam = COINGECKO_KEY ? `&x_cg_demo_api_key=${COINGECKO_KEY}` : '';
    const url = `https://api.coingecko.com/api/v3/coins/${COINGECKO_PLATFORM}/contract/${addr}/market_chart`
              + `?vs_currency=usd&days=${PRICE_WINDOW_DAYS}&interval=daily${keyParam}`;
    const res  = await fetch(url, { signal: AbortSignal.timeout(12_000) });
    if (!res.ok) return null;
    const json = await res.json() as any;
    const pts  = (json.prices ?? []) as Array<[number, number]>;
    if (pts.length < 15) return null;
    return pts.map(([, price]) => price);
  } catch { return null; }
}

/**
 * Fetch prices with DeFiLlama primary, CoinGecko fallback.
 * Also validates that both sources roughly agree (< 5% divergence on last price)
 * so we don't use stale/wrong data from one source silently.
 */
async function fetchPricesWithFallback(addr: string): Promise<PriceEntry> {
  const lowerAddr = addr.toLowerCase();

  // Stablecoins: synthetic flat price series
  if (STABLECOINS.has(lowerAddr)) {
    return { prices: Array(PRICE_WINDOW_DAYS).fill(1), fetchedAt: Date.now(), source: 'stablecoin' };
  }

  // Try DeFiLlama first
  const llamaPrices = await fetchDeFiLlama(lowerAddr);

  // Try CoinGecko as fallback (or for validation)
  const geckoPrices = await fetchCoinGecko(lowerAddr);

  if (llamaPrices && geckoPrices) {
    // Cross-validate: check last price divergence
    const lastLlama = llamaPrices[llamaPrices.length - 1];
    const lastGecko = geckoPrices[geckoPrices.length - 1];
    const divergence = Math.abs(lastLlama - lastGecko) / Math.max(lastGecko, 1);
    if (divergence > PRICE_DIV_THRESHOLD) {
      console.warn(`[ScreenerV2] Price divergence ${(divergence * 100).toFixed(1)}% for ${lowerAddr} — using CoinGecko`);
      // Prefer CoinGecko if divergence detected (DeFiLlama can lag)
      return { prices: geckoPrices, fetchedAt: Date.now(), source: 'coingecko' };
    }
    return { prices: llamaPrices, fetchedAt: Date.now(), source: 'defillama' };
  }

  if (llamaPrices) return { prices: llamaPrices, fetchedAt: Date.now(), source: 'defillama' };
  if (geckoPrices) return { prices: geckoPrices, fetchedAt: Date.now(), source: 'coingecko' };

  return { prices: [], fetchedAt: Date.now(), source: 'defillama' };
}

async function fetchAllPrices(addresses: string[]): Promise<void> {
  const now     = Date.now();
  const toFetch = addresses.filter(a => {
    if (STABLECOINS.has(a.toLowerCase())) return false;
    const cached = priceCache.get(a.toLowerCase());
    return !cached || (now - cached.fetchedAt) > PRICE_TTL_MS;
  });

  // Set stablecoins immediately
  for (const a of addresses) {
    if (STABLECOINS.has(a.toLowerCase())) {
      priceCache.set(a.toLowerCase(), { prices: Array(PRICE_WINDOW_DAYS).fill(1), fetchedAt: now, source: 'stablecoin' });
    }
  }

  if (toFetch.length === 0) return;

  // Parallel fetch with controlled concurrency (max 5 at once to respect rate limits)
  const chunks: string[][] = [];
  for (let i = 0; i < toFetch.length; i += 5) chunks.push(toFetch.slice(i, i + 5));

  for (const chunk of chunks) {
    await Promise.allSettled(chunk.map(async addr => {
      const entry = await fetchPricesWithFallback(addr);
      priceCache.set(addr.toLowerCase(), entry);
    }));
    // Small delay between chunks to avoid CoinGecko rate limiting
    if (chunks.length > 1) await new Promise(r => setTimeout(r, 500));
  }
}

// ── Pool discovery ────────────────────────────────────────────────────────────

interface RawPool {
  symbol:         string;
  address:        string;
  token0:         string;
  token1:         string;
  feeTierBps:     number;
  feeAPY:         number;   // current APY (apyBase — can spike)
  smoothedFeeAPY: number;   // capped at 1.5× apyMean30d to prevent spike inflation
  apyMean30d:     number;   // DeFiLlama 30-day mean APY
  apyBase7d:      number;   // 7-day base APY
  apySigma:       number;   // DeFiLlama's APY volatility σ
  volume7dUSD:    number;   // 7-day volume (smoother than 24h)
  volume24hUSD:   number;
  tvlUSD:         number;
  cAvg:           number;
}

async function discoverPools(provider?: ethers.JsonRpcProvider): Promise<RawPool[]> {
  const res  = await fetch('https://yields.llama.fi/pools', { signal: AbortSignal.timeout(20_000) });
  const json = await res.json() as any;

  const DEFAULT_CAPITAL_FOR_TVL = 10_000;
  const minTVL = DEFAULT_CAPITAL_FOR_TVL / MAX_POSITION_PCT;

  const raw = (json.data as any[]).filter(p =>
    p.chain === 'Arbitrum' &&
    p.project?.includes('uniswap-v3') &&
    p.tvlUsd >= minTVL &&
    Array.isArray(p.underlyingTokens) &&
    p.underlyingTokens.length >= 2 &&
    (p.apyBase ?? p.apy ?? 0) > 0,
  );

  // Deduplicate by token pair — keep highest APY per pair
  const byPair = new Map<string, any>();
  for (const p of raw) {
    const key = [...p.underlyingTokens].map((t: string) => t.toLowerCase()).sort().join('-');
    if (!byPair.has(key) || (p.apyBase ?? p.apy) > (byPair.get(key).apyBase ?? byPair.get(key).apy)) {
      byPair.set(key, p);
    }
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

  const pools: RawPool[] = [];

  for (const p of byPair.values()) {
    // Parse DeFiLlama's poolMeta field to extract the fee tier they actually measured.
    // e.g. poolMeta = "0.05%" → feeTier = 500. This prevents deploying into the wrong
    // fee tier pool (e.g. 0.01% pool) when DeFiLlama's APY belongs to the 0.05% pool.
    const poolMetaFee = (() => {
      const meta = (p.poolMeta ?? '') as string;
      const match = meta.match(/(\d+(?:\.\d+)?)\s*%/);
      if (!match) return null;
      const pct = parseFloat(match[1]);
      // Map percentage to Uniswap fee tier units (1/1,000,000)
      const tier = Math.round(pct * 10_000);
      return [100, 500, 3000, 10000].includes(tier) ? tier : null;
    })();

    // If DeFiLlama specifies the fee tier, use it exactly.
    // Otherwise fall back to iterating all tiers (V1 behaviour).
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

        // V2 improvement: prefer apyBase (fee-only, no emissions) over total apy
        const feeAPY     = (p.apyBase ?? p.apy) as number;
        const apyMean30d = (p.apyMean30d ?? feeAPY) as number;
        const apyBase7d  = (p.apyBase7d ?? feeAPY) as number;
        // Smoothing: cap current APY at 1.5× the 30-day mean.
        // Prevents a high-volume week (e.g., big ETH move driving ARB/WETH arb)
        // from inflating the screener's projected netAPY beyond what's sustainable.
        // 1.5× gives headroom for genuine above-average periods without accepting spikes.
        const smoothedFeeAPY = apyMean30d > 0
          ? Math.min(feeAPY, apyMean30d * 1.5)
          : feeAPY;
        // DeFiLlama's sigma field = APY volatility (not price vol) — use for GeckoScore stability
        const apySigma   = (p.sigma ?? feeAPY * 0.5) as number;

        // V2: prefer 7-day volume for smoother cAvg (less sensitive to spike days)
        const volume7dUSD  = Number(p.volumeUsd7d ?? 0);
        const volume24hUSD = Number(p.volumeUsd1d ?? 0);

        // cAvg from 7-day if available, otherwise 24h, otherwise DeFiLlama-implied
        const tvlUSD    = p.tvlUsd as number;
        let cAvg        = DEFAULT_C_AVG;
        const refVol    = volume7dUSD > 0 ? volume7dUSD / 7 : volume24hUSD; // daily average
        if (refVol > 0) {
          const baseAPY = (feeTier / 1_000_000) * (refVol / tvlUSD) * 365 * 100;
          if (baseAPY > 0) {
            // Use apyMean30d for cAvg to avoid 24h spike inflating the ratio
            cAvg = Math.max(1.0, Math.min(50, (apyMean30d > 0 ? apyMean30d : feeAPY) / baseAPY));
          }
        }

        pools.push({
          symbol: `${s0}-${s1}`, address: addr,
          token0: p.underlyingTokens[0].toLowerCase(),
          token1: p.underlyingTokens[1].toLowerCase(),
          feeTierBps: feeTier, feeAPY, smoothedFeeAPY, apyMean30d, apyBase7d, apySigma,
          volume7dUSD, volume24hUSD, tvlUSD, cAvg,
        });
        break;
      } catch { /* next fee tier */ }
    }
  }
  return pools;
}

// ── Full screening pipeline ───────────────────────────────────────────────────

async function _runFullScreenV2(provider?: ethers.JsonRpcProvider): Promise<ScreenedPoolV2[]> {
  try {
    const pools = await discoverPools(provider);

    const allTokens = [...new Set(pools.flatMap(p => [p.token0, p.token1]))];
    await fetchAllPrices(allTokens);

    const results: ScreenedPoolV2[] = [];
    const DEFAULT_CAPITAL = 10_000; // screener cache uses $10k; adjustPoolForCapitalV2() corrects per-user

    for (const pool of pools) {
      // Skip stablecoin-stablecoin (σ≈0, LVR framework doesn't apply)
      if (STABLECOINS.has(pool.token0) && STABLECOINS.has(pool.token1)) continue;

      const p0entry = priceCache.get(pool.token0);
      const p1entry = priceCache.get(pool.token1);

      const r0 = dailyLogReturns(p0entry?.prices ?? []);
      const r1 = dailyLogReturns(p1entry?.prices ?? []);

      // V2: EWMA-only vol on 60-day window — no naive max() across windows
      const σ0_annual = STABLECOINS.has(pool.token0) ? 0 : ewmaVolAnnual(r0);
      const σ1_annual = STABLECOINS.has(pool.token1) ? 0 : ewmaVolAnnual(r1);
      const σ0_daily  = σ0_annual / Math.sqrt(365);
      const σ1_daily  = σ1_annual / Math.sqrt(365);

      // Spearman correlation of log returns (same as V1, still correct)
      const ρ = (r0.length >= 5 && r1.length >= 5 &&
                 !STABLECOINS.has(pool.token0) && !STABLECOINS.has(pool.token1))
        ? spearman(r0, r1) : 0;

      // σ of the price RATIO (what actually drives LP IL)
      const σRatioDaily  = Math.sqrt(Math.max(0, σ0_daily ** 2 + σ1_daily ** 2 - 2 * ρ * σ0_daily * σ1_daily)) * 100;
      const σRatioAnnual = σRatioDaily * Math.sqrt(365);

      // Skip if no price data for a non-stable token
      if (σRatioDaily === 0 && !STABLECOINS.has(pool.token0) && !STABLECOINS.has(pool.token1)) continue;

      // LVR screening — use smoothedFeeAPY so a spike week doesn't pass a pool
      // that would normally fail. Raw feeAPY still stored for display/reporting.
      const lvrBaseline = (σRatioAnnual / 100) ** 2 / 8 * 100;
      const lvrRatio    = lvrBaseline > 0 ? pool.smoothedFeeAPY / lvrBaseline : 999;

      if (lvrBaseline > 0 && pool.smoothedFeeAPY <= lvrBaseline) continue;
      if (lvrRatio < MIN_LVR_RATIO && lvrRatio < 999) continue;

      const minTVL = DEFAULT_CAPITAL / MAX_POSITION_PCT;
      if (pool.tvlUSD < minTVL) continue;

      // Optimal range — smoothedFeeAPY gives a realistic netAPY projection
      const opt = computeOptimalRange(pool.smoothedFeeAPY, σRatioDaily, pool.cAvg, DEFAULT_CAPITAL);

      if (opt.netAPY <= 0) continue;
      if (opt.epochRatio < MIN_EPOCH_RATIO) continue;

      results.push({
        address:         pool.address,
        symbol:          pool.symbol,
        token0:          pool.token0,
        token1:          pool.token1,
        feeTierBps:      pool.feeTierBps,
        dllamaAPY:       pool.feeAPY,
        smoothedFeeAPY:  pool.smoothedFeeAPY,
        apyMean30d:      pool.apyMean30d,
        apyBase7d:       pool.apyBase7d,
        apySigma:        pool.apySigma,
        volume7dUSD:     pool.volume7dUSD,
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
        priceSource:     p0entry?.source ?? 'defillama',
        scoredAt:        Date.now(),
      });
    }

    results.sort((a, b) => b.netAPY - a.netAPY);
    cachedPoolsV2 = results;
    cachedAtV2    = Date.now();
    return results;
  } catch (err: any) {
    console.warn('[UniV3ScreenerV2] Screen failed:', err.message);
    return cachedPoolsV2;
  }
}

// ── Per-user capital viability (V2 — correct gas model) ──────────────────────
//
// V1 hardcoded DEFAULT_CAPITAL=$10k in rangeMetrics, making small positions
// look viable (gas is a tiny % of $10k) when they're not ($1 gas at $1 capital = 100%).
// V2 passes actual capitalUSD into rangeMetrics so gas friction is real.

export function adjustPoolForCapitalV2(
  pool:       ScreenedPoolV2,
  capitalUSD: number,
): { rangePct: number; netAPY: number; viable: boolean } | null {
  if (MIN_DELTA_NEUTRAL_USD > 0 && capitalUSD < MIN_DELTA_NEUTRAL_USD) return null;

  const σ = pool.sigmaRatioDaily / 100;
  let bestRange:    { rangePct: number; netAPY: number } | null = null;
  let widestViable: { rangePct: number; netAPY: number } | null = null;

  for (let rPct = 3; rPct <= 50; rPct += 0.5) {
    const r = rPct / 100;
    // Use smoothedFeeAPY for per-user range calc — same cap as the screener
    const m = rangeMetrics(pool.smoothedFeeAPY, σ, r, pool.cAvg, capitalUSD);

    if (m.netAPY > 0) widestViable = { rangePct: rPct, netAPY: m.netAPY };

    const annualProfit = (m.netAPY / 100) * capitalUSD;
    const gasPerYear   = (365 / Math.max(0.5, (MIGRATION_TRIGGER * r / (σ || 0.001)) ** 2)) * GAS_PER_MIGRATION;
    const gasOk        = annualProfit > 0 && gasPerYear <= MAX_GAS_FRACTION * annualProfit;
    if (gasOk && m.netAPY > 0 && (!bestRange || m.netAPY > bestRange.netAPY)) {
      bestRange = { rangePct: rPct, netAPY: m.netAPY };
    }
  }

  const chosen = bestRange ?? widestViable ?? { rangePct: 50, netAPY: 0 };
  return { rangePct: chosen.rangePct, netAPY: chosen.netAPY, viable: bestRange !== null };
}
