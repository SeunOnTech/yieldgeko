

import { RankedOpportunity, StrategyType } from '../types/market';
import { RiskTier, TIER_RANK } from '../types/policy';

const EMISSION_TOKENS = new Set([
  'ARB', 'OP', 'PENDLE', 'GMX', 'GNS', 'GRAIL', 'RAM', 'MAGIC',
  'RDPX', 'DPX', 'JONES', 'CVX', 'CRV', 'SUSHI', 'COMP', 'AAVE',
]);

export function detectEmissionFraction(opp: RankedOpportunity): number {
  const total = opp.grossAPY;
  if (total <= 0) return 0;
  const rewardAPY = Math.max(
    0,
    total - opp.netAPY - opp.costs.executionPct - opp.costs.gasAnnual - opp.costs.fundingAnnual,
  );
  return rewardAPY > 0 ? Math.min(rewardAPY / total, 0.8) : 0;
}

export function computeRealYieldAPY(opp: RankedOpportunity): number {
  const emF     = opp.emissionFraction ?? detectEmissionFraction(opp);
  const emitAPY = opp.grossAPY * emF;
  const realAPY = opp.grossAPY - emitAPY;
  return Math.max(0, realAPY + emitAPY * 0.60);  
}

const LP_STRATEGIES = new Set<StrategyType>(['DELTA_NEUTRAL', 'PENDLE_LP', 'GMX_REAL_YIELD']);
const NO_IL_STRATEGIES = new Set<StrategyType>(['AAVE_LENDING', 'MORPHO_LENDING', 'PENDLE_PT']);

function ilCoverageScore(opp: RankedOpportunity): number {
  if (NO_IL_STRATEGIES.has(opp.strategyType)) return 30;   

  if (opp.strategyType === 'PENDLE_YT' || opp.strategyType === 'LEVERAGED_LOOP') {
    return 5;  
  }

  
  if (opp.lvrRatio !== undefined && opp.lvrRatio > 0) {
    
    
    const coverage = Math.min(opp.lvrRatio / 3, 1);
    return coverage * 30;
  }

  
  if (opp.quantStats) {
    const { correlation, volatility, divergenceRisk } = opp.quantStats;
    
    const ilRisk = divergenceRisk;  
    return Math.max(0, (1 - ilRisk)) * 22;  
  }

  
  const defaultILRisk: Partial<Record<StrategyType, number>> = {
    DELTA_NEUTRAL:  0.15,  
    GMX_REAL_YIELD: 0.25,  
    PENDLE_LP:      0.20,
  };
  const ilRisk = defaultILRisk[opp.strategyType] ?? 0.40;
  return (1 - ilRisk) * 22;
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

function getStrategyCorrelation(a: StrategyType, b: StrategyType): number {
  if (a === b) return 1.0;
  return CORRELATION[a]?.[b] ?? CORRELATION[b]?.[a] ?? 0.35;
}

function diversificationBonus(strategyType: StrategyType, existingTypes: StrategyType[]): number {
  if (existingTypes.length === 0) return 0.8;
  const avgCorr = existingTypes.reduce((s, t) => s + getStrategyCorrelation(strategyType, t), 0) / existingTypes.length;
  return Math.max(0, 1 - avgCorr);
}

export function computeGeckoScore(
  opp:           RankedOpportunity,
  managedUSD:    number,
  existingTypes: StrategyType[] = [],
): number {
  const managed = Math.max(managedUSD, 1);

  
  const ilScore = ilCoverageScore(opp);

  
  
  
  const realAPY       = LP_STRATEGIES.has(opp.strategyType)
    ? opp.netAPY                    
    : computeRealYieldAPY(opp);
  const yieldScore    = Math.min(realAPY / 20, 1) * 25;   

  
  const sigma         = opp.history.sigma ?? (opp.grossAPY * 0.5);
  const mean          = opp.history.apy30d ?? opp.grossAPY;
  const cv            = mean > 0 ? sigma / mean : 1;
  const stability     = Math.max(0, 1 - Math.min(cv, 1)) * 15;

  
  const depth         = Math.min(Math.log10(Math.max(1, opp.metrics.tvlUSD / managed)) / Math.log10(1_000), 1) * 15;

  
  const divBonus      = diversificationBonus(opp.strategyType, existingTypes) * 15;

  const total = ilScore + yieldScore + stability + depth + divBonus;
  return Math.max(0, Math.round(total * 100) / 100);
}

const TIER_MULTIPLIERS: Record<RiskTier, Partial<Record<StrategyType, number>>> = {
  conservative: {
    AAVE_LENDING: 1.30, MORPHO_LENDING: 1.30, PENDLE_PT: 1.20,
    GMX_REAL_YIELD: 0.60, DELTA_NEUTRAL: 0.70,
    LEVERAGED_LOOP: 0.10, PENDLE_YT: 0.10,
  },
  balanced: {
    GMX_REAL_YIELD: 1.10, DELTA_NEUTRAL: 1.20,  
    PENDLE_LP: 1.05, AAVE_LENDING: 0.60, LEVERAGED_LOOP: 0.30,
  },
  aggressive: {
    DELTA_NEUTRAL: 1.25, GMX_REAL_YIELD: 1.15, PENDLE_LP: 1.15,
    PENDLE_YT: 1.00, AAVE_LENDING: 0.40, LEVERAGED_LOOP: 0.50,
  },
  advanced: {
    LEVERAGED_LOOP: 1.30, DELTA_NEUTRAL: 1.25, PENDLE_YT: 1.15,
    GMX_REAL_YIELD: 1.10, AAVE_LENDING: 0.40,
  },
};

export function applyTierMultiplier(score: number, strategyType: StrategyType, tier: RiskTier): number {
  return score * (TIER_MULTIPLIERS[tier]?.[strategyType] ?? 1.0);
}

export function rankByGeckoScore(
  opps:          RankedOpportunity[],
  tier:          RiskTier,
  managedUSD:    number,
  existingTypes: StrategyType[] = [],
): RankedOpportunity[] {
  return opps
    .map(o => ({
      ...o,
      geckoScore: applyTierMultiplier(
        computeGeckoScore(o, managedUSD, existingTypes),
        o.strategyType,
        tier,
      ),
    }))
    .sort((a, b) => b.geckoScore - a.geckoScore);
}
