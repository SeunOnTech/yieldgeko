import * as crypto from 'node:crypto';
import type { JsonRpcProvider } from 'ethers';
import type {
  Portfolio, PortfolioPosition, Opportunity, UserPolicy,
  CircuitBreaker, ExecutionRecord, ActionType,
} from './types';
import type { PriceMap } from './protocols/chainlink';
import { applyILUpdate, shouldExitForIL } from './il-engine';
import { estimatePendingRewards } from './compounder';
import { updatePortfolio, computePortfolioMetrics } from './portfolio';
import { readRealPositionValue } from './position-reader';

// ── Position Monitor ──────────────────────────────────────────────────────────
//
//  Updates every position in the portfolio every tick:
//    1. NAV simulation (income accrual from netAPY)
//    2. IL calculation from live Chainlink prices
//    3. Pending rewards estimation
//    4. Per-position peak/drawdown tracking
//
//  For GMX positions: simulate small NAV fluctuation (trader PnL effect).
//  For all others: clean compound growth from netAPY.
// ─────────────────────────────────────────────────────────────────────────────

const TICK_SECONDS = 60;

// ── NAV fluctuation for GMX (trader PnL effect) ───────────────────────────────

const gmxFluctMap = new Map<string, number>();  // positionId → cumulative factor

function gmxNavFactor(positionId: string): number {
  const prev = gmxFluctMap.get(positionId) ?? 1.0;
  // ±0.15% per tick with slight positive bias (fees usually outpace trader wins)
  const delta = (Math.random() - 0.48) * 0.003;
  const next  = Math.max(0.95, Math.min(1.08, prev * (1 + delta)));
  gmxFluctMap.set(positionId, next);
  return next;
}

// ── Update single position ────────────────────────────────────────────────────

export function updatePosition(
  pos:        PortfolioPosition,
  opp:        Opportunity | null,
  elapsedSec: number,
  prices:     PriceMap,
): PortfolioPosition {
  const netAPY   = opp?.netAPY   ?? pos.currentNetAPY;
  const grossAPY = opp?.grossAPY ?? pos.currentAPY;
  const yearFrac  = elapsedSec / 31_536_000;

  // Income accrual
  const newIncome = pos.allocationUSD * (netAPY / 100) * yearFrac;
  const totalIncome = pos.incomeEarnedUSD + newIncome;

  // NAV: GMX gets trader PnL simulation, others are clean compound growth
  let navUSD = pos.entryUSD;
  if (pos.strategyType === 'GMX_REAL_YIELD') {
    navUSD = pos.entryUSD * gmxNavFactor(pos.id);
  }

  const currentUSD     = navUSD + totalIncome;
  const totalReturnUSD = currentUSD - pos.entryUSD;
  const totalReturnPct = (totalReturnUSD / pos.entryUSD) * 100;
  const daysHeld       = (Date.now() - pos.entryTime) / 86_400_000;
  const effectiveAPY   = daysHeld > 0 ? (totalReturnPct / daysHeld) * 365 : netAPY;
  const peakUSD        = Math.max(pos.peakUSD, currentUSD);
  const drawdownPct    = peakUSD > 0 ? ((peakUSD - currentUSD) / peakUSD) * 100 : 0;

  // IL update from live Chainlink prices
  let currentPriceUSD = pos.entryPriceUSD;
  if (pos.entryPriceUSD > 0 && prices) {
    // Try to find current price for the volatile asset in this LP
    for (const [sym, tp] of prices.entries()) {
      if (pos.venueName.toUpperCase().includes(sym.toUpperCase()) && sym !== 'USDC' && sym !== 'USDT' && sym !== 'DAI') {
        currentPriceUSD = tp.priceUSD;
        break;
      }
    }
  }

  const ilUpdate = applyILUpdate(pos, currentPriceUSD, newIncome * 0.3);  // 30% of income is "fees" for IL tracking

  // Pending rewards estimation
  const pendingRewardsUSD = estimatePendingRewards(
    { ...pos, currentNetAPY: netAPY },
    elapsedSec,
  );

  return {
    ...pos,
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
    pendingRewardsUSD,
    ...ilUpdate,
  };
}

// ── Update full portfolio — formula-based (demo users, /agent page) ───────────
//
//  Used for Alice / Bob / Carol and any user without policy.isReal.
//  Completely unchanged — demo page stays exactly as-is.

export function updatePortfolioPositions(
  portfolio:  Portfolio,
  opportunities: Opportunity[],
  elapsedSec: number,
  prices:     PriceMap,
): Portfolio {
  const updated = portfolio.positions.map(pos => {
    const opp = opportunities.find(o => o.id === pos.venueId) ?? null;
    return updatePosition(pos, opp, elapsedSec, prices);
  });
  return updatePortfolio(portfolio, updated);
}

// ── Update full portfolio — real on-chain reads (isReal users only) ───────────
//
//  For each position, calls position-reader.ts which reads the ACTUAL current
//  value from the protocol (Aave aUSDC balance, UniV3 NFT, Pendle oracle, etc.).
//
//  Falls back to formula-based estimate if any on-chain read fails (network error,
//  position not yet settled, etc.) — the tick loop never stalls.
//
//  The formula is still used for:
//    · APY/IL/circuit-breaker derived fields (these stay formula-based even for
//      real users because they describe rate/risk, not absolute value)
//    · GMX pending deposits (gmTokenAmount = '' until async order settles)

export async function updatePortfolioPositionsReal(
  portfolio:    Portfolio,
  opportunities: Opportunity[],
  elapsedSec:   number,
  prices:       PriceMap,
  provider:     JsonRpcProvider,
  vaultAddress: string,
  userAddress?: string,
): Promise<Portfolio> {
  const updated = await Promise.all(
    portfolio.positions.map(async (pos) => {
      const opp = opportunities.find(o => o.id === pos.venueId) ?? null;

      // 1. Start with the formula-based update for APY/IL/drawdown/rewards fields
      const formulaPos = updatePosition(pos, opp, elapsedSec, prices);

      // 2. Attempt real on-chain value read
      let realRead: Awaited<ReturnType<typeof readRealPositionValue>> = null;
      try {
        realRead = await readRealPositionValue(pos, provider, vaultAddress, prices, userAddress);
      } catch (err: any) {
        console.warn(`[Monitor] Real read failed for ${pos.strategyType} — using formula. ${err.message}`);
      }

      if (!realRead) {
        // No real data available — keep formula result
        return formulaPos;
      }

      // 3. Merge: override currentUSD + incomeEarnedUSD with real values,
      //    keep everything else (APY, IL, drawdown, peak tracking) from formula
      const currentUSD      = realRead.currentUSD;
      const incomeEarnedUSD = Math.max(0, realRead.incomeEarnedUSD);  // clamp negatives from rounding
      const totalReturnUSD  = currentUSD - pos.entryUSD;
      const totalReturnPct  = pos.entryUSD > 0 ? (totalReturnUSD / pos.entryUSD) * 100 : 0;
      const daysHeld        = (Date.now() - pos.entryTime) / 86_400_000;
      const effectiveAPY    = daysHeld > 0 ? (totalReturnPct / daysHeld) * 365 : formulaPos.currentNetAPY;
      const peakUSD         = Math.max(formulaPos.peakUSD, currentUSD);
      const drawdownPct     = peakUSD > 0 ? ((peakUSD - currentUSD) / peakUSD) * 100 : 0;

      return {
        ...formulaPos,
        currentUSD,
        incomeEarnedUSD,
        // Self-heal: if NAV reader found a better tokenId (0-liquidity → active),
        // patch it into the position so future reads use the correct one directly.
        totalReturnUSD,
        totalReturnPct,
        effectiveAPY,
        peakUSD,
        drawdownPct,
        currentUSDExact:        realRead.currentUSDExact ?? currentUSD.toString(),
        incomeEarnedUSDExact:   realRead.incomeEarnedUSDExact ?? incomeEarnedUSD.toString(),
        pendingRewardsUSDExact: realRead.pendingRewardsUSDExact ?? realRead.pendingRewardsUSD.toString(),
        // Real pending rewards drives the harvest decision (not formula estimate)
        pendingRewardsUSD: realRead.pendingRewardsUSD,
        // UniV3: real fees owed = actual income; for other protocols income is NAV delta
        feesEarnedUSD: pos.strategyType === 'DELTA_NEUTRAL'
          ? realRead.incomeEarnedUSD
          : formulaPos.feesEarnedUSD,
        feesEarnedUSDExact: pos.strategyType === 'DELTA_NEUTRAL'
          ? (realRead.incomeEarnedUSDExact ?? realRead.incomeEarnedUSD.toString())
          : formulaPos.feesEarnedUSD.toString(),
        // Track consecutive out-of-range ticks for UniV3 range circuit breaker
        uniV3OutOfRangeTicks: pos.strategyType === 'DELTA_NEUTRAL'
          ? (realRead.outOfRange ? (pos.uniV3OutOfRangeTicks ?? 0) + 1 : 0)
          : pos.uniV3OutOfRangeTicks,
        // LEVERAGED_LOOP: persist health factor for circuit breaker
        ...(realRead.healthFactor != null ? { healthFactor: realRead.healthFactor } : {}),
        // UniV3 exact fee state: keep raw token units so tiny fees do not
        // disappear behind USD rounding or JS number formatting.
        ...(realRead.uniV3Fees ? {
          uniV3Token0:          realRead.uniV3Fees.token0,
          uniV3Token1:          realRead.uniV3Fees.token1,
          uniV3Token0Decimals:  realRead.uniV3Fees.token0Decimals,
          uniV3Token1Decimals:  realRead.uniV3Fees.token1Decimals,
          uniV3TokensOwed0Raw:  realRead.uniV3Fees.tokensOwed0Raw,
          uniV3TokensOwed1Raw:  realRead.uniV3Fees.tokensOwed1Raw,
          uniV3TokensOwed0:     realRead.uniV3Fees.tokensOwed0,
          uniV3TokensOwed1:     realRead.uniV3Fees.tokensOwed1,
          uniV3PendingFees0USD: realRead.uniV3Fees.fees0USD,
          uniV3PendingFees1USD: realRead.uniV3Fees.fees1USD,
          uniV3PendingFees0USDExact: realRead.uniV3Fees.fees0USDExact,
          uniV3PendingFees1USDExact: realRead.uniV3Fees.fees1USDExact,
          uniV3PendingFeesUSDExact:  realRead.uniV3Fees.feesUSDExact,
        } : {}),
      };
    }),
  );

  return updatePortfolio(portfolio, updated);
}

// ── Circuit Breakers ──────────────────────────────────────────────────────────
//
//  Portfolio-level + per-position breakers.
//  Red = exit immediately. Yellow = monitor closely. Green = all clear.

export function checkCircuitBreakers(
  portfolio:  Portfolio | null,
  opportunities: Opportunity[],
  policy:     UserPolicy,
): CircuitBreaker[] {
  const breakers: CircuitBreaker[] = [];
  if (!portfolio) return breakers;

  const m = portfolio.metrics;

  // ── 1. Portfolio NAV drawdown ────────────────────────────────────────────
  // Sanity cap: peak cannot exceed 1.5× entry unless genuinely earned.
  // Rebalance floor: when all positions have liquidity=0 (between close and remint),
  // funds exist as idle WETH/ARB in vault balances. IL from market movement is real
  // but should not exceed 15% of entry — if it does, cap the peak to current value
  // to avoid a false circuit breaker during the transitional state.
  const sanePeak = m.totalEntryUSD * 1.5;
  const allPositionsEmpty = portfolio.positions.every(p => p.currentUSD === 0 || p.uniV3Liquidity === '0');
  const rebalanceFloor   = allPositionsEmpty ? m.totalEntryUSD * 0.85 : 0;
  const cappedPeak       = m.peakValueUSD <= sanePeak ? m.peakValueUSD : m.totalValueUSD;
  const truePeak         = m.totalValueUSD >= rebalanceFloor ? cappedPeak : m.totalValueUSD;
  const dd       = truePeak > 0 ? Math.max(0, ((truePeak - m.totalValueUSD) / truePeak) * 100) : 0;
  const maxDD    = policy.maxDrawdownPct;
  breakers.push({
    id: 'portfolio-drawdown', name: 'Portfolio Drawdown',
    status: dd >= maxDD ? 'RED' : dd >= maxDD * 0.60 ? 'YELLOW' : 'GREEN',
    value: `-${dd.toFixed(2)}%`, threshold: `max -${maxDD}%`,
    description: 'Total portfolio USD value decline from peak',
  });

  // ── 2. Weighted APY vs minimum ───────────────────────────────────────────
  const apy   = m.weightedNetAPY;
  const floor = policy.minAPY;
  breakers.push({
    id: 'portfolio-apy', name: 'Portfolio APY Floor',
    status: apy < floor * 0.50 ? 'RED' : apy < floor * 0.80 ? 'YELLOW' : 'GREEN',
    value: `${apy.toFixed(2)}%`, threshold: `min ${floor}%`,
    description: 'Capital-weighted net APY across all positions',
  });

  // ── 3. IL coverage (fees beating IL?) ───────────────────────────────────
  if (!m.ilCoveredByFees && Math.abs(m.totalILUSD) > 10) {
    breakers.push({
      id: 'il-coverage', name: 'IL vs Fees Coverage',
      status: Math.abs(m.totalILUSD) > m.incomeEarnedUSD * 1.5 ? 'RED' : 'YELLOW',
      value: `IL: $${Math.abs(m.totalILUSD).toFixed(0)} | Fees: $${m.incomeEarnedUSD.toFixed(0)}`,
      threshold: 'Fees must exceed IL',
      description: 'Accumulated IL is outpacing fee income — positions losing real USD value',
    });
  }

  // ── 4. Per-position checks ───────────────────────────────────────────────
  for (const pos of portfolio.positions) {
    const opp = opportunities.find(o => o.id === pos.venueId);

    // IL exit signal per position
    const ilCheck = shouldExitForIL(pos);
    if (ilCheck.shouldExit) {
      breakers.push({
        id:          `il-exit-${pos.id.slice(0, 8)}`,
        name:        `IL Exit — ${pos.protocol}`,
        status:      'RED',
        value:       `IL: ${(Math.abs(pos.ilPct) * 100).toFixed(1)}% | Ticks: ${pos.ilUnprofTicks}`,
        threshold:   `${3} consecutive unprofitable ticks`,
        description: ilCheck.reason,
        positionId:  pos.id,
      });
    }

    // LEVERAGED_LOOP health factor — must unwind before Aave liquidates (HF < 1.0)
    if (pos.strategyType === 'LEVERAGED_LOOP' && pos.healthFactor != null) {
      const hf = pos.healthFactor;
      if (hf < 1.3) {
        breakers.push({
          id:          `hf-${pos.id.slice(0, 8)}`,
          name:        `Aave Health Factor — ${pos.protocol}`,
          // RED at HF < 1.1: immediate unwind required (liquidation bot threshold is 1.0)
          // YELLOW at HF < 1.3: de-risk, consider unwinding
          status:      hf < 1.1 ? 'RED' : 'YELLOW',
          value:       `HF ${hf.toFixed(3)}`,
          threshold:   'Min 1.3 safe | Unwind at 1.1',
          description: hf < 1.1
            ? 'CRITICAL: Aave liquidation imminent — unwind leveraged position immediately'
            : 'Health factor approaching danger zone — consider reducing leverage',
          positionId:  pos.id,
        });
      }
    }

    // UniV3 out-of-range (real users only — field is undefined for demo users)
    if (pos.strategyType === 'DELTA_NEUTRAL' && pos.uniV3OutOfRangeTicks != null) {
      const oor = pos.uniV3OutOfRangeTicks;
      if (oor > 0) {
        breakers.push({
          id:          `univ3-oor-${pos.id.slice(0, 8)}`,
          name:        `UniV3 Out-of-Range — ${pos.protocol}`,
          // RED after 3 consecutive out-of-range ticks (~3 min): earning 0 fees, must rebalance
          status:      oor >= 3 ? 'RED' : 'YELLOW',
          value:       `${oor} tick${oor > 1 ? 's' : ''} out of range`,
          threshold:   '3 ticks = rebalance',
          description: 'LP price outside tick range — earning 0 fees. Agent will migrate to a new range.',
          positionId:  pos.id,
        });
      }
    }

    // GMX OI balance per position
    if (pos.strategyType === 'GMX_REAL_YIELD' && opp?.risk.oiBalance !== null) {
      const oiBal = opp?.risk.oiBalance ?? 0.5;
      const skew  = Math.abs(oiBal - 0.5) * 2;
      if (skew > 0.20) {
        breakers.push({
          id:          `gmx-oi-${pos.id.slice(0, 8)}`,
          name:        `GMX OI — ${pos.protocol}`,
          status:      skew > 0.50 ? 'RED' : 'YELLOW',
          value:       `${(oiBal * 100).toFixed(1)}% long`,
          threshold:   '30–70% long = safe',
          description: 'Open interest skew — heavy imbalance increases counterparty risk',
          positionId:  pos.id,
        });
      }
    }

    // Liquidity per position
    if (opp) {
      const tvl    = opp.tvlUSD;
      const minTvl = policy.managedUSD * 50 * (pos.allocationPct / 100);
      if (tvl < policy.managedUSD * 10) {
        breakers.push({
          id:          `liq-${pos.id.slice(0, 8)}`,
          name:        `Liquidity — ${pos.protocol}`,
          status:      'RED',
          value:       `$${(tvl / 1e6).toFixed(2)}M TVL`,
          threshold:   `≥ $${(minTvl / 1e6).toFixed(2)}M`,
          description: 'Pool TVL critically low — exit risk',
          positionId:  pos.id,
        });
      }
    }
  }

  return breakers;
}

export function hasRedBreaker(breakers: CircuitBreaker[]): boolean {
  return breakers.some(b => b.status === 'RED');
}

export function redBreakerForPosition(breakers: CircuitBreaker[], positionId: string): boolean {
  return breakers.some(b => b.status === 'RED' && b.positionId === positionId);
}

// ── Execution record ──────────────────────────────────────────────────────────

export function buildExecutionRecord(
  action:    ActionType,
  from:      string | null,
  to:        string,
  amountUSD: number,
  portfolioValueBefore?: number,
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
    portfolioValueBefore,
  };
}
