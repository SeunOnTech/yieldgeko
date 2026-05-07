import { Indexer, MemData } from '@0gfoundation/0g-ts-sdk';
import { decryptPayload, encryptPayload, importKeyBase64 } from '@yieldgeko/core';
import { Signer } from 'ethers';
import { NormalizedYield } from '../types/normalized-yield';
import { canonicalJsonStringify, sha256Hex } from '../utils/canonical-json';

export interface StoragePersistenceConfig {
  indexerUrl: string;
  evmRpcUrl: string;
  signer: Signer;
  gasLimit?: bigint;
}

export interface PersistedArtifact {
  cid: string;
  proofHash: `0x${string}`;
  txHash: `0x${string}`;
  txSeq: number;
}

export interface StorageReadConfig {
  indexerUrl: string;
}

export interface EncryptedJsonEnvelope {
  schema: string;
  data: string;
  iv: string;
}

function extractSingleUploadResult(
  result:
    | { txHash: string; rootHash: string; txSeq: number }
    | { txHashes: string[]; rootHashes: string[]; txSeqs: number[] }
): PersistedArtifact {
  if ('rootHash' in result) {
    return {
      cid: result.rootHash,
      proofHash: sha256Hex(result.rootHash),
      txHash: result.txHash as `0x${string}`,
      txSeq: result.txSeq,
    };
  }

  if (result.rootHashes.length !== 1 || result.txHashes.length !== 1 || result.txSeqs.length !== 1) {
    throw new Error('Expected a single-root JSON artifact upload, received fragmented output');
  }

  return {
    cid: result.rootHashes[0]!,
    proofHash: sha256Hex(result.rootHashes[0]!),
    txHash: result.txHashes[0]! as `0x${string}`,
    txSeq: result.txSeqs[0]!,
  };
}

export async function persistJsonArtifact(
  payload: unknown,
  config: StoragePersistenceConfig
): Promise<PersistedArtifact> {
  const serialized = canonicalJsonStringify(payload);
  const memData = new MemData(Buffer.from(serialized, 'utf8'));
  const indexer = new Indexer(config.indexerUrl);
  const [result, error] = await indexer.upload(
    memData,
    config.evmRpcUrl,
    config.signer,
    undefined,
    undefined,
    { gasLimit: config.gasLimit ?? 500000n }
  );

  if (error) {
    throw new Error(`0G upload failed: ${error.message}`);
  }

  const uploaded = extractSingleUploadResult(result);

  return {
    ...uploaded,
    proofHash: sha256Hex(serialized),
  };
}

export async function downloadJsonArtifact<T>(
  cid: string,
  config: StorageReadConfig
): Promise<T> {
  const indexer = new Indexer(config.indexerUrl);
  const [blob, error] = await indexer.downloadToBlob(cid);

  if (error) {
    throw new Error(`0G download failed: ${error.message}`);
  }

  const text = Buffer.from(await blob.arrayBuffer()).toString('utf8');
  return JSON.parse(text) as T;
}

export async function persistEncryptedJsonArtifact(
  schema: string,
  payload: unknown,
  encryptionKeyBase64: string,
  config: StoragePersistenceConfig
): Promise<PersistedArtifact> {
  const key = await importKeyBase64(encryptionKeyBase64);
  const serialized = canonicalJsonStringify(payload);
  const { iv, encrypted } = await encryptPayload(serialized, key);

  const envelope: EncryptedJsonEnvelope = {
    schema,
    data: Buffer.from(encrypted).toString('base64'),
    iv: Buffer.from(iv).toString('base64'),
  };

  return persistJsonArtifact(envelope, config);
}

export async function restoreEncryptedJsonArtifact<T>(
  cid: string,
  expectedSchema: string,
  encryptionKeyBase64: string,
  config: StorageReadConfig
): Promise<T> {
  const envelope = await downloadJsonArtifact<EncryptedJsonEnvelope>(cid, config);

  if (envelope.schema !== expectedSchema) {
    throw new Error(`Unexpected artifact schema: expected ${expectedSchema}, received ${envelope.schema}`);
  }

  const key = await importKeyBase64(encryptionKeyBase64);
  const encryptedBuffer = Buffer.from(envelope.data, 'base64');
  const arrayBuffer = encryptedBuffer.buffer.slice(
    encryptedBuffer.byteOffset,
    encryptedBuffer.byteOffset + encryptedBuffer.byteLength
  );
  const iv = new Uint8Array(Buffer.from(envelope.iv, 'base64'));

  return (await decryptPayload(arrayBuffer, iv, key)) as T;
}

export async function persistNormalizedYield(
  yieldData: NormalizedYield,
  userAddress: string,
  aesKey: CryptoKey,
  config: StoragePersistenceConfig
): Promise<PersistedArtifact> {
  const payload = canonicalJsonStringify({
    yieldData,
    userAddress,
    timestamp: Date.now(),
  });
  const { iv, encrypted } = await encryptPayload(payload, aesKey);

  const blob = {
    schema: 'yieldgeko.encrypted-yield.v1',
    data: Buffer.from(encrypted).toString('base64'),
    iv: Buffer.from(iv).toString('base64'),
  } as const;

  console.log(
    `[0G-STORAGE] Uploading encrypted normalized yield for ${yieldData.venue} on behalf of ${userAddress}`
  );

  return persistJsonArtifact(blob, config);
}
