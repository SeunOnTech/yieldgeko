/**
 * YieldGeko Verification Engine
 * 
 * Logic to verify that an off-chain receipt from 0G Storage
 * matches the hash anchored on the 0G blockchain.
 */

import { storageService } from './storage';
import { createPublicClient, decodeEventLog, defineChain, http, type Hex } from 'viem';
import { ADDRESSES, RPC_URL } from '@yieldgeko/core';
import { yieldGekoRouterAbi } from '../src/generated';

export interface VerificationResult {
  isValid: boolean;
  computedHash: string;
  onChainHash: string;
  data?: unknown;
  error?: string;
}

const zeroGGalileo = defineChain({
  id: 16602,
  name: '0G Galileo',
  nativeCurrency: { name: 'A0G', symbol: 'A0G', decimals: 18 },
  rpcUrls: {
    default: { http: [RPC_URL] },
  },
  blockExplorers: {
    default: { name: '0G Explorer', url: 'https://chainscan-galileo.0g.ai' },
  },
  testnet: true,
});

export class Verifier {
  private static readonly publicClient = createPublicClient({
    chain: zeroGGalileo,
    transport: http(RPC_URL),
  });

  /**
   * Computes SHA-256 hash of a JSON object (canonicalized)
   */
  public static async computeHash(data: Record<string, unknown>): Promise<string> {
    const sortedKeys = Object.keys(data).sort();
    const canonical = JSON.stringify(data, sortedKeys);
    
    const msgUint8 = new TextEncoder().encode(canonical);
    const hashBuffer = await crypto.subtle.digest('SHA-256', msgUint8);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    
    return '0x' + hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  }

  private static async getAuthoritativeReceiptHash(txHash: Hex): Promise<string> {
    const receipt = await this.publicClient.getTransactionReceipt({ hash: txHash });

    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== ADDRESSES.YIELD_GEKO_ROUTER.toLowerCase()) {
        continue;
      }

      try {
        const decoded = decodeEventLog({
          abi: yieldGekoRouterAbi,
          data: log.data,
          topics: log.topics,
        });

        if (decoded.eventName === 'FeeSettled') {
          return decoded.args.receiptHash;
        }
      } catch {
        // Ignore unrelated logs on the same transaction receipt.
      }
    }

    throw new Error(`No FeeSettled event found for transaction ${txHash}`);
  }

  /**
   * Verifies a receipt against the authoritative on-chain FeeSettled event.
   */
  public static async verifyReceipt(cid: string, txHash: Hex): Promise<VerificationResult> {
    try {
      // 1. Fetch from 0G Storage
      const receipt = await storageService.retrieveData<Record<string, unknown>>(cid);
      
      // 2. Compute Local Hash
      const computedHash = await this.computeHash(receipt);
      const onChainHash = await this.getAuthoritativeReceiptHash(txHash);
      const isValid = computedHash.toLowerCase() === onChainHash.toLowerCase();
      
      return {
        isValid,
        computedHash,
        onChainHash,
        data: receipt,
      };
    } catch (error) {
      return {
        isValid: false,
        computedHash: '',
        onChainHash: '',
        error: error instanceof Error ? error.message : `Verification failed: ${String(error)}`
      };
    }
  }
}
