import { RawPool, ChainId, StrategyType } from '../types/market';

const LLAMA_URL  = 'https://yields.llama.fi/pools';
const TIMEOUT_MS = 20_000;

const CHAIN_MAP: Record<string, ChainId> = {
  Arbitrum: 'arbitrum', Base: 'base',
  Ethereum: 'ethereum', Optimism: 'optimism', Polygon: 'polygon',
};

interface LlamaPool {
  pool: string; chain: string; project: string; symbol: string;
  tvlUsd: number; apyBase: number | null; apyReward: number | null;
  apy: number; rewardTokens: string[] | null;
  apyBase7d: number | null; apyMean30d: number | null;
  volumeUsd1d: number | null; sigma: number | null;
  underlyingTokens: string[] | null; poolMeta: string | null;
}

function inferStrategy(p: LlamaPool): StrategyType {
  const proj = p.project.toLowerCase();
  if (proj.includes('uniswap-v3') || proj.includes('uniswap-v2')) return 'DELTA_NEUTRAL';
  if (proj.includes('morpho'))                                     return 'MORPHO_LENDING';
  if (proj.includes('pendle'))                                     return 'PENDLE_PT';
  if (proj.includes('gmx'))                                        return 'GMX_REAL_YIELD';
  if (proj.includes('aave'))                                       return 'AAVE_LENDING';
  return 'AAVE_LENDING';
}

function normalize(p: LlamaPool, chain: ChainId): RawPool {
  const tokens = p.underlyingTokens ?? [];
  const syms   = p.symbol.split(/[-/]+/);
  return {
    id:           `${p.project}:${p.pool}:${chain}`,
    address:      p.pool,
    chain,
    protocol:     p.project,
    strategyType: inferStrategy(p),
    tokens: {
      base: {
        address:  (tokens[0] ?? '0x0').toLowerCase(),
        symbol:   syms[0] ?? p.symbol,
        decimals: 18,
        chainId:  chain,
      },
      quote: tokens[1] ? {
        address:  tokens[1].toLowerCase(),
        symbol:   syms[1] ?? syms[0] ?? '',
        decimals: 18,
        chainId:  chain,
      } : undefined,
    },
    metrics: {
      apyBase:     p.apyBase  ?? 0,
      apyReward:   p.apyReward ?? 0,
      totalAPY:    p.apy      ?? 0,
      tvlUSD:      p.tvlUsd   ?? 0,
      volume24hUSD: p.volumeUsd1d ?? 0,
      sigma:       p.sigma,
      apy7d:       p.apyBase7d,
      apy30d:      p.apyMean30d,
    },
    rewardTokens:   p.rewardTokens ?? [],
    verifiedOnChain: !!(tokens[0] && tokens[0] !== '0x0'),
    updatedAt:      Date.now(),
  };
}

let _cache: RawPool[]              = [];
let _fetchedAt                     = 0;
let _running: Promise<RawPool[]> | null = null;
const CACHE_TTL = 10 * 60_000;

export async function fetchLlamaPools(chains?: ChainId[]): Promise<RawPool[]> {
  const now = Date.now();
  if (_cache.length > 0 && now - _fetchedAt < CACHE_TTL) {
    return chains ? _cache.filter(p => chains.includes(p.chain)) : _cache;
  }
  if (_running) return _running.then(all => chains ? all.filter(p => chains.includes(p.chain)) : all);

  _running = (async () => {
    try {
      const ctrl = new AbortController();
      const t    = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
      const res  = await fetch(LLAMA_URL, { signal: ctrl.signal });
      clearTimeout(t);
      if (!res.ok) throw new Error(`DeFiLlama ${res.status}`);
      const { data } = await res.json() as { data: LlamaPool[] };

      _cache = data
        .filter(p => CHAIN_MAP[p.chain] && p.apy > 0 && p.apy < 50_000 && p.tvlUsd >= 50_000)
        .map(p => normalize(p, CHAIN_MAP[p.chain]!));
      _fetchedAt = Date.now();
      console.log(`[DefiLlama] Loaded ${_cache.length} pools`);
      return _cache;
    } finally {
      _running = null;
    }
  })();

  return _running.then(all => chains ? all.filter(p => chains.includes(p.chain)) : all);
}

export function invalidateLlamaCache(): void {
  _cache = []; _fetchedAt = 0; _running = null;
}
