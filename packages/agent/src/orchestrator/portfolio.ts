import * as crypto from 'node:crypto';
import type {
  Opportunity, Portfolio, PortfolioPosition, PortfolioMetrics,
  UserPolicy, RiskTier, StrategyType, AllocationTarget, PnLPoint,
} from './types';
import { applyTierMultiplier } from './gecko-scorer';

// ── Portfolio Manager ─────────────────────────────────────────────────────────
//
//  Manages multi-position portfolios. Each user holds 2-4 positions
//  simultaneously across uncorrelated strategies.
//
//  Allocation targets per tier (research-backed):
//
//    Conservative  — zero IL, stable real yield
//      50% Morpho/Aave (best lending rate)
//      30% Aave (safe haven)
//      20% Pendle PT (fixed yield bond)
//
//    Balanced      — stable + active real yield
//      40% GMX ETH/USDC (trader fees)
//      25% Delta-neutral Uni V3 (LP fees, hedged)
//      20% Morpho/Aave (floor)
//      15% Pendle LP (yield market fees)
//
//    Aggressive    — active strategies, higher APY, managed IL
//      40% Delta-neutral concentrated LP
//      35% GMX ETH/USDC
//      15% Pendle LP
//      10% Aave (emergency floor, minimal)
//
//    Advanced      — full sophistication, leverage, speculation
//      40% Leveraged Aave loop
//      30% Delta-neutral
//      20% Pendle YT
//      10% GMX
// ─────────────────────────────────────────────────────────────────────────────

const TIER_TARGETS: Record<RiskTier, AllocationTarget[]> = {
  conservative: [
    { strategyType: 'MORPHO_LENDING', minPct: 30, maxPct: 60, targetPct: 50, priority: 1 },
    { strategyType: 'AAVE_LENDING',   minPct: 20, maxPct: 40, targetPct: 30, priority: 2 },
    { strategyType: 'PENDLE_PT',      minPct: 10, maxPct: 30, targetPct: 20, priority: 3 },
  ],
  balanced: [
    { strategyType: 'GMX_REAL_YIELD', minPct: 25, maxPct: 55, targetPct: 40, priority: 1 },
    { strategyType: 'DELTA_NEUTRAL',  minPct: 15, maxPct: 35, targetPct: 25, priority: 2 },
    { strategyType: 'MORPHO_LENDING', minPct: 10, maxPct: 30, targetPct: 20, priority: 3 },
    { strategyType: 'PENDLE_LP',      minPct: 5,  maxPct: 25, targetPct: 15, priority: 4 },
  ],
  aggressive: [
    { strategyType: 'DELTA_NEUTRAL',  minPct: 25, maxPct: 55, targetPct: 40, priority: 1 },
    { strategyType: 'GMX_REAL_YIELD', minPct: 20, maxPct: 45, targetPct: 35, priority: 2 },
    { strategyType: 'PENDLE_LP',      minPct: 5,  maxPct: 25, targetPct: 15, priority: 3 },
    { strategyType: 'AAVE_LENDING',   minPct: 5,  maxPct: 15, targetPct: 10, priority: 4 },
  ],
  advanced: [
    { strategyType: 'LEVERAGED_LOOP', minPct: 25, maxPct: 50, targetPct: 40, priority: 1 },
    { strategyType: 'DELTA_NEUTRAL',  minPct: 20, maxPct: 40, targetPct: 30, priority: 2 },
    { strategyType: 'PENDLE_YT',      minPct: 10, maxPct: 25, targetPct: 20, priority: 3 },
    { strategyType: 'GMX_REAL_YIELD', minPct: 5,  maxPct: 20, targetPct: 10, priority: 4 },
  ],
};

// ── Allocation planning ───────────────────────────────────────────────────────

export interface AllocationPlan {
  allocations: { opportunity: Opportunity; allocationPct: number; allocationUSD: number }[];
  totalPct:    number;
  warnings:    string[];
}

export function planAllocation(
  opportunities: Opportunity[],
  policy:        UserPolicy,
): AllocationPlan {
  const targets   = TIER_TARGETS[policy.riskTier];
  const warnings: string[] = [];
  const allocations: AllocationPlan['allocations'] = [];
  let remainingPct = 100;

  for (const target of targets.sort((a, b) => a.priority - b.priority)) {
    // Find best opportunity matching this strategy type
    const match = opportunities.find(o =>
      o.strategyType === target.strategyType &&
      o.netAPY >= policy.minAPY * 0.8  // allow 20% below minAPY for portfolio slots
    );

    if (!match) {
      // Try fallback: if Morpho not available, use Aave
      const fallbackType = getFallback(target.strategyType);
      const fallback = fallbackType
        ? opportunities.find(o => o.strategyType === fallbackType && o.netAPY >= policy.minAPY * 0.6)
        : null;

      if (fallback) {
        warnings.push(`No ${target.strategyType} opportunity — using ${fallbackType} as fallback`);
        allocations.push({
          opportunity:   fallback,
          allocationPct: Math.min(target.targetPct, remainingPct),
          allocationUSD: policy.managedUSD * Math.min(target.targetPct, remainingPct) / 100,
        });
        remainingPct -= Math.min(target.targetPct, remainingPct);
      } else {
        warnings.push(`No qualifying opportunity for ${target.strategyType} — skipping slot`);
      }
      continue;
    }

    const pct = Math.min(target.targetPct, remainingPct);
    allocations.push({
      opportunity:   match,
      allocationPct: pct,
      allocationUSD: policy.managedUSD * pct / 100,
    });
    remainingPct -= pct;

    if (remainingPct <= 0) break;
  }

  // If remaining capital exists, add it to the highest-scoring existing slot
  if (remainingPct > 1 && allocations.length > 0) {
    const best = allocations.reduce((a, b) =>
      b.opportunity.geckoScore > a.opportunity.geckoScore ? b : a
    );
    best.allocationPct += remainingPct;
    best.allocationUSD  = policy.managedUSD * best.allocationPct / 100;
  }

  return {
    allocations,
    totalPct: allocations.reduce((s, a) => s + a.allocationPct, 0),
    warnings,
  };
}

function getFallback(strategyType: StrategyType): StrategyType | null {
  const fallbacks: Partial<Record<StrategyType, StrategyType>> = {
    MORPHO_LENDING: 'AAVE_LENDING',
    PENDLE_PT:      'AAVE_LENDING',
    PENDLE_LP:      'DELTA_NEUTRAL',
    PENDLE_YT:      'PENDLE_LP',
    LEVERAGED_LOOP: 'DELTA_NEUTRAL',
  };
  return fallbacks[strategyType] ?? null;
}

// ── Portfolio construction ────────────────────────────────────────────────────

export function openPortfolio(
  plan:   AllocationPlan,
  policy: UserPolicy,
): Portfolio {
  const now = Date.now();

  const positions: PortfolioPosition[] = plan.allocations.map(a => ({
    id:              crypto.randomUUID(),
    venueId:         a.opportunity.id,
    venueAddress:    a.opportunity.address,
    venueName:       `${a.opportunity.protocol} ${a.opportunity.pool}`,
    protocol:        a.opportunity.protocol,
    strategyType:    a.opportunity.strategyType,
    allocationPct:   a.allocationPct,
    allocationUSD:   a.allocationUSD,
    geckoScore:      a.opportunity.geckoScore,

    entryAPY:        a.opportunity.grossAPY,
    entryUSD:        a.allocationUSD,
    entryTime:       now,
    entryPriceUSD:   0,   // set by orchestrator from Chainlink at genesis

    currentAPY:      a.opportunity.grossAPY,
    currentNetAPY:   a.opportunity.netAPY,
    currentUSD:      a.allocationUSD,
    incomeEarnedUSD: 0,
    totalReturnUSD:  0,
    totalReturnPct:  0,
    effectiveAPY:    a.opportunity.netAPY,

    ilPct:           0,
    ilUSD:           0,
    ilCategory:      'none',
    feesEarnedUSD:   0,
    netAfterILUSD:   0,
    isILProfitable:  true,
    ilUnprofTicks:   0,

    pendingRewardsUSD: 0,
    lastHarvestAt:   now,

    peakUSD:         a.allocationUSD,
    drawdownPct:     0,
    daysHeld:        0,

    simulated:       true,
  }));

  return {
    positions,
    metrics:         computePortfolioMetrics(positions),
    lastRebalanceAt: now,
    updatedAt:       now,
  };
}

// ── Portfolio metrics ─────────────────────────────────────────────────────────

export function computePortfolioMetrics(positions: PortfolioPosition[]): PortfolioMetrics {
  if (positions.length === 0) {
    return {
      totalValueUSD: 0, totalEntryUSD: 0, totalReturnUSD: 0,
      totalReturnPct: 0, incomeEarnedUSD: 0, totalILUSD: 0,
      weightedNetAPY: 0, realYieldAPY: 0,
      peakValueUSD: 0, drawdownPct: 0,
      diversificationScore: 0, ilCoveredByFees: true,
    };
  }

  const totalValueUSD   = positions.reduce((s, p) => s + p.currentUSD, 0);
  const totalEntryUSD   = positions.reduce((s, p) => s + p.entryUSD, 0);
  const incomeEarnedUSD = positions.reduce((s, p) => s + p.incomeEarnedUSD, 0);
  const totalILUSD      = positions.reduce((s, p) => s + p.ilUSD, 0);
  const totalReturnUSD  = totalValueUSD + incomeEarnedUSD - totalEntryUSD;
  const totalReturnPct  = totalEntryUSD > 0 ? (totalReturnUSD / totalEntryUSD) * 100 : 0;
  const peakValueUSD    = positions.reduce((s, p) => s + p.peakUSD, 0);
  const drawdownPct     = peakValueUSD > 0 ? ((peakValueUSD - totalValueUSD) / peakValueUSD) * 100 : 0;
  const totalFeesEarned = positions.reduce((s, p) => s + p.feesEarnedUSD, 0);

  // Capital-weighted APY
  const weightedNetAPY = totalEntryUSD > 0
    ? positions.reduce((s, p) => s + p.currentNetAPY * (p.allocationUSD / totalEntryUSD), 0)
    : 0;

  const realYieldAPY = totalEntryUSD > 0
    ? positions.reduce((s, p) => s + (p.currentNetAPY * 0.85) * (p.allocationUSD / totalEntryUSD), 0)
    : 0;

  // Diversification score: average pairwise correlation (lower = more diversified)
  const divScore = positions.length <= 1 ? 0 : computeDiversificationScore(positions);

  return {
    totalValueUSD,
    totalEntryUSD,
    totalReturnUSD,
    totalReturnPct,
    incomeEarnedUSD,
    totalILUSD,
    weightedNetAPY,
    realYieldAPY,
    peakValueUSD,
    drawdownPct,
    diversificationScore: divScore,
    ilCoveredByFees: Math.abs(totalILUSD) < totalFeesEarned,
  };
}

// ── Diversification score ─────────────────────────────────────────────────────

const CORR: Partial<Record<StrategyType, Partial<Record<StrategyType, number>>>> = {
  GMX_REAL_YIELD:  { DELTA_NEUTRAL: 0.40, AAVE_LENDING: 0.20, MORPHO_LENDING: 0.20, PENDLE_LP: 0.25, PENDLE_PT: 0.10, PENDLE_YT: 0.30, LEVERAGED_LOOP: 0.15 },
  DELTA_NEUTRAL:   { AAVE_LENDING: 0.15, MORPHO_LENDING: 0.15, PENDLE_LP: 0.35 },
  AAVE_LENDING:    { MORPHO_LENDING: 0.85 },
  MORPHO_LENDING:  { PENDLE_PT: 0.60 },
};

function pairCorrelation(a: StrategyType, b: StrategyType): number {
  if (a === b) return 1.0;
  return CORR[a]?.[b] ?? CORR[b]?.[a] ?? 0.30;
}

function computeDiversificationScore(positions: PortfolioPosition[]): number {
  let totalCorr = 0;
  let pairs     = 0;
  for (let i = 0; i < positions.length; i++) {
    for (let j = i + 1; j < positions.length; j++) {
      totalCorr += pairCorrelation(positions[i].strategyType, positions[j].strategyType);
      pairs++;
    }
  }
  if (pairs === 0) return 0;
  const avgCorr = totalCorr / pairs;
  return Math.max(0, Math.min(1, 1 - avgCorr)); // 1 = fully uncorrelated, 0 = fully correlated
}

// ── Rebalance detection ───────────────────────────────────────────────────────
//
//  A rebalance is needed when:
//    1. A position has drifted >10% from its target allocation
//    2. A new significantly better opportunity exists (GeckoScore +15% better)
//    3. A position has triggered an IL exit signal

export interface RebalanceCheck {
  needsRebalance:  boolean;
  reasons:         string[];
  driftedPositions: { positionId: string; currentPct: number; targetPct: number; drift: number }[];
}

export function checkRebalanceNeeded(
  portfolio:         Portfolio,
  opportunities:     Opportunity[],
  policy:            UserPolicy,
): RebalanceCheck {
  const reasons: string[]     = [];
  const drifted: RebalanceCheck['driftedPositions'] = [];
  const totalUSD = portfolio.metrics.totalValueUSD || 1;

  for (const pos of portfolio.positions) {
    const currentPct = (pos.currentUSD / totalUSD) * 100;
    const drift      = Math.abs(currentPct - pos.allocationPct);

    if (drift > 10) {
      drifted.push({ positionId: pos.id, currentPct, targetPct: pos.allocationPct, drift });
      reasons.push(`${pos.venueName} drifted ${drift.toFixed(1)}% from target`);
    }
  }

  // Check if a significantly better opportunity exists for any slot
  for (const pos of portfolio.positions) {
    const better = opportunities.find(o =>
      o.strategyType === pos.strategyType &&
      o.geckoScore > pos.geckoScore * 1.15 &&  // 15% better GeckoScore
      o.id !== pos.venueId
    );
    if (better) {
      reasons.push(`Better ${pos.strategyType} opportunity: ${better.protocol} ${better.pool} (score +${((better.geckoScore / pos.geckoScore - 1) * 100).toFixed(0)}%)`);
    }
  }

  return {
    needsRebalance: reasons.length > 0,
    reasons,
    driftedPositions: drifted,
  };
}

// ── Update portfolio after tick ───────────────────────────────────────────────

export function updatePortfolio(
  portfolio:     Portfolio,
  updatedPositions: PortfolioPosition[],
): Portfolio {
  return {
    ...portfolio,
    positions: updatedPositions,
    metrics:   computePortfolioMetrics(updatedPositions),
    updatedAt: Date.now(),
  };
}

// ── P&L point for chart ───────────────────────────────────────────────────────

export function buildPnLPoint(portfolio: Portfolio): PnLPoint {
  const { metrics: m } = portfolio;
  return {
    ts:        Date.now(),
    totalUSD:  m.totalValueUSD + m.incomeEarnedUSD,
    navUSD:    m.totalValueUSD,
    incomeUSD: m.incomeEarnedUSD,
    ilUSD:     m.totalILUSD,
    netUSD:    m.incomeEarnedUSD + m.totalILUSD,
  };
}
