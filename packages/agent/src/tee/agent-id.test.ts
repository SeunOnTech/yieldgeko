import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentIDManager } from './agent-id';
import { resetAgentEnvForTests } from '../config/env';

const ORIGINAL_ENV = { ...process.env };

test.afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  AgentIDManager.resetForTests();
  resetAgentEnvForTests();
});

test('initializeAgentID requires a configured private key', async () => {
  process.env.AGENT_SKIP_DOTENV = 'true';
  delete process.env.PRIVATE_KEY;
  process.env.AGENT_USER_ID = 'user';
  process.env.AGENT_MANAGED_AMOUNT = '1';
  process.env.AGENT_STATE_ENCRYPTION_KEY_B64 = Buffer.alloc(32, 1).toString('base64');
  process.env.AGENT_QUEUE_ENCRYPTION_KEY_B64 = Buffer.alloc(32, 2).toString('base64');
  process.env.RPC_URL = 'https://example-rpc.local';
  process.env.INDEXER_URL = 'https://example-indexer.local';

  await assert.rejects(
    () => AgentIDManager.initializeAgentID(),
    /PRIVATE_KEY is required/
  );
});

test('generateAttestationReport fails closed without attestation metadata', async () => {
  process.env.AGENT_SKIP_DOTENV = 'true';
  process.env.PRIVATE_KEY = `0x${'1'.repeat(64)}`;
  process.env.AGENT_USER_ID = 'user';
  process.env.AGENT_MANAGED_AMOUNT = '1';
  process.env.AGENT_STATE_ENCRYPTION_KEY_B64 = Buffer.alloc(32, 1).toString('base64');
  process.env.AGENT_QUEUE_ENCRYPTION_KEY_B64 = Buffer.alloc(32, 2).toString('base64');
  process.env.RPC_URL = 'https://example-rpc.local';
  process.env.INDEXER_URL = 'https://example-indexer.local';
  await AgentIDManager.initializeAgentID();

  await assert.rejects(
    () => AgentIDManager.generateAttestationReport(),
    /ZERO_G_TEE_MRENCLAVE is required/
  );
});

test('generateAttestationReport supports explicit local development mode', async () => {
  process.env.AGENT_SKIP_DOTENV = 'true';
  process.env.PRIVATE_KEY = `0x${'2'.repeat(64)}`;
  process.env.AGENT_ENVIRONMENT = 'development';
  process.env.ALLOW_UNATTESTED_AGENT = 'true';
  process.env.AGENT_USER_ID = 'user';
  process.env.AGENT_MANAGED_AMOUNT = '1';
  process.env.AGENT_STATE_ENCRYPTION_KEY_B64 = Buffer.alloc(32, 1).toString('base64');
  process.env.AGENT_QUEUE_ENCRYPTION_KEY_B64 = Buffer.alloc(32, 2).toString('base64');
  process.env.RPC_URL = 'https://example-rpc.local';
  process.env.INDEXER_URL = 'https://example-indexer.local';

  await AgentIDManager.initializeAgentID();
  const report = await AgentIDManager.generateAttestationReport();

  assert.equal(report.mode, 'development-unattested');
  assert.match(report.mrenclave, /^0x[0-9a-f]{64}$/);
});
