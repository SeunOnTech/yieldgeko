import { JsonRpcProvider } from 'ethers';
import type { Opportunity, RiskTier, OpportunityCosts, OpportunityRisk, Trend } from './types';
import type { OnChainSnapshot } from './protocols';
import { computeGeckoScore, applyTierMultiplier, computeRealYieldAPY } from './gecko-scorer';
import { getTopScreenedPools } from './protocols/uniV3Screener';

const TIER_RANK: Record<RiskTier, number> = {
  conservative: 0, balanced: 1, aggressive: 2, advanced: 3,
};
const GAS_PCT = (4 * 12 * 0.15 / 10_000) * 100;

const HEDGE_ASSET: Record<string, string> = {
  ETH: 'WETH', WETH: 'WETH', BTC: 'WBTC', WBTC: 'WBTC', ARB: 'ARB',
};

interface LlamaPool {
  chain: string; project: string; symbol: string; tvlUsd: number;
  apyBase: number | null; apyReward: number | null; apy: number;
  rewardTokens: string[] | null; pool: string;
  apyBase7d: number | null; apyMean30d: number | null;
  volumeUsd7d: number | null; poolMeta: string | null;
  stablecoin: boolean; ilRisk: string | null;
  mu: number | null; sigma: number | null;
  underlyingTokens: string[] | null;
}

async function fetchLlamaPools(): Promise<LlamaPool[]> {
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12_000);
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch('https://yields.llama.fi/pools', { signal: ctrl.signal });
      clearTimeout(timer);
      if (!res.ok) continue;
      const data = await res.json() as { data: LlamaPool[] };
      return data.data?.filter(p => p.chain === 'Arbitrum' && p.apy > 0 && p.apy < 10_000) ?? [];
    } catch { if (i < 2) await new Promise(r => setTimeout(r, 700 * (i + 1))); }
  }
  clearTimeout(timer);
  return [];
}

async function fetchFundingRates(): Promise<Map<string, number>> {
  const rates = new Map<string, number>();
  try {
    const ctrl  = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8_000);
    const res   = await fetch('https://backend-arbitrum.gains.trade/trading-variables', { signal: ctrl.signal });
    clearTimeout(timer);
    if (res.ok) {
      const data = await res.json() as any;
      for (const pair of (data?.pairs ?? [])) {
        const from = (pair.from ?? '').toUpperCase();
        const annual = (Number(pair.fundingFee ?? 0) / 1e10) * 4 * 3600 * 24 * 365 * 100;
        if (from === 'ETH') rates.set('WETH', annual);
        if (from === 'BTC') rates.set('WBTC', annual);
        if (from === 'ARB') rates.set('ARB',  annual);
      }
    }
  } catch {  }
  if (!rates.has('WETH')) rates.set('WETH', 6.5);
  if (!rates.has('WBTC')) rates.set('WBTC', 7.0);
  if (!rates.has('ARB'))  rates.set('ARB',  9.0);
  return rates;
}

function calcTrend(now: number, d7: number | null, d30: number | null): Trend {
  const ref = d7 ?? d30;
  if (!ref || ref === 0) return 'unknown';
  const delta = (now - ref) / ref;
  if (delta > 0.05) return 'rising';
  if (delta < -0.05) return 'falling';
  return 'stable';
}

function mkRisk(overrides: Partial<OpportunityRisk> = {}): OpportunityRisk {
  return {
    counterpartyRisk: 'low', ilRisk: false, liquidationRisk: false,
    rebalanceNeeded: false, oiBalance: null, oiRiskFlag: false,
    ...overrides,
  } as any;
}

function emissionFraction(pool: LlamaPool): number {
  const reward = pool.apyReward ?? 0;
  const total  = pool.apy;
  if (total <= 0) return 0;
  return reward > 0 ? Math.min(reward / total, 0.8) : 0;
}

function buildGMXOpps(pools: LlamaPool[], oc: OnChainSnapshot): Opportunity[] {
  return pools
    .filter(p => p.project.toLowerCase().includes('gmx') && p.tvlUsd >= 500_000)
    .slice(0, 8)
    .map((p, i): Opportunity => {
      const sym       = p.symbol.toUpperCase();
      const mktData   = oc.gmxMarkets.find(m => sym.includes(m.name.split('/')[0]));
      const grossAPY  = (mktData?.feeAPY && mktData.feeAPY > 0) ? mktData.feeAPY : p.apy;
      const oiBal     = mktData?.oiBalance ?? 0.5;
      const oiSkew    = Math.abs(oiBal - 0.5) * 2;
      const oiFlag    = oiSkew > 0.40;
      const emFrac    = 0;  

      const costs: OpportunityCosts = {
        fundingAnnual: 0, executionPct: 0.10, gasAnnual: GAS_PCT,
        oiPenalty: oiSkew * 6,
      };
      const netAPY = Math.max(0, grossAPY - costs.executionPct - costs.gasAnnual - costs.oiPenalty);

      return {
        id: `gmx-${i}`, strategyType: 'GMX_REAL_YIELD',
        protocol: 'GMX V2', pool: p.symbol, asset: mktData?.name ?? sym,
        tvlUSD: mktData?.poolValueUSD ?? p.tvlUsd,
        grossAPY, realYieldAPY: grossAPY, emissionFraction: emFrac, netAPY,
        geckoScore: 0,  
        costs, risk: mkRisk({ counterpartyRisk: oiFlag ? 'medium' : 'low', oiBalance: oiBal, oiRiskFlag: oiFlag }),
        history: { apy7d: p.apyBase7d, apy30d: p.apyMean30d, trend: calcTrend(grossAPY, p.apyBase7d, p.apyMean30d), sigma: p.sigma },
        minTier: 'balanced', verifiedOnChain: mktData !== undefined,
        llamaPoolId: p.pool, address: mktData?.gmToken ?? '', updatedAt: Date.now(),
      };
    });
}

async function buildDeltaNeutralOpps(
  _pools:       LlamaPool[],
  _fundingRates: Map<string, number>,
  provider?:    JsonRpcProvider,
): Promise<Opportunity[]> {
  const screened = await getTopScreenedPools(10, provider);
  if (screened.length === 0) return [];

  return screened.map((sp, i): Opportunity => {
    const costs: OpportunityCosts = {
      fundingAnnual: 0,
      executionPct:  0.10,
      gasAnnual:     GAS_PCT + 1.0,
      oiPenalty:     0,
    };
    return {
      id:              `dn-lvr-${i}`,
      strategyType:    'DELTA_NEUTRAL',
      protocol:        'Uniswap V3 (LVR-screened)',
      pool:            sp.symbol,
      asset:           sp.symbol,
      tvlUSD:          sp.tvlUSD,
      grossAPY:        sp.adjFeeAPY,
      realYieldAPY:    sp.adjFeeAPY,
      emissionFraction: 0,
      netAPY:          sp.netAPY,
      geckoScore:      0,          
      costs,
      risk: mkRisk({ counterpartyRisk: 'low', ilRisk: true, rebalanceNeeded: true }),
      history: { apy7d: null, apy30d: null, trend: 'stable', sigma: sp.sigmaRatioDaily ?? null },
      minTier:         'balanced',
      verifiedOnChain: true,       
      llamaPoolId:     sp.address,
      address:         sp.address,
      updatedAt:       Date.now(),
      
      lvrOptimalRangePct: sp.optimalRangePct,
      lvrConcentrationC:  sp.concentrationC,
      lvrCAvg:            sp.cAvg,
      lvrAdjFeeAPY:       sp.adjFeeAPY,
      lvrNetAPY:          sp.netAPY,
      lvrSigmaDaily:      sp.sigmaRatioDaily,
      lvrEpochRatio:      sp.epochRatio,
      lvrScoredAt:        sp.scoredAt,
    };
  });
}

function buildMorphoOpps(pools: LlamaPool[], _oc: OnChainSnapshot): Opportunity[] {
  return pools
    .filter(p => p.project.toLowerCase().includes('morpho') && p.tvlUsd >= 500_000)
    .slice(0, 4)
    .map((p, i): Opportunity => {
      const sym = p.symbol.toUpperCase();
      const costs: OpportunityCosts = { fundingAnnual: 0, executionPct: 0.03, gasAnnual: GAS_PCT, oiPenalty: 0 };
      const netAPY = Math.max(0, p.apy - costs.executionPct - costs.gasAnnual);

      return {
        id: `morpho-${i}`, strategyType: 'MORPHO_LENDING',
        protocol: 'Morpho', pool: p.symbol, asset: sym,
        tvlUSD: p.tvlUsd, grossAPY: p.apy, realYieldAPY: p.apy,
        emissionFraction: 0, netAPY, geckoScore: 0,
        costs, risk: mkRisk({ counterpartyRisk: 'none' }),
        history: { apy7d: p.apyBase7d, apy30d: p.apyMean30d, trend: calcTrend(p.apy, p.apyBase7d, p.apyMean30d), sigma: p.sigma },
        minTier: 'conservative', verifiedOnChain: false,
        
        llamaPoolId: p.pool, address: p.pool, updatedAt: Date.now(),
      };
    });
}

interface PendleMarket {
  address:        string;
  expiry:         string;          
  impliedApy:     number;          
  liquidity:      { usd: number };
  pt:             { address: string; symbol: string };
  yt:             { address: string; symbol: string };
  underlyingAsset: { symbol: string };
}

async function fetchPendleMarkets(chainId = 42161, limit = 8): Promise<PendleMarket[]> {
  try {
    const url  = `https://api-v2.pendle.finance/core/v1/${chainId}/markets?limit=${limit}&is_active=true`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(8_000) });
    if (!resp.ok) return [];
    const data = await resp.json() as { results?: PendleMarket[] };
    return (data.results ?? []).filter(m => m.liquidity?.usd >= 200_000);
  } catch {
    return [];
  }
}

async function buildPendleOpps(_pools: LlamaPool[]): Promise<Opportunity[]> {
  const markets = await fetchPendleMarkets();
  if (markets.length === 0) return [];

  const results: Opportunity[] = [];
  const nowSec  = Math.floor(Date.now() / 1000);

  for (const m of markets) {
    const maturityDate = Math.floor(new Date(m.expiry).getTime() / 1_000);
    
    if (maturityDate - nowSec < 7 * 24 * 3600) continue;

    const grossAPY  = m.impliedApy * 100;
    const ptCosts: OpportunityCosts = { fundingAnnual: 0, executionPct: 0.05, gasAnnual: GAS_PCT, oiPenalty: 0 };
    const lpCosts: OpportunityCosts = { fundingAnnual: 0, executionPct: 0.10, gasAnnual: GAS_PCT + 1.0, oiPenalty: 0 };

    const symbol = `PT-${m.underlyingAsset.symbol}-${new Date(m.expiry).toLocaleDateString('en-US', { month: 'short', year: '2-digit' })}`;

    
    results.push({
      id:              `pendle-pt-${m.address.slice(2, 10)}`,
      strategyType:    'PENDLE_PT',
      protocol:        'Pendle',
      pool:            symbol,
      asset:           m.underlyingAsset.symbol,
      tvlUSD:          m.liquidity.usd,
      grossAPY,
      realYieldAPY:    grossAPY,   
      emissionFraction: 0,
      netAPY:          Math.max(0, grossAPY - ptCosts.executionPct - ptCosts.gasAnnual),
      geckoScore:      0,
      costs:           ptCosts,
      risk:            mkRisk({ counterpartyRisk: 'low', ilRisk: false }),
      history:         { apy7d: null, apy30d: null, trend: 'stable', sigma: null },
      minTier:         'conservative',
      verifiedOnChain: false,
      llamaPoolId:     m.address,
      address:         m.address,         
      maturityDate,
      ytAddress:       m.yt.address,
      ptAddress:       m.pt.address,      
      updatedAt:       Date.now(),
    });

    
    const lpAPY = grossAPY * 0.3; 
    results.push({
      id:              `pendle-lp-${m.address.slice(2, 10)}`,
      strategyType:    'PENDLE_LP',
      protocol:        'Pendle LP',
      pool:            symbol,
      asset:           m.underlyingAsset.symbol,
      tvlUSD:          m.liquidity.usd,
      grossAPY:        lpAPY,
      realYieldAPY:    lpAPY,
      emissionFraction: 0,
      netAPY:          Math.max(0, lpAPY - lpCosts.executionPct - lpCosts.gasAnnual),
      geckoScore:      0,
      costs:           lpCosts,
      risk:            mkRisk({ counterpartyRisk: 'low', ilRisk: true }),
      history:         { apy7d: null, apy30d: null, trend: 'stable', sigma: null },
      minTier:         'balanced',
      verifiedOnChain: false,
      llamaPoolId:     m.address,
      address:         m.address,
      maturityDate,
      ytAddress:       m.yt.address,
      updatedAt:       Date.now(),
    });

    
    const ytAPY = grossAPY * 3; 
    results.push({
      id:              `pendle-yt-${m.address.slice(2, 10)}`,
      strategyType:    'PENDLE_YT',
      protocol:        'Pendle YT',
      pool:            `YT-${m.underlyingAsset.symbol}`,
      asset:           m.underlyingAsset.symbol,
      tvlUSD:          m.liquidity.usd,
      grossAPY:        ytAPY,
      realYieldAPY:    ytAPY,
      emissionFraction: 0,
      netAPY:          Math.max(0, ytAPY - lpCosts.executionPct - lpCosts.gasAnnual),
      geckoScore:      0,
      costs:           lpCosts,
      risk:            mkRisk({ counterpartyRisk: 'low', ilRisk: false }),
      history:         { apy7d: null, apy30d: null, trend: 'stable', sigma: null },
      minTier:         'advanced',
      verifiedOnChain: false,
      llamaPoolId:     m.address,
      address:         m.address,
      maturityDate,
      ytAddress:       m.yt.address,     
      updatedAt:       Date.now(),
    });
  }

  return results;
}

function buildAaveOpps(pools: LlamaPool[], oc: OnChainSnapshot): Opportunity[] {
  return pools
    .filter(p => p.project.toLowerCase().includes('aave') && p.tvlUsd >= 1_000_000)
    .slice(0, 4)
    .map((p, i): Opportunity => {
      const sym    = p.symbol.toUpperCase();
      const live   = oc.aaveMarkets.find(m => sym.includes(m.symbol));
      const apy    = live?.supplyAPY ?? p.apy;
      const tvl    = live?.liquidityUSD ?? p.tvlUsd;
      const costs: OpportunityCosts = { fundingAnnual: 0, executionPct: 0.05, gasAnnual: GAS_PCT, oiPenalty: 0 };
      const netAPY = Math.max(0, apy - costs.executionPct - costs.gasAnnual);

      return {
        id: `aave-${i}`, strategyType: 'AAVE_LENDING',
        protocol: 'Aave V3', pool: p.symbol, asset: sym,
        tvlUSD: tvl, grossAPY: apy, realYieldAPY: apy, emissionFraction: 0, netAPY, geckoScore: 0,
        costs, risk: mkRisk({ counterpartyRisk: 'none' }),
        history: { apy7d: p.apyBase7d, apy30d: p.apyMean30d, trend: calcTrend(apy, p.apyBase7d, p.apyMean30d), sigma: p.sigma },
        minTier: 'conservative', verifiedOnChain: live !== undefined,
        llamaPoolId: p.pool, address: live?.aTokenAddress ?? '', updatedAt: Date.now(),
      };
    });
}

export interface UniverseResult {
  opportunities: Opportunity[];
  fundingRates:  Map<string, number>;
}

export async function fetchUniverse(
  _provider:  JsonRpcProvider,
  userTier:   RiskTier,
  ocSnapshot: OnChainSnapshot,
): Promise<UniverseResult> {
  const [llamaPools, fundingRates] = await Promise.all([
    fetchLlamaPools(),
    fetchFundingRates(),
  ]);

  const [pendleOpps, deltaNeutralOpps] = await Promise.all([
    buildPendleOpps(llamaPools),
    buildDeltaNeutralOpps(llamaPools, fundingRates, _provider),
  ]);

  const all = [
    ...buildGMXOpps(llamaPools, ocSnapshot),
    ...deltaNeutralOpps,
    ...buildMorphoOpps(llamaPools, ocSnapshot),
    ...pendleOpps,
    ...buildAaveOpps(llamaPools, ocSnapshot),
  ];

  
  const scored = all
    .filter(o => TIER_RANK[o.minTier] <= TIER_RANK[userTier])
    .map(o => ({
      ...o,
      realYieldAPY: computeRealYieldAPY(o),
      geckoScore:   applyTierMultiplier(
        computeGeckoScore(o, [], _provider ? 10_000 : 10_000),
        o.strategyType,
        userTier,
      ),
    }))
    .sort((a, b) => b.geckoScore - a.geckoScore);

  return { opportunities: scored, fundingRates };
}
