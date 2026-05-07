import { JsonRpcProvider } from 'ethers';
import type { Opportunity, RiskTier, OpportunityCosts, OpportunityRisk, Trend } from './types';
import type { OnChainSnapshot } from './protocols';

// ── Constants ─────────────────────────────────────────────────────────────────

const HEDGE_ASSET: Record<string, string> = {
  ETH: 'WETH', WETH: 'WETH', BTC: 'WBTC', WBTC: 'WBTC', ARB: 'ARB',
};

const TIER_RANK: Record<RiskTier, number> = {
  conservative: 0, balanced: 1, aggressive: 2, advanced: 3,
};

// Gas cost: 4 management txs/month × $0.15 each / $10K position
const GAS_PCT = (4 * 12 * 0.15 / 10_000) * 100;

// ── DeFiLlama ─────────────────────────────────────────────────────────────────

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
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch('https://yields.llama.fi/pools', { signal: ctrl.signal });
      clearTimeout(timer);
      if (!res.ok) continue;
      const data = await res.json() as { data: LlamaPool[] };
      return data.data?.filter(p => p.chain === 'Arbitrum' && p.apy > 0 && p.apy < 10_000) ?? [];
    } catch {
      if (attempt < 2) await new Promise(r => setTimeout(r, 700 * (attempt + 1)));
    }
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
        const perBlock = Number(pair.fundingFee ?? 0) / 1e10;
        const annual   = perBlock * 4 * 3600 * 24 * 365 * 100;
        if (from === 'ETH') rates.set('WETH', annual);
        if (from === 'BTC') rates.set('WBTC', annual);
        if (from === 'ARB') rates.set('ARB',  annual);
      }
    }
  } catch { /* use defaults */ }
  if (!rates.has('WETH')) rates.set('WETH', 6.5);
  if (!rates.has('WBTC')) rates.set('WBTC', 7.0);
  if (!rates.has('ARB'))  rates.set('ARB',  9.0);
  return rates;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function calcTrend(now: number, d7: number | null, d30: number | null): Trend {
  const ref = d7 ?? d30;
  if (!ref || ref === 0) return 'unknown';
  const delta = (now - ref) / ref;
  if (delta > 0.05) return 'rising';
  if (delta < -0.05) return 'falling';
  return 'stable';
}

function tierQualifies(minTier: RiskTier, userTier: RiskTier): boolean {
  return TIER_RANK[minTier] <= TIER_RANK[userTier];
}

// ── Strategy builders ─────────────────────────────────────────────────────────

function buildGMXOpps(
  pools:   LlamaPool[],
  oc:      OnChainSnapshot,
): Opportunity[] {
  return pools
    .filter(p => p.project.toLowerCase().includes('gmx') && p.tvlUsd >= 500_000)
    .slice(0, 8)
    .map((p, i): Opportunity => {
      const sym       = p.symbol.toUpperCase();
      // Match DeFiLlama pool symbol to on-chain GMX market name
      const marketKey = oc.gmxMarkets.find(m =>
        sym.includes(m.name.split('/')[0])
      );
      const oiBal     = marketKey?.oiBalance ?? 0.5;
      const oiSkew    = Math.abs(oiBal - 0.5) * 2;
      const oiFlag    = oiSkew > 0.40;

      // Use on-chain fee APY if available, else DeFiLlama
      const grossAPY  = (marketKey?.feeAPY && marketKey.feeAPY > 0)
        ? marketKey.feeAPY
        : p.apy;

      const costs: OpportunityCosts = {
        fundingAnnual: 0,
        executionPct:  0.10,
        gasAnnual:     GAS_PCT,
        oiPenalty:     oiSkew * 6,
      };
      const netAPY = Math.max(0, grossAPY - costs.executionPct - costs.gasAnnual - costs.oiPenalty);
      const score  = netAPY * (1 - 0.05 - oiSkew * 0.10);

      const risk: OpportunityRisk = {
        counterpartyRisk: oiFlag ? 'medium' : 'low',
        ilRisk: false, liquidationRisk: false,
        rebalanceNeeded: oiFlag,
        oiBalance: oiBal, oiRiskFlag: oiFlag,
      } as any;

      return {
        id: `gmx-${i}`, strategyType: 'GMX_REAL_YIELD',
        protocol: 'GMX V2', pool: p.symbol, asset: marketKey?.name ?? sym,
        tvlUSD: marketKey?.poolValueUSD ?? p.tvlUsd,
        grossAPY, netAPY, costs, risk,
        history: { apy7d: p.apyBase7d, apy30d: p.apyMean30d, trend: calcTrend(grossAPY, p.apyBase7d, p.apyMean30d), sigma: p.sigma },
        minTier: 'balanced', score,
        verifiedOnChain: marketKey !== undefined,
        llamaPoolId: p.pool,
        address:    marketKey?.gmToken ?? '',
        updatedAt:  Date.now(),
      };
    });
}

function buildDeltaNeutralOpps(
  pools:        LlamaPool[],
  fundingRates: Map<string, number>,
): Opportunity[] {
  return pools
    .filter(p => {
      const sym = p.symbol.toUpperCase();
      return (p.project.toLowerCase().includes('uniswap') || p.project.toLowerCase().includes('camelot'))
        && Object.keys(HEDGE_ASSET).some(k => sym.includes(k))
        && (sym.includes('USDC') || sym.includes('USDT'))
        && (p.volumeUsd7d ?? 0) > 0
        && p.tvlUsd >= 1_000_000
        && p.apy > 5;
    })
    .slice(0, 6)
    .map((p, i): Opportunity => {
      const sym        = p.symbol.toUpperCase();
      const hedgeKey   = Object.keys(HEDGE_ASSET).find(k => sym.includes(k)) ?? 'WETH';
      const hedgeAsset = HEDGE_ASSET[hedgeKey];
      const funding    = fundingRates.get(hedgeAsset) ?? 6.5;

      const costs: OpportunityCosts = {
        fundingAnnual: funding,
        executionPct:  0.20,
        gasAnnual:     GAS_PCT + 2.0,
        oiPenalty:     0,
      };
      const netAPY = Math.max(0, p.apy - costs.fundingAnnual - costs.executionPct - costs.gasAnnual);
      const score  = netAPY * 0.85;

      const risk: OpportunityRisk = {
        counterpartyRisk: 'medium', ilRisk: false,
        liquidationRisk: true, rebalanceNeeded: true,
        oiBalance: null, oiRiskFlag: false,
      } as any;

      return {
        id: `dn-${i}`, strategyType: 'DELTA_NEUTRAL',
        protocol: `${p.project.replace(/-/g, ' ')} + Perp Hedge`,
        pool: p.symbol, asset: sym,
        tvlUSD: p.tvlUsd, grossAPY: p.apy, netAPY, costs, risk,
        history: { apy7d: p.apyBase7d, apy30d: p.apyMean30d, trend: calcTrend(p.apy, p.apyBase7d, p.apyMean30d), sigma: p.sigma },
        minTier: 'balanced', score,
        verifiedOnChain: false,  // requires pool address + fetchUniV3Pool
        llamaPoolId: p.pool, address: '', updatedAt: Date.now(),
      };
    });
}

function buildAaveOpps(
  pools: LlamaPool[],
  oc:    OnChainSnapshot,
): Opportunity[] {
  return pools
    .filter(p => p.project.toLowerCase().includes('aave') && p.tvlUsd >= 1_000_000)
    .slice(0, 6)
    .map((p, i): Opportunity => {
      const sym      = p.symbol.toUpperCase();
      // Use on-chain verified APY — it's exact, compound, derived from liquidityRate
      const onChain  = oc.aaveMarkets.find(m => sym.includes(m.symbol));
      const grossAPY = onChain?.supplyAPY ?? p.apy;
      const tvlUSD   = onChain?.liquidityUSD ?? p.tvlUsd;

      const costs: OpportunityCosts = {
        fundingAnnual: 0, executionPct: 0.05,
        gasAnnual: GAS_PCT, oiPenalty: 0,
      };
      const netAPY = Math.max(0, grossAPY - costs.executionPct - costs.gasAnnual);

      const risk: OpportunityRisk = {
        counterpartyRisk: 'low', ilRisk: false,
        liquidationRisk: false, rebalanceNeeded: false,
        oiBalance: null, oiRiskFlag: false,
      } as any;

      return {
        id: `aave-${i}`, strategyType: 'AAVE_LENDING',
        protocol: 'Aave V3', pool: p.symbol, asset: sym,
        tvlUSD, grossAPY, netAPY, costs, risk,
        history: { apy7d: p.apyBase7d, apy30d: p.apyMean30d, trend: calcTrend(grossAPY, p.apyBase7d, p.apyMean30d), sigma: p.sigma },
        minTier: 'conservative',
        score: netAPY * 0.97,
        verifiedOnChain: onChain !== undefined,
        llamaPoolId: p.pool,
        address: onChain?.aTokenAddress ?? '',
        updatedAt: Date.now(),
      };
    });
}

// ── Scoring ───────────────────────────────────────────────────────────────────

function scoreForTier(opps: Opportunity[], tier: RiskTier): Opportunity[] {
  return opps
    .filter(o => tierQualifies(o.minTier, tier))
    .map(o => {
      let s = o.score;

      // Reward APY consistency vs 30d mean
      if (o.history.apy30d && o.history.apy30d > 0) {
        const consistency = 1 - Math.min(0.5, Math.abs(o.grossAPY - o.history.apy30d) / o.history.apy30d);
        s *= (0.75 + 0.25 * consistency);
      }

      // Bonus for on-chain verified data — we trust it more
      if (o.verifiedOnChain) s *= 1.05;

      // Aave is last resort — heavily deprioritized
      if (o.strategyType === 'AAVE_LENDING') s *= 0.40;

      // OI risk penalty
      if (o.risk.oiRiskFlag) s *= 0.80;

      return { ...o, score: Math.max(0, s) };
    })
    .sort((a, b) => b.score - a.score);
}

// ── Main export ───────────────────────────────────────────────────────────────

export interface UniverseResult {
  opportunities: Opportunity[];
  fundingRates:  Map<string, number>;
}

export async function fetchUniverse(
  _provider: JsonRpcProvider,    // kept for signature compatibility
  userTier:  RiskTier,
  ocSnapshot: OnChainSnapshot,   // pre-fetched by orchestrator — shared with all engines
): Promise<UniverseResult> {
  const [llamaPools, fundingRates] = await Promise.all([
    fetchLlamaPools(),
    fetchFundingRates(),
  ]);

  // Build using on-chain data where available, DeFiLlama as fallback
  const all = [
    ...buildGMXOpps(llamaPools, ocSnapshot),
    ...buildDeltaNeutralOpps(llamaPools, fundingRates),
    ...buildAaveOpps(llamaPools, ocSnapshot),
  ];

  return {
    opportunities: scoreForTier(all, userTier),
    fundingRates,
  };
}
