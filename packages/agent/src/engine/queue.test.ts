import test from 'node:test';
import assert from 'node:assert/strict';
import { deserializeQueueItems, QueueTier, serializeQueueItems } from './queue';

test('queue serialization round-trips bigint amounts', () => {
  const items = [
    {
      userId: 'user-1',
      intent: { type: 'MIGRATION' },
      tier: QueueTier.YIELD_SEEK,
      amount: 5000n,
      targetVenue: 'pendle',
      timestamp: 1,
    },
  ];

  const roundTrip = deserializeQueueItems(serializeQueueItems(items));
  assert.deepEqual(roundTrip, items);
});
