import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentRuntimeState } from './agent-state';
import { canonicalJsonStringify } from '../utils/canonical-json';

test('agent runtime state canonicalizes deterministically', () => {
  const state: AgentRuntimeState = {
    schemaVersion: 1,
    userId: 'user-1',
    amount: '5000000000',
    currentPosition: {
      venueId: 'aave',
      venueName: 'Aave USDC',
      apy: 5.25,
    },
    updatedAt: 123456,
  };

  assert.equal(
    canonicalJsonStringify(state),
    '{"amount":"5000000000","currentPosition":{"apy":5.25,"venueId":"aave","venueName":"Aave USDC"},"schemaVersion":1,"updatedAt":123456,"userId":"user-1"}'
  );
});
