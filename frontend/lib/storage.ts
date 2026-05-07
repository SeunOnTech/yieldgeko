import { Indexer, MemData } from '@0gfoundation/0g-ts-sdk';
import { ethers } from 'ethers';
import { encryptPayload } from '@yieldgeko/core';

export interface StorageConfig {
  rpcUrl: string;
  indexerUrl: string;
}

interface StoredIntentEnvelope {
  data: string;
  iv: string;
  metadata: {
    app: 'YieldGeko';
    type: 'intent';
    walletAddress: string;
    keyDerivation: 'wallet-signature-v1';
  };
}

type UploadSuccess =
  | { txHash: string; rootHash: string; txSeq: number }
  | { txHashes: string[]; rootHashes: string[]; txSeqs: number[] };

function resolveCidFromUploadResult(result: UploadSuccess): string | null {
  if ('rootHash' in result) {
    return result.rootHash;
  }

  return result.rootHashes[0] ?? null;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function uint8ArrayToBase64(value: Uint8Array): string {
  return btoa(String.fromCharCode(...value));
}

async function deriveIntentEncryptionKey(signer: ethers.Signer): Promise<CryptoKey> {
  const walletAddress = await signer.getAddress();
  const derivationMessage = `YieldGeko Storage Key v1\nWallet:${walletAddress}\nPurpose:Intent Encryption`;
  const signedMessage = await signer.signMessage(derivationMessage);
  const keyMaterial = ethers.getBytes(signedMessage);
  const digest = await crypto.subtle.digest('SHA-256', keyMaterial);

  return crypto.subtle.importKey(
    'raw',
    digest,
    { name: 'AES-GCM' },
    false,
    ['encrypt', 'decrypt']
  );
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
  async persistIntent<T>(state: T, signer: ethers.Signer): Promise<{ cid: string }> {
    // 1. Derive a wallet-bound key instead of persisting a raw symmetric key in browser storage.
    const walletAddress = await signer.getAddress();
    const key = await deriveIntentEncryptionKey(signer);
    const { iv, encrypted } = await encryptPayload(state, key);

    const payload: StoredIntentEnvelope = {
      data: uint8ArrayToBase64(new Uint8Array(encrypted)),
      iv: uint8ArrayToBase64(new Uint8Array(iv)),
      metadata: {
        app: 'YieldGeko',
        type: 'intent',
        walletAddress,
        keyDerivation: 'wallet-signature-v1',
      },
    };

    // 2. Robust Balance Check before upload
    try {
        const provider = signer.provider || new ethers.JsonRpcProvider(this.config.rpcUrl);
        const balance = await provider.getBalance(walletAddress);
        
        if (balance < ethers.parseEther("0.001")) {
            throw new Error('Insufficient 0G balance. Please fund your wallet at faucet.0g.ai');
        }
    } catch (balanceError) {
        const message = getErrorMessage(balanceError);
        if (message.includes('Insufficient 0G balance')) throw balanceError;
        console.warn("Balance check skipped due to provider error:", balanceError);
    }

    // 3. Upload to 0G Storage via SDK
    const indexer = new Indexer(this.config.indexerUrl);
    
    const encoder = new TextEncoder();
    const data = encoder.encode(JSON.stringify(payload));
    const memData = new MemData(data);
    
    try {
        // Transaction options belong to the sixth argument in the current SDK surface.
        const [tx, uploadError]: [UploadSuccess, Error | null] = await indexer.upload(
          memData,
          this.config.rpcUrl,
          signer,
          undefined,
          undefined,
          { gasLimit: BigInt(500000) }
        );

        if (uploadError) {
          throw uploadError;
        }

        const cid = resolveCidFromUploadResult(tx);

        if (!cid) {
          throw new Error('Could not resolve rootHash (CID) from 0G response');
        }

        return {
          cid,
        };
    } catch (error) {
        throw new Error(`0G Upload Failed: ${getErrorMessage(error)}`);
    }
  }

  /**
   * Retrieves and decrypts data from 0G Storage
   */
  async retrieveData<T = unknown>(cid: string): Promise<T> {
    const indexer = new Indexer(this.config.indexerUrl);
    
    try {
        // SDK returns a single Blob, or [Blob, Error] tuple
        const response = await indexer.downloadToBlob(cid);
        
        let blob: Blob | undefined;
        if (Array.isArray(response)) {
            if (response[1]) throw response[1];
            blob = response[0];
        } else {
            blob = response;
        }
        
        if (!blob) {
          throw new Error('No blob returned from 0G download');
        }

        // Parse JSON
        const text = await blob.text();
        return JSON.parse(text) as T;
    } catch (error) {
        console.error("0G Retrieval Failed:", error);
        throw new Error(`0G Retrieval Failed: ${getErrorMessage(error)}`);
    }
  }
}

export const storageService = new YieldGekoStorage();
