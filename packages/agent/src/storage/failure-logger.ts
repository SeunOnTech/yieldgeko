import { Signer } from 'ethers';
import { persistJsonArtifact, PersistedArtifact } from './persist';

/**
 * 0G Storage Failure Logger
 * Immutably records every hard abort for user audit.
 */
export class FailureLogger {
  /**
   * Logs a safety abort to 0G Storage
   */
  public static async logAbort(params: {
    userHash: string;
    reason: string;
    expectedApy: bigint;
    actualApy: bigint;
    calldataHash?: string;
    signer: Signer;
    indexerUrl: string;
    evmRpcUrl: string;
  }): Promise<PersistedArtifact> {
    const logBlob = {
      userHash: params.userHash,
      reason: params.reason,
      expectedApy: params.expectedApy.toString(),
      actualApy: params.actualApy.toString(),
      calldataHash: params.calldataHash,
      timestamp: Date.now(),
      status: 'ABORTED',
      type: 'SAFETY_GATE_TRIGGER',
    };

    console.log(`[FailureLogger] Anchoring Abort Proof to 0G Storage: ${params.reason}`);

    return persistJsonArtifact(logBlob, {
      signer: params.signer,
      indexerUrl: params.indexerUrl,
      evmRpcUrl: params.evmRpcUrl,
    });
  }
}
