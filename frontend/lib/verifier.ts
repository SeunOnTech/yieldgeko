/**
 * YieldGeko Verification Engine
 * 
 * Logic to verify that an off-chain receipt from 0G Storage
 * matches the hash anchored on the 0G blockchain.
 */

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
    // 1. Canonicalize (simple alphabetical sort for keys)
    const sortedKeys = Object.keys(data).sort();
    const canonical = JSON.stringify(data, sortedKeys);
    
    // 2. Hash using Web Crypto API
    const msgUint8 = new TextEncoder().encode(canonical);
    const hashBuffer = await crypto.subtle.digest('SHA-256', msgUint8);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    
    return '0x' + hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  }

  /**
   * Verifies a receipt against an on-chain hash
   */
  public static async verifyReceipt(receipt: any, onChainHash: string): Promise<VerificationResult> {
    try {
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
        error: err.message
      };
    }
  }
}
