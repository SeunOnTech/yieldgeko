#!/usr/bin/env npx ts-node
/**
 * Fund the test user wallet with a tiny ETH from the deployer wallet.
 *
 * The deployer wallet has leftover ETH after contract deployment (~0.0004 ETH).
 * This script sends 0.0002 ETH to TEST_USER_ADDRESS so they can pay the
 * single vault.deposit() gas fee (~$0.03) in the e2e test.
 *
 * Usage:
 *   npx ts-node scripts/fund-test-user.ts
 */

import { ethers } from 'ethers';
import * as dotenv from 'dotenv';
import * as path  from 'node:path';
import * as fs    from 'node:fs';

// Load agent .env (has TEST_USER_ADDRESS and ARB_RPC_URL)
dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

// Read deployer key directly from contracts/.env — avoids collision with agent PRIVATE_KEY
function readContractsEnvKey(key: string): string | undefined {
  const contractsEnv = path.resolve(__dirname, '..', '..', '..', 'contracts', '.env');
  if (!fs.existsSync(contractsEnv)) return undefined;
  const lines = fs.readFileSync(contractsEnv, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('#') || !trimmed.includes('=')) continue;
    const [k, ...rest] = trimmed.split('=');
    if (k.trim() === key) return rest.join('=').trim();
  }
  return undefined;
}

const ARB_RPC_URL    = process.env.ARB_RPC_URL ?? 'https://arb1.arbitrum.io/rpc';
const DEPLOYER_KEY   = readContractsEnvKey('PRIVATE_KEY');
const TEST_USER      = process.env.TEST_USER_ADDRESS;
const SEND_AMOUNT    = ethers.parseEther('0.0002'); // ~$0.48 — enough for several deposit txns

async function main() {
  if (!DEPLOYER_KEY) { console.error('❌ PRIVATE_KEY not set'); process.exit(1); }
  if (!TEST_USER)    { console.error('❌ TEST_USER_ADDRESS not set in .env'); process.exit(1); }

  const provider  = new ethers.JsonRpcProvider(ARB_RPC_URL, 42161, { staticNetwork: true });
  const deployer  = new ethers.Wallet(DEPLOYER_KEY, provider);

  const [deployerBal, userBal] = await Promise.all([
    provider.getBalance(deployer.address),
    provider.getBalance(TEST_USER),
  ]);

  console.log(`\nDeployer: ${deployer.address}`);
  console.log(`  balance: ${ethers.formatEther(deployerBal)} ETH`);
  console.log(`\nTest user: ${TEST_USER}`);
  console.log(`  balance: ${ethers.formatEther(userBal)} ETH`);

  if (deployerBal < SEND_AMOUNT + ethers.parseEther('0.0001')) {
    console.error(`\n❌ Deployer has insufficient ETH (need ${ethers.formatEther(SEND_AMOUNT + ethers.parseEther('0.0001'))} ETH)`);
    process.exit(1);
  }

  if (userBal >= ethers.parseEther('0.0001')) {
    console.log(`\n✅ Test user already has enough ETH (${ethers.formatEther(userBal)} ETH) — no transfer needed`);
    process.exit(0);
  }

  console.log(`\nSending ${ethers.formatEther(SEND_AMOUNT)} ETH to test user…`);
  const tx = await deployer.sendTransaction({ to: TEST_USER, value: SEND_AMOUNT });
  console.log(`tx: ${tx.hash}`);
  await tx.wait(1);

  const newBal = await provider.getBalance(TEST_USER);
  console.log(`\n✅ Done — test user balance: ${ethers.formatEther(newBal)} ETH`);
  console.log('\nNow run: npx ts-node scripts/e2e-user-test.ts\n');
}

main().catch(err => { console.error('❌', err.message); process.exit(1); });
