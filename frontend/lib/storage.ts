import { Indexer, MemData } from '@0gfoundation/0g-ts-sdk';
import { ethers } from 'ethers';
import { encryptPayload, generateKey, exportKeyBase64 } from '@yieldgeko/core';

export interface StorageConfig {
  rpcUrl: string;
  indexerUrl: string;
}

const DEFAULT_CONFIG: StorageConfig = {
  rpcUrl: "https://evmrpc-testnet.0g.ai",
  indexerUrl: "https://indexer-storage-testnet-turbo.0g.ai"
};

export class YieldGekoStorage {
  private config: StorageConfig;

  constructor(config: Partial<StorageConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Persists user state to 0G Storage using a real signer
   */
  async persistIntent(state: any, signer: ethers.Signer): Promise<{ cid: string; key: string; iv: string }> {
    // 1. Generate Key & Encrypt Client-Side
    const key = await generateKey();
    const { iv, encrypted } = await encryptPayload(state, key);
    const keyBase64 = await exportKeyBase64(key);
    
    const ivBase64 = btoa(String.fromCharCode(...new Uint8Array(iv)));
    const encryptedBase64 = btoa(String.fromCharCode(...new Uint8Array(encrypted)));
    
    const payload = JSON.stringify({
      data: encryptedBase64,
      iv: ivBase64,
      metadata: { app: "YieldGeko", type: "intent" }
    });

    // 2. Robust Balance Check before upload
    try {
        const address = await signer.getAddress();
        const provider = signer.provider || new ethers.JsonRpcProvider(this.config.rpcUrl);
        const balance = await provider.getBalance(address);
        
        if (balance < ethers.parseEther("0.001")) {
            throw new Error('Insufficient 0G balance. Please fund your wallet at faucet.0g.ai');
        }
    } catch (balErr: any) {
        if (balErr.message.includes('Insufficient 0G balance')) throw balErr;
        console.warn("Balance check skipped due to provider error:", balErr);
    }

    // 3. Upload to 0G Storage via SDK
    const indexer = new Indexer(this.config.indexerUrl);
    
    const encoder = new TextEncoder();
    const data = encoder.encode(payload);
    const memData = new MemData(data);
    
    try {
        // We add a manual gas limit to bypass cryptic estimateGas failures
        const response: any = await indexer.upload(memData, this.config.rpcUrl, signer, {
            gasLimit: 500000 
        });
        
        if (!response) {
          throw new Error('No response returned from 0G upload');
        }

        // Robust Result Discovery
        let tx = response;
        if (Array.isArray(response)) {
            if (response[1]) throw response[1];
            tx = response[0];
        }

        const cid = tx.rootHash || (tx.rootHashes && tx.rootHashes[0]) || (typeof tx === 'string' ? tx : null);

        if (!cid) {
          throw new Error('Could not resolve rootHash (CID) from 0G response');
        }

        return {
          cid,
          key: keyBase64,
          iv: ivBase64
        };
    } catch (err: any) {
        throw new Error(`0G Upload Failed: ${err.message || err}`);
    }
  }

  /**
   * Retrieves and decrypts data from 0G Storage
   */
  async retrieveData(cid: string): Promise<any> {
    const indexer = new Indexer(this.config.indexerUrl);
    
    try {
        // SDK returns a single Blob, or [Blob, Error] tuple
        const response: any = await indexer.downloadToBlob(cid);
        
        let blob: Blob = response;
        if (Array.isArray(response)) {
            if (response[1]) throw response[1];
            blob = response[0];
        }
        
        // Parse JSON
        const text = await blob.text();
        return JSON.parse(text);
    } catch (err: any) {
        console.error("0G Retrieval Failed:", err);
        throw new Error(`0G Retrieval Failed: ${err.message || err}`);
    }
  }
}

export const storageService = new YieldGekoStorage();
