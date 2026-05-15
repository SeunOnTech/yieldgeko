import { QueueItem } from './queue';

export interface MigrationBatch {
  venue: string;
  items: QueueItem[];
  totalAmount: bigint;
  totalGasEstimate: bigint;
}

export class MigrationBatcher {
  
  public static createBatches(items: QueueItem[]): MigrationBatch[] {
    const venueMap: { [key: string]: QueueItem[] } = {};

    items.forEach(item => {
      if (!venueMap[item.targetVenue]) venueMap[item.targetVenue] = [];
      venueMap[item.targetVenue].push(item);
    });

    return Object.entries(venueMap).map(([venue, batchItems]) => {
      const totalAmount = batchItems.reduce((acc, item) => acc + item.amount, 0n);
      
      
      
      const gasEstimate = 200000n + (150000n * BigInt(batchItems.length));

      console.log(`[Batcher] Created batch for ${venue} with ${batchItems.length} users. Total Value: ${totalAmount.toString()}`);
      
      return {
        venue,
        items: batchItems,
        totalAmount,
        totalGasEstimate: gasEstimate
      };
    });
  }

  
  public static calculateGasShare(userAmount: bigint, batch: MigrationBatch): bigint {
    if (batch.totalAmount === 0n) return 0n;
    return (userAmount * batch.totalGasEstimate) / batch.totalAmount;
  }
}
