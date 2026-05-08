import type { StrategyType, ILCategory, Position, PortfolioPosition } from './types';

// ── IL Engine ─────────────────────────────────────────────────────────────────
//
//  Impermanent Loss calculation, break-even monitoring, and hedge tracking.
//
//  Standard AMM IL formula (Uniswap V2 / wide V3):
//    P   = currentPrice / entryPrice
//    IL  = 2√P / (1 + P) − 1          (always ≤ 0)
//
//  Concentrated LP (Uniswap V3 tight range) — amplification:
//    rangeWidth    = √(priceUpper / priceLower)
//    amplification = 2 / (rangeWidth − 1)    (higher for tighter ranges)
//    IL_conc       = IL_standard × amplification
//
//  Verified IL values (standard AMM):
//    P=1.10 (+10% move):  -0.11%    P=0.90 (-10% move):  -0.11%
//    P=1.25 (+25% move):  -0.62%    P=0.80 (-20% move):  -0.62% (symmetric)
//    P=1.50 (+50% move):  -2.02%    P=2.00 (+100% move): -5.72%
//    P=3.00 (+200% move): -13.4%    P=4.00 (+300% move): -20.1%
//
//  Concentrated amplification uses capital efficiency formula:
//    amplification = 1 / (1 - sqrt(priceLower/priceUpper))
//    ±10% range: ~10.5×    ±20% range: ~5.7×    ±5% range: ~20×
//
//  Delta-neutral hedge:
//    hedgeRatio = currentHedgeSize / requiredHedgeSize
//    Required   = LP token0 exposure (amount0 × currentPrice)
//    Rebalance when hedgeRatio < 0.85 or > 1.15  (15% tolerance)
// ─────────────────────────────────────────────────────────────────────────────

// ── Strategy IL classification ────────────────────────────────────────────────

const STRATEGY_HAS_IL: Record<StrategyType, boolean> = {
  AAVE_LENDING:   false,
  MORPHO_LENDING: false,
  PENDLE_PT:      false,
  PENDLE_LP:      true,   // low — PT and underlying highly correlated pre-maturity
  PENDLE_YT:      false,  // not traditional IL, but time decay
  GMX_REAL_YIELD: false,  // trader PnL risk handled separately
  DELTA_NEUTRAL:  false,  // hedged — near-zero residual
  LEVERAGED_LOOP: false,  // liquidation risk, not IL
};

// ── Core IL calculation ───────────────────────────────────────────────────────

export interface ILResult {
  ilPct:       number;       // fraction (≤ 0, e.g. -0.057 = -5.7%)
  ilUSD:       number;       // absolute USD loss (≤ 0)
  ilCategory:  ILCategory;
  amplified:   boolean;      // was concentration amplification applied?
  priceRatio:  number;       // currentPrice / entryPrice
}

export function calculateIL(
  strategyType:  StrategyType,
  positionUSD:   number,
  entryPriceUSD: number,
  currentPriceUSD: number,
  options?: {
    tickLower?:  number;
    tickUpper?:  number;
  },
): ILResult {
  const noIL: ILResult = { ilPct: 0, ilUSD: 0, ilCategory: 'none', amplified: false, priceRatio: 1 };

  if (!STRATEGY_HAS_IL[strategyType] && strategyType !== 'PENDLE_LP') return noIL;
  if (entryPriceUSD <= 0 || currentPriceUSD <= 0) return noIL;

  const P = currentPriceUSD / entryPriceUSD;
  if (Math.abs(P - 1) < 0.0001) return { ...noIL, priceRatio: P };

  // Standard AMM IL formula
  const standardIL = (2 * Math.sqrt(P) / (1 + P)) - 1;  // always ≤ 0

  // Concentrated LP amplification (if tick range provided)
  let ilPct      = standardIL;
  let amplified  = false;

  if (options?.tickLower !== undefined && options?.tickUpper !== undefined) {
    const priceLower = Math.pow(1.0001, options.tickLower);
    const priceUpper = Math.pow(1.0001, options.tickUpper);

    if (priceUpper > priceLower && priceLower > 0) {
      // Capital efficiency formula: derived from Uniswap V3 liquidity math.
      // Amplification ≈ 1 / (1 - sqrt(priceLower/priceUpper))
      // ±10% range → ~10.5×   ±20% → ~5.7×   ±5% → ~20×
      const sqrtRatio    = Math.sqrt(priceLower / priceUpper);
      const denominator  = 1 - sqrtRatio;
      if (denominator > 0.001) {
        const amplification = Math.min(1 / denominator, 50); // cap at 50× for extreme ranges
        ilPct     = Math.max(-1, standardIL * amplification);
        amplified = true;
      }
    }
  }

  const ilUSD     = positionUSD * ilPct;   // negative number
  const ilAbs     = Math.abs(ilPct);
  const ilCategory: ILCategory =
    ilAbs < 0.005 ? 'none'    // < 0.5%
    : ilAbs < 0.02 ? 'low'    // 0.5–2%
    : ilAbs < 0.08 ? 'medium' // 2–8%
    : 'high';                 // > 8%

  return { ilPct, ilUSD, ilCategory, amplified, priceRatio: P };
}

// ── Break-even monitor ────────────────────────────────────────────────────────
//
//  Determines whether a position is net-profitable after accounting for IL.
//  This is the key signal for whether an LP position should be kept or exited.

export interface BreakEvenResult {
  feesEarned:    number;    // USD earned from fees/interest
  ilLoss:        number;    // absolute IL loss (positive number for clarity)
  netResult:     number;    // feesEarned - ilLoss (positive = profitable)
  isProfitable:  boolean;
  coverageRatio: number;    // feesEarned / ilLoss (>1 = profitable; ideal >1.5)
  daysToBreakEven: number | null;  // if currently unprofitable, days to recover
  feeRatePerDay: number;    // USD fees per day
  ilRatePerDay:  number;    // USD IL accumulation per day (positive = getting worse)
}

export function checkBreakEven(
  feesEarnedUSD: number,
  ilUSD:         number,     // negative number
  daysHeld:      number,
  positionUSD:   number,
): BreakEvenResult {
  const ilLoss     = Math.abs(ilUSD);
  const netResult  = feesEarnedUSD - ilLoss;
  const isProfitable = netResult >= 0;
  const coverageRatio = ilLoss > 0 ? feesEarnedUSD / ilLoss : Infinity;

  const days = Math.max(daysHeld, 0.01);
  const feeRatePerDay = feesEarnedUSD / days;
  const ilRatePerDay  = ilLoss / days;

  // Days to recover: IL is treated as fixed at current value (price has already moved).
  // Further price moves add more IL, but the base case assumes price stabilises here.
  // t = (ilLoss - feesEarned) / feeRatePerDay  (simple: just cover the deficit with fees)
  let daysToBreakEven: number | null = null;
  if (!isProfitable && feeRatePerDay > 0) {
    const deficit   = ilLoss - feesEarnedUSD;
    daysToBreakEven = deficit / feeRatePerDay;
  }

  return { feesEarned: feesEarnedUSD, ilLoss, netResult, isProfitable, coverageRatio, daysToBreakEven, feeRatePerDay, ilRatePerDay };
}

// ── Unprofitable-tick counter ─────────────────────────────────────────────────
//
//  IL exit signal: if fees-vs-IL has been negative for N consecutive ticks,
//  position is deteriorating and should migrate.

const IL_EXIT_TICKS = 3;   // exit after 3 consecutive unprofitable ticks

export function shouldExitForIL(
  position:  Pick<PortfolioPosition, 'ilUnprofTicks' | 'ilPct' | 'feesEarnedUSD' | 'strategyType'>,
): { shouldExit: boolean; reason: string } {
  if (!STRATEGY_HAS_IL[position.strategyType]) {
    return { shouldExit: false, reason: 'Strategy has no IL' };
  }

  if (position.ilUnprofTicks >= IL_EXIT_TICKS) {
    return {
      shouldExit: true,
      reason: `IL exceeded fee income for ${position.ilUnprofTicks} consecutive ticks — migrating to protect capital`,
    };
  }

  // Acute IL: price moved > 30% from entry → check if fees can possibly recover
  if (Math.abs(position.ilPct) > 0.20 && position.feesEarnedUSD < Math.abs(position.ilPct) * 0.1) {
    return {
      shouldExit: true,
      reason: `Acute IL: ${(Math.abs(position.ilPct) * 100).toFixed(1)}% IL with minimal fee coverage — exiting`,
    };
  }

  return { shouldExit: false, reason: '' };
}

// ── Delta-neutral hedge monitor ───────────────────────────────────────────────
//
//  For DELTA_NEUTRAL positions: verify the perp short is properly sized
//  relative to the LP position's token0 exposure.
//
//  When price moves, the LP's token ratio changes:
//    In-range:  both tokens present, amount0 decreases as price rises
//    Out-range: fully in one token, hedge may be over/under-sized
//
//  Optimal hedge = partial (60-70% of exposure), not 100%.
//  Research shows partial hedging outperforms both unhedged and fully-hedged.

export interface HedgeStatus {
  isHedged:    boolean;
  hedgeRatio:  number;       // actual / required
  hedgeDrift:  number;       // |1 - hedgeRatio|
  needsRebalance: boolean;
  recommendation: string;
}

export function checkHedgeStatus(
  lpToken0ExposureUSD: number,  // current token0 value in LP position
  perpShortSizeUSD:    number,  // current perp short notional
  targetHedgeRatio:    number = 0.65,   // 65% hedge — research-optimal
  rebalanceThreshold:  number = 0.15,   // rebalance if drifts ±15%
): HedgeStatus {
  if (lpToken0ExposureUSD <= 0) {
    return { isHedged: false, hedgeRatio: 0, hedgeDrift: 1, needsRebalance: false, recommendation: 'No LP exposure to hedge' };
  }

  const requiredHedge = lpToken0ExposureUSD * targetHedgeRatio;
  const hedgeRatio    = perpShortSizeUSD > 0 ? perpShortSizeUSD / requiredHedge : 0;
  const hedgeDrift    = Math.abs(1 - hedgeRatio);
  const needsRebalance = hedgeDrift > rebalanceThreshold;

  let recommendation = '';
  if (!perpShortSizeUSD || perpShortSizeUSD === 0) {
    recommendation = 'Open perp short — position is fully exposed to price risk';
  } else if (hedgeRatio < 1 - rebalanceThreshold) {
    const deficit = requiredHedge - perpShortSizeUSD;
    recommendation = `Under-hedged: increase short by $${deficit.toFixed(0)}`;
  } else if (hedgeRatio > 1 + rebalanceThreshold) {
    const excess = perpShortSizeUSD - requiredHedge;
    recommendation = `Over-hedged: reduce short by $${excess.toFixed(0)}`;
  } else {
    recommendation = `Hedge healthy (${(hedgeRatio * 100).toFixed(1)}% of target ${(targetHedgeRatio * 100).toFixed(0)}%)`;
  }

  return {
    isHedged:       perpShortSizeUSD > 0,
    hedgeRatio,
    hedgeDrift,
    needsRebalance,
    recommendation,
  };
}

// ── Apply IL update to position ───────────────────────────────────────────────
//
//  Called every tick to update a position's IL fields from live price data.

export function applyILUpdate(
  position:        Position,
  currentPriceUSD: number,
  feesAccruedUSD?: number,  // new fees since last tick (added to existing)
): Partial<Position> {
  const il = calculateIL(
    position.strategyType,
    position.entryUSD,
    position.entryPriceUSD,
    currentPriceUSD,
  );

  const newFeesEarned = position.feesEarnedUSD + (feesAccruedUSD ?? 0);
  const newILUSD      = il.ilUSD;  // negative
  const netAfterIL    = newFeesEarned + newILUSD;
  const isProfitable  = netAfterIL >= 0;

  // Increment unprofitable-tick counter (used for IL exit signal)
  const ilUnprofTicks = (STRATEGY_HAS_IL[position.strategyType] && !isProfitable)
    ? position.ilUnprofTicks + 1
    : 0;

  return {
    ilPct:          il.ilPct,
    ilUSD:          il.ilUSD,
    ilCategory:     il.ilCategory,
    feesEarnedUSD:  newFeesEarned,
    netAfterILUSD:  netAfterIL,
    isILProfitable: isProfitable,
    ilUnprofTicks,
  };
}
