import { Indexer, MemData } from '@0gfoundation/0g-ts-sdk';
import { Signer, ethers } from 'ethers';
import * as crypto from 'crypto';

export interface FinancialReceipt {
  timestamp: number;
  user: { id: string };
  venue: { id: string; name: string; apy: number };
  previousVenue: { id: string; apy: number };
  amount: string;
  fees: {
    migration: string;
    success: string;
    gas: string;
  };
  enclaveId: string;
}

export class LedgerLogger {
  /**
   * Computes SHA-256 hash of the receipt JSON
   */
  public static computeReceiptHash(receipt: FinancialReceipt): string {
    const sortedKeys = Object.keys(receipt).sort();
    const canonical = JSON.stringify(receipt, sortedKeys);
    return '0x' + crypto.createHash('sha256').update(canonical).digest('hex');
  }

  /**
   * Logs migration to 0G Storage and returns the real Merkle Root Hash
   */
  public static async logMigration(
    user: { id: string },
    venue: { id: string; name: string; apy: number },
    prevVenue: { id: string; apy: number },
    amount: bigint,
    fees: { migration: bigint; success: bigint; gas: bigint },
    signer: Signer,
    indexerUrl: string,
    evmRpcUrl: string
  ): Promise<{ receipt: FinancialReceipt; hash: string; cid: string }> {
    const receipt: FinancialReceipt = {
      timestamp: Date.now(),
      user,
      venue,
      previousVenue: prevVenue,
      amount: amount.toString(),
      fees: {
        migration: fees.migration.toString(),
        success: fees.success.toString(),
        gas: fees.gas.toString(),
      },
      enclaveId: '0g-tee-production-v1',
    };

    // 1. Compute Hash for anchoring
    const hash = this.computeReceiptHash(receipt);

    // 2. Prepare for 0G Storage using MemData
    const payload = JSON.stringify(receipt);
    const data = Buffer.from(payload);
    const memData = new MemData(data);
    
    // 3. Upload to real 0G Storage
    const indexer = new Indexer(indexerUrl);
    
    try {
        const response: any = await indexer.upload(memData, evmRpcUrl, signer);
        
        if (!response) {
          throw new Error('No response returned from 0G upload');
        }

        // Robust Result Discovery
        let tx = response;
        
        // Check if it's a [result, error] tuple
        if (Array.isArray(response)) {
            if (response[1]) throw response[1]; // Throw if error is present in tuple
            tx = response[0];
        }

        // Extract CID (rootHash)
        // 1. Try standard object properties
        // 2. Try array properties (batch upload)
        // 3. Fallback to raw string if the SDK returned the hash directly
        const cid = tx.rootHash || (tx.rootHashes && tx.rootHashes[0]) || (typeof tx === 'string' ? tx : null);

        if (!cid) {
          console.error("DEBUG: Unexpected 0G Response Format:", JSON.stringify(response));
          throw new Error('Could not resolve rootHash (CID) from 0G response');
        }

        return { receipt, hash, cid };
    } catch (err: any) {
        throw new Error(`0G Storage Upload Failed: ${err.message || err}`);
    }
  }
}
