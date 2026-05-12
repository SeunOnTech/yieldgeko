/**
 * V2 Position Withdrawal Script
 *
 * Closes UniV3 LP position and converts all tokens back to USDC
 * in the smart account via Pimlico-sponsored UserOps.
 *
 * Steps:
 *   1. decreaseLiquidity (burn all LP, collect WBTC + USDT to smart account)
 *   2. collect (sweep any remaining tokensOwed)
 *   3. Swap WBTC → USDC
 *   4. Swap USDT → USDC
 *
 * Run:
 *   npx ts-node src/scripts/withdrawV2Position.ts
 */

import 'dotenv/config';
import {
  createPublicClient, createWalletClient, http,
  encodeFunctionData, parseAbi, formatUnits, maxUint128,
  type Address, type Hex,
} from 'viem';
import { createBundlerClient } from 'viem/account-abstraction';
import { privateKeyToAccount } from 'viem/accounts';
import { arbitrum } from 'viem/chains';
import { Implementation, toMetaMaskSmartAccount } from '@metamask/smart-accounts-kit';
import { toSimpleSmartAccount } from 'permissionless/accounts';
import { createPimlicoClient }  from 'permissionless/clients/pimlico';

// ─────────────────────────────────────────────────────────────────────────────
// Addresses
// ─────────────────────────────────────────────────────────────────────────────

const NFPM       = '0xC36442b4a4522E871399CD717aBDD847Ab11FE88' as Address;
const ROUTER     = '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45' as Address;
const USDC       = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831' as Address;
const WBTC       = '0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f' as Address;
const USDT       = '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9' as Address;
const TOKEN_ID   = 5485941n;
const ENTRY_POINT = '0x0000000071727De22E5E9d8BAf0edAc6f37da032' as Address;

const NFPM_ABI = parseAbi([
  'function positions(uint256) external view returns (uint96,address,address,address,uint24,int24,int24,uint128,uint256,uint256,uint128,uint128)',
  'function decreaseLiquidity((uint256 tokenId,uint128 liquidity,uint256 amount0Min,uint256 amount1Min,uint256 deadline)) external returns (uint256,uint256)',
  'function collect((uint256 tokenId,address recipient,uint128 amount0Max,uint128 amount1Max)) external returns (uint256,uint256)',
]);

const ERC20_ABI = parseAbi([
  'function balanceOf(address) external view returns (uint256)',
  'function approve(address,uint256) external returns (bool)',
]);

const ROUTER_ABI = parseAbi([
  'function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) external returns (uint256)',
]);

async function main() {
  const ARB_RPC     = process.env.ARB_RPC_URL ?? 'https://arb1.arbitrum.io/rpc';
  const PIMLICO_URL = `https://api.pimlico.io/v2/42161/rpc?apikey=${process.env.PIMLICO_API_KEY}`;

  const userAccount = privateKeyToAccount(process.env.TEST_USER_PRIVKEY as Hex);
  const agentEOA    = privateKeyToAccount(process.env.AGENT_PRIVATE_KEY as Hex);

  const publicClient = createPublicClient({ chain: arbitrum, transport: http(ARB_RPC) });

  const pimlicoClient = createPimlicoClient({
    transport: http(PIMLICO_URL),
    entryPoint: { address: ENTRY_POINT, version: '0.7' },
  });

  const delegatorSA = await toMetaMaskSmartAccount({
    client: publicClient, implementation: Implementation.Hybrid,
    deployParams: [userAccount.address, [], [], []] as const,
    deploySalt: '0x', signer: { account: userAccount },
  });
  const smartAcct = delegatorSA.address;

  const bundlerClient = createBundlerClient({
    client: publicClient, transport: http(PIMLICO_URL), paymaster: true,
    userOperation: {
      estimateFeesPerGas: async () => (await pimlicoClient.getUserOperationGasPrice()).fast,
    },
  });

  console.log('\n══════════════════════════════════════════════════');
  console.log('  YieldGeko V2 — Position Withdrawal');
  console.log('══════════════════════════════════════════════════\n');
  console.log(`  Smart account: ${smartAcct}`);
  console.log(`  NFT tokenId:   ${TOKEN_ID}`);

  // ── Read current position ─────────────────────────────────────────────────

  const pos = await publicClient.readContract({
    address: NFPM, abi: NFPM_ABI, functionName: 'positions', args: [TOKEN_ID],
  });
  const liquidity = pos[7];
  const tokensOwed0 = pos[10];
  const tokensOwed1 = pos[11];

  console.log(`\n  Liquidity:     ${liquidity}`);
  console.log(`  Tokens owed:   ${tokensOwed0} WBTC-raw, ${tokensOwed1} USDT-raw`);

  if (liquidity === 0n && tokensOwed0 === 0n && tokensOwed1 === 0n) {
    console.log('\n  Position already closed.');
    return;
  }

  // ── Step 1: Close position (decreaseLiquidity + collect) ──────────────────

  console.log('\n  Step 1: Closing position (decreaseLiquidity + collect)...');

  const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);

  const decreaseData = encodeFunctionData({
    abi: NFPM_ABI, functionName: 'decreaseLiquidity',
    args: [{ tokenId: TOKEN_ID, liquidity, amount0Min: 0n, amount1Min: 0n, deadline }],
  });

  const collectData = encodeFunctionData({
    abi: NFPM_ABI, functionName: 'collect',
    args: [{ tokenId: TOKEN_ID, recipient: smartAcct, amount0Max: maxUint128, amount1Max: maxUint128 }],
  });

  const op1Hash = await bundlerClient.sendUserOperation({
    account: delegatorSA,
    calls: [
      { to: NFPM, value: 0n, data: decreaseData },
      { to: NFPM, value: 0n, data: collectData  },
    ],
  });
  const op1Receipt = await bundlerClient.waitForUserOperationReceipt({ hash: op1Hash });
  console.log(`  ✅ Position closed — tx: ${op1Receipt.receipt.transactionHash}`);

  // ── Read balances after close ─────────────────────────────────────────────

  const [wbtcBal, usdtBal, usdcBefore] = await Promise.all([
    publicClient.readContract({ address: WBTC, abi: ERC20_ABI, functionName: 'balanceOf', args: [smartAcct] }),
    publicClient.readContract({ address: USDT, abi: ERC20_ABI, functionName: 'balanceOf', args: [smartAcct] }),
    publicClient.readContract({ address: USDC, abi: ERC20_ABI, functionName: 'balanceOf', args: [smartAcct] }),
  ]);

  console.log(`\n  Received:`);
  console.log(`    WBTC: ${wbtcBal} sat (${formatUnits(wbtcBal, 8)} WBTC)`);
  console.log(`    USDT: ${usdtBal} (${formatUnits(usdtBal, 6)} USDT)`);
  console.log(`    USDC before swaps: ${formatUnits(usdcBefore, 6)} USDC`);

  // ── Step 2: Swap WBTC + USDT → USDC ──────────────────────────────────────

  console.log('\n  Step 2: Swapping WBTC + USDT → USDC...');

  const swapCalls: { to: Address; value: bigint; data: Hex }[] = [];

  // Swaps send USDC to smart account (ready for next E2E test)
  const eoa = smartAcct;

  if (wbtcBal > 0n) {
    swapCalls.push({
      to: WBTC, value: 0n,
      data: encodeFunctionData({ abi: ERC20_ABI, functionName: 'approve', args: [ROUTER, wbtcBal] }),
    });
    swapCalls.push({
      to: ROUTER, value: 0n,
      data: encodeFunctionData({
        abi: ROUTER_ABI, functionName: 'exactInputSingle',
        args: [{
          tokenIn: WBTC, tokenOut: USDC, fee: 3000,
          recipient: eoa, amountIn: wbtcBal,
          amountOutMinimum: 0n, sqrtPriceLimitX96: 0n,
        }],
      }),
    });
  }

  if (usdtBal > 0n) {
    swapCalls.push({
      to: USDT, value: 0n,
      data: encodeFunctionData({ abi: ERC20_ABI, functionName: 'approve', args: [ROUTER, usdtBal] }),
    });
    swapCalls.push({
      to: ROUTER, value: 0n,
      data: encodeFunctionData({
        abi: ROUTER_ABI, functionName: 'exactInputSingle',
        args: [{
          tokenIn: USDT, tokenOut: USDC, fee: 100,
          recipient: eoa, amountIn: usdtBal,
          amountOutMinimum: 0n, sqrtPriceLimitX96: 0n,
        }],
      }),
    });
  }

  // Also sweep any USDC already sitting in smart account back to EOA
  const usdcInSA = await publicClient.readContract({ address: USDC, abi: ERC20_ABI, functionName: 'balanceOf', args: [smartAcct] });
  if (usdcInSA > 0n) {
    const ERC20_TRANSFER = parseAbi(['function transfer(address,uint256) external returns (bool)']);
    swapCalls.push({
      to: USDC, value: 0n,
      data: encodeFunctionData({ abi: ERC20_TRANSFER, functionName: 'transfer', args: [eoa, usdcInSA] }),
    });
  }

  if (swapCalls.length === 0) {
    console.log('  Nothing to swap.');
  } else {
    const op2Hash = await bundlerClient.sendUserOperation({
      account: delegatorSA, calls: swapCalls,
    });
    const op2Receipt = await bundlerClient.waitForUserOperationReceipt({ hash: op2Hash });
    console.log(`  ✅ Swaps complete — tx: ${op2Receipt.receipt.transactionHash}`);
  }

  // ── Final balances ────────────────────────────────────────────────────────

  const [usdcEOA, usdcSA] = await Promise.all([
    publicClient.readContract({ address: USDC, abi: ERC20_ABI, functionName: 'balanceOf', args: [userAccount.address] }),
    publicClient.readContract({ address: USDC, abi: ERC20_ABI, functionName: 'balanceOf', args: [smartAcct] }),
  ]);

  console.log('\n══════════════════════════════════════════════════');
  console.log('  Withdrawal complete');
  console.log('══════════════════════════════════════════════════\n');
  console.log(`  Smart account USDC:  ${formatUnits(usdcSA, 6)} USDC  ← ready for E2E test`);
  console.log(`  User paid gas:       $0 (Pimlico sponsored)`);
  console.log(`\n  Arbiscan: https://arbiscan.io/address/${smartAcct}`);
}

main().catch(err => {
  console.error('\n[FATAL]', err?.message ?? err);
  process.exit(1);
});
