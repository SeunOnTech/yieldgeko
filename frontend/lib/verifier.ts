/**
 * YieldGeko Verification Engine
 * 
 * Logic to verify that an off-chain receipt from 0G Storage
 * matches the hash anchored on the 0G blockchain.
 */

import { storageService } from './storage';

export interface VerificationResult {
  isValid: boolean;
  computedHash: string;
  onChainHash: string;
  error?: string;
}

export class Verifier {
  /**
   * Computes SHA-256 hash of a JSON object (canonicalized)
   */
  public static async computeHash(data: any): Promise<string> {
    const sortedKeys = Object.keys(data).sort();
    const canonical = JSON.stringify(data, sortedKeys);
    
    const msgUint8 = new TextEncoder().encode(canonical);
    const hashBuffer = await crypto.subtle.digest('SHA-256', msgUint8);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    
    return '0x' + hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  }

  /**
   * Verifies a receipt by fetching it from real 0G Storage
   */
  public static async verifyReceipt(cid: string, onChainHash: string): Promise<VerificationResult> {
    try {
      // 1. Fetch from 0G Storage
      const receipt = await storageService.retrieveData(cid);
      
      // 2. Compute Local Hash
      const computedHash = await this.computeHash(receipt);
      const isValid = computedHash.toLowerCase() === onChainHash.toLowerCase();
      
      return {
        isValid,
        computedHash,
        onChainHash
      };
    } catch (err: any) {
      return {
        isValid: false,
        computedHash: '',
        onChainHash,
        error: `0G Retrieval Failed: ${err.message}`
      };
    }
  }
}
