

import type { Opportunity, PortfolioPosition, RiskTier, StrategyType } from './types';

const EMISSION_TOKENS = new Set([
  'ARB', 'OP', 'PENDLE', 'GMX', 'GNS', 'GRAIL', 'RAM', 'MAGIC',
  'RDPX', 'DPX', 'JONES', 'CVX', 'CRV', 'SUSHI', 'COMP', 'AAVE',
]);
const EMISSION_DISCOUNT = 0.60;

export function detectEmissionFractionV2(opp: Opportunity): number {
  const total = opp.grossAPY;
  if (total <= 0) return 0;
  const rewardAPY = opp.costs.oiPenalty === 0
    ? Math.max(0, total - (opp.netAPY + opp.costs.executionPct + opp.costs.gasAnnual + opp.costs.fundingAnnual))
    : 0;
  return rewardAPY > 0 && total > 0 ? Math.min(rewardAPY / total, 0.8) : 0;
}

export function computeRealYieldAPYV2(opp: Opportunity): number {
  const emF       = opp.emissionFraction ?? detectEmissionFractionV2(opp);
  const emissionAPY = opp.grossAPY * emF;
  const realAPY     = opp.grossAPY - emissionAPY;
  return Math.max(0, realAPY + emissionAPY * EMISSION_DISCOUNT);
}

const BASE_IL_RISK: Record<StrategyType, number> = {
  AAVE_LENDING:   0.00,
  MORPHO_LENDING: 0.00,
  PENDLE_PT:      0.00,
  PENDLE_LP:      0.08,   
  PENDLE_YT:      0.35,   
  GMX_REAL_YIELD: 0.20,   
  DELTA_NEUTRAL:  0.04,   
  LEVERAGED_LOOP: 0.25,   
};

export function getILRiskScoreV2(strategyType: StrategyType, σDailyPct?: number): number {
  const base = BASE_IL_RISK[strategyType] ?? 0.25;

  
  if (!σDailyPct || !['DELTA_NEUTRAL', 'PENDLE_LP'].includes(strategyType)) {
    return base;
  }

  
  
  const σRef = 2.0;
  const ampFactor = Math.min(2.0, Math.max(1.0, σDailyPct / σRef));
  return Math.min(0.8, base * ampFactor);
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

function computeDiversificationBonusV2(opp: Opportunity, existing: PortfolioPosition[]): number {
  if (existing.length === 0) {
    
    return 0.5;
  }
  const avgCorr = existing.reduce((sum, p) => sum + getCorrelation(opp.strategyType, p.strategyType), 0) / existing.length;
  return Math.max(0, 1 - avgCorr);
}

export function computeGeckoScoreV2(
  opp:        Opportunity,
  existing:   PortfolioPosition[],
  managedUSD: number,
  σDailyPct?: number,   
): number {
  const managed = Math.max(managedUSD, 1);

  
  
  
  const realAPY        = computeRealYieldAPYV2(opp);
  const realYieldScore = Math.min(realAPY / 20, 1) * 30;

  
  
  
  
  const apySigma       = opp.history.sigma ?? (opp.grossAPY * 0.4);
  const apyMean        = opp.history.apy30d ?? opp.grossAPY;
  const cv             = apyMean > 0 ? apySigma / apyMean : 1;
  const stabilityScore = Math.max(0, (1 - Math.min(cv, 1.5)) / 1.5) * 20;
  

  
  
  
  const depthRatio     = opp.tvlUSD / managed;
  const depthScore     = Math.min(Math.log10(Math.max(1, depthRatio)) / Math.log10(100), 1) * 15;

  
  
  
  let histScore = 0;
  if (apyMean > 0) {
    const ratio = opp.grossAPY / apyMean;
    if (ratio >= 1) {
      
      histScore = Math.min(ratio, 1.5) / 1.5 * 15;
    } else {
      
      histScore = Math.max(0, ratio ** 2) * 15;
    }
  } else {
    histScore = 7.5; 
  }

  
  
  const ilRisk   = getILRiskScoreV2(opp.strategyType, σDailyPct);
  const ilScore  = ilRisk * 10;

  
  
  const divBonus = computeDiversificationBonusV2(opp, existing) * 10;

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

export function applyTierMultiplierV2(score: number, strategyType: StrategyType, tier: RiskTier): number {
  const mult = TIER_MULTIPLIERS[tier]?.[strategyType] ?? 1.0;
  return score * mult;
}
