import type { PortfolioPosition, HarvestRecommendation, StrategyType } from './types';

const GAS_ESTIMATE_USD: Record<StrategyType, number> = {
  AAVE_LENDING:   0,      
  MORPHO_LENDING: 0,      
  GMX_REAL_YIELD: 0,      
  PENDLE_PT:      0,      
  PENDLE_YT:      0,      
  DELTA_NEUTRAL:  1.50,   
  PENDLE_LP:      1.20,   
  LEVERAGED_LOOP: 0,      
};

const HARVEST_MULTIPLIERS: Record<string, number> = {
  small:  3.34, 
  medium: 2,    
  large:  1.5,  
};

function getMultiplier(positionUSD: number): number {
  if (positionUSD < 5_000)  return HARVEST_MULTIPLIERS.small;
  if (positionUSD < 50_000) return HARVEST_MULTIPLIERS.medium;
  return HARVEST_MULTIPLIERS.large;
}

export function effectiveAPY(
  nominalAPY:     number,   
  compoundsPerYr: number,
): number {
  if (compoundsPerYr <= 0) return nominalAPY;
  const r = nominalAPY / 100 / compoundsPerYr;
  return ((1 + r) ** compoundsPerYr - 1) * 100;
}

export function compoundBoost(nominalAPY: number, compoundsPerYr: number): number {
  return effectiveAPY(nominalAPY, compoundsPerYr) - nominalAPY;
}

export function optimalHarvestsPerYear(
  positionUSD:    number,
  nominalAPY:     number,
  gasPerHarvest:  number,
): number {
  if (gasPerHarvest <= 0) return 0;  

  
  
  let bestN   = 0;
  let bestNet = 0;

  for (const n of [1, 4, 12, 26, 52, 104, 365]) {
    const gasDragPct = (n * gasPerHarvest / positionUSD) * 100;
    const eff        = effectiveAPY(nominalAPY, n);
    const net        = eff - gasDragPct;
    if (net > bestNet) { bestNet = net; bestN = n; }
  }

  return bestN;
}

export function evaluateHarvest(
  position: PortfolioPosition,
): HarvestRecommendation {
  const gasEstimate = GAS_ESTIMATE_USD[position.strategyType] ?? 0;
  const base: HarvestRecommendation = {
    shouldHarvest:     false,
    positionId:        position.id,
    pendingRewardsUSD: position.pendingRewardsUSD,
    estimatedGasUSD:   gasEstimate,
    netGainUSD:        position.pendingRewardsUSD - gasEstimate,
    reason:            '',
  };

  
  if (gasEstimate === 0) {
    return { ...base, reason: 'Auto-compounds — no harvest needed' };
  }

  const multiplier   = getMultiplier(position.allocationUSD);
  const minThreshold = gasEstimate * multiplier;

  
  if (position.pendingRewardsUSD < minThreshold) {
    return {
      ...base,
      reason: `Rewards $${position.pendingRewardsUSD.toFixed(2)} below threshold $${minThreshold.toFixed(2)} (gas ×${multiplier})`,
    };
  }

  
  const daysHeld        = Math.max(position.daysHeld, 0.01);
  const annualisedYield = (position.pendingRewardsUSD / position.allocationUSD / daysHeld) * 365 * 100;
  if (annualisedYield < 0.5) {
    return {
      ...base,
      reason: `Annualised pending yield ${annualisedYield.toFixed(2)}% too small to justify gas`,
    };
  }

  
  const netGain    = position.pendingRewardsUSD - gasEstimate;
  const boostPct   = compoundBoost(position.currentNetAPY, 52); 

  return {
    ...base,
    shouldHarvest: true,
    netGainUSD:    netGain,
    reason: `Harvest $${position.pendingRewardsUSD.toFixed(2)} → net gain $${netGain.toFixed(2)} after $${gasEstimate.toFixed(2)} gas. Compounding adds ~${boostPct.toFixed(2)}% effective APY`,
  };
}

export function estimatePendingRewards(
  position:     PortfolioPosition,
  elapsedSecs:  number,
): number {
  const HARVEST_PROTOCOLS: StrategyType[] = ['DELTA_NEUTRAL', 'PENDLE_LP'];
  if (!HARVEST_PROTOCOLS.includes(position.strategyType)) return 0;

  
  const yearFrac     = elapsedSecs / 31_536_000;
  const newRewards   = position.allocationUSD * (position.currentNetAPY / 100) * yearFrac;
  return position.pendingRewardsUSD + Math.max(0, newRewards);
}

export function evaluatePortfolioHarvests(
  positions: PortfolioPosition[],
): HarvestRecommendation[] {
  return positions
    .map(evaluateHarvest)
    .filter(r => r.shouldHarvest)
    .sort((a, b) => b.netGainUSD - a.netGainUSD); 
}
