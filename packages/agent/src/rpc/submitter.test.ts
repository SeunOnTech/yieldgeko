import test from 'node:test';
import assert from 'node:assert/strict';
import { PrivateSubmitter } from './submitter';

const ORIGINAL_ENV = { ...process.env };

test.afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

test('prefers explicit private RPC when configured', () => {
  process.env.ZERO_G_PRIVATE_RPC = 'https://private.example';
  process.env.ZERO_G_RPC = 'https://public.example';

  const endpoint = PrivateSubmitter.resolveRpcEndpoint();
  assert.equal(endpoint.url, 'https://private.example');
  assert.equal(endpoint.mode, 'private');
});

test('falls back to standard RPC when private endpoint is absent', () => {
  delete process.env.ZERO_G_PRIVATE_RPC;
  process.env.ZERO_G_RPC = 'https://public.example';

  const endpoint = PrivateSubmitter.resolveRpcEndpoint();
  assert.equal(endpoint.url, 'https://public.example');
  assert.equal(endpoint.mode, 'public');
});
