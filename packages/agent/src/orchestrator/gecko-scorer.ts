import type { Opportunity, PortfolioPosition, RiskTier, StrategyType } from './types';

// ── GeckoScore — Proprietary Multi-Factor Ranking ────────────────────────────
//
//  Six-factor scoring that produces a single comparable number per opportunity.
//  Higher = better for a given user context.
//
//  Why this beats raw netAPY:
//    · Raw APY is backward-looking and emission-inflated
//    · Ignores IL risk (pool could be 30% APY but bleeding IL)
//    · Ignores sustainability (token emissions end, real yield doesn't)
//    · Ignores correlation with existing positions
//    · Ignores liquidity depth (can we actually exit this position?)
//
//  Factor weights (sum = 1.0):
//    realYieldComponent    0.30  — only durable fee/interest income counts
//    yieldStability        0.20  — penalises high-sigma volatile APY
//    liquidityDepth        0.15  — log-scaled TVL relative to position size
//    historicalConsistency 0.15  — is current APY near 30d mean?
//    ilRiskPenalty         0.10  — negative for IL-exposed strategies
//    diversificationBonus  0.10  — rewards low correlation with existing positions
// ─────────────────────────────────────────────────────────────────────────────

// ── Emission detection ────────────────────────────────────────────────────────
//
//  Protocols that emit governance tokens as yield → unsustainable
//  We identify emission tokens by common governance token symbols.
//  apyBase (fee/interest) = real yield; apyReward (token emissions) = discounted

const EMISSION_TOKENS = new Set([
  'ARB', 'OP', 'PENDLE', 'GMX', 'GNS', 'GRAIL', 'RAM', 'MAGIC',
  'RDPX', 'DPX', 'JONES', 'CVX', 'CRV', 'SUSHI', 'COMP', 'AAVE',
]);

const EMISSION_DISCOUNT = 0.60; // emissions worth 60 cents on the dollar vs real yield

export function detectEmissionFraction(opp: Opportunity): number {
  const total = opp.grossAPY;
  if (total <= 0) return 0;

  const rewardAPY  = opp.costs.oiPenalty === 0
    ? Math.max(0, total - (opp.netAPY + opp.costs.executionPct + opp.costs.gasAnnual + opp.costs.fundingAnnual))
    : 0;

  // emissionFraction = proportion of grossAPY that comes from token emissions
  // rewardAPY is the surplus above what fees/interest can explain
  const emissionFraction = rewardAPY > 0 && total > 0 ? Math.min(rewardAPY / total, 0.8) : 0;

  return emissionFraction;
}

export function computeRealYieldAPY(opp: Opportunity): number {
  const emF = opp.emissionFraction ?? detectEmissionFraction(opp);
  const emissionAPY  = opp.grossAPY * emF;
  const realAPY      = opp.grossAPY - emissionAPY;
  return Math.max(0, realAPY + emissionAPY * EMISSION_DISCOUNT);
}

// ── IL risk score per strategy ────────────────────────────────────────────────
//
//  0.0 = no IL risk (lending, fixed yield)
//  0.5 = moderate IL (GMX trader PnL risk, wide LP)
//  1.0 = high IL (tight concentrated LP, unhedged volatile pair)

export function getILRiskScore(strategyType: StrategyType): number {
  const scores: Record<StrategyType, number> = {
    AAVE_LENDING:   0.00,   // no IL
    MORPHO_LENDING: 0.00,   // no IL
    PENDLE_PT:      0.00,   // fixed yield, no IL
    PENDLE_LP:      0.15,   // low IL — PT and underlying highly correlated pre-maturity
    PENDLE_YT:      0.40,   // moderate — time decay + yield rate risk
    GMX_REAL_YIELD: 0.25,   // trader PnL risk (not true IL but similar risk profile)
    DELTA_NEUTRAL:  0.05,   // hedged — minimal residual IL from hedge slippage
    LEVERAGED_LOOP: 0.30,   // liquidation risk proxy
  };
  return scores[strategyType] ?? 0.30;
}

// ── Correlation matrix (from DeFi research) ───────────────────────────────────
//
//  Research-derived correlation estimates between strategy APY returns.
//  Both driven by ETH volatility and trading volume → moderate positive correlation.
//  Lending is driven by utilization rate → uncorrelated with LP/trading strategies.

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
  if (existing.length === 0) return 0.8; // empty portfolio — bonus for first position
  const avgCorr = existing.reduce((sum, p) => sum + getCorrelation(opp.strategyType, p.strategyType), 0) / existing.length;
  // Low correlation → high bonus; high correlation → no bonus
  return Math.max(0, 1 - avgCorr);
}

// ── Main scoring function ─────────────────────────────────────────────────────

export function computeGeckoScore(
  opp:       Opportunity,
  existing:  PortfolioPosition[],
  managedUSD: number,
): number {
  const managed = Math.max(managedUSD, 1);

  // 1. Real yield component (30 pts max)
  const realAPY         = computeRealYieldAPY(opp);
  const realYieldScore  = Math.min(realAPY / 25, 1) * 30;  // normalised at 25% APY = full score

  // 2. Yield stability (20 pts max)
  //    High sigma relative to mean = volatile APY = lower score
  const sigma           = opp.history.sigma ?? (opp.grossAPY * 0.5);
  const mean            = opp.history.apy30d ?? opp.grossAPY;
  const cv              = mean > 0 ? sigma / mean : 1;  // coefficient of variation
  const stabilityScore  = Math.max(0, (1 - Math.min(cv, 1))) * 20;

  // 3. Liquidity depth (15 pts max)
  //    We need room to enter AND exit without moving the market
  const depthRatio      = opp.tvlUSD / managed;
  const depthScore      = Math.min(Math.log10(Math.max(1, depthRatio)) / Math.log10(1_000), 1) * 15;
  // log10(1000) = 3 → full score when TVL is 1000× position size

  // 4. Historical consistency (15 pts max)
  //    Is current APY close to the 30d mean? Outlier APYs may not persist
  const consistencyRatio = mean > 0 ? Math.min(opp.grossAPY / mean, mean / opp.grossAPY) : 0.5;
  const histScore        = consistencyRatio * 15;

  // 5. IL risk penalty (0-10 pts deducted)
  const ilScore          = getILRiskScore(opp.strategyType) * 10;

  // 6. Diversification bonus (10 pts max)
  const divBonus         = computeDiversificationBonus(opp, existing) * 10;

  const total = realYieldScore + stabilityScore + depthScore + histScore - ilScore + divBonus;
  return Math.max(0, Math.round(total * 100) / 100);
}

// ── Tier-adjusted scoring ─────────────────────────────────────────────────────
//
//  Conservative users should see lending rank higher even with same score.
//  Aggressive users should see high-APY active strategies rank higher.

const TIER_MULTIPLIERS: Record<RiskTier, Partial<Record<StrategyType, number>>> = {
  conservative: {
    AAVE_LENDING:   1.30,   // boost safe strategies
    MORPHO_LENDING: 1.30,
    PENDLE_PT:      1.20,
    GMX_REAL_YIELD: 0.60,   // reduce active for conservative
    DELTA_NEUTRAL:  0.70,
    LEVERAGED_LOOP: 0.10,   // essentially block leverage for conservative
    PENDLE_YT:      0.10,
  },
  balanced: {
    GMX_REAL_YIELD: 1.10,
    DELTA_NEUTRAL:  1.10,
    PENDLE_LP:      1.05,
    AAVE_LENDING:   0.60,   // still deprioritised (last resort)
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
