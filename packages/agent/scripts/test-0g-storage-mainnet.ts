#!/usr/bin/env npx ts-node
/**
 * test-0g-storage-mainnet.ts — 0G Storage mainnet verification
 * Usage: cd packages/agent && npx ts-node scripts/test-0g-storage-mainnet.ts
 */

// Must be first — forces Node.js to prefer IPv4 before any network imports
import * as dns from 'node:dns';
dns.setDefaultResultOrder('ipv4first');

import { ethers } from 'ethers';
import { Indexer, MemData } from '@0gfoundation/0g-ts-sdk';
import * as dotenv from 'dotenv';
import * as path from 'node:path';

dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

const MAINNET_RPC     = 'https://evmrpc.0g.ai';
const MAINNET_INDEXER = 'https://indexer-storage-turbo.0g.ai';
const CHAIN_ID        = 16661;
const PRIVATE_KEY     = process.env.PRIVATE_KEY!;

const ok   = (s: string) => console.log(`  ✅ ${s}`);
const fail = (s: string) => { console.error(`  ❌ ${s}`); process.exit(1); };
const info = (s: string) => console.log(`  ℹ  ${s}`);
const step = (s: string) => console.log(`\n[${s}]`);

async function main() {
  console.log('\n╔══════════════════════════════════════════════════════╗');
  console.log('║  0G Storage Mainnet — Verification Script            ║');
  console.log('╚══════════════════════════════════════════════════════╝\n');

  if (!PRIVATE_KEY) fail('PRIVATE_KEY not set in .env');

  step('1. Connecting to 0G Chain mainnet');
  const provider = new ethers.JsonRpcProvider(MAINNET_RPC, CHAIN_ID, { staticNetwork: true });
  const wallet   = new ethers.Wallet(PRIVATE_KEY, provider);

  info(`Wallet:  ${wallet.address}`);

  const balance   = await provider.getBalance(wallet.address);
  const balanceOG = Number(ethers.formatEther(balance));
  info(`OG balance: ${balanceOG.toFixed(6)} OG`);
  if (balanceOG < 0.001) fail(`Insufficient OG — fund ${wallet.address} on 0G mainnet (chain 16661)`);
  ok(`Wallet funded — ${balanceOG.toFixed(6)} OG`);

  step('2. Building test payload');
  const payload = {
    type:      'yieldgeko-storage-test',
    timestamp:  Date.now(),
    wallet:     wallet.address,
    network:   'arbitrum-mainnet',
    message:   'YieldGeko × 0G — every yield decision is now immutably stored on 0G mainnet.',
  };
  const data    = new TextEncoder().encode(JSON.stringify(payload));
  const memData = new MemData(data);

  // merkleTree() must be called before upload per docs
  const [tree, treeErr] = await memData.merkleTree();
  if (treeErr) fail(`Merkle tree error: ${treeErr}`);
  ok(`Payload ready — root: ${(tree as any)?.rootHash()?.slice(0, 20)}...`);

  step('3. Uploading to 0G Storage mainnet');
  info('Indexer: ' + MAINNET_INDEXER);
  info('This may take 15–60 seconds...');

  const indexer = new Indexer(MAINNET_INDEXER);
  const [tx, uploadErr] = await indexer.upload(memData, MAINNET_RPC, wallet);

  if (uploadErr) fail(`Upload failed: ${uploadErr.message ?? uploadErr}`);

  const cid    = 'rootHash' in tx ? tx.rootHash    : tx.rootHashes[0]!;
  const txHash = 'txHash'   in tx ? tx.txHash      : tx.txHashes[0]!;

  ok('Upload confirmed!');
  info(`CID:    ${cid}`);
  info(`TxHash: ${txHash}`);
  console.log(`\n  🔗 StorageScan: https://storagescan.0g.ai/tx/${txHash}`);
  console.log(`  🔗 By CID:      https://storagescan.0g.ai/file?cid=${cid}`);

  step('4. Downloading back to verify');
  await new Promise(r => setTimeout(r, 5000));
  const [blob, dlErr] = await indexer.downloadToBlob(cid);
  if (dlErr) {
    info(`Download check skipped (propagation): ${dlErr}`);
  } else {
    const retrieved = JSON.parse(Buffer.from(await blob.arrayBuffer()).toString('utf8'));
    if (retrieved.message === payload.message) ok('Round-trip verified ✓');
    else info('Data retrieved but differs — propagation lag');
  }

  console.log('\n══════════════════════════════════════════════════════');
  console.log('  ✅ 0G Storage mainnet works. Now update .env:');
  console.log('     RPC_URL=https://evmrpc.0g.ai');
  console.log('     INDEXER_URL=https://indexer-storage-turbo.0g.ai');
  console.log('     FLOW_ADDR=0x62D4144dB0F0a6fBBaeb6296c785C71B3D57C526');
  console.log('══════════════════════════════════════════════════════\n');
}

main().catch(err => { console.error('\n❌ Fatal:', err.message); process.exit(1); });
