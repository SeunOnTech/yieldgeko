/**
 * GeckoScore V2 — improved multi-factor opportunity ranking
 *
 * Changes from V1:
 *   1. Stability score uses DeFiLlama's `sigma` field (APY volatility, not price vol)
 *   2. IL risk scales dynamically with pool σ (not static per strategy type)
 *   3. Liquidity depth normalised at 100× TVL (not 1000×) — industry standard
 *   4. Consistency uses trend-aware scoring: falling APY penalised more than rising
 *   5. Diversification bonus capped at 0.5 (was 0.8) — reduces first-position bias
 *   6. Real yield normalised at 20% APY for full score (was 25%) — more achievable
 */

import type { Opportunity, PortfolioPosition, RiskTier, StrategyType } from './types';

// ── Emission detection (unchanged from V1 — logic is correct) ─────────────────

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

// ── IL risk — V2: scales with pool σ ─────────────────────────────────────────
//
// V1 flaw: all DELTA_NEUTRAL got IL=0.05 regardless of pair volatility.
// V2: base risk by strategy + amplification by σ (daily ratio vol).
// A WETH-USDC position at σ=5%/day has much higher residual IL than σ=1%/day.
//
// Residual IL for DELTA_NEUTRAL after hedging comes from:
//   - Hedge slippage at rebalance (≈ 0.1-0.5% per rebalance)
//   - Funding rate on perp short
//   - Gamma PnL between rebalances
// These all scale roughly with σ.

const BASE_IL_RISK: Record<StrategyType, number> = {
  AAVE_LENDING:   0.00,
  MORPHO_LENDING: 0.00,
  PENDLE_PT:      0.00,
  PENDLE_LP:      0.08,   // low base — correlated pre-maturity
  PENDLE_YT:      0.35,   // higher base — time decay + yield rate risk
  GMX_REAL_YIELD: 0.20,   // trader PnL risk proxy
  DELTA_NEUTRAL:  0.04,   // very low base when σ is low (hedged)
  LEVERAGED_LOOP: 0.25,   // liquidation risk proxy
};

/**
 * Dynamic IL risk score (0–1).
 * For LP strategies (DELTA_NEUTRAL, PENDLE_LP): scales with pool σ.
 * For non-LP strategies: uses static base (σ irrelevant).
 *
 * σDaily: daily ratio volatility in % (from ScreenedPool.sigmaRatioDaily)
 */
export function getILRiskScoreV2(strategyType: StrategyType, σDailyPct?: number): number {
  const base = BASE_IL_RISK[strategyType] ?? 0.25;

  // Dynamic scaling only applies to strategies with actual LP IL exposure
  if (!σDailyPct || !['DELTA_NEUTRAL', 'PENDLE_LP'].includes(strategyType)) {
    return base;
  }

  // σ amplification: normalise against a "calm" reference of 2%/day
  // Below 2%/day: near base. Above 2%/day: scales up to 2× base at 4%/day.
  const σRef = 2.0;
  const ampFactor = Math.min(2.0, Math.max(1.0, σDailyPct / σRef));
  return Math.min(0.8, base * ampFactor);
}

// ── Correlation matrix (same as V1, research-derived) ────────────────────────

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
    // V2: capped at 0.5 (was 0.8 in V1 — too aggressive, distorted first-position ranking)
    return 0.5;
  }
  const avgCorr = existing.reduce((sum, p) => sum + getCorrelation(opp.strategyType, p.strategyType), 0) / existing.length;
  return Math.max(0, 1 - avgCorr);
}

// ── Main scoring function V2 ──────────────────────────────────────────────────

export function computeGeckoScoreV2(
  opp:        Opportunity,
  existing:   PortfolioPosition[],
  managedUSD: number,
  σDailyPct?: number,   // pool daily ratio vol — passed from screener for dynamic IL
): number {
  const managed = Math.max(managedUSD, 1);

  // 1. Real yield component (30 pts max)
  //    V2: normalised at 20% APY for full score (was 25% — 20% is more achievable
  //    across the universe and gives better discrimination at typical APY levels)
  const realAPY        = computeRealYieldAPYV2(opp);
  const realYieldScore = Math.min(realAPY / 20, 1) * 30;

  // 2. Yield stability (20 pts max)
  //    V2: uses DeFiLlama's `sigma` field — this is APY volatility, not price vol.
  //    A pool can have high price vol but stable fees (and vice versa).
  //    DeFiLlama computes sigma from their historical APY time-series — correct input.
  const apySigma       = opp.history.sigma ?? (opp.grossAPY * 0.4);
  const apyMean        = opp.history.apy30d ?? opp.grossAPY;
  const cv             = apyMean > 0 ? apySigma / apyMean : 1;
  const stabilityScore = Math.max(0, (1 - Math.min(cv, 1.5)) / 1.5) * 20;
  //                               ↑ allows CV up to 1.5 before full penalisation (was 1.0)

  // 3. Liquidity depth (15 pts max)
  //    V2: normalised at 100× TVL (was 1000× — too strict and economically unjustified).
  //    50–100× is the industry convention for LP entries without meaningful price impact.
  const depthRatio     = opp.tvlUSD / managed;
  const depthScore     = Math.min(Math.log10(Math.max(1, depthRatio)) / Math.log10(100), 1) * 15;

  // 4. Historical consistency (15 pts max)
  //    V2: trend-aware. Falling APY (current < 30d mean) is penalised more than rising.
  //    V1 used min(now/mean, mean/now) which treated both directions symmetrically.
  let histScore = 0;
  if (apyMean > 0) {
    const ratio = opp.grossAPY / apyMean;
    if (ratio >= 1) {
      // Rising or flat: gentle bonus, capped at 1.5× mean
      histScore = Math.min(ratio, 1.5) / 1.5 * 15;
    } else {
      // Falling: penalise steeper — 50% APY drop → 25% of max score
      histScore = Math.max(0, ratio ** 2) * 15;
    }
  } else {
    histScore = 7.5; // no history — neutral
  }

  // 5. IL risk penalty (0-10 pts deducted)
  //    V2: dynamic scaling by σ for LP strategies
  const ilRisk   = getILRiskScoreV2(opp.strategyType, σDailyPct);
  const ilScore  = ilRisk * 10;

  // 6. Diversification bonus (10 pts max)
  //    V2: first-position bonus capped at 0.5 (was 0.8 — inflated allocation bias)
  const divBonus = computeDiversificationBonusV2(opp, existing) * 10;

  const total = realYieldScore + stabilityScore + depthScore + histScore - ilScore + divBonus;
  return Math.max(0, Math.round(total * 100) / 100);
}

// ── Tier multipliers (unchanged — sensible as-is) ─────────────────────────────

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
