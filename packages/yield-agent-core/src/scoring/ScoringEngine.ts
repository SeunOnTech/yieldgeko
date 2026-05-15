

import { RankedOpportunity } from '../types/market';
import { IntelligencePolicy } from '../types/policy';
import { computeGeckoScore, applyTierMultiplier, computeRealYieldAPY } from '../analysis/GeckoScorer';
import { ILEngine }              from '../analysis/ILEngine';
import { calculateDivergenceStats } from '../analysis/QuantMath';
import { getCachedTokenPrices }  from '../analysis/LVRScreener';
import { getDiskPrices }         from '../providers/DiskPriceHistory';
import { getPriceHistory }       from '../providers/MoralisPrice';

export function scoreOpportunities(
  opps:   RankedOpportunity[],
  policy: IntelligencePolicy,
): RankedOpportunity[] {
  const existing = policy.existingTypes ?? [];
  return opps
    .map(o => {
      const base  = computeGeckoScore(o, policy.managedUSD, existing);
      const score = applyTierMultiplier(base, o.strategyType, policy.riskTier);
      return { ...o, geckoScore: score, realYieldAPY: computeRealYieldAPY(o) };
    })
    .sort((a, b) => b.geckoScore - a.geckoScore);
}

async function getPriceArray(address: string, chain = 'arbitrum'): Promise<number[]> {
  const addr = address.toLowerCase();

  
  const disk = getDiskPrices(addr);
  if (disk.length >= 10) return disk;

  
  const lvr = getCachedTokenPrices(addr);
  if (lvr.length >= 10) return lvr;

  
  try {
    const pts = await getPriceHistory(addr, chain);
    return pts.map(p => p.close);
  } catch {
    return [];
  }
}

export async function enrichWithIL(
  opp:   RankedOpportunity,
  chain = 'arbitrum',
): Promise<RankedOpportunity> {
  const baseAddr  = opp.tokens.base.address;
  const quoteAddr = opp.tokens.quote?.address;

  
  
  if (!quoteAddr || ['AAVE_LENDING', 'MORPHO_LENDING', 'PENDLE_PT'].includes(opp.strategyType)) {
    return opp;
  }

  try {
    const [basePrices, quotePrices] = await Promise.all([
      getPriceArray(baseAddr, chain),
      getPriceArray(quoteAddr, chain),
    ]);

    if (basePrices.length < 10 || quotePrices.length < 10) return opp;

    const stats = calculateDivergenceStats(basePrices, quotePrices);
    const il    = ILEngine.analyze(opp, stats);

    
    
    const realILPct         = il.predictedIL * 100;
    const adjustedNetAPY    = Math.max(0, opp.grossAPY - realILPct - opp.costs.executionPct - opp.costs.gasAnnual);

    return {
      ...opp,
      netAPY:     adjustedNetAPY,
      quantStats: {
        correlation:    stats.correlation,
        volatility:     stats.volatility,
        divergenceRisk: stats.divergenceRisk,
        priceRatioVar:  stats.priceRatioVar,
        dataPoints:     stats.dataPoints,
      },
    };
  } catch {
    return opp;
  }
}

export async function enrichTopN(
  ranked: RankedOpportunity[],
  n      = 15,
  chain  = 'arbitrum',
): Promise<RankedOpportunity[]> {
  const top    = ranked.slice(0, n);
  const rest   = ranked.slice(n);
  const enriched = await Promise.all(top.map(o => enrichWithIL(o, chain)));
  return [...enriched, ...rest];
}
