/**
 * YieldGeko Priority Execution Queue
 * Manages multi-user intents with strict ordering and persistence.
 */
export enum QueueTier {
  RISK_OFF = 0, // Highest Priority (Emergency Exits)
  YIELD_SEEK = 1 // Normal Priority (FIFO)
}

export interface QueueItem {
  userId: string;
  intent: any;
  tier: QueueTier;
  amount: bigint;
  targetVenue: string;
  timestamp: number;
}

export class ExecutionQueue {
  private queue: QueueItem[] = [];

  /**
   * Adds an intent to the queue with priority sorting
   */
  public enqueue(item: QueueItem) {
    this.queue.push(item);
    // Sort by Tier (Risk-Off first), then by Timestamp (FIFO)
    this.queue.sort((a, b) => {
      if (a.tier !== b.tier) return a.tier - b.tier;
      return a.timestamp - b.timestamp;
    });
    console.log(`[Queue] Item added for User ${item.userId} (Tier: ${QueueTier[item.tier]}). Total Depth: ${this.queue.length}`);
  }

  /**
   * Persists the queue state to 0G Storage (Encrypted)
   */
  public async persistToStorage(): Promise<string> {
    console.log("[Queue] Anchoring encrypted state to 0G Storage...");
    // Simulated: In prod, we encrypt this.queue with Agent ID key and upload to 0G
    const stateHash = `0x-queue-${Date.now()}`;
    return stateHash;
  }

  /**
   * Restores the queue from 0G Storage on boot
   */
  public async restoreFromStorage(cid: string) {
    console.log(`[Queue] Restoring pending migrations from 0G Storage (CID: ${cid})...`);
    // Simulated: Fetch from 0G and decrypt
    this.queue = []; 
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
