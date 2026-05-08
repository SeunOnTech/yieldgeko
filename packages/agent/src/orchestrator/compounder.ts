import type { PortfolioPosition, HarvestRecommendation, StrategyType } from './types';

// ── Compounder — Gas-aware harvest optimisation ───────────────────────────────
//
//  Determines when to harvest and compound rewards per position.
//
//  Decision model:
//    Harvest when: pendingRewards > gasCost × multiplier
//    AND:          annualised pending yield > minimum meaningful threshold
//
//  Research-derived optimal multipliers by position size:
//    < $5K:   multiplier = 5   (harvest rarely — gas drag is significant)
//    $5-50K:  multiplier = 3   (harvest weekly-ish)
//    $50K+:   multiplier = 2   (harvest more frequently, gas is small %)
//
//  Protocol-specific compounding behaviour:
//    AAVE_LENDING / MORPHO_LENDING  → auto-compounds via exchange rate. Nothing needed.
//    GMX_REAL_YIELD                 → fee income reflected in GM token price. Auto-compounds.
//    DELTA_NEUTRAL                  → Uni V3 fees sit idle in tokensOwed. MUST harvest to compound.
//    PENDLE_LP                      → PENDLE rewards need harvest + reinvest.
//    PENDLE_YT                      → no traditional harvest; value changes via time decay.
//    PENDLE_PT                      → no harvest until maturity.
//    LEVERAGED_LOOP                 → no harvest; yield via rate spread in position.
//
//  Compounding impact (research):
//    Weekly vs no-compound on 15% APY $10K:  +7.6% effective APY → $1,614 vs $1,500/yr
//    Daily vs weekly: +0.3% additional — diminishing returns past weekly for <$50K
// ─────────────────────────────────────────────────────────────────────────────

const GAS_ESTIMATE_USD: Record<StrategyType, number> = {
  AAVE_LENDING:   0,      // auto-compound — no gas needed
  MORPHO_LENDING: 0,      // auto-compound
  GMX_REAL_YIELD: 0,      // auto-compound via GM price
  PENDLE_PT:      0,      // no harvest until maturity
  PENDLE_YT:      0,      // no traditional harvest
  DELTA_NEUTRAL:  1.50,   // collect fees + add liquidity back = ~1.5 USD on Arbitrum
  PENDLE_LP:      1.20,   // collect PENDLE rewards + reinvest
  LEVERAGED_LOOP: 0,      // no harvest
};

const HARVEST_MULTIPLIERS: Record<string, number> = {
  small:  5,   // position < $5K
  medium: 3,   // position $5K-$50K
  large:  2,   // position > $50K
};

function getMultiplier(positionUSD: number): number {
  if (positionUSD < 5_000)  return HARVEST_MULTIPLIERS.small;
  if (positionUSD < 50_000) return HARVEST_MULTIPLIERS.medium;
  return HARVEST_MULTIPLIERS.large;
}

// ── Effective APY with compounding ────────────────────────────────────────────

export function effectiveAPY(
  nominalAPY:     number,   // %
  compoundsPerYr: number,
): number {
  if (compoundsPerYr <= 0) return nominalAPY;
  const r = nominalAPY / 100 / compoundsPerYr;
  return ((1 + r) ** compoundsPerYr - 1) * 100;
}

export function compoundBoost(nominalAPY: number, compoundsPerYr: number): number {
  return effectiveAPY(nominalAPY, compoundsPerYr) - nominalAPY;
}

// ── Optimal harvest frequency ─────────────────────────────────────────────────

export function optimalHarvestsPerYear(
  positionUSD:    number,
  nominalAPY:     number,
  gasPerHarvest:  number,
): number {
  if (gasPerHarvest <= 0) return 0;  // auto-compounds, no action needed

  // Find n that maximises: effectiveAPY(n) - (n × gasPerHarvest / positionUSD × 100)
  // Gas drag % = (n × gasPerHarvest / positionUSD) × 100
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

// ── Main harvest recommendation ───────────────────────────────────────────────

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

  // Protocols that auto-compound — nothing to do
  if (gasEstimate === 0) {
    return { ...base, reason: 'Auto-compounds — no harvest needed' };
  }

  const multiplier   = getMultiplier(position.allocationUSD);
  const minThreshold = gasEstimate * multiplier;

  // Condition 1: pending rewards must cover gas × multiplier
  if (position.pendingRewardsUSD < minThreshold) {
    return {
      ...base,
      reason: `Rewards $${position.pendingRewardsUSD.toFixed(2)} below threshold $${minThreshold.toFixed(2)} (gas ×${multiplier})`,
    };
  }

  // Condition 2: annualised pending yield must be meaningful (>0.5% of position)
  const daysHeld        = Math.max(position.daysHeld, 0.01);
  const annualisedYield = (position.pendingRewardsUSD / position.allocationUSD / daysHeld) * 365 * 100;
  if (annualisedYield < 0.5) {
    return {
      ...base,
      reason: `Annualised pending yield ${annualisedYield.toFixed(2)}% too small to justify gas`,
    };
  }

  // Harvest is justified
  const netGain    = position.pendingRewardsUSD - gasEstimate;
  const boostPct   = compoundBoost(position.currentNetAPY, 52); // estimate weekly compound boost

  return {
    ...base,
    shouldHarvest: true,
    netGainUSD:    netGain,
    reason: `Harvest $${position.pendingRewardsUSD.toFixed(2)} → net gain $${netGain.toFixed(2)} after $${gasEstimate.toFixed(2)} gas. Compounding adds ~${boostPct.toFixed(2)}% effective APY`,
  };
}

// ── Estimate pending rewards per tick ─────────────────────────────────────────
//
//  For protocols where rewards sit idle, estimate accumulation since last harvest.
//  This is a simulation estimate — real values require on-chain reads.

export function estimatePendingRewards(
  position:     PortfolioPosition,
  elapsedSecs:  number,
): number {
  const HARVEST_PROTOCOLS: StrategyType[] = ['DELTA_NEUTRAL', 'PENDLE_LP'];
  if (!HARVEST_PROTOCOLS.includes(position.strategyType)) return 0;

  // Estimate based on netAPY and elapsed time
  const yearFrac     = elapsedSecs / 31_536_000;
  const newRewards   = position.allocationUSD * (position.currentNetAPY / 100) * yearFrac;
  return position.pendingRewardsUSD + Math.max(0, newRewards);
}

// ── Evaluate all positions in portfolio ──────────────────────────────────────

export function evaluatePortfolioHarvests(
  positions: PortfolioPosition[],
): HarvestRecommendation[] {
  return positions
    .map(evaluateHarvest)
    .filter(r => r.shouldHarvest)
    .sort((a, b) => b.netGainUSD - a.netGainUSD); // highest-value harvests first
}
