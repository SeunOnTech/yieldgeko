import { fetchAaveUSDCSupplyAPY } from '../parsers/aave-v3';
import { fetchPendleMarketYield } from '../parsers/pendle';

export enum SafetyStatus {
  VERIFIED = 'VERIFIED',
  ABORT_APY_DRIFT = 'ABORT_APY_DRIFT',
  ABORT_LIQUIDITY_INSUFFICIENT = 'ABORT_LIQUIDITY_INSUFFICIENT',
  ABORT_PROTOCOL_PAUSED = 'ABORT_PROTOCOL_PAUSED'
}

export class VerificationGate {
  private static readonly DRIFT_THRESHOLD_BPS = 50n; 

  
  public static async verifySafety(
    targetVenue: string,
    scoredApyBps: bigint,
    amount: bigint
  ): Promise<{ status: SafetyStatus; liveApyBps: bigint }> {
    console.log(`[Gate] Flash Syncing State for ${targetVenue}...`);
    
    let liveApyBps = 0n;
    let liveLiquidity = 0n;

    
    if (targetVenue.includes('aave-v3')) {
      const data = await fetchAaveUSDCSupplyAPY();
      liveApyBps = data.apyBps;
      liveLiquidity = data.liquidity;
    } else if (targetVenue.includes('pendle')) {
      const data = await fetchPendleMarketYield();
      liveApyBps = data.impliedApyBps;
      liveLiquidity = data.liquidity;
    }

    
    const drift = liveApyBps > scoredApyBps 
      ? liveApyBps - scoredApyBps 
      : scoredApyBps - liveApyBps;

    if (drift > this.DRIFT_THRESHOLD_BPS && liveApyBps < scoredApyBps) {
      return { status: SafetyStatus.ABORT_APY_DRIFT, liveApyBps };
    }

    
    if (liveLiquidity < (amount * 10n)) {
      return { status: SafetyStatus.ABORT_LIQUIDITY_INSUFFICIENT, liveApyBps };
    }

    return { status: SafetyStatus.VERIFIED, liveApyBps };
  }
}
