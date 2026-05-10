#!/usr/bin/env npx ts-node
/**
 * Swaps all USDT in user wallet → USDC via Uniswap V3 (direct wallet tx, no vault).
 * Uses the 0.01% USDT/USDC pool on Arbitrum.
 */

import { ethers } from 'ethers';
import * as dotenv from 'dotenv';
import * as path   from 'node:path';

dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

const ARB_RPC   = process.env.ARB_RPC_URL ?? 'https://arb1.arbitrum.io/rpc';
const USER_KEY  = process.env.PRIVATE_KEY!;
const USER_ADDR = process.env.TEST_USER_ADDRESS!;

const USDC        = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831';
const USDT        = '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9';
const ROUTER      = '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45'; // SwapRouter02

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
];

const ROUTER_ABI = [
  'function exactInputSingle(tuple(address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) external payable returns (uint256 amountOut)',
];

async function main() {
  if (!USER_KEY)  { console.error('❌ PRIVATE_KEY not set'); process.exit(1); }
  if (!USER_ADDR) { console.error('❌ TEST_USER_ADDRESS not set'); process.exit(1); }

  const provider = new ethers.JsonRpcProvider(ARB_RPC, 42161, { staticNetwork: true });
  const signer   = new ethers.Wallet(USER_KEY, provider);

  if (signer.address.toLowerCase() !== USER_ADDR.toLowerCase()) {
    console.error(`❌ PRIVATE_KEY address ${signer.address} ≠ TEST_USER_ADDRESS ${USER_ADDR}`);
    process.exit(1);
  }

  const usdt   = new ethers.Contract(USDT, ERC20_ABI, signer);
  const usdc   = new ethers.Contract(USDC, ERC20_ABI, provider);
  const router = new ethers.Contract(ROUTER, ROUTER_ABI, signer);

  const usdtBal: bigint = await usdt.balanceOf(USER_ADDR);
  if (usdtBal === 0n) {
    console.log('No USDT balance to swap.');
    process.exit(0);
  }

  const usdcBefore: bigint = await usdc.balanceOf(USER_ADDR);
  console.log(`\n  USDT to swap:   ${ethers.formatUnits(usdtBal, 6)} USDT`);
  console.log(`  USDC before:    ${ethers.formatUnits(usdcBefore, 6)} USDC`);

  // Approve router if needed
  const allowance: bigint = await usdt.allowance(USER_ADDR, ROUTER);
  if (allowance < usdtBal) {
    console.log('\n  Approving SwapRouter02 for USDT...');
    const tx = await usdt.approve(ROUTER, usdtBal);
    await tx.wait(1);
    console.log('  ✅ Approved');
  }

  // Swap: USDT → USDC, 0.01% fee pool, 1% slippage floor
  const minOut = (usdtBal * 99n) / 100n; // 1% slippage
  console.log(`\n  Swapping via 0.01% USDT/USDC pool...`);
  console.log(`  minOut: ${ethers.formatUnits(minOut, 6)} USDC`);

  const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
  const tx = await router.exactInputSingle({
    tokenIn:            USDT,
    tokenOut:           USDC,
    fee:                100,       // 0.01%
    recipient:          USER_ADDR,
    amountIn:           usdtBal,
    amountOutMinimum:   minOut,
    sqrtPriceLimitX96:  0n,
  });
  console.log(`  tx: ${tx.hash}`);
  const receipt = await tx.wait(1);
  console.log(`  ✅ Swap confirmed (gas used: ${receipt.gasUsed})`);

  const usdcAfter: bigint = await usdc.balanceOf(USER_ADDR);
  console.log(`\n  USDC after:  ${ethers.formatUnits(usdcAfter, 6)} USDC`);
  console.log(`  Received:    ${ethers.formatUnits(usdcAfter - usdcBefore, 6)} USDC`);
  console.log('\n  ✅ Done — wallet is all USDC now.\n');
}

main().catch(err => { console.error('\n❌ Fatal:', err.message); process.exit(1); });
