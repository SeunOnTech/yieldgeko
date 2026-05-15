import { RawPool } from '../types/market';
import { calculateDivergenceStats, DivergenceStats } from './QuantMath';

export interface ILResult {
  predictedIL:    number;   
  correlation:    number;   
  volatilityScore: number;  
  isPegged:       boolean;
}

export class ILEngine {
  
  static analyze(
    pool:    RawPool,
    stats?:  DivergenceStats,
  ): ILResult {
    let correlation    = 0;
    let volatility     = this.heuristicVolatility(pool);
    let isPegged       = false;
    let priceRatioVar  = 1.0;

    if (stats) {
      correlation   = stats.correlation;
      volatility    = stats.volatility;
      priceRatioVar = stats.priceRatioVar;
      
      isPegged = priceRatioVar < 0.0005;
      if (isPegged) correlation = 0.995;
    }

    
    const divergence = volatility * (1 - Math.max(0, correlation));
    const r          = 1 + divergence;

    
    const il         = Math.abs((2 * Math.sqrt(r)) / (1 + r) - 1);

    return {
      predictedIL:    Math.min(il, 0.50),    
      correlation:    Math.max(0, correlation),
      volatilityScore: Math.min(volatility, 1),
      isPegged,
    };
  }

  static analyzeFromHistory(
    pool:              RawPool,
    basePrices:        number[],
    quotePrices:       number[],
  ): ILResult {
    if (basePrices.length < 5 || quotePrices.length < 5) {
      return this.analyze(pool);
    }
    const stats = calculateDivergenceStats(basePrices, quotePrices);
    return this.analyze(pool, stats);
  }

  private static heuristicVolatility(pool: RawPool): number {
    if (pool.metrics.sigma) return pool.metrics.sigma / 100;
    const { volume24hUSD, tvlUSD } = pool.metrics;
    if (!tvlUSD || tvlUSD === 0) return 0.5;
    return Math.min(Math.max((volume24hUSD / tvlUSD) * 0.5, 0.15), 1.5);
  }
}
