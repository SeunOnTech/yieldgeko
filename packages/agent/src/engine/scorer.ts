import { NormalizedYield } from '../types/normalized-yield';

export class ScoringEngine {
  
  private static readonly WEIGHT_APY = 4000n;        
  private static readonly WEIGHT_VOLATILITY = 3000n; 
  private static readonly WEIGHT_REPUTATION = 2000n; 
  private static readonly WEIGHT_LIQUIDITY = 1000n;  

  
  public static computeScore(
    yieldData: NormalizedYield,
    volatilityBps: bigint = 150n,       
    reputationPenaltyBps: bigint = 0n   
  ): bigint {
    
    const apyComponent = (yieldData.apyBps * this.WEIGHT_APY) / 10000n;

    
    const volPenalty = (volatilityBps * this.WEIGHT_VOLATILITY) / 10000n;
    const repPenalty = (reputationPenaltyBps * this.WEIGHT_REPUTATION) / 10000n;

    
    
    const targetLiq = 1_000_000n * 10n**18n; 
    let liqFactor = (yieldData.liquidityUsd * 10000n) / targetLiq;
    if (liqFactor > 10000n) liqFactor = 10000n;
    if (liqFactor < 1000n) liqFactor = 1000n; 

    
    
    let baseScore = apyComponent - volPenalty - repPenalty;
    if (baseScore < 0n) baseScore = 0n;

    const geckoScore = (baseScore * liqFactor) / 10000n;

    return geckoScore;
  }

  
  public static rankVenues(venues: NormalizedYield[]): (NormalizedYield & { geckoScore: bigint })[] {
    const scored = venues.map(v => ({
      ...v,
      geckoScore: this.computeScore(v)
    }));

    
    return scored.sort((a, b) => {
      if (b.geckoScore !== a.geckoScore) {
        return b.geckoScore > a.geckoScore ? 1 : -1;
      }
      return a.venue.localeCompare(b.venue);
    });
  }
}
