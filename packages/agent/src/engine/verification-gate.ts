import { fetchAaveUSDCSupplyAPY } from '../parsers/aave-v3';
import { fetchPendleMarketYield } from '../parsers/pendle';

export enum SafetyStatus {
  VERIFIED = 'VERIFIED',
  ABORT_APY_DRIFT = 'ABORT_APY_DRIFT',
  ABORT_LIQUIDITY_INSUFFICIENT = 'ABORT_LIQUIDITY_INSUFFICIENT',
  ABORT_PROTOCOL_PAUSED = 'ABORT_PROTOCOL_PAUSED'
}

/**
 * Pre-Execution Verification Gate
 * Runs after decision, immediately before signing.
 */
export class VerificationGate {
  private static readonly DRIFT_THRESHOLD_BPS = 50n; // 0.50%

  /**
   * Verifies that the target state is still safe for execution
   */
  public static async verifySafety(
    targetVenue: string,
    scoredApyBps: bigint,
    amount: bigint
  ): Promise<{ status: SafetyStatus; liveApyBps: bigint }> {
    console.log(`[Gate] Flash Syncing State for ${targetVenue}...`);
    
    let liveApyBps = 0n;
    let liveLiquidity = 0n;

    // 1. Fetch Fresh State
    if (targetVenue.includes('aave-v3')) {
      const data = await fetchAaveUSDCSupplyAPY();
      liveApyBps = data.apyBps;
      liveLiquidity = data.liquidity;
    } else if (targetVenue.includes('pendle')) {
      const data = await fetchPendleMarketYield();
      liveApyBps = data.impliedApyBps;
      liveLiquidity = data.liquidity;
    }

    // 2. APY Drift Check
    const drift = liveApyBps > scoredApyBps 
      ? liveApyBps - scoredApyBps 
      : scoredApyBps - liveApyBps;

    if (drift > this.DRIFT_THRESHOLD_BPS && liveApyBps < scoredApyBps) {
      return { status: SafetyStatus.ABORT_APY_DRIFT, liveApyBps };
    }

    // 3. Liquidity Check (Min 10x user amount)
    if (liveLiquidity < (amount * 10n)) {
      return { status: SafetyStatus.ABORT_LIQUIDITY_INSUFFICIENT, liveApyBps };
    }

    return { status: SafetyStatus.VERIFIED, liveApyBps };
  }
}
