import {
  PersistedArtifact,
  StoragePersistenceConfig,
  StorageReadConfig,
  persistEncryptedJsonArtifact,
  restoreEncryptedJsonArtifact,
} from '../storage/persist';

export enum QueueTier {
  SAFETY_EXIT = 0, 
  RISK_OFF = 1,    
  YIELD_SEEK = 2   
}

export interface QueueItem {
  userId: string;
  intent: any;
  tier: QueueTier;
  amount: bigint;
  targetVenue: string;
  timestamp: number;
}

interface QueueItemWire {
  userId: string;
  intent: unknown;
  tier: QueueTier;
  amount: string;
  targetVenue: string;
  timestamp: number;
}

interface QueueSnapshot {
  schemaVersion: 1;
  savedAt: number;
  items: QueueItemWire[];
}

const QUEUE_SCHEMA = 'yieldgeko.execution-queue.v1';

export function serializeQueueItems(items: QueueItem[]): QueueItemWire[] {
  return items.map((item) => ({
    userId: item.userId,
    intent: item.intent,
    tier: item.tier,
    amount: item.amount.toString(),
    targetVenue: item.targetVenue,
    timestamp: item.timestamp,
  }));
}

export function deserializeQueueItems(items: QueueItemWire[]): QueueItem[] {
  return items.map((item) => ({
    userId: item.userId,
    intent: item.intent,
    tier: item.tier,
    amount: BigInt(item.amount),
    targetVenue: item.targetVenue,
    timestamp: item.timestamp,
  }));
}

export class ExecutionQueue {
  private queue: QueueItem[] = [];

  
  public enqueue(item: QueueItem) {
    this.queue.push(item);
    
    this.queue.sort((a, b) => {
      if (a.tier !== b.tier) return a.tier - b.tier;
      return a.timestamp - b.timestamp;
    });
    console.log(`[Queue] Item added for User ${item.userId} (Tier: ${QueueTier[item.tier]}). Total Depth: ${this.queue.length}`);
  }

  
  public async persistToStorage(
    encryptionKeyBase64: string,
    config: StoragePersistenceConfig
  ): Promise<PersistedArtifact> {
    console.log('[Queue] Anchoring encrypted state to 0G Storage...');

    const snapshot: QueueSnapshot = {
      schemaVersion: 1,
      savedAt: Date.now(),
      items: serializeQueueItems(this.queue),
    };

    return persistEncryptedJsonArtifact(QUEUE_SCHEMA, snapshot, encryptionKeyBase64, config);
  }

  
  public async restoreFromStorage(
    cid: string,
    encryptionKeyBase64: string,
    config: StorageReadConfig
  ): Promise<void> {
    console.log(`[Queue] Restoring pending migrations from 0G Storage (CID: ${cid})...`);

    const snapshot = await restoreEncryptedJsonArtifact<QueueSnapshot>(
      cid,
      QUEUE_SCHEMA,
      encryptionKeyBase64,
      config
    );

    if (snapshot.schemaVersion !== 1) {
      throw new Error(`Unsupported queue snapshot version: ${snapshot.schemaVersion}`);
    }

    this.queue = deserializeQueueItems(snapshot.items);
    this.queue.sort((a, b) => {
      if (a.tier !== b.tier) return a.tier - b.tier;
      return a.timestamp - b.timestamp;
    });
  }

  public getNextBatch(batchSize: number = 5): QueueItem[] {
    return this.queue.splice(0, batchSize);
  }

  public peek(): QueueItem[] {
    return [...this.queue];
  }

  public getDepth(): number {
    return this.queue.length;
  }
}
