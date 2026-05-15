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

const TICK_SECONDS = 60;

const gmxFluctMap = new Map<string, number>();  

function gmxNavFactor(positionId: string): number {
  const prev = gmxFluctMap.get(positionId) ?? 1.0;
  
  const delta = (Math.random() - 0.48) * 0.003;
  const next  = Math.max(0.95, Math.min(1.08, prev * (1 + delta)));
  gmxFluctMap.set(positionId, next);
  return next;
}

export function updatePosition(
  pos:        PortfolioPosition,
  opp:        Opportunity | null,
  elapsedSec: number,
  prices:     PriceMap,
): PortfolioPosition {
  const netAPY   = opp?.netAPY   ?? pos.currentNetAPY;
  const grossAPY = opp?.grossAPY ?? pos.currentAPY;
  const yearFrac  = elapsedSec / 31_536_000;

  
  const newIncome = pos.allocationUSD * (netAPY / 100) * yearFrac;
  const totalIncome = pos.incomeEarnedUSD + newIncome;

  
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

  
  let currentPriceUSD = pos.entryPriceUSD;
  if (pos.entryPriceUSD > 0 && prices) {
    
    for (const [sym, tp] of prices.entries()) {
      if (pos.venueName.toUpperCase().includes(sym.toUpperCase()) && sym !== 'USDC' && sym !== 'USDT' && sym !== 'DAI') {
        currentPriceUSD = tp.priceUSD;
        break;
      }
    }
  }

  const ilUpdate = applyILUpdate(pos, currentPriceUSD, newIncome * 0.3);  

  
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

export async function updatePortfolioPositionsReal(
  portfolio:    Portfolio,
  opportunities: Opportunity[],
  elapsedSec:   number,
  prices:       PriceMap,
  provider:     JsonRpcProvider,
  vaultAddress: string,
  userAddress?: string,
  batchPositions?: import('./protocols').UserOnChainPositions,
): Promise<Portfolio> {
  const updated = await Promise.all(
    portfolio.positions.map(async (pos) => {
      const opp = opportunities.find(o => o.id === pos.venueId) ?? null;

      
      const formulaPos = updatePosition(pos, opp, elapsedSec, prices);

      
      let realRead: Awaited<ReturnType<typeof readRealPositionValue>> = null;
      try {
        realRead = await readRealPositionValue(pos, provider, vaultAddress, prices, userAddress, batchPositions);
      } catch (err: any) {
        console.warn(`[Monitor] Real read failed for ${pos.strategyType} — using formula. ${err.message}`);
      }

      if (!realRead) {
        
        return formulaPos;
      }

      
      
      const currentUSD      = realRead.currentUSD;
      const incomeEarnedUSD = Math.max(0, realRead.incomeEarnedUSD);  
      const currentValueUSD = currentUSD + incomeEarnedUSD;
      const totalReturnUSD  = currentValueUSD - pos.entryUSD;
      const totalReturnPct  = pos.entryUSD > 0 ? (totalReturnUSD / pos.entryUSD) * 100 : 0;
      const daysHeld        = (Date.now() - pos.entryTime) / 86_400_000;
      const effectiveAPY    = daysHeld > 0 ? (totalReturnPct / daysHeld) * 365 : formulaPos.currentNetAPY;
      const peakUSD         = Math.max(formulaPos.peakUSD, currentValueUSD);
      const drawdownPct     = peakUSD > 0 ? ((peakUSD - currentValueUSD) / peakUSD) * 100 : 0;

      return {
        ...formulaPos,
        currentUSD,
        incomeEarnedUSD,
        
        
        totalReturnUSD,
        totalReturnPct,
        effectiveAPY,
        peakUSD,
        drawdownPct,
        currentUSDExact:        realRead.currentUSDExact ?? currentUSD.toString(),
        incomeEarnedUSDExact:   realRead.incomeEarnedUSDExact ?? incomeEarnedUSD.toString(),
        pendingRewardsUSDExact: realRead.pendingRewardsUSDExact ?? realRead.pendingRewardsUSD.toString(),
        
        pendingRewardsUSD: realRead.pendingRewardsUSD,
        
        feesEarnedUSD: pos.strategyType === 'DELTA_NEUTRAL'
          ? realRead.incomeEarnedUSD
          : formulaPos.feesEarnedUSD,
        feesEarnedUSDExact: pos.strategyType === 'DELTA_NEUTRAL'
          ? (realRead.incomeEarnedUSDExact ?? realRead.incomeEarnedUSD.toString())
          : formulaPos.feesEarnedUSD.toString(),
        
        uniV3OutOfRangeTicks: pos.strategyType === 'DELTA_NEUTRAL'
          ? (realRead.outOfRange ? (pos.uniV3OutOfRangeTicks ?? 0) + 1 : 0)
          : pos.uniV3OutOfRangeTicks,
        
        ...(realRead.healthFactor != null ? { healthFactor: realRead.healthFactor } : {}),
        
        
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

export function checkCircuitBreakers(
  portfolio:  Portfolio | null,
  opportunities: Opportunity[],
  policy:     UserPolicy,
): CircuitBreaker[] {
  const breakers: CircuitBreaker[] = [];
  if (!portfolio) return breakers;

  const m = portfolio.metrics;

  
  
  
  
  
  
  const allPositionsInTransit = portfolio.positions.length > 0 &&
    portfolio.positions.every(p => (p.currentUSD ?? 0) === 0 || p.uniV3Liquidity === '0');
  const walletAwareNAV = allPositionsInTransit
    ? Math.max(m.totalValueUSD, m.totalEntryUSD * 0.95)  
    : m.totalValueUSD;

  const sanePeak       = m.totalEntryUSD * 1.5;
  const cappedPeak     = m.peakValueUSD <= sanePeak ? m.peakValueUSD : walletAwareNAV;
  const truePeak       = allPositionsInTransit ? walletAwareNAV : cappedPeak;
  const dd     = truePeak > 0 ? Math.max(0, ((truePeak - walletAwareNAV) / truePeak) * 100) : 0;
  const maxDD    = policy.maxDrawdownPct;
  breakers.push({
    id: 'portfolio-drawdown', name: 'Portfolio Drawdown',
    status: dd >= maxDD ? 'RED' : dd >= maxDD * 0.60 ? 'YELLOW' : 'GREEN',
    value: `-${dd.toFixed(2)}%`, threshold: `max -${maxDD}%`,
    description: 'Total portfolio USD value decline from peak',
  });

  
  const apy   = m.weightedNetAPY;
  const floor = policy.minAPY;
  breakers.push({
    id: 'portfolio-apy', name: 'Portfolio APY Floor',
    status: apy < floor * 0.50 ? 'RED' : apy < floor * 0.80 ? 'YELLOW' : 'GREEN',
    value: `${apy.toFixed(2)}%`, threshold: `min ${floor}%`,
    description: 'Capital-weighted net APY across all positions',
  });

  
  if (!m.ilCoveredByFees && Math.abs(m.totalILUSD) > 10) {
    breakers.push({
      id: 'il-coverage', name: 'IL vs Fees Coverage',
      status: Math.abs(m.totalILUSD) > m.incomeEarnedUSD * 1.5 ? 'RED' : 'YELLOW',
      value: `IL: $${Math.abs(m.totalILUSD).toFixed(0)} | Fees: $${m.incomeEarnedUSD.toFixed(0)}`,
      threshold: 'Fees must exceed IL',
      description: 'Accumulated IL is outpacing fee income — positions losing real USD value',
    });
  }

  
  for (const pos of portfolio.positions) {
    const opp = opportunities.find(o => o.id === pos.venueId);

    
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

    
    if (pos.strategyType === 'LEVERAGED_LOOP' && pos.healthFactor != null) {
      const hf = pos.healthFactor;
      if (hf < 1.3) {
        breakers.push({
          id:          `hf-${pos.id.slice(0, 8)}`,
          name:        `Aave Health Factor — ${pos.protocol}`,
          
          
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

    
    if (pos.strategyType === 'DELTA_NEUTRAL' && pos.uniV3OutOfRangeTicks != null) {
      const oor = pos.uniV3OutOfRangeTicks;
      if (oor > 0) {
        breakers.push({
          id:          `univ3-oor-${pos.id.slice(0, 8)}`,
          name:        `UniV3 Out-of-Range — ${pos.protocol}`,
          
          status:      oor >= 3 ? 'RED' : 'YELLOW',
          value:       `${oor} tick${oor > 1 ? 's' : ''} out of range`,
          threshold:   '3 ticks = rebalance',
          description: 'LP price outside tick range — earning 0 fees. Agent will migrate to a new range.',
          positionId:  pos.id,
        });
      }
    }

    
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
    status:      'planned',
    receiptHash: `0x${hash}`,
    timestamp:   Date.now(),
    portfolioValueBefore,
  };
}
