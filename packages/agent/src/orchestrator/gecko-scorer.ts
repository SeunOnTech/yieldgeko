import type { Opportunity, PortfolioPosition, RiskTier, StrategyType } from './types';

const EMISSION_TOKENS = new Set([
  'ARB', 'OP', 'PENDLE', 'GMX', 'GNS', 'GRAIL', 'RAM', 'MAGIC',
  'RDPX', 'DPX', 'JONES', 'CVX', 'CRV', 'SUSHI', 'COMP', 'AAVE',
]);

const EMISSION_DISCOUNT = 0.60; 

export function detectEmissionFraction(opp: Opportunity): number {
  const total = opp.grossAPY;
  if (total <= 0) return 0;

  const rewardAPY  = opp.costs.oiPenalty === 0
    ? Math.max(0, total - (opp.netAPY + opp.costs.executionPct + opp.costs.gasAnnual + opp.costs.fundingAnnual))
    : 0;

  
  
  const emissionFraction = rewardAPY > 0 && total > 0 ? Math.min(rewardAPY / total, 0.8) : 0;

  return emissionFraction;
}

export function computeRealYieldAPY(opp: Opportunity): number {
  const emF = opp.emissionFraction ?? detectEmissionFraction(opp);
  const emissionAPY  = opp.grossAPY * emF;
  const realAPY      = opp.grossAPY - emissionAPY;
  return Math.max(0, realAPY + emissionAPY * EMISSION_DISCOUNT);
}

export function getILRiskScore(strategyType: StrategyType): number {
  const scores: Record<StrategyType, number> = {
    AAVE_LENDING:   0.00,   
    MORPHO_LENDING: 0.00,   
    PENDLE_PT:      0.00,   
    PENDLE_LP:      0.15,   
    PENDLE_YT:      0.40,   
    GMX_REAL_YIELD: 0.25,   
    DELTA_NEUTRAL:  0.05,   
    LEVERAGED_LOOP: 0.30,   
  };
  return scores[strategyType] ?? 0.30;
}

const CORRELATION: Partial<Record<StrategyType, Partial<Record<StrategyType, number>>>> = {
  GMX_REAL_YIELD:  { DELTA_NEUTRAL: 0.40, AAVE_LENDING: 0.20, MORPHO_LENDING: 0.20, PENDLE_LP: 0.25, PENDLE_PT: 0.10, PENDLE_YT: 0.30, LEVERAGED_LOOP: 0.15 },
  DELTA_NEUTRAL:   { GMX_REAL_YIELD: 0.40, AAVE_LENDING: 0.15, MORPHO_LENDING: 0.15, PENDLE_LP: 0.35, PENDLE_PT: 0.10, PENDLE_YT: 0.25, LEVERAGED_LOOP: 0.20 },
  AAVE_LENDING:    { GMX_REAL_YIELD: 0.20, DELTA_NEUTRAL: 0.15, MORPHO_LENDING: 0.85, PENDLE_LP: 0.20, PENDLE_PT: 0.60, PENDLE_YT: 0.20, LEVERAGED_LOOP: 0.70 },
  MORPHO_LENDING:  { GMX_REAL_YIELD: 0.20, DELTA_NEUTRAL: 0.15, AAVE_LENDING: 0.85, PENDLE_LP: 0.20, PENDLE_PT: 0.60, PENDLE_YT: 0.20, LEVERAGED_LOOP: 0.65 },
  PENDLE_PT:       { AAVE_LENDING: 0.60, MORPHO_LENDING: 0.60, GMX_REAL_YIELD: 0.10, DELTA_NEUTRAL: 0.10, PENDLE_LP: 0.50, PENDLE_YT: 0.35, LEVERAGED_LOOP: 0.55 },
  PENDLE_LP:       { GMX_REAL_YIELD: 0.25, DELTA_NEUTRAL: 0.35, AAVE_LENDING: 0.20, MORPHO_LENDING: 0.20, PENDLE_PT: 0.50, PENDLE_YT: 0.45, LEVERAGED_LOOP: 0.25 },
  PENDLE_YT:       { GMX_REAL_YIELD: 0.30, DELTA_NEUTRAL: 0.25, AAVE_LENDING: 0.20, MORPHO_LENDING: 0.20, PENDLE_PT: 0.35, PENDLE_LP: 0.45, LEVERAGED_LOOP: 0.20 },
  LEVERAGED_LOOP:  { AAVE_LENDING: 0.70, MORPHO_LENDING: 0.65, GMX_REAL_YIELD: 0.15, DELTA_NEUTRAL: 0.20, PENDLE_PT: 0.55, PENDLE_LP: 0.25, PENDLE_YT: 0.20 },
};

function getCorrelation(a: StrategyType, b: StrategyType): number {
  if (a === b) return 1.0;
  return CORRELATION[a]?.[b] ?? CORRELATION[b]?.[a] ?? 0.35;
}

function computeDiversificationBonus(
  opp:       Opportunity,
  existing:  PortfolioPosition[],
): number {
  if (existing.length === 0) return 0.8; 
  const avgCorr = existing.reduce((sum, p) => sum + getCorrelation(opp.strategyType, p.strategyType), 0) / existing.length;
  
  return Math.max(0, 1 - avgCorr);
}

export function computeGeckoScore(
  opp:       Opportunity,
  existing:  PortfolioPosition[],
  managedUSD: number,
): number {
  const managed = Math.max(managedUSD, 1);

  
  const realAPY         = computeRealYieldAPY(opp);
  const realYieldScore  = Math.min(realAPY / 25, 1) * 30;  

  
  
  const sigma           = opp.history.sigma ?? (opp.grossAPY * 0.5);
  const mean            = opp.history.apy30d ?? opp.grossAPY;
  const cv              = mean > 0 ? sigma / mean : 1;  
  const stabilityScore  = Math.max(0, (1 - Math.min(cv, 1))) * 20;

  
  
  const depthRatio      = opp.tvlUSD / managed;
  const depthScore      = Math.min(Math.log10(Math.max(1, depthRatio)) / Math.log10(1_000), 1) * 15;
  

  
  
  const consistencyRatio = mean > 0 ? Math.min(opp.grossAPY / mean, mean / opp.grossAPY) : 0.5;
  const histScore        = consistencyRatio * 15;

  
  const ilScore          = getILRiskScore(opp.strategyType) * 10;

  
  const divBonus         = computeDiversificationBonus(opp, existing) * 10;

  const total = realYieldScore + stabilityScore + depthScore + histScore - ilScore + divBonus;
  return Math.max(0, Math.round(total * 100) / 100);
}

const TIER_MULTIPLIERS: Record<RiskTier, Partial<Record<StrategyType, number>>> = {
  conservative: {
    AAVE_LENDING:   1.30,   
    MORPHO_LENDING: 1.30,
    PENDLE_PT:      1.20,
    GMX_REAL_YIELD: 0.60,   
    DELTA_NEUTRAL:  0.70,
    LEVERAGED_LOOP: 0.10,   
    PENDLE_YT:      0.10,
  },
  balanced: {
    GMX_REAL_YIELD: 1.10,
    DELTA_NEUTRAL:  1.10,
    PENDLE_LP:      1.05,
    AAVE_LENDING:   0.60,   
    LEVERAGED_LOOP: 0.30,
  },
  aggressive: {
    DELTA_NEUTRAL:  1.20,
    GMX_REAL_YIELD: 1.15,
    PENDLE_LP:      1.15,
    PENDLE_YT:      1.00,
    AAVE_LENDING:   0.40,
    LEVERAGED_LOOP: 0.50,
  },
  advanced: {
    LEVERAGED_LOOP: 1.30,
    DELTA_NEUTRAL:  1.20,
    PENDLE_YT:      1.15,
    GMX_REAL_YIELD: 1.10,
    AAVE_LENDING:   0.40,
  },
};

export function applyTierMultiplier(score: number, strategyType: StrategyType, tier: RiskTier): number {
  const mult = TIER_MULTIPLIERS[tier]?.[strategyType] ?? 1.0;
  return score * mult;
}

export function rankOpportunities(
  opps:      Opportunity[],
  existing:  PortfolioPosition[],
  tier:      RiskTier,
  managedUSD: number,
): Opportunity[] {
  return opps
    .map(o => ({
      ...o,
      geckoScore: applyTierMultiplier(
        computeGeckoScore(o, existing, managedUSD),
        o.strategyType,
        tier,
      ),
    }))
    .sort((a, b) => b.geckoScore - a.geckoScore);
}
