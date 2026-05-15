import type { StrategyType, ILCategory, Position, PortfolioPosition } from './types';

const STRATEGY_HAS_IL: Record<StrategyType, boolean> = {
  AAVE_LENDING:   false,
  MORPHO_LENDING: false,
  PENDLE_PT:      false,
  PENDLE_LP:      true,   
  PENDLE_YT:      false,  
  GMX_REAL_YIELD: false,  
  DELTA_NEUTRAL:  false,  
  LEVERAGED_LOOP: false,  
};

export interface ILResult {
  ilPct:       number;       
  ilUSD:       number;       
  ilCategory:  ILCategory;
  amplified:   boolean;      
  priceRatio:  number;       
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

  
  const standardIL = (2 * Math.sqrt(P) / (1 + P)) - 1;  

  
  let ilPct      = standardIL;
  let amplified  = false;

  if (options?.tickLower !== undefined && options?.tickUpper !== undefined) {
    const priceLower = Math.pow(1.0001, options.tickLower);
    const priceUpper = Math.pow(1.0001, options.tickUpper);

    if (priceUpper > priceLower && priceLower > 0) {
      
      
      
      const sqrtRatio    = Math.sqrt(priceLower / priceUpper);
      const denominator  = 1 - sqrtRatio;
      if (denominator > 0.001) {
        const amplification = Math.min(1 / denominator, 50); 
        ilPct     = Math.max(-1, standardIL * amplification);
        amplified = true;
      }
    }
  }

  const ilUSD     = positionUSD * ilPct;   
  const ilAbs     = Math.abs(ilPct);
  const ilCategory: ILCategory =
    ilAbs < 0.005 ? 'none'    
    : ilAbs < 0.02 ? 'low'    
    : ilAbs < 0.08 ? 'medium' 
    : 'high';                 

  return { ilPct, ilUSD, ilCategory, amplified, priceRatio: P };
}

export interface BreakEvenResult {
  feesEarned:    number;    
  ilLoss:        number;    
  netResult:     number;    
  isProfitable:  boolean;
  coverageRatio: number;    
  daysToBreakEven: number | null;  
  feeRatePerDay: number;    
  ilRatePerDay:  number;    
}

export function checkBreakEven(
  feesEarnedUSD: number,
  ilUSD:         number,     
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

  
  
  
  let daysToBreakEven: number | null = null;
  if (!isProfitable && feeRatePerDay > 0) {
    const deficit   = ilLoss - feesEarnedUSD;
    daysToBreakEven = deficit / feeRatePerDay;
  }

  return { feesEarned: feesEarnedUSD, ilLoss, netResult, isProfitable, coverageRatio, daysToBreakEven, feeRatePerDay, ilRatePerDay };
}

const IL_EXIT_TICKS = 3;   

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

  
  if (Math.abs(position.ilPct) > 0.20 && position.feesEarnedUSD < Math.abs(position.ilPct) * 0.1) {
    return {
      shouldExit: true,
      reason: `Acute IL: ${(Math.abs(position.ilPct) * 100).toFixed(1)}% IL with minimal fee coverage — exiting`,
    };
  }

  return { shouldExit: false, reason: '' };
}

export interface HedgeStatus {
  isHedged:    boolean;
  hedgeRatio:  number;       
  hedgeDrift:  number;       
  needsRebalance: boolean;
  recommendation: string;
}

export function checkHedgeStatus(
  lpToken0ExposureUSD: number,  
  perpShortSizeUSD:    number,  
  targetHedgeRatio:    number = 0.65,   
  rebalanceThreshold:  number = 0.15,   
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

export function applyILUpdate(
  position:        Position,
  currentPriceUSD: number,
  feesAccruedUSD?: number,  
): Partial<Position> {
  const il = calculateIL(
    position.strategyType,
    position.entryUSD,
    position.entryPriceUSD,
    currentPriceUSD,
  );

  const newFeesEarned = position.feesEarnedUSD + (feesAccruedUSD ?? 0);
  const newILUSD      = il.ilUSD;  
  const netAfterIL    = newFeesEarned + newILUSD;
  const isProfitable  = netAfterIL >= 0;

  
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
