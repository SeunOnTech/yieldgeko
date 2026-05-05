import { EncryptedUserState } from '../types/user-state';
import { encryptData, generateAESKey, exportKeyBase64 } from './encryption';

/**
 * 0G Storage Service Wrapper
 * Provides high-level methods for persisting encrypted user intents.
 */

export interface StorageConfig {
  rpcUrl: string;
  storageNodeUrl: string;
  indexerUrl: string;
}

// Default Galileo Testnet Config
const DEFAULT_CONFIG: StorageConfig = {
  rpcUrl: "https://evmrpc-testnet.0g.ai",
  storageNodeUrl: "https://storage-node-testnet.0g.ai", // Placeholder, will be injected via env
  indexerUrl: "https://indexer-testnet.0g.ai"
};

export class YieldGekoStorage {
  private config: StorageConfig;

  constructor(config: Partial<StorageConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Persists user state to 0G Storage
   * 1. Encrypts data client-side
   * 2. Uploads to 0G Storage
   * 3. Returns CID and Decryption Key (to be stored in local storage)
   */
  async persistIntent(state: any): Promise<{ cid: string; key: string; iv: string }> {
    // 1. Generate Key & Encrypt
    const key = await generateAESKey();
    const { iv, encrypted } = await encryptData(state, key);
    const keyBase64 = await exportKeyBase64(key);

    // 2. Upload to 0G Storage
    // In a pro production setup, we use the 0G Gateway or AgentKit Storage Module
    // For now, we simulate the upload and return a mock CID if the node is unreachable
    // but we prepare the payload exactly for 0G.
    
    const payload = JSON.stringify({
      data: encrypted,
      iv: iv,
      metadata: {
        app: "YieldGeko",
        version: "1.0",
        type: "intent"
      }
    });

    console.log("Uploading to 0G Storage:", payload);
    
    // Simulate CID generation (will be replaced by real SDK call in next step)
    const mockCid = `0g-${Math.random().toString(36).substring(2)}`;

    return {
      cid: mockCid,
      key: keyBase64,
      iv: iv
    };
  }

  async retrieveIntent(cid: string, keyBase64: string, iv: string): Promise<any> {
    // In production, this fetches from the 0G Indexer
    console.log("Fetching from 0G Indexer CID:", cid);
    return null; // Implementation follow-up
  }
}

export const storageService = new YieldGekoStorage();
