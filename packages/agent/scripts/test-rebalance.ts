#!/usr/bin/env npx ts-node
/**
 * YieldGeko — Force Rebalance Test Script
 *
 * Triggers the full rebalance flow (close → normalize → remint) for a given
 * UniV3 position directly, bypassing the drift threshold check in the agent.
 *
 * Run WHILE the agent is STOPPED to avoid state conflicts.
 *
 * Usage:
 *   cd packages/agent && npx ts-node scripts/test-rebalance.ts
 *
 * Required env (packages/agent/.env):
 *   AGENT_PRIVATE_KEY, VAULT_ADDRESS, ARB_RPC_URL
 *   TOKEN_ID      — NFT token ID to rebalance (set below or as env var)
 *   USER_ADDRESS  — user whose position this is
 */

import { ethers } from 'ethers';
import * as dotenv from 'dotenv';
import * as path from 'node:path';

dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

// ── Config ────────────────────────────────────────────────────────────────────

const AGENT_PRIVATE_KEY = process.env.AGENT_PRIVATE_KEY!;
const VAULT_ADDRESS     = process.env.VAULT_ADDRESS!;
const ARB_RPC_URL       = process.env.ARB_RPC_URL ?? 'https://arb1.arbitrum.io/rpc';
const PIMLICO_API_KEY   = process.env.PIMLICO_API_KEY;

// Override these or pass as env vars
const TOKEN_ID      = BigInt(process.env.TOKEN_ID      ?? '5480907');
const USER_ADDRESS  = process.env.TEST_USER_ADDRESS    ?? process.env.USER_ADDRESS!;

// WETH-ARB 0.05% pool on Arbitrum
const POOL_ADDRESS  = '0x92c63d0e701caae670c9415d91c474d9f8db97f0';

// ── ABIs ──────────────────────────────────────────────────────────────────────

const VAULT_ABI = [
  'function balances(address user, address asset) external view returns (uint256)',
  'function deployed(address user, address asset) external view returns (uint256)',
  'function policies(address user) external view returns (bool active, uint256 managedUSD, uint256 minAPY, uint256 maxDrawdownBps, uint256 maxFeeBps, uint256 registeredAt, uint256 expiresAt)',
];

const NFT_ABI = [
  'function positions(uint256 tokenId) external view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)',
  'function ownerOf(uint256 tokenId) external view returns (address)',
];

const NONFUNGIBLE_POSITION_MANAGER = '0xC36442b4a4522E871399CD717aBDD847Ab11FE88';

// ── Token addresses ───────────────────────────────────────────────────────────

const WETH = '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1';
const ARB  = '0x912CE59144191C1204E64559FE8253a0e49E6548';
const USDC = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831';

// ── Price fetch ───────────────────────────────────────────────────────────────

async function fetchPrices(): Promise<Map<string, { priceUSD: number }>> {
  const url = 'https://api.coingecko.com/api/v3/simple/price?ids=weth,arbitrum&vs_currencies=usd';
  try {
    const res  = await fetch(url);
    const data = await res.json() as Record<string, { usd: number }>;
    const map  = new Map<string, { priceUSD: number }>();
    map.set('WETH', { priceUSD: data['weth']?.usd ?? 3000 });
    map.set('ARB',  { priceUSD: data['arbitrum']?.usd ?? 0.8 });
    return map;
  } catch {
    console.warn('[Prices] CoinGecko failed, using fallback prices');
    return new Map([['WETH', { priceUSD: 3000 }], ['ARB', { priceUSD: 0.8 }]]);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('='.repeat(60));
  console.log('YieldGeko — Force Rebalance Test');
  console.log('='.repeat(60));

  if (!AGENT_PRIVATE_KEY) throw new Error('AGENT_PRIVATE_KEY not set');
  if (!VAULT_ADDRESS)     throw new Error('VAULT_ADDRESS not set');
  if (!USER_ADDRESS)      throw new Error('TEST_USER_ADDRESS not set');

  const provider = new ethers.JsonRpcProvider(ARB_RPC_URL, 42161, { staticNetwork: true });
  const vault    = new ethers.Contract(VAULT_ADDRESS, VAULT_ABI, provider);
  const nftMgr   = new ethers.Contract(NONFUNGIBLE_POSITION_MANAGER, NFT_ABI, provider);

  // ── 1. Read on-chain state before rebalance ──────────────────────────────────

  console.log('\n[Pre-check] Reading on-chain state...');

  const [pos, policy] = await Promise.all([
    nftMgr.positions(TOKEN_ID),
    vault.policies(USER_ADDRESS),
  ]);

  const [wethBal, arbBal, usdcBal] = await Promise.all([
    vault.balances(USER_ADDRESS, WETH),
    vault.balances(USER_ADDRESS, ARB),
    vault.balances(USER_ADDRESS, USDC),
  ]);

  console.log(`  NFT ${TOKEN_ID}:`);
  console.log(`    liquidity  : ${pos.liquidity}`);
  console.log(`    tickLower  : ${pos.tickLower}`);
  console.log(`    tickUpper  : ${pos.tickUpper}`);
  console.log(`    tokensOwed0: ${pos.tokensOwed0}`);
  console.log(`    tokensOwed1: ${pos.tokensOwed1}`);
  console.log(`  vault.balances[user]:`);
  console.log(`    WETH : ${ethers.formatEther(wethBal)} WETH`);
  console.log(`    ARB  : ${ethers.formatEther(arbBal)} ARB`);
  console.log(`    USDC : ${ethers.formatUnits(usdcBal, 6)} USDC`);
  console.log(`  policy active: ${policy.active}`);

  if (!policy.active) {
    console.error('\n[ERROR] User policy is not active — register a policy first.');
    process.exit(1);
  }

  if (pos.liquidity === 0n && wethBal === 0n && arbBal === 0n) {
    console.log('\n[INFO] NFT liquidity=0 and no WETH/ARB in vault.');
    if (usdcBal > 0n) {
      console.log(`[INFO] USDC balance is ${ethers.formatUnits(usdcBal, 6)} — a previous normalize step already ran.`);
      console.log('[INFO] Run vault-withdraw.ts instead to withdraw USDC to the user wallet.');
    } else {
      console.log('[INFO] All balances are 0 — nothing to rebalance. Position may already be closed and withdrawn.');
    }
    process.exit(0);
  }

  // ── 2. Fetch prices ──────────────────────────────────────────────────────────

  console.log('\n[Prices] Fetching token prices...');
  const tokenPrices = await fetchPrices();
  console.log(`  WETH: $${tokenPrices.get('WETH')?.priceUSD}`);
  console.log(`  ARB : $${tokenPrices.get('ARB')?.priceUSD}`);

  // ── 3. Estimate position USD value ──────────────────────────────────────────

  const wethPrice = tokenPrices.get('WETH')?.priceUSD ?? 3000;
  const arbPrice  = tokenPrices.get('ARB')?.priceUSD ?? 0.8;
  const amountUSD =
    (Number(wethBal) / 1e18) * wethPrice +
    (Number(arbBal)  / 1e18) * arbPrice  +
    Number(usdcBal)  / 1e6;

  console.log(`\n[Position] Estimated USD value: $${amountUSD.toFixed(4)}`);

  // ── 4. Import and run rebalance ──────────────────────────────────────────────

  console.log('\n[Rebalance] Importing AgentExecutor...');

  // Dynamic import to avoid circular init
  const { AgentExecutor } = await import('../src/orchestrator/execution');

  const executor = new AgentExecutor(
    AGENT_PRIVATE_KEY,
    VAULT_ADDRESS,
    ARB_RPC_URL,
    undefined,
    undefined,
  );

  // Wire up Pimlico if configured (required for UserOp gas sponsorship)
  if (PIMLICO_API_KEY) {
    console.log('[Rebalance] Pimlico API key found — initialising ERC-4337 layer...');
    await (executor as any).pimlicoInit;
  }

  console.log(`\n[Rebalance] Calling rebalanceUniV3Position for NFT ${TOKEN_ID}...`);
  console.log('  This runs: close → normalize → remint');
  console.log('  Stop the agent before proceeding! (Ctrl+C now if agent is running)\n');

  // Give 3 seconds to abort
  await new Promise(r => setTimeout(r, 3000));

  const rangePct    = 0.03; // ±3% range
  const assertedAPY = 200;  // 2% min APY (bps)

  try {
    const result = await executor.rebalanceUniV3Position({
      tokenId:        TOKEN_ID,
      userAddress:    USER_ADDRESS,
      poolAddress:    POOL_ADDRESS,
      rangePct,
      liquidity:      pos.liquidity,
      feesPendingUSD: 0,
      amountUSD:      Math.max(amountUSD, 0.01),
      assertedAPY,
      tokenPrices,
    });

    console.log('\n[Rebalance] SUCCESS');
    console.log('  result:', JSON.stringify(result, null, 2));
  } catch (err: any) {
    console.error('\n[Rebalance] FAILED');
    console.error('  error:', err.message ?? err);
    if (err.data) console.error('  revert data:', err.data);
    process.exit(1);
  }

  // ── 5. Read post-rebalance state ─────────────────────────────────────────────

  console.log('\n[Post-check] Reading on-chain state after rebalance...');

  const [wethAfter, arbAfter, usdcAfter] = await Promise.all([
    vault.balances(USER_ADDRESS, WETH),
    vault.balances(USER_ADDRESS, ARB),
    vault.balances(USER_ADDRESS, USDC),
  ]);

  console.log(`  vault.balances[user] after:`);
  console.log(`    WETH : ${ethers.formatEther(wethAfter)} WETH`);
  console.log(`    ARB  : ${ethers.formatEther(arbAfter)} ARB`);
  console.log(`    USDC : ${ethers.formatUnits(usdcAfter, 6)} USDC`);
  console.log('\nDone.');
}

main().catch(e => { console.error(e); process.exit(1); });
