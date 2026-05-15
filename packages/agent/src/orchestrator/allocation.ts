import type {
  Opportunity, Portfolio, UserPolicy, PortfolioPosition,
  AllocationDecision, ActionType, CircuitBreaker,
} from './types';
import { planAllocation } from './portfolio';
import { shouldExitForIL } from './il-engine';
import { evaluatePortfolioHarvests } from './compounder';

export function decideAllocation(
  opportunities: Opportunity[],
  policy: UserPolicy,
  portfolio: Portfolio | null,
  circuitBreakerRed: boolean,
): AllocationDecision {
  const topOpp = opportunities[0] ?? null;

  
  if (circuitBreakerRed && portfolio) {
    
    const idealSafeHaven = opportunities.find(o =>
      o.strategyType === 'AAVE_LENDING' || o.strategyType === 'MORPHO_LENDING'
    ) ?? null;

    let safeHaven = idealSafeHaven;
    let safeHavenReason = 'Circuit breaker RED — moving to safe haven to protect capital';

    if (!safeHaven) {
      
      
      safeHaven = opportunities[0] ?? null;
      if (safeHaven) {
        console.warn(
          `[Allocation] WARN: ideal safe haven (Aave/Morpho) unavailable — using ${safeHaven.protocol} ${safeHaven.pool} as fallback safe haven`,
        );
        safeHavenReason = `Circuit breaker RED — ideal safe haven unavailable, falling back to highest-ranked opportunity (${safeHaven.protocol} ${safeHaven.pool})`;
      }
      
    }

    if (!safeHaven) {
      
      return {
        action: 'HOLD', targetOpportunity: null, currentOpportunity: topCurrentOpp(portfolio, opportunities),
        reason: 'Circuit breaker RED but no opportunities available — holding until market recovers',
        upliftPct: 0,
      };
    }

    return {
      action: 'SAFETY_EXIT',
      targetOpportunity: safeHaven,
      currentOpportunity: topCurrentOpp(portfolio, opportunities),
      reason: safeHavenReason,
      upliftPct: 0,
    };
  }

  
  if (portfolio) {
    const harvests = evaluatePortfolioHarvests(portfolio.positions);
    if (harvests.length > 0) {
      const best = harvests[0];
      return {
        action: 'HARVEST',
        targetOpportunity: opportunities.find(o => o.id === portfolio.positions.find(p => p.id === best.positionId)?.venueId) ?? null,
        currentOpportunity: topCurrentOpp(portfolio, opportunities),
        reason: best.reason,
        upliftPct: 0,
      };
    }
  }

  
  if (!portfolio) {
    
    
    
    const nowMs = Date.now();
    const validOpps = opportunities.filter(o => {
      if (o.netAPY < policy.minAPY * 0.8) return false;
      if ((o.strategyType === 'PENDLE_PT' || o.strategyType === 'PENDLE_YT') && o.maturityDate) {
        const maturityMs = o.maturityDate * 1_000;
        
        
        const sevenDaysMs = 7 * 24 * 60 * 60 * 1_000;
        if (maturityMs - nowMs < sevenDaysMs) return false;
      }
      return true;
    });

    if (validOpps.length === 0) {
      
      const aave = opportunities.find(o => o.strategyType === 'AAVE_LENDING');
      if (aave) {
        return {
          action: 'GENESIS', targetOpportunity: aave,
          currentOpportunity: null,
          reason: 'No active strategy meets minAPY — deploying to Aave safe haven',
          upliftPct: 0,
        };
      }
      return {
        action: 'HOLD', targetOpportunity: null, currentOpportunity: null,
        reason: 'No qualifying opportunities found — waiting', upliftPct: 0,
      };
    }

    const plan = planAllocation(validOpps, policy);
    if (plan.allocations.length === 0) {
      return {
        action: 'HOLD', targetOpportunity: null, currentOpportunity: null,
        reason: 'Allocation plan empty — waiting for better conditions', upliftPct: 0,
      };
    }

    const topAlloc = plan.allocations[0];
    return {
      action: 'GENESIS',
      targetOpportunity: topAlloc.opportunity,
      currentOpportunity: null,
      reason: `Opening ${plan.allocations.length}-position portfolio: ${plan.allocations.map(a => `${a.opportunity.strategyType} ${a.allocationPct.toFixed(0)}%`).join(' · ')}`,
      upliftPct: plan.allocations.reduce((s, a) => s + a.opportunity.netAPY * a.allocationPct / 100, 0),
    };
  }

  
  for (const pos of portfolio.positions) {
    const ilCheck = shouldExitForIL(pos);
    if (ilCheck.shouldExit) {
      
      const replacement = opportunities.find(o =>
        o.id !== pos.venueId &&
        o.geckoScore > pos.geckoScore * 0.8 &&  
        o.netAPY >= policy.minAPY * 0.8
      );
      if (replacement) {
        return {
          action: 'MIGRATE',
          targetOpportunity: replacement,
          currentOpportunity: opportunities.find(o => o.id === pos.venueId) ?? null,
          reason: `IL exit on ${pos.venueName}: ${ilCheck.reason} → migrating to ${replacement.protocol} ${replacement.pool}`,
          upliftPct: replacement.netAPY - pos.currentNetAPY,
        };
      }
    }
  }

  
  if (portfolio) {
    
    if (policy.forceMigrateTargetId) {
      const target = opportunities.find(o => o.id === policy.forceMigrateTargetId);
      if (target) {
        return {
          action: 'MIGRATE',
          targetOpportunity: target,
          currentOpportunity: topCurrentOpp(portfolio, opportunities),
          reason: `Forced migration to ${target.protocol} ${target.pool} (manual override)`,
          upliftPct: target.netAPY - (portfolio.metrics.weightedNetAPY ?? 0),
        };
      }
    }

    const currentWeightedAPY = portfolio.metrics.weightedNetAPY;

    
    
    
    
    for (const pos of portfolio.positions) {
      const better = opportunities.find(o =>
        o.strategyType === pos.strategyType &&
        o.id !== pos.venueId &&
        o.netAPY >= policy.minAPY * 0.8
      );
      if (better) {
        const uplift = better.netAPY - pos.currentNetAPY;
        const scoreUpgrade = better.geckoScore > pos.geckoScore * 1.15;
        const bigAPYGap = better.netAPY >= pos.currentNetAPY * 2 && uplift >= policy.migrationThresholdPct;

        if ((scoreUpgrade && uplift >= policy.migrationThresholdPct) || bigAPYGap) {
          return {
            action: 'MIGRATE',
            targetOpportunity: better,
            currentOpportunity: opportunities.find(o => o.id === pos.venueId) ?? null,
            reason: `Migrating: ${pos.venueName} (${pos.currentNetAPY.toFixed(1)}%) → ${better.protocol} ${better.pool} (${better.netAPY.toFixed(1)}%) +${uplift.toFixed(1)}% APY`,
            upliftPct: uplift,
          };
        }
      }
    }

    
    const topName = portfolio.positions
      .sort((a, b) => b.allocationPct - a.allocationPct)[0]?.venueName ?? 'portfolio';
    return {
      action: 'HOLD',
      targetOpportunity: topCurrentOpp(portfolio, opportunities),
      currentOpportunity: topCurrentOpp(portfolio, opportunities),
      reason: `${portfolio.positions.length}-position portfolio healthy — weighted APY ${currentWeightedAPY.toFixed(2)}%, no better opportunities (+${topOpp ? (topOpp.netAPY - currentWeightedAPY).toFixed(2) : 0}% uplift below ${policy.migrationThresholdPct}% threshold)`,
      upliftPct: topOpp ? topOpp.netAPY - currentWeightedAPY : 0,
    };
  }

  return { action: 'HOLD', targetOpportunity: null, currentOpportunity: null, reason: 'Holding', upliftPct: 0 };
}

function topCurrentOpp(portfolio: Portfolio, opportunities: Opportunity[]): Opportunity | null {
  const largest = portfolio.positions.sort((a, b) => b.allocationUSD - a.allocationUSD)[0];
  return largest ? (opportunities.find(o => o.id === largest.venueId) ?? null) : null;
}

export interface SafetyCheck {
  name: string;
  passed: boolean;
  value: string;
  required: string;
}

export interface SafetyGateResult {
  passed: boolean;
  checks: SafetyCheck[];
  abortReason: string | null;
}

export function runSafetyGate(target: Opportunity, policy: UserPolicy): SafetyGateResult {
  const checks: SafetyCheck[] = [];

  const apyOk = target.netAPY >= policy.minAPY * 0.8;
  checks.push({ name: 'Net APY floor', passed: apyOk, value: `${target.netAPY.toFixed(2)}%`, required: `≥ ${(policy.minAPY * 0.8).toFixed(1)}%` });

  const minTVL = policy.managedUSD * 30;
  const tvlOk = target.tvlUSD >= minTVL;
  checks.push({ name: 'Pool liquidity', passed: tvlOk, value: `$${(target.tvlUSD / 1e6).toFixed(2)}M`, required: `≥ $${(minTVL / 1e6).toFixed(2)}M` });

  let oiOk = true;
  if (target.strategyType === 'GMX_REAL_YIELD' && target.risk.oiBalance !== null) {
    oiOk = !target.risk.oiRiskFlag;
    checks.push({ name: 'GMX OI balance', passed: oiOk, value: `${(target.risk.oiBalance * 100).toFixed(1)}% long`, required: '30–70% long' });
  }

  let stabilityOk = true;
  if (target.history.apy30d && target.history.apy30d > 0) {
    stabilityOk = target.grossAPY <= target.history.apy30d * 4;
    checks.push({ name: 'APY stability', passed: stabilityOk, value: `${target.grossAPY.toFixed(1)}% vs 30d ${target.history.apy30d.toFixed(1)}%`, required: '≤ 4× 30d mean' });
  }

  const passed = apyOk && tvlOk && oiOk && stabilityOk;
  const failed = checks.filter(c => !c.passed);

  return { passed, checks, abortReason: passed ? null : `Failed: ${failed.map(c => c.name).join(', ')}` };
}
