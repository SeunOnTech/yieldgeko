import * as crypto from 'node:crypto';
import type {
  Position, Opportunity, UserPolicy,
  CircuitBreaker, CBStatus, ExecutionRecord, ActionType,
} from './types';

// ── Position simulation ───────────────────────────────────────────────────────
//
//  For dev/demo: no real funds on-chain.
//  Position value is simulated from real live APYs.
//
//  income grows linearly: managedUSD × (netAPY/100) × (seconds / 31536000)
//  For GMX: small daily NAV fluctuation simulates trader PnL effect.
// ─────────────────────────────────────────────────────────────────────────────

const TICK_SECONDS = 60;  // matches orchestrator tick interval

interface NavFluctuation {
  venueId:        string;
  lastFluctuation: number;
  cumFluctuation:  number;
}

const fluctMap = new Map<string, NavFluctuation>();

function getGMXNavFactor(venueId: string): number {
  if (!fluctMap.has(venueId)) {
    fluctMap.set(venueId, { venueId, lastFluctuation: 0, cumFluctuation: 1.0 });
  }
  const f = fluctMap.get(venueId)!;
  // ±0.15% per tick when within 60-second windows (realistic for GM tokens)
  const tick = (Math.random() - 0.48) * 0.003;  // slight positive bias
  f.cumFluctuation *= (1 + tick);
  // Clamp: GM tokens realistically trade within ±5% of inception over weeks
  f.cumFluctuation = Math.max(0.95, Math.min(1.08, f.cumFluctuation));
  f.lastFluctuation = tick;
  return f.cumFluctuation;
}

export function updatePosition(
  position:    Position,
  opportunity: Opportunity | null,
  elapsedSec:  number,
): Position {
  const netAPY     = opportunity?.netAPY ?? position.currentNetAPY;
  const grossAPY   = opportunity?.grossAPY ?? position.currentAPY;
  const yearFrac   = elapsedSec / 31_536_000;

  // Compound income on existing position
  const newIncome = position.entryUSD * (netAPY / 100) * yearFrac;
  const totalIncome = position.incomeEarnedUSD + newIncome;

  // NAV: for GMX simulate trader PnL fluctuation on top of entry
  let navUSD = position.entryUSD;
  if (position.strategyType === 'GMX_REAL_YIELD') {
    navUSD = position.entryUSD * getGMXNavFactor(position.venueId);
  }

  const currentUSD     = navUSD + totalIncome;
  const totalReturnUSD = currentUSD - position.entryUSD;
  const totalReturnPct = (totalReturnUSD / position.entryUSD) * 100;
  const daysHeld       = (Date.now() - position.entryTime) / 86_400_000;
  const effectiveAPY   = daysHeld > 0 ? (totalReturnPct / daysHeld) * 365 : netAPY;
  const peakUSD        = Math.max(position.peakUSD, currentUSD);
  const drawdownPct    = peakUSD > 0 ? ((peakUSD - currentUSD) / peakUSD) * 100 : 0;

  return {
    ...position,
    currentAPY:      grossAPY,
    currentNetAPY:   netAPY,
    currentUSD,
    incomeEarnedUSD: totalIncome,
    totalReturnUSD,
    totalReturnPct,
    effectiveAPY,
    peakUSD,
    drawdownPct,
    daysHeld,
  };
}

// ── Circuit Breakers ──────────────────────────────────────────────────────────

export function checkCircuitBreakers(
  position:    Position | null,
  opportunity: Opportunity | null,
  policy:      UserPolicy,
): CircuitBreaker[] {
  const breakers: CircuitBreaker[] = [];

  // ── 1. APY Floor ────────────────────────────────────────────────────────────
  if (position && opportunity) {
    const apy     = opportunity.netAPY;
    const floor   = policy.minAPY;
    let status: CBStatus = 'GREEN';
    if (apy < floor * 0.50) status = 'RED';
    else if (apy < floor * 0.80) status = 'YELLOW';
    breakers.push({
      id: 'apy-floor', name: 'APY Floor',
      status,
      value: `${apy.toFixed(2)}%`,
      threshold: `min ${floor}%`,
      description: 'Current net APY vs user minimum policy',
    });
  }

  // ── 2. Drawdown from peak ───────────────────────────────────────────────────
  if (position) {
    const dd      = position.drawdownPct;
    const maxDD   = policy.maxDrawdownPct;
    let status: CBStatus = 'GREEN';
    if (dd >= maxDD) status = 'RED';
    else if (dd >= maxDD * 0.60) status = 'YELLOW';
    breakers.push({
      id: 'drawdown', name: 'NAV Drawdown',
      status,
      value: `-${dd.toFixed(2)}%`,
      threshold: `max -${maxDD}%`,
      description: 'USD value decline from peak',
    });
  }

  // ── 3. OI Balance (GMX only) ────────────────────────────────────────────────
  if (opportunity?.strategyType === 'GMX_REAL_YIELD' && opportunity.risk.oiBalance !== null) {
    const oi = opportunity.risk.oiBalance;
    const skew = Math.abs(oi - 0.5) * 2;
    let status: CBStatus = 'GREEN';
    if (skew > 0.50) status = 'RED';
    else if (skew > 0.30) status = 'YELLOW';
    breakers.push({
      id: 'oi-balance', name: 'GMX OI Balance',
      status,
      value: `${(oi * 100).toFixed(1)}% long`,
      threshold: '30–70% long = safe',
      description: 'Open interest skew — heavy imbalance means trader wins probable',
    });
  }

  // ── 4. Pool Liquidity ────────────────────────────────────────────────────────
  if (opportunity) {
    const tvl     = opportunity.tvlUSD;
    const minTVL  = policy.managedUSD * 50;
    let status: CBStatus = 'GREEN';
    if (tvl < policy.managedUSD * 10) status = 'RED';
    else if (tvl < minTVL) status = 'YELLOW';
    breakers.push({
      id: 'liquidity', name: 'Pool Liquidity',
      status,
      value: `$${(tvl / 1e6).toFixed(2)}M TVL`,
      threshold: `≥ $${(minTVL / 1e6).toFixed(2)}M`,
      description: 'Pool TVL vs position size — must have room to exit',
    });
  }

  // ── 5. APY Drift from entry ──────────────────────────────────────────────────
  if (position && opportunity) {
    const drift = ((position.entryAPY - opportunity.netAPY) / position.entryAPY) * 100;
    let status: CBStatus = 'GREEN';
    if (drift > 50) status = 'RED';
    else if (drift > 30) status = 'YELLOW';
    breakers.push({
      id: 'apy-drift', name: 'APY Drift from Entry',
      status,
      value: drift > 0 ? `-${drift.toFixed(1)}%` : `+${Math.abs(drift).toFixed(1)}%`,
      threshold: 'max -50% drift',
      description: 'How much APY has changed since position entry',
    });
  }

  // ── 6. Position age ──────────────────────────────────────────────────────────
  if (position) {
    const days   = position.daysHeld;
    const status: CBStatus = days > 30 ? 'YELLOW' : 'GREEN';
    breakers.push({
      id: 'position-age', name: 'Position Age',
      status,
      value: `${days.toFixed(1)} days`,
      threshold: 'review after 30d',
      description: 'Old positions should be re-evaluated against fresh opportunities',
    });
  }

  return breakers;
}

export function hasRedBreaker(breakers: CircuitBreaker[]): boolean {
  return breakers.some(b => b.status === 'RED');
}

// ── Execution record ──────────────────────────────────────────────────────────

export function buildExecutionRecord(
  action:   ActionType,
  from:     string | null,
  to:       string,
  amountUSD: number,
): ExecutionRecord {
  const hash = crypto
    .createHash('sha256')
    .update(`${action}:${from ?? 'null'}:${to}:${amountUSD}:${Date.now()}`)
    .digest('hex');

  return {
    action, from, to, amountUSD,
    simulated:   true,
    receiptHash: `0x${hash}`,
    timestamp:   Date.now(),
  };
}

// ── Build new simulated position ──────────────────────────────────────────────

export function openPosition(
  opportunity: Opportunity,
  policy:      UserPolicy,
): Position {
  return {
    id:              crypto.randomUUID(),
    venueId:         opportunity.id,
    venueName:       `${opportunity.protocol} ${opportunity.pool}`,
    protocol:        opportunity.protocol,
    strategyType:    opportunity.strategyType,
    entryAPY:        opportunity.grossAPY,
    entryUSD:        policy.managedUSD,
    entryTime:       Date.now(),
    currentAPY:      opportunity.grossAPY,
    currentNetAPY:   opportunity.netAPY,
    currentUSD:      policy.managedUSD,
    incomeEarnedUSD: 0,
    totalReturnUSD:  0,
    totalReturnPct:  0,
    effectiveAPY:    opportunity.netAPY,
    peakUSD:         policy.managedUSD,
    drawdownPct:     0,
    daysHeld:        0,
    simulated:       true,
  };
}
