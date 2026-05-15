import { decryptPayload, importKeyBase64 } from '@yieldgeko/core';
import { NormalizedYield } from '../types/normalized-yield';
import { ScoringEngine } from '../engine/scorer';

export interface UserIntent {
  minApyBps: bigint;
  maxSlippageBps: bigint;
  riskTier: 'conservative' | 'balanced' | 'aggressive';
  excludedVenues: string[];
}

export interface EncryptedIntentBlob {
  iv: string; 
  encrypted: string; 
}

export class IntentProcessor {
  
  public static async processIntent(
    encryptedBlob: EncryptedIntentBlob,
    userKeyBase64: string,
    allVenues: NormalizedYield[]
  ): Promise<(NormalizedYield & { geckoScore: bigint })[]> {
    
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
      
      
      const arrayBuffer = encryptedBuffer.buffer.slice(
        encryptedBuffer.byteOffset,
        encryptedBuffer.byteOffset + encryptedBuffer.byteLength
      );

      intent = (await decryptPayload(arrayBuffer, iv, key)) as UserIntent;
    }

    
    const filtered = allVenues.filter(v => {
      
      if (v.apyBps < intent.minApyBps) return false;

      
      if (intent.excludedVenues.includes(v.venue)) return false;

      
      if (intent.riskTier === 'conservative' && v.riskScore < 80) return false;
      
      return true;
    });

    
    
    return ScoringEngine.rankVenues(filtered);
  }
}
