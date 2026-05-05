import { NormalizedYield } from '../types/normalized-yield';

/**
 * Deterministic Scoring Engine for YieldGeko
 * Runs inside 0G Sealed Inference (TEE)
 * Uses BigInt exclusively to ensure bit-perfect determinism across hardware.
 */
export class ScoringEngine {
  // Weights in BPS (Sum = 10,000)
  private static readonly WEIGHT_APY = 4000n;        // 40%
  private static readonly WEIGHT_VOLATILITY = 3000n; // 30%
  private static readonly WEIGHT_REPUTATION = 2000n; // 20%
  private static readonly WEIGHT_LIQUIDITY = 1000n;  // 10%

  /**
   * Calculate a GeckoScore (0 - 10,000) for a venue
   */
  public static computeScore(
    yieldData: NormalizedYield,
    volatilityBps: bigint = 150n,       // Mocked for demo
    reputationPenaltyBps: bigint = 0n   // 0 = Audited, >0 = Penalty
  ): bigint {
    // 1. Base APY Component
    const apyComponent = (yieldData.apyBps * this.WEIGHT_APY) / 10000n;

    // 2. Risk Components (Subtractive)
    const volPenalty = (volatilityBps * this.WEIGHT_VOLATILITY) / 10000n;
    const repPenalty = (reputationPenaltyBps * this.WEIGHT_REPUTATION) / 10000n;

    // 3. Liquidity Factor (Multiplier)
    // Scale: 1.0 (10000) if liq > $1M, scales down below that
    const targetLiq = 1_000_000n * 10n**18n; // $1M in 18 dec
    let liqFactor = (yieldData.liquidityUsd * 10000n) / targetLiq;
    if (liqFactor > 10000n) liqFactor = 10000n;
    if (liqFactor < 1000n) liqFactor = 1000n; // Floor at 10%

    // 4. Final Aggregation
    // GeckoScore = (APY - Penalties) * LiquidityFactor
    let baseScore = apyComponent - volPenalty - repPenalty;
    if (baseScore < 0n) baseScore = 0n;

    const geckoScore = (baseScore * liqFactor) / 10000n;

    return geckoScore;
  }

  /**
   * Ranks a list of venues deterministically
   */
  public static rankVenues(venues: NormalizedYield[]): (NormalizedYield & { geckoScore: bigint })[] {
    const scored = venues.map(v => ({
      ...v,
      geckoScore: this.computeScore(v)
    }));

    // Sort Descending by score, then tie-break by name (deterministic)
    return scored.sort((a, b) => {
      if (b.geckoScore !== a.geckoScore) {
        return b.geckoScore > a.geckoScore ? 1 : -1;
      }
      return a.venue.localeCompare(b.venue);
    });
  }
}
