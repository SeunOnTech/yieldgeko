import { Indexer } from '@0gfoundation/0g-storage-ts-sdk';
import { encryptPayload } from '@yieldgeko/core';
import { NormalizedYield } from '../types/normalized-yield';

// 0G Galileo Testnet Config
const INDEXER_URL = 'https://indexer-storage-testnet-turbo.0g.ai';

export async function persistNormalizedYield(
  yieldData: NormalizedYield,
  userAddress: string,
  aesKey: CryptoKey
): Promise<{ cid: string; proofHash: string }> {
  // Helper to handle BigInt in JSON
  const bigIntReplacer = (_key: string, value: any) => 
    typeof value === 'bigint' ? value.toString() : value;

  // 1. Encrypt the data
  const payload = JSON.stringify({ yieldData, userAddress, timestamp: Date.now() }, bigIntReplacer);
  const { iv, encrypted } = await encryptPayload(payload, aesKey);

  // 2. Prepare the final blob
  const blob = JSON.stringify({
    data: Buffer.from(encrypted).toString('base64'),
    iv: Buffer.from(iv).toString('base64'),
  });

  // 3. Upload to 0G Storage
  console.log(`[0G-STORAGE] Prepared encrypted blob for ${yieldData.venue} (${blob.length} bytes)`);
  
  // Simulated CID for Day 3 verification
  const cid = `0g-yield-${Math.random().toString(36).substring(7)}`;
  const proofHash = `0x${Math.random().toString(16).substring(2, 66)}`;

  return { cid, proofHash };
}
