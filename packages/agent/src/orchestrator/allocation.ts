import type {
  Opportunity, Position, UserPolicy,
  AllocationDecision, ActionType,
} from './types';

// ── Allocation Engine ─────────────────────────────────────────────────────────
//
//  Priority order for active yield (as per product direction):
//    1. GMX Real Yield   — trader fee income, real yield
//    2. Delta-Neutral LP — LP fees with price hedge
//    3. Aave Lending     — last resort only, safe haven
//
//  Rules:
//    GENESIS:      no position + qualifying opportunity found
//    MIGRATE:      better opportunity available above threshold uplift
//    SAFETY_EXIT:  circuit breaker RED or APY fell below minAPY
//    HOLD:         current position still best
// ─────────────────────────────────────────────────────────────────────────────

export function decideAllocation(
  opportunities:    Opportunity[],
  policy:           UserPolicy,
  position:         Position | null,
  circuitBreakerRed: boolean,
): AllocationDecision {

  // Filter to opportunities above minAPY that pass threshold
  const valid = opportunities.filter(o =>
    o.netAPY >= policy.minAPY &&
    o.tvlUSD >= policy.managedUSD * 50  // pool must be at least 50× our size
  );

  const best = valid[0] ?? null;

  // ── SAFETY EXIT: circuit breaker or APY collapse ───────────────────────────
  if (circuitBreakerRed && position) {
    const safeHaven = opportunities.find(o => o.strategyType === 'AAVE_LENDING') ?? null;
    return {
      action:             'SAFETY_EXIT',
      targetOpportunity:  safeHaven,
      currentOpportunity: position ? opportunityFromPosition(position, opportunities) : null,
      reason:             'Circuit breaker triggered — moving to safe haven',
      upliftPct:          0,
    };
  }

  // ── GENESIS: no position, deploy to best non-Aave first ───────────────────
  if (!position) {
    // Prefer active yield (GMX, delta-neutral) over Aave on genesis
    const activeFirst = valid.find(o => o.strategyType !== 'AAVE_LENDING') ?? best;

    if (!activeFirst) {
      // Nothing passes minAPY — fallback to Aave if available
      const aave = opportunities.find(o => o.strategyType === 'AAVE_LENDING');
      if (aave) {
        return {
          action: 'GENESIS', targetOpportunity: aave,
          currentOpportunity: null,
          reason: 'No active yield meets minAPY — deploying to Aave safe haven',
          upliftPct: 0,
        };
      }
      return {
        action: 'HOLD', targetOpportunity: null, currentOpportunity: null,
        reason: 'No qualifying opportunities found — waiting',
        upliftPct: 0,
      };
    }

    return {
      action: 'GENESIS', targetOpportunity: activeFirst,
      currentOpportunity: null,
      reason: `Deploying to ${activeFirst.protocol} ${activeFirst.pool} @ ${activeFirst.netAPY.toFixed(2)}% net APY`,
      upliftPct: activeFirst.netAPY,
    };
  }

  // ── With existing position ─────────────────────────────────────────────────

  const currentOpp = opportunityFromPosition(position, opportunities);
  const currentAPY = currentOpp?.netAPY ?? position.currentNetAPY;

  // APY fell below minimum — migrate away
  if (currentAPY < policy.minAPY * 0.80) {
    const next = valid.find(o => o.id !== (currentOpp?.id ?? '')) ?? null;
    if (next) {
      return {
        action: 'MIGRATE', targetOpportunity: next,
        currentOpportunity: currentOpp,
        reason: `${position.venueName} APY (${currentAPY.toFixed(1)}%) fell below floor — migrating`,
        upliftPct: next.netAPY - currentAPY,
      };
    }
  }

  // Better opportunity with sufficient uplift — migrate
  if (best && best.id !== (currentOpp?.id ?? '')) {
    const uplift = best.netAPY - currentAPY;
    if (uplift >= policy.migrationThresholdPct) {
      return {
        action: 'MIGRATE', targetOpportunity: best,
        currentOpportunity: currentOpp,
        reason: `+${uplift.toFixed(2)}% uplift available at ${best.protocol} ${best.pool}`,
        upliftPct: uplift,
      };
    }
  }

  // HOLD
  return {
    action: 'HOLD', targetOpportunity: currentOpp,
    currentOpportunity: currentOpp,
    reason: `Holding ${position.venueName} @ ${currentAPY.toFixed(2)}% net APY — no better opportunity (+${((best?.netAPY ?? 0) - currentAPY).toFixed(2)}% uplift below ${policy.migrationThresholdPct}% threshold)`,
    upliftPct: best ? best.netAPY - currentAPY : 0,
  };
}

function opportunityFromPosition(
  position: Position,
  opportunities: Opportunity[],
): Opportunity | null {
  return opportunities.find(o => o.id === position.venueId) ?? null;
}

// ── Safety gate: verify conditions before executing ───────────────────────────

export interface SafetyCheck {
  name:     string;
  passed:   boolean;
  value:    string;
  required: string;
}

export interface SafetyGateResult {
  passed:      boolean;
  checks:      SafetyCheck[];
  abortReason: string | null;
}

export function runSafetyGate(
  target:  Opportunity,
  policy:  UserPolicy,
): SafetyGateResult {
  const checks: SafetyCheck[] = [];

  // 1. APY still above minimum
  const apyOk = target.netAPY >= policy.minAPY;
  checks.push({
    name: 'Net APY floor', passed: apyOk,
    value: `${target.netAPY.toFixed(2)}%`,
    required: `≥ ${policy.minAPY}%`,
  });

  // 2. Pool liquidity: TVL must be at least 50× managed amount
  const minTVL   = policy.managedUSD * 50;
  const tvlOk    = target.tvlUSD >= minTVL;
  checks.push({
    name: 'Pool liquidity', passed: tvlOk,
    value: `$${(target.tvlUSD / 1e6).toFixed(2)}M TVL`,
    required: `≥ $${(minTVL / 1e6).toFixed(2)}M`,
  });

  // 3. OI balance check for GMX (not too skewed)
  let oiOk = true;
  if (target.strategyType === 'GMX_REAL_YIELD' && target.risk.oiBalance !== null) {
    oiOk = !target.risk.oiRiskFlag;
    checks.push({
      name: 'GMX OI balance', passed: oiOk,
      value: `${(target.risk.oiBalance * 100).toFixed(1)}% long`,
      required: '30–70% long',
    });
  }

  // 4. APY not an obvious outlier (>2× 30d mean is suspicious)
  let apyStable = true;
  if (target.history.apy30d && target.history.apy30d > 0) {
    apyStable = target.grossAPY <= target.history.apy30d * 3.0;
    checks.push({
      name: 'APY stability', passed: apyStable,
      value: `${target.grossAPY.toFixed(1)}% vs 30d mean ${target.history.apy30d.toFixed(1)}%`,
      required: '≤ 3× 30d mean',
    });
  }

  const passed      = apyOk && tvlOk && oiOk && apyStable;
  const failed      = checks.filter(c => !c.passed);
  const abortReason = passed ? null : `Failed: ${failed.map(c => c.name).join(', ')}`;

  return { passed, checks, abortReason };
}
