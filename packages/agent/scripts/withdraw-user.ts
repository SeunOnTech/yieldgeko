#!/usr/bin/env npx ts-node
/**
 * YieldGeko — Real User Withdrawal Helper
 *
 * Production shape:
 *   1. Ask the agent to prepare withdrawal:
 *      close active strategy positions and normalise returned assets to idle USDC.
 *   2. User signs vault.withdraw(USDC, idleAmount) from their own wallet.
 *
 * By default this script only performs step 1 and prints the exact user-signed
 * withdrawal call needed. Set WITHDRAW_TO_WALLET=true to execute step 2 using
 * TEST_USER_PRIVKEY/USER_PRIVATE_KEY/PRIVATE_KEY from .env for local E2E tests.
 */

import { ethers } from 'ethers';
import * as dotenv from 'dotenv';
import * as path from 'node:path';

dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

const AGENT_URL = process.env.AGENT_URL ?? 'http://localhost:3001';
const RPC_URL = process.env.ARB_RPC_URL ?? 'https://arb1.arbitrum.io/rpc';
const VAULT_ADDRESS = process.env.VAULT_ADDRESS;
const USER_ADDRESS = process.env.TEST_USER_ADDRESS ?? process.env.USER_ADDRESS;
const USER_KEY = process.env.TEST_USER_PRIVKEY ?? process.env.USER_PRIVATE_KEY ?? process.env.PRIVATE_KEY;
const USER_ID = process.env.WITHDRAW_USER_ID ?? (USER_ADDRESS ? `user-${USER_ADDRESS.slice(2, 10)}` : undefined);
const WITHDRAW_TO_WALLET = process.env.WITHDRAW_TO_WALLET === 'true';

const USDC = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831';
const VAULT_ABI = [
  'function balances(address user, address asset) view returns (uint256)',
  'function withdraw(address asset, uint256 amount) external',
];

function fail(message: string): never {
  throw new Error(message);
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json?.ok === false) {
    fail(json?.error ?? `HTTP ${res.status}`);
  }
  return json as T;
}

async function main() {
  console.log('\nYieldGeko User Withdrawal Helper\n');

  if (!VAULT_ADDRESS) fail('VAULT_ADDRESS is not set');
  if (!USER_ADDRESS) fail('TEST_USER_ADDRESS or USER_ADDRESS is not set');
  if (!USER_ID) fail('WITHDRAW_USER_ID or TEST_USER_ADDRESS is required');

  console.log(`  Agent: ${AGENT_URL}`);
  console.log(`  Vault: ${VAULT_ADDRESS}`);
  console.log(`  User:  ${USER_ADDRESS}`);
  console.log(`  Mode:  ${WITHDRAW_TO_WALLET ? 'prepare + user-signed wallet withdrawal' : 'prepare only'}\n`);

  console.log('[1] Asking agent to prepare withdrawal...');
  const prepared = await postJson<{
    status: string;
    idleUSDCRaw: string;
    idleUSDC: number;
    txs?: Array<{ positionId: string; closeTxHash: string; normalizeTxHash?: string }>;
    nextStep?: string;
  }>(`${AGENT_URL}/api/withdraw`, { userId: USER_ID, userAddress: USER_ADDRESS });

  console.log(`  Status:    ${prepared.status}`);
  console.log(`  Idle USDC: ${prepared.idleUSDC} (${prepared.idleUSDCRaw} raw)`);
  for (const tx of prepared.txs ?? []) {
    console.log(`  Position:  ${tx.positionId}`);
    console.log(`    close:     ${tx.closeTxHash}`);
    if (tx.normalizeTxHash) console.log(`    normalize: ${tx.normalizeTxHash}`);
  }

  const amount = BigInt(prepared.idleUSDCRaw ?? '0');
  if (amount === 0n) {
    console.log('\nNo idle USDC available to withdraw.');
    return;
  }

  console.log('\n[2] Final wallet withdrawal');
  console.log(`  User-signed call: vault.withdraw(${USDC}, ${amount.toString()})`);

  if (!WITHDRAW_TO_WALLET) {
    console.log('  Skipped. Set WITHDRAW_TO_WALLET=true to execute this local E2E step.');
    return;
  }

  if (!USER_KEY) fail('WITHDRAW_TO_WALLET=true requires TEST_USER_PRIVKEY, USER_PRIVATE_KEY, or PRIVATE_KEY');

  const provider = new ethers.JsonRpcProvider(RPC_URL, 42161, { staticNetwork: true });
  const wallet = new ethers.Wallet(USER_KEY, provider);
  if (wallet.address.toLowerCase() !== USER_ADDRESS.toLowerCase()) {
    fail(`Signer mismatch: key resolves to ${wallet.address}, expected ${USER_ADDRESS}`);
  }

  const vault = new ethers.Contract(VAULT_ADDRESS, VAULT_ABI, wallet);
  const idleBefore = await vault.balances(USER_ADDRESS, USDC) as bigint;
  if (idleBefore < amount) {
    fail(`Idle USDC changed before withdrawal: have ${idleBefore}, expected ${amount}`);
  }

  const tx = await vault.withdraw(USDC, amount);
  console.log(`  tx: ${tx.hash}`);
  await tx.wait(1);
  console.log(`  Withdrawn ${ethers.formatUnits(amount, 6)} USDC to ${USER_ADDRESS}`);
}

main().catch((err) => {
  console.error(`\nFatal: ${err.message}`);
  process.exitCode = 1;
});
