import { decryptPayload, importKeyBase64 } from '../../../core/src/utils/encryption';
import { NormalizedYield } from '../types/normalized-yield';
import { ScoringEngine } from '../engine/scorer';

export interface UserIntent {
  minApyBps: bigint;
  maxSlippageBps: bigint;
  riskTier: 'conservative' | 'balanced' | 'aggressive';
  excludedVenues: string[];
}

export interface EncryptedIntentBlob {
  iv: string; // Base64
  encrypted: string; // Base64
}

export class IntentProcessor {
  /**
   * Process a user's intent privately inside the TEE
   */
  public static async processIntent(
    encryptedBlob: EncryptedIntentBlob,
    userKeyBase64: string,
    allVenues: NormalizedYield[]
  ): Promise<(NormalizedYield & { geckoScore: bigint })[]> {
    // 1. Decrypt Intent inside TEE (Bypass for mock demo)
    let intent: UserIntent;
    if (encryptedBlob.encrypted === 'mock') {
      intent = {
        minApyBps: 200n,
        maxSlippageBps: 100n,
        riskTier: 'balanced',
        excludedVenues: []
      };
    } else {
      const key = await importKeyBase64(userKeyBase64);
      const encryptedBuffer = Buffer.from(encryptedBlob.encrypted, 'base64');
      const iv = new Uint8Array(Buffer.from(encryptedBlob.iv, 'base64'));
      
      // Convert Buffer to ArrayBuffer
      const arrayBuffer = encryptedBuffer.buffer.slice(
        encryptedBuffer.byteOffset,
        encryptedBuffer.byteOffset + encryptedBuffer.byteLength
      );

      intent = (await decryptPayload(arrayBuffer, iv, key)) as UserIntent;
    }

    // 2. Bounds Filtering
    const filtered = allVenues.filter(v => {
      // APY Floor
      if (v.apyBps < intent.minApyBps) return false;

      // Venue Blacklist
      if (intent.excludedVenues.includes(v.venue)) return false;

      // Risk Adjustment (Demo logic: filter by riskScore if conservative)
      if (intent.riskTier === 'conservative' && v.riskScore < 80) return false;
      
      return true;
    });

    // 3. Personalized Ranking
    // Note: In a real TEE, we'd adjust weights based on intent.riskTier
    return ScoringEngine.rankVenues(filtered);
  }
}
