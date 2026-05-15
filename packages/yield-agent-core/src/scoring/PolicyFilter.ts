import { RankedOpportunity } from '../types/market';
import { IntelligencePolicy, TIER_RANK } from '../types/policy';

const MIN_TVL = 50_000;

const STRATEGY_MIN_TIER: Record<string, number> = {
  AAVE_LENDING:   0,  
  MORPHO_LENDING: 0,
  PENDLE_PT:      0,
  GMX_REAL_YIELD: 1,  
  DELTA_NEUTRAL:  1,
  PENDLE_LP:      1,
  PENDLE_YT:      3,  
  LEVERAGED_LOOP: 3,
};

const STABLES = new Set(['USDC', 'USDT', 'DAI', 'USDS', 'FRAX', 'LUSD', 'PYUSD', 'USD₮0', 'USDT0']);

function isStable(symbol: string): boolean {
  return STABLES.has(symbol.toUpperCase().replace(/[₮0]/g, ''));
}

export function applyPolicyFilter(
  opps:   RankedOpportunity[],
  policy: IntelligencePolicy,
): RankedOpportunity[] {
  const userTierRank = TIER_RANK[policy.riskTier];
  const minNetAPY    = policy.minNetAPY ?? 0;
  const chains       = policy.allowedChains ?? ['arbitrum'];

  return opps.filter(o => {
    
    if (!chains.includes(o.chain)) return false;

    
    if (policy.allowedProtocols?.length && !policy.allowedProtocols.includes(o.protocol.toLowerCase())) return false;

    
    const stratMin = STRATEGY_MIN_TIER[o.strategyType] ?? 1;
    if (userTierRank < stratMin) return false;

    
    if (o.netAPY < minNetAPY) return false;

    
    if (o.metrics.tvlUSD < MIN_TVL) return false;

    
    if (policy.stablecoinOnly) {
      if (!isStable(o.tokens.base.symbol)) return false;
      if (o.tokens.quote && !isStable(o.tokens.quote.symbol)) return false;
    }

    
    if (policy.maxVolatility !== undefined) {
      const vol = o.quantStats?.volatility ?? 0;
      if (vol > policy.maxVolatility) return false;
    }

    return true;
  });
}
