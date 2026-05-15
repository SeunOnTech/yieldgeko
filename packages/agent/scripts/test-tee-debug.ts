/**
 * test-tee-debug.ts — end-to-end TEE diagnostics for execution proof readiness
 *
 * Run:
 *   pnpm --dir packages/agent exec ts-node scripts/test-tee-debug.ts
 *
 * What this checks:
 *   1. Required 0G / compute env vars exist
 *   2. Broker can initialise against 0G Chain
 *   3. Provider is acknowledged and metadata resolves
 *   4. Direct TEE inference succeeds
 *   5. processResponse verification runs
 *   6. RA + chat-signature links resolve
 *   7. generateTEEAttestation(...) returns a real 0G Storage CID
 *   8. Whether the final mode is `tee-compute` or only `local-signing`
 *
 * Exit codes:
 *   0 = real TEE path succeeded (`mode: tee-compute`)
 *   2 = fallback path only (`mode: local-signing`) — proof badge would NOT be true TEE
 *   1 = hard failure / missing prerequisites
 */

import * as dotenv from 'dotenv';
import * as path from 'node:path';
import * as dns from 'node:dns';
import { ethers } from 'ethers';

import { generateTEEAttestation } from '../src/orchestrator/teeIntelligence';

dotenv.config({ path: path.resolve(__dirname, '../.env') });
dotenv.config({ path: path.resolve(__dirname, '../.env.local'), override: true });

dns.setDefaultResultOrder('ipv4first');

const ZG_CHAIN_RPC = process.env.RPC_URL ?? 'https://evmrpc.0g.ai';
const ZG_CHAIN_ID = 16661;
const ZG_COMPUTE_PROVIDER = process.env.ZG_COMPUTE_PROVIDER_ADDRESS ?? '';
const ZG_COMPUTE_MODEL = process.env.ZG_COMPUTE_MODEL ?? 'deepseek-chat';
const PRIVATE_KEY = process.env.PRIVATE_KEY ?? '';
const INDEXER_URL = process.env.INDEXER_URL ?? '';
const TEST_USER = process.env.TEST_USER_ADDRESS ?? '0x092106703adE19BF7a638AD371f8f6c25831F349';
const TEST_RECEIPT = (`0x${'cd'.repeat(32)}`) as `0x${string}`;

function ok(label: string, detail?: string) {
  console.log(`  PASS ${label}${detail ? ` — ${detail}` : ''}`);
}

function warn(label: string, detail?: string) {
  console.log(`  WARN ${label}${detail ? ` — ${detail}` : ''}`);
}

function fail(label: string, detail?: string): never {
  console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  process.exit(1);
}

async function main() {
  console.log('\n════════════════════════════════════════════════════════════');
  console.log(' YieldGeko TEE Diagnostic');
  console.log('════════════════════════════════════════════════════════════\n');

  console.log('Environment');
  if (!PRIVATE_KEY) fail('PRIVATE_KEY missing');
  if (!INDEXER_URL) fail('INDEXER_URL missing');
  if (!ZG_COMPUTE_PROVIDER) fail('ZG_COMPUTE_PROVIDER_ADDRESS missing');
  ok('PRIVATE_KEY present');
  ok('INDEXER_URL present', INDEXER_URL);
  ok('RPC_URL present', ZG_CHAIN_RPC);
  ok('ZG_COMPUTE_PROVIDER_ADDRESS present', ZG_COMPUTE_PROVIDER);
  ok('ZG_COMPUTE_MODEL', ZG_COMPUTE_MODEL);

  console.log('\nBroker readiness');
  const provider = new ethers.JsonRpcProvider(ZG_CHAIN_RPC, ZG_CHAIN_ID, { staticNetwork: true });
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
  const balance = await provider.getBalance(wallet.address);
  ok('0G signer wallet', wallet.address);
  ok('0G signer balance', `${ethers.formatEther(balance)} OG`);

  const { createZGComputeNetworkBroker } = await import('@0gfoundation/0g-compute-ts-sdk');
  const broker = await createZGComputeNetworkBroker(wallet);
  ok('broker created');

  try {
    const ledger = await broker.ledger.getLedger();
    ok('ledger available', String(ledger));
  } catch {
    warn('ledger missing', 'creating one-time ledger with addLedger(3)');
    await broker.ledger.addLedger(3);
    ok('ledger created');
  }

  const acked = await broker.inference.acknowledged(ZG_COMPUTE_PROVIDER).catch(() => false);
  if (!acked) {
    warn('provider not acknowledged', 'acknowledging now');
    await broker.inference.acknowledgeProviderSigner(ZG_COMPUTE_PROVIDER);
  }
  ok('provider acknowledged');

  const meta = await broker.inference.getServiceMetadata(ZG_COMPUTE_PROVIDER);
  ok('service metadata', `endpoint=${meta.endpoint} model=${meta.model || ZG_COMPUTE_MODEL}`);

  console.log('\nDirect TEE inference');
  const testPrompt = 'Reply in valid JSON only: {"confirmedRank":1,"confidence":99,"rationale":"TEE diagnostic ok","riskFlags":[]}';
  const headers = await broker.inference.getRequestHeaders(ZG_COMPUTE_PROVIDER, testPrompt);
  ok('billing headers generated', `fee=${headers.Fee} nonce=${headers.Nonce}`);

  const inferenceRes = await fetch(`${meta.endpoint}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers } as Record<string, string>,
    body: JSON.stringify({
      model: meta.model || ZG_COMPUTE_MODEL,
      messages: [{ role: 'user', content: testPrompt }],
      max_tokens: 128,
      temperature: 0,
    }),
  });
  if (!inferenceRes.ok) {
    fail('TEE inference HTTP error', `${inferenceRes.status} ${await inferenceRes.text()}`);
  }

  const inferenceJson = await inferenceRes.json() as any;
  const content = inferenceJson.choices?.[0]?.message?.content ?? '';
  const responseKeyHeader = inferenceRes.headers.get('ZG-Res-Key') || inferenceRes.headers.get('zg-res-key') || '';
  const chatID = responseKeyHeader || inferenceJson.id || '';
  ok('inference response received', `chatID=${chatID}`);
  ok('raw content', content.slice(0, 180));

  const verified = await broker.inference.processResponse(
    ZG_COMPUTE_PROVIDER,
    chatID,
    content,
  ).catch((error: any) => {
    warn('processResponse warning', error.message?.slice(0, 120));
    return null;
  });
  if (verified === true) ok('processResponse verified', 'true');
  else if (verified === false) warn('processResponse verified', 'false');
  else warn('processResponse verified', 'null');

  const [signerRaUrl, chatSignatureUrl] = await Promise.all([
    broker.inference.getSignerRaDownloadLink(ZG_COMPUTE_PROVIDER).catch(() => ''),
    chatID ? broker.inference.getChatSignatureDownloadLink(ZG_COMPUTE_PROVIDER, chatID).catch(() => '') : Promise.resolve(''),
  ]);
  ok('signer RA URL', signerRaUrl || '(empty)');
  ok('chat signature URL', chatSignatureUrl || '(empty)');

  console.log('\nExecution-style attestation');
  const teeAttestation = await generateTEEAttestation({
    opportunities: [],
    decision: {
      action: 'GENESIS',
      reason: 'TEE diagnostic end-to-end validation',
      upliftPct: 0,
      targetOpportunity: null,
      currentOpportunity: null,
    },
    userId: 'tee-diagnostic',
    userAddress: TEST_USER,
    receiptHash: TEST_RECEIPT,
  });

  if (!teeAttestation) {
    fail('generateTEEAttestation returned null', 'execution records will not get a TEE badge');
  }

  ok('attestation CID stored', teeAttestation.attestCID);
  ok('attestation mode', teeAttestation.mode);
  console.log(`  StorageScan: https://storagescan.0g.ai/submission/${teeAttestation.attestCID}`);

  if (teeAttestation.mode !== 'tee-compute') {
    console.log('\nResult');
    warn(
      'fallback only',
      'attestation exists, but it is local-signing instead of real TEE; frontend should not treat this as top-tier TEE proof',
    );
    process.exit(2);
  }

  console.log('\nResult');
  ok('real TEE path working', 'new executions are capable of receiving a genuine TEE attestation artifact');
  console.log('\n════════════════════════════════════════════════════════════');
  console.log(' SUCCESS — YieldGeko TEE path is working end-to-end');
  console.log('════════════════════════════════════════════════════════════\n');
}

main().catch((error: any) => {
  console.error('\nFatal TEE diagnostic failure:', error.message ?? error);
  process.exit(1);
});
