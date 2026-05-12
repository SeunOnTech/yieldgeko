/**
 * V2 Execution Debug Script
 *
 * Bypasses the agent entirely. Signs a delegation, builds redeemDelegations
 * calldata for the WBTC-USDT pool the agent keeps picking, and submits it
 * directly via Pimlico — so we see the exact error instead of a silent IDLE loop.
 *
 * Run:
 *   npx ts-node src/scripts/debugV2Execution.ts
 */

import 'dotenv/config';
import {
  createPublicClient, createWalletClient, http,
  encodeFunctionData, encodeAbiParameters, parseAbiParameters,
  encodePacked, parseAbi, formatUnits,
  type Address, type Hex,
} from 'viem';
import { createBundlerClient } from 'viem/account-abstraction';
import { privateKeyToAccount } from 'viem/accounts';
import { arbitrum } from 'viem/chains';
import {
  Implementation, toMetaMaskSmartAccount,
  getSmartAccountsEnvironment, createCaveat, ROOT_AUTHORITY,
} from '@metamask/smart-accounts-kit';
import { toSimpleSmartAccount } from 'permissionless/accounts';
import { createPimlicoClient }  from 'permissionless/clients/pimlico';
import { DelegationClient, depositArgs } from '../orchestrator/delegation-client';

// ─────────────────────────────────────────────────────────────────────────────
// Addresses
// ─────────────────────────────────────────────────────────────────────────────

const USDC        = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831' as Address;
const WBTC        = '0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f' as Address;
const USDT        = '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9' as Address;
const POOL        = '0x5969EFddE3cF5C0D9a88aE51E47d721096A97203' as Address; // WBTC-USDT 0.05%
const UNIV3_PM    = '0xC36442b4a4522E871399CD717aBDD847Ab11FE88' as Address;
const SWAP_ROUTER = '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45' as Address;
const EXECUTOR    = (process.env.EXECUTOR_ADDRESS ?? '0x94DE8790BEd6Be0395C6BE7f42FD677b7B8cBcFb') as Address;
const ENFORCER    = (process.env.ENFORCER_ADDRESS ?? '0x21b25E099CA7AF1BEa3a4558E437C56680B4b925') as Address;
const SWAPPER     = (process.env.SWAPPER_ADDRESS  ?? '0x4313539C4fF1b93891B6A66D6a2eb690153A1b33') as Address;
const TREASURY    = '0x78620A06b55d47913B6e23Ef3EE9D0A44C360021' as Address;

const POOL_ABI = parseAbi([
  'function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool)',
  'function fee() external view returns (uint24)',
  'function tickSpacing() external view returns (int24)',
]);
const ERC20_ABI = parseAbi(['function balanceOf(address) external view returns (uint256)']);
const UNIV3_MINT_ABI = parseAbi([
  'function mint((address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint256 amount0Desired, uint256 amount1Desired, uint256 amount0Min, uint256 amount1Min, address recipient, uint256 deadline)) external returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)',
]);
const SWAP_ABI = parseAbi([
  'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) external returns (uint256)',
]);

const ENTRY_POINT = '0x0000000071727De22E5E9d8BAf0edAc6f37da032' as Address;
const DEPOSIT_AMT = 1_000_000n; // $1 USDC

// Matches execution.ts rangePctToTicks exactly — log-based, floor/ceil aligned
function rangePctToTicks(currentTick: number, rangePct: number, spacing: number) {
  const r         = rangePct / 100;
  const halfTicks = Math.round(Math.log(1 + r) / Math.log(1.0001));
  return {
    tickLower: Math.floor((currentTick - halfTicks) / spacing) * spacing,
    tickUpper: Math.ceil( (currentTick + halfTicks) / spacing) * spacing,
  };
}

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

  const agentSimpleAcct = await toSimpleSmartAccount({
    owner: agentEOA, client: publicClient,
    entryPoint: { address: ENTRY_POINT, version: '0.7' },
  });
  const agentPimlicoSA = agentSimpleAcct.address as Address;

  const environment  = getSmartAccountsEnvironment(arbitrum.id);
  const DM_ADDR      = environment.DelegationManager as Address;
  const AT_ENFORCER  = environment.caveatEnforcers.AllowedTargetsEnforcer as Address;

  const bundlerClient = createBundlerClient({
    client: publicClient, transport: http(PIMLICO_URL), paymaster: true,
    userOperation: {
      estimateFeesPerGas: async () => (await pimlicoClient.getUserOperationGasPrice()).fast,
    },
  });

  console.log('\n══════════════════════════════════════════════════');
  console.log('  YieldGeko V2 — Execution Debug (Direct)');
  console.log('══════════════════════════════════════════════════\n');
  console.log(`  User smart account owner: ${userAccount.address}`);
  console.log(`  Agent Pimlico SA (delegate): ${agentPimlicoSA}`);
  console.log(`  Pool: WBTC-USDT 0.05% ${POOL}`);

  // ── 1. Derive user's smart account ────────────────────────────────────────

  const delegatorSA = await toMetaMaskSmartAccount({
    client: publicClient, implementation: Implementation.Hybrid,
    deployParams: [userAccount.address, [], [], []] as const,
    deploySalt: '0x', signer: { account: userAccount },
  });
  const smartAcct = delegatorSA.address;

  const usdcBal = await publicClient.readContract({
    address: USDC, abi: ERC20_ABI, functionName: 'balanceOf', args: [smartAcct],
  });

  console.log(`\n  Smart account:  ${smartAcct}`);
  console.log(`  USDC balance:   ${formatUnits(usdcBal, 6)} USDC`);

  if (usdcBal < DEPOSIT_AMT) {
    console.log('\n  ❌ Insufficient USDC — run testV2E2E.ts first to fund');
    return;
  }

  // Check and approve USDC for both executor and swapper from the smart account
  const USDC_ALLOWANCE_ABI = parseAbi(['function allowance(address,address) external view returns (uint256)', 'function approve(address,uint256) external returns (bool)']);
  const [execAllowance, swapAllowance] = await Promise.all([
    publicClient.readContract({ address: USDC, abi: USDC_ALLOWANCE_ABI, functionName: 'allowance', args: [smartAcct, EXECUTOR] }),
    publicClient.readContract({ address: USDC, abi: USDC_ALLOWANCE_ABI, functionName: 'allowance', args: [smartAcct, SWAPPER] }),
  ]);
  console.log(`  Executor USDC allowance: ${formatUnits(execAllowance, 6)}`);
  console.log(`  Swapper  USDC allowance: ${formatUnits(swapAllowance, 6)}`);

  const approvalCalls: { to: Address; value: bigint; data: Hex }[] = [];
  if (execAllowance < DEPOSIT_AMT) approvalCalls.push({ to: USDC, value: 0n, data: encodeFunctionData({ abi: USDC_ALLOWANCE_ABI, functionName: 'approve', args: [EXECUTOR, DEPOSIT_AMT * 1000n] }) });
  if (swapAllowance < DEPOSIT_AMT) approvalCalls.push({ to: USDC, value: 0n, data: encodeFunctionData({ abi: USDC_ALLOWANCE_ABI, functionName: 'approve', args: [SWAPPER,  DEPOSIT_AMT * 1000n] }) });

  // No volatile (WBTC/USDT) approvals needed — Swapper now sends tokens directly to
  // executor. executeFromBalance uses executor's own balance; no smart account allowance needed.

  if (approvalCalls.length > 0) {
    console.log(`\n  Approving tokens for executor + swapper (${approvalCalls.length} approval(s))...`);
    const opHash    = await bundlerClient.sendUserOperation({ account: delegatorSA, calls: approvalCalls });
    const opReceipt = await bundlerClient.waitForUserOperationReceipt({ hash: opHash });
    console.log(`  ✅ Approved (tx: ${opReceipt.receipt.transactionHash})`);
  }

  // ── 2. Read live pool state ──────────────────────────────────────────────

  const [slot0, spacing] = await Promise.all([
    publicClient.readContract({ address: POOL, abi: POOL_ABI, functionName: 'slot0' }),
    publicClient.readContract({ address: POOL, abi: POOL_ABI, functionName: 'tickSpacing' }),
  ]);
  const currentTick = slot0[1];
  const { tickLower, tickUpper } = rangePctToTicks(currentTick, 3, spacing);
  console.log(`\n  Pool tick: ${currentTick} | range: [${tickLower}, ${tickUpper}]`);

  // ── 3. Sign delegation (delegate = agent Pimlico SA) ─────────────────────

  const expiresAt   = BigInt(Math.floor(Date.now() / 1000) + 365 * 24 * 3600);
  const policyTerms = encodeAbiParameters(
    parseAbiParameters('uint256, uint256, uint256, uint256, address, uint256, address'),
    [200n, 2000n, DEPOSIT_AMT, 1000n, TREASURY, expiresAt, USDC],
  ) as Hex;
  const allowedTargetsTerms = encodePacked(['address', 'address'], [EXECUTOR, SWAPPER]) as Hex;

  // AllowedTargetsEnforcer only handles SINGLE mode — throws CaveatEnforcer:invalid-call-type
  // on BATCH mode (3-exec delta-neutral path). YieldGekoPolicyCaveatEnforcer covers policy
  // enforcement, so AllowedTargets is dropped here.
  const delegation = {
    delegate:  agentPimlicoSA,
    delegator: smartAcct,
    authority: ROOT_AUTHORITY,
    caveats: [
      createCaveat(ENFORCER, policyTerms, '0x'),
    ],
    salt: '0x0000000000000000000000000000000000000000000000000000000000000001' as Hex,
  };
  const signature       = await delegatorSA.signDelegation({ delegation });
  const signedDelegation = { ...delegation, signature };
  console.log(`\n  Delegation signed. delegate=${agentPimlicoSA.slice(0, 12)}…`);

  // ── 4. Build calldata ────────────────────────────────────────────────────

  const halfAmt  = DEPOSIT_AMT / 2n;
  const minOut0  = 600n;  // WBTC satoshis (very conservative for $0.5)
  const minOut1  = 490000n; // USDT micro

  // DEX calldatas: recipient = SWAPPER (Swapper measures balance delta, then forwards to EXECUTOR)
  const dexCd0 = encodeFunctionData({
    abi: SWAP_ABI, functionName: 'exactInputSingle',
    args: [{ tokenIn: USDC, tokenOut: WBTC, fee: 500, recipient: SWAPPER,
             amountIn: halfAmt, amountOutMinimum: minOut0, sqrtPriceLimitX96: 0n }],
  });
  const dexCd1 = encodeFunctionData({
    abi: SWAP_ABI, functionName: 'exactInputSingle',
    args: [{ tokenIn: USDC, tokenOut: USDT, fee: 100, recipient: SWAPPER,
             amountIn: halfAmt, amountOutMinimum: minOut1, sqrtPriceLimitX96: 0n }],
  });
  // Mint calldata: LP NFT recipient = smart account, amounts are desired (executor uses full balance)
  const mintCd = encodeFunctionData({
    abi: UNIV3_MINT_ABI, functionName: 'mint',
    args: [{
      token0: WBTC, token1: USDT, fee: 500,
      tickLower, tickUpper,
      amount0Desired: (minOut0 * 99n) / 100n,
      amount1Desired: (minOut1 * 99n) / 100n,
      amount0Min: 0n, amount1Min: 0n,
      recipient: smartAcct,  // LP NFT goes to smart account
      deadline: BigInt(Math.floor(Date.now() / 1000) + 600),
    }],
  });

  const userId = `debug-${userAccount.address.slice(2, 10)}`;
  const dc = new DelegationClient(EXECUTOR, DM_ADDR);
  dc.setDelegation(userId, {
    delegate:  signedDelegation.delegate,
    delegator: signedDelegation.delegator,
    authority: signedDelegation.authority,
    caveats:   signedDelegation.caveats.map(c => ({
      enforcer: c.enforcer as string, terms: c.terms as string, args: (c.args ?? '0x') as string,
    })),
    salt:      signedDelegation.salt,
    signature: signedDelegation.signature,
  });

  const redeemCd = dc.buildDeltaNeutralNonUsdcPairCalldata({
    userId,
    swapperAddress: SWAPPER,
    dex0: SWAP_ROUTER, swapCalldata0: dexCd0,
    token0: WBTC,      usdcForToken0: halfAmt, token0MinOut: minOut0,
    dex1: SWAP_ROUTER, swapCalldata1: dexCd1,
    token1: USDT,      usdcForToken1: halfAmt, token1MinOut: minOut1,
    usdcAddress: USDC,
    protocolAddress: UNIV3_PM, mintCalldata: mintCd,
    executionArgs: depositArgs(1),
  });

  console.log(`\n  redeemDelegations calldata built (${redeemCd.length / 2} bytes)`);
  console.log(`  Target: DelegationManager ${DM_ADDR}`);

  // ── 5. Submit via Pimlico (agent's smart account calls DM) ────────────────

  console.log('\n  Submitting UserOperation via Pimlico...\n');
  try {
    const opHash = await bundlerClient.sendUserOperation({
      account: agentSimpleAcct,
      calls: [{ to: DM_ADDR, value: 0n, data: redeemCd as Hex }],
    });
    console.log(`  UserOp hash: ${opHash}`);
    const receipt = await bundlerClient.waitForUserOperationReceipt({ hash: opHash });
    const tx = receipt.receipt.transactionHash;
    console.log(`\n  ✅ SUCCESS`);
    console.log(`  Tx: ${tx}`);
    console.log(`  Arbiscan: https://arbiscan.io/tx/${tx}`);
    console.log(`  Smart account: https://arbiscan.io/address/${smartAcct}`);

    const usdcAfter = await publicClient.readContract({
      address: USDC, abi: ERC20_ABI, functionName: 'balanceOf', args: [smartAcct],
    });
    console.log(`\n  Smart account USDC after: ${formatUnits(usdcAfter, 6)} (was ${formatUnits(usdcBal, 6)})`);
    console.log(`  Spent: ${formatUnits(usdcBal - usdcAfter, 6)} USDC → UniV3 LP minted to smart account`);
  } catch (err: any) {
    console.log(`\n  ❌ FAILED`);
    console.log(`  Error: ${err.message?.slice(0, 300)}`);
    if (err.message?.includes('reverted')) {
      console.log('\n  Likely causes:');
      console.log('    - AllowedTargets enforcer: execution targets not in allowed list');
      console.log('    - PolicyEnforcer: agent not authorized or policy mismatch');
      console.log('    - Swapper: USDC not approved or wrong recipient');
      console.log('    - UniV3 mint: tick range invalid or slippage too tight');
    }
  }
}

main().catch(err => {
  console.error('\n[FATAL]', err?.message ?? err);
  process.exit(1);
});
