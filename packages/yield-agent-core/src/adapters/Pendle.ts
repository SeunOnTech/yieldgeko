import { IProtocolAdapter, AdapterContext, mkRisk, GAS_PCT } from './types';
import { RankedOpportunity } from '../types/market';
import { IntelligencePolicy, TIER_RANK } from '../types/policy';

interface PendleMarket {
  address:          string;
  expiry:           string;
  impliedApy:       number;
  liquidity:        { usd: number };
  pt:               { address: string; symbol: string };
  yt:               { address: string; symbol: string };
  underlyingAsset:  { symbol: string };
}

let _pendleCache: PendleMarket[]   = [];
let _pendleFetched = 0;
const PENDLE_TTL = 15 * 60_000;

async function fetchPendleMarkets(chainId = 42161, limit = 10): Promise<PendleMarket[]> {
  if (Date.now() - _pendleFetched < PENDLE_TTL && _pendleCache.length > 0) return _pendleCache;
  try {
    const url  = `https://api-v2.pendle.finance/core/v1/${chainId}/markets?limit=${limit}&is_active=true`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(8_000) });
    if (!resp.ok) return _pendleCache;
    const data = await resp.json() as { results?: PendleMarket[] };
    _pendleCache  = (data.results ?? []).filter(m => m.liquidity?.usd >= 200_000);
    _pendleFetched = Date.now();
    return _pendleCache;
  } catch { return _pendleCache; }
}

export class PendleAdapter implements IProtocolAdapter {
  id       = 'pendle';
  protocol = 'pendle';
  chain    = 'arbitrum';

  async build(policy: IntelligencePolicy, _ctx: AdapterContext): Promise<RankedOpportunity[]> {
    const markets = await fetchPendleMarkets();
    if (markets.length === 0) return [];

    const results: RankedOpportunity[] = [];
    const nowSec = Math.floor(Date.now() / 1000);

    for (const m of markets) {
      const maturityDate = Math.floor(new Date(m.expiry).getTime() / 1_000);
      if (maturityDate - nowSec < 7 * 24 * 3600) continue;

      const grossAPY = m.impliedApy * 100;
      const sym      = `PT-${m.underlyingAsset.symbol}-${new Date(m.expiry).toLocaleDateString('en-US', { month: 'short', year: '2-digit' })}`;
      const base     = { address: m.pt.address, symbol: m.underlyingAsset.symbol, decimals: 18, chainId: 'arbitrum' as const };
      const ptCosts  = { fundingAnnual: 0, executionPct: 0.05, gasAnnual: GAS_PCT, oiPenalty: 0 };
      const lpCosts  = { fundingAnnual: 0, executionPct: 0.10, gasAnnual: GAS_PCT + 1.0, oiPenalty: 0 };
      const common   = { address: m.address, chain: 'arbitrum' as const, llamaPoolId: m.address, verifiedOnChain: false, updatedAt: Date.now(), maturityDate, ytAddress: m.yt.address, ptAddress: m.pt.address, history: { apy7d: null, apy30d: null, trend: 'stable' as const, sigma: null } };

      
      results.push({
        ...common,
        id: `pendle-pt-${m.address.slice(2, 10)}`,
        protocol: 'Pendle', strategyType: 'PENDLE_PT',
        tokens: { base }, metrics: { apyBase: grossAPY, apyReward: 0, totalAPY: grossAPY, tvlUSD: m.liquidity.usd, volume24hUSD: 0, sigma: null, apy7d: null, apy30d: null },
        grossAPY, realYieldAPY: grossAPY, emissionFraction: 0,
        netAPY: Math.max(0, grossAPY - ptCosts.executionPct - ptCosts.gasAnnual),
        geckoScore: 0, costs: ptCosts, risk: mkRisk({ counterpartyRisk: 'low' }), minTier: 'conservative',
      });

      
      const lpAPY = grossAPY * 0.30;
      results.push({
        ...common,
        id: `pendle-lp-${m.address.slice(2, 10)}`,
        protocol: 'Pendle LP', strategyType: 'PENDLE_LP',
        tokens: { base }, metrics: { apyBase: lpAPY, apyReward: 0, totalAPY: lpAPY, tvlUSD: m.liquidity.usd, volume24hUSD: 0, sigma: null, apy7d: null, apy30d: null },
        grossAPY: lpAPY, realYieldAPY: lpAPY, emissionFraction: 0,
        netAPY: Math.max(0, lpAPY - lpCosts.executionPct - lpCosts.gasAnnual),
        geckoScore: 0, costs: lpCosts, risk: mkRisk({ counterpartyRisk: 'low', ilRisk: true }), minTier: 'balanced',
      });

      
      const ytAPY = grossAPY * 3;
      results.push({
        ...common,
        id: `pendle-yt-${m.address.slice(2, 10)}`,
        protocol: 'Pendle YT', strategyType: 'PENDLE_YT',
        tokens: { base: { ...base, symbol: `YT-${m.underlyingAsset.symbol}` } },
        metrics: { apyBase: ytAPY, apyReward: 0, totalAPY: ytAPY, tvlUSD: m.liquidity.usd, volume24hUSD: 0, sigma: null, apy7d: null, apy30d: null },
        grossAPY: ytAPY, realYieldAPY: ytAPY, emissionFraction: 0,
        netAPY: Math.max(0, ytAPY - lpCosts.executionPct - lpCosts.gasAnnual),
        geckoScore: 0, costs: lpCosts, risk: mkRisk({ counterpartyRisk: 'low' }), minTier: 'advanced',
      });
    }

    return results;
  }
}
