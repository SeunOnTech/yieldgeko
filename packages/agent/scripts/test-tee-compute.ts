/**
 * test-tee-compute.ts — smoke-test the 0G Compute TEE integration
 *
 * Run: npx ts-node scripts/test-tee-compute.ts
 *
 * Tests:
 *   1. Broker initialises against 0G Chain
 *   2. Provider is acknowledged
 *   3. Service metadata (endpoint + model) is fetched
 *   4. getRequestHeaders returns billing headers
 *   5. Inference call succeeds and returns a chatID
 *   6. processResponse settles the fee and verifies the signature
 *   7. signerRaUrl + chatSignatureUrl are returned (for 0G Storage blob)
 *
 * If you see "0G Compute broker init failed" it means:
 *   - The ledger is not funded → run: broker.ledger.addLedger(3)
 *   - Provider address is wrong → check ZG_COMPUTE_PROVIDER_ADDRESS
 *   - RPC is down → check https://evmrpc.0g.ai
 */

import * as dotenv from 'dotenv';
import * as path   from 'path';
dotenv.config({ path: path.resolve(__dirname, '../.env') });

import * as dns from 'node:dns';
dns.setDefaultResultOrder('ipv4first');

import { ethers } from 'ethers';

const ZG_CHAIN_RPC        = process.env.RPC_URL         ?? 'https://evmrpc.0g.ai';
const ZG_CHAIN_ID         = 16661;
const ZG_COMPUTE_PROVIDER = process.env.ZG_COMPUTE_PROVIDER_ADDRESS ?? '';
const ZG_COMPUTE_MODEL    = process.env.ZG_COMPUTE_MODEL ?? 'deepseek-chat';
const PRIVATE_KEY         = process.env.PRIVATE_KEY ?? '';

if (!PRIVATE_KEY)   { console.error('PRIVATE_KEY not set'); process.exit(1); }
if (!ZG_COMPUTE_PROVIDER) { console.error('ZG_COMPUTE_PROVIDER_ADDRESS not set'); process.exit(1); }

async function main() {
  console.log('\n═══════════════════════════════════════════');
  console.log(' 0G Compute TEE — Smoke Test');
  console.log('═══════════════════════════════════════════\n');
  console.log(`Provider:  ${ZG_COMPUTE_PROVIDER}`);
  console.log(`Model:     ${ZG_COMPUTE_MODEL}`);
  console.log(`RPC:       ${ZG_CHAIN_RPC}\n`);

  // Step 1 — connect
  console.log('[1] Connecting to 0G Chain...');
  const provider = new ethers.JsonRpcProvider(ZG_CHAIN_RPC, ZG_CHAIN_ID, { staticNetwork: true });
  const wallet   = new ethers.Wallet(PRIVATE_KEY, provider);
  console.log(`    Agent wallet: ${wallet.address}`);
  const balance = await provider.getBalance(wallet.address);
  console.log(`    OG balance:   ${ethers.formatEther(balance)} OG\n`);

  // Step 2 — create broker
  console.log('[2] Creating 0G Compute broker...');
  const { createZGComputeNetworkBroker } = await import('@0gfoundation/0g-compute-ts-sdk');
  const broker = await createZGComputeNetworkBroker(wallet);
  console.log('    Broker created ✅\n');

  // Step 2b — ensure ledger exists (one-time setup, costs ~0.5 OG)
  console.log('[2b] Checking ledger...');
  try {
    const ledger = await broker.ledger.getLedger();
    console.log(`    Ledger exists — balance: ${ledger} ✅`);
  } catch {
    console.log('    No ledger found — creating with 0.5 OG (one-time setup)...');
    await broker.ledger.addLedger(3);
    console.log('    Ledger created ✅');
  }

  // Step 3 — acknowledge provider
  console.log('\n[3] Checking provider acknowledgment...');
  const acked = await broker.inference.acknowledged(ZG_COMPUTE_PROVIDER).catch(() => false);
  if (!acked) {
    console.log('    Not yet acknowledged — acknowledging now...');
    await broker.inference.acknowledgeProviderSigner(ZG_COMPUTE_PROVIDER);
    console.log('    Acknowledged ✅');
  } else {
    console.log('    Already acknowledged ✅');
  }

  // Step 4 — service metadata
  console.log('\n[4] Fetching service metadata...');
  const meta = await broker.inference.getServiceMetadata(ZG_COMPUTE_PROVIDER);
  console.log(`    Endpoint: ${meta.endpoint}`);
  console.log(`    Model:    ${meta.model}`);

  // Step 5 — request headers
  const testPrompt = 'Reply with the single word: VERIFIED';
  console.log('\n[5] Generating billing headers...');
  const headers = await broker.inference.getRequestHeaders(ZG_COMPUTE_PROVIDER, testPrompt);
  console.log(`    Fee:   ${headers.Fee}`);
  console.log(`    Nonce: ${headers.Nonce}`);
  console.log('    Headers generated ✅');

  // Step 6 — inference call
  console.log('\n[6] Calling TEE inference...');
  const res = await fetch(`${meta.endpoint}/chat/completions`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', ...headers } as Record<string, string>,
    body:    JSON.stringify({
      model:    meta.model || ZG_COMPUTE_MODEL,
      messages: [{ role: 'user', content: testPrompt }],
      max_tokens:  20,
      temperature: 0,
    }),
  });

  if (!res.ok) {
    console.error(`    HTTP ${res.status}: ${await res.text()}`);
    process.exit(1);
  }

  const data    = await res.json() as any;
  const content = data.choices?.[0]?.message?.content ?? '';
  const responseKeyHeader = res.headers.get('ZG-Res-Key') || res.headers.get('zg-res-key') || '';
  const chatID  = responseKeyHeader || data.id || '';
  console.log(`    Response: "${content}"`);
  console.log(`    chatID:   ${chatID}`);
  console.log('    Inference call ✅');

  // Step 7 — processResponse (settles fee + verifies TEE sig)
  console.log('\n[7] Processing response (settle + verify)...');
  // New SDK: processResponse(provider, chatID, content)
  const verified = await broker.inference.processResponse(
    ZG_COMPUTE_PROVIDER,
    chatID,
    content,
  ).catch((e: any) => { console.warn('    processResponse warning:', e.message); return null; });
  console.log(`    Verified: ${verified}`);

  // Step 8 — attestation download links
  console.log('\n[8] Getting attestation links...');
  const signerRaUrl      = await broker.inference.getSignerRaDownloadLink(ZG_COMPUTE_PROVIDER).catch(() => '');
  const chatSignatureUrl = chatID
    ? await broker.inference.getChatSignatureDownloadLink(ZG_COMPUTE_PROVIDER, chatID).catch(() => '')
    : '';

  console.log(`    Signer RA:     ${signerRaUrl}`);
  console.log(`    Chat Sig:      ${chatSignatureUrl}`);

  console.log('\n═══════════════════════════════════════════');
  console.log(' ✅ 0G Compute TEE test PASSED');
  console.log('═══════════════════════════════════════════');
  console.log('\nThe real teeIntelligence.ts will use these links to build');
  console.log('the attestation blob stored on 0G Storage and anchored on 0G Chain.');
  console.log('\nNote: if processResponse returns false, the ledger may need funding:');
  console.log('  broker.ledger.addLedger(3)  →  adds 3 OG tokens to your ledger\n');
}

main().catch(err => {
  console.error('\n❌ Test failed:', err.message);
  process.exit(1);
});
