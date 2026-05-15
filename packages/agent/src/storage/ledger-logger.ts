
import { Indexer, MemData } from '@0gfoundation/0g-ts-sdk';
import { Signer, ethers, NonceManager } from 'ethers';
import PQueue from 'p-queue';
import * as crypto from 'crypto';

export interface FinancialReceipt {
  timestamp: number;
  operation: 'GENESIS' | 'MIGRATION' | 'SAFETY_EXIT';
  user: { id: string };
  venue: { id: string; name: string; apy: number };
  previousVenue?: { id: string; apy: number };
  amount: string;
  fees: {
    migration: string;
    success: string;
    gas: string;
  };
  enclaveId: string;
}

export class LedgerLogger {
  
  private static archiverQueue = new PQueue({ concurrency: 1 });
  private static managedSigner: NonceManager | null = null;

  
  public static computeReceiptHash(receipt: FinancialReceipt): string {
    const sortedKeys = Object.keys(receipt).sort();
    const canonical = JSON.stringify(receipt, sortedKeys);
    return '0x' + crypto.createHash('sha256').update(canonical).digest('hex');
  }

  
  public static async prepareInstantProof(
    operation: 'GENESIS' | 'MIGRATION' | 'SAFETY_EXIT',
    user: any,
    venue: any,
    prevVenue: any | null,
    amount: bigint,
    fees: any,
    signer: Signer
  ): Promise<{ receipt: any; hash: string; cid: string; data: MemData }> {
    const receipt: FinancialReceipt = {
      timestamp: Date.now(),
      operation,
      user,
      venue,
      previousVenue: prevVenue || undefined,
      amount: amount.toString(),
      fees: {
        migration: fees.migration.toString(),
        success: fees.success.toString(),
        gas: fees.gas.toString(),
      },
      enclaveId: '0g-tee-production-v1',
    };

    const hash = this.computeReceiptHash(receipt);
    const payload = JSON.stringify(receipt);
    const memData = new MemData(Buffer.from(payload));
    
    
    const [tree] = await memData.merkleTree();
    if (!tree) throw new Error('merkle tree computation failed');
    const cid = tree.rootHash() as string;

    return { receipt, hash, cid, data: memData };
  }

  
  public static async logAction(
    operation: 'GENESIS' | 'MIGRATION' | 'SAFETY_EXIT',
    user: any,
    venue: any,
    prevVenue: any | null,
    amount: bigint,
    fees: any,
    signer: Signer,
    indexerUrl: string,
    evmRpcUrl: string
  ): Promise<{ receipt: any; hash: string; cid: string }> {
    
    if (!this.managedSigner) {
      this.managedSigner = new NonceManager(signer);
    }

    
    const { receipt, hash, cid, data } = await this.prepareInstantProof(operation, user, venue, prevVenue, amount, fees, signer);

    
    const indexer = new Indexer(indexerUrl);
    
    this.archiverQueue.add(async () => {
      console.log(`[0G-Archiver] 🦎 Processing background archival for CID: ${cid}`);
      try {
        await indexer.upload(data, evmRpcUrl, this.managedSigner!);
        console.log(`[0G-Archiver] ✅ Successfully archived CID: ${cid}`);
      } catch (err) {
        console.error(`[0G-Archiver] ❌ Archival failed for CID: ${cid}`, err instanceof Error ? err.message : err);
        
      }
    });

    
    return { receipt, hash, cid };
  }
}
