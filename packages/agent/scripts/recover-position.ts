#!/usr/bin/env npx ts-node
/**
 * YieldGeko — Position Recovery Script
 *
 * Recovers a user whose vault state got into an inconsistent state from a
 * failed migrate sequence (decreaseLiquidity succeeded but collect/deposit failed).
 *
 * What this script does:
 *   1. Vault owner calls resumeUser() — clears the drawdown pause
 *   2. Agent calls executeWithdrawMulti([token0, token1], [0, 0], collect) —
 *      collects any owed tokens from the NFT position into vault balances
 *   3. Prints the recovered vault balances
 *
 * Run WHILE the agent is STOPPED to avoid state conflicts.
 *
 * Usage:
 *   cd packages/agent && npx ts-node scripts/recover-position.ts
 */

import { ethers } from 'ethers';
import * as dotenv from 'dotenv';
import * as path   from 'node:path';
import * as crypto from 'node:crypto';
import * as fs     from 'node:fs';

dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

// ── Config ────────────────────────────────────────────────────────────────────

const ARB_RPC      = process.env.ARB_RPC_URL ?? 'https://arb1.arbitrum.io/rpc';
const VAULT_ADDR   = process.env.VAULT_ADDRESS!;
// Vault owner key — read from contracts/.env (the Hardhat/Foundry deployer key)
const _contractsEnvPath = path.resolve(__dirname, '..', '..', '..', 'contracts', '.env');
const _contractsEnvRaw  = (() => {
  try { return fs.readFileSync(_contractsEnvPath, 'utf8'); } catch { return ''; }
})();
const _contractsKeyMatch = _contractsEnvRaw.match(/^PRIVATE_KEY=(.+)$/m);
const OWNER_KEY = process.env.VAULT_OWNER_KEY
  ?? (_contractsKeyMatch ? _contractsKeyMatch[1].trim() : process.env.PRIVATE_KEY!);
const AGENT_KEY    = process.env.AGENT_PRIVATE_KEY!;  // authorized agent
const USER_ADDR    = process.env.TEST_USER_ADDRESS!;
const TOKEN_ID_STR = process.env.RECOVER_TOKEN_ID ?? '5480441';

const USDC    = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831';
const USDT    = '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9';
const POS_MGR = '0xC36442b4a4522E871399CD717aBDD847Ab11FE88';

// ── ABIs ──────────────────────────────────────────────────────────────────────

const VAULT_ABI = [
  'function resumeUser(address user) external',
  'function userPaused(address user) view returns (bool)',
  'function balances(address user, address asset) view returns (uint256)',
  'function deployed(address user, address asset) view returns (uint256)',
  'function executeWithdrawMulti(address user, address[] calldata assets, uint256[] calldata deployedAmounts, address target, bytes calldata data, bytes32 receiptHash) external payable returns (uint256[] memory)',
  'function approvedTargets(uint256 chainId, address target) view returns (bool)',
  'function withdraw(address asset, uint256 amount) external',
];

const POS_MGR_ABI = [
  'function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)',
  'function multicall(bytes[] calldata data) external payable returns (bytes[] memory results)',
];

const ERC20_ABI = [
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function balanceOf(address) view returns (uint256)',
];

const COLLECT_IFACE = new ethers.Interface([
  'function collect(tuple(uint256 tokenId, address recipient, uint128 amount0Max, uint128 amount1Max) params) external payable returns (uint256 amount0, uint256 amount1)',
]);

const MAX_UINT128 = (2n ** 128n) - 1n;

// ── Helpers ───────────────────────────────────────────────────────────────────

const log  = (msg: string) => console.log(`  ${msg}`);
const ok   = (msg: string) => console.log(`  ✅ ${msg}`);
const fail = (msg: string) => console.error(`  ❌ ${msg}`);
const info = (msg: string) => console.log(`  ℹ  ${msg}`);

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║  YieldGeko — Position Recovery                              ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  if (!VAULT_ADDR)  { fail('VAULT_ADDRESS not set'); process.exit(1); }
  if (!OWNER_KEY)   { fail('PRIVATE_KEY not set (vault owner)'); process.exit(1); }
  if (!AGENT_KEY)   { fail('AGENT_PRIVATE_KEY not set'); process.exit(1); }
  if (!USER_ADDR)   { fail('TEST_USER_ADDRESS not set'); process.exit(1); }

  const provider = new ethers.JsonRpcProvider(ARB_RPC, 42161, { staticNetwork: true });
  const owner    = new ethers.Wallet(OWNER_KEY,  provider);
  const agent    = new ethers.Wallet(AGENT_KEY,  provider);

  const vaultOwner = new ethers.Contract(VAULT_ADDR, VAULT_ABI, owner);
  const vaultAgent = new ethers.Contract(VAULT_ADDR, VAULT_ABI, agent);
  const posMgr     = new ethers.Contract(POS_MGR, POS_MGR_ABI, provider);

  const tokenId = BigInt(TOKEN_ID_STR);

  console.log(`  Vault:    ${VAULT_ADDR}`);
  console.log(`  User:     ${USER_ADDR}`);
  console.log(`  Owner:    ${owner.address}`);
  console.log(`  Agent:    ${agent.address}`);
  console.log(`  TokenId:  ${TOKEN_ID_STR}\n`);

  // ── Step 0: Read current state ────────────────────────────────────────────

  log('Reading current on-chain state...');

  const [isPaused, usdcBalance, usdtBalance, usdcDeployed, usdtDeployed] = await Promise.all([
    vaultOwner.userPaused(USER_ADDR) as Promise<boolean>,
    vaultOwner.balances(USER_ADDR, USDC) as Promise<bigint>,
    vaultOwner.balances(USER_ADDR, USDT) as Promise<bigint>,
    vaultOwner.deployed(USER_ADDR, USDC) as Promise<bigint>,
    vaultOwner.deployed(USER_ADDR, USDT) as Promise<bigint>,
  ]);

  // NFT may already be burned — catch the revert
  let token0: string = USDC;
  let token1: string = USDT;
  let liquidity = 0n;
  let tokensOwed0 = 0n;
  let tokensOwed1 = 0n;
  let sym0 = 'USDC', dec0 = 6, sym1 = 'USDT', dec1 = 6;
  let nftBurned = false;

  try {
    const pos = await posMgr.positions(tokenId);
    token0 = pos.token0;
    token1 = pos.token1;
    liquidity = pos.liquidity;
    tokensOwed0 = pos.tokensOwed0;
    tokensOwed1 = pos.tokensOwed1;

    const t0c = new ethers.Contract(token0, ERC20_ABI, provider);
    const t1c = new ethers.Contract(token1, ERC20_ABI, provider);
    [sym0, dec0, sym1, dec1] = await Promise.all([
      t0c.symbol(), t0c.decimals(), t1c.symbol(), t1c.decimals(),
    ]);
  } catch {
    nftBurned = true;
    info('NFT already burned — skipping position read');
  }

  console.log(`  Position state:`);
  console.log(`    liquidity:    ${liquidity}`);
  console.log(`    tokensOwed0:  ${ethers.formatUnits(tokensOwed0, dec0)} ${sym0}`);
  console.log(`    tokensOwed1:  ${ethers.formatUnits(tokensOwed1, dec1)} ${sym1}`);
  console.log(`  Vault balances:`);
  console.log(`    USDC idle:    ${ethers.formatUnits(usdcBalance, 6)} USDC`);
  console.log(`    USDT idle:    ${ethers.formatUnits(usdtBalance, 6)} USDT`);
  console.log(`    USDC deployed: ${ethers.formatUnits(usdcDeployed, 6)} USDC`);
  console.log(`    User paused:  ${isPaused}\n`);

  // ── Step 1: Resume user if paused ────────────────────────────────────────

  if (isPaused) {
    log('Step 1: Calling resumeUser() as vault owner...');
    const tx = await vaultOwner.resumeUser(USER_ADDR);
    console.log(`    tx: ${tx.hash}`);
    await tx.wait(1);
    ok(`User resumed — drawdown pause cleared`);
  } else {
    log('Step 1: User is not paused — skipping resumeUser');
  }

  // ── Step 1b: Withdraw idle USDC from vault to user wallet ─────────────────
  // vault.withdraw() is user-callable — msg.sender must be the user

  const USER_KEY = process.env.PRIVATE_KEY!;
  if (!USER_KEY) { fail('PRIVATE_KEY (user) not set in packages/agent/.env'); process.exit(1); }
  const userSigner = new ethers.Wallet(USER_KEY, provider);
  const vaultUser  = new ethers.Contract(VAULT_ADDR, VAULT_ABI, userSigner);

  const idleUSDC: bigint = await vaultOwner.balances(USER_ADDR, USDC) as bigint;
  if (idleUSDC > 0n) {
    log(`Step 1b: Withdrawing ${ethers.formatUnits(idleUSDC, 6)} USDC idle balance to user wallet...`);
    const tx = await vaultUser.withdraw(USDC, idleUSDC);
    console.log(`    tx: ${tx.hash}`);
    await tx.wait(1);
    ok(`${ethers.formatUnits(idleUSDC, 6)} USDC withdrawn to ${USER_ADDR.slice(0,10)}…`);
  } else {
    log('Step 1b: No idle USDC to withdraw');
  }

  // ── Step 2: Collect owed tokens via executeWithdrawMulti ─────────────────

  const hasOwed = !nftBurned && (tokensOwed0 > 0n || tokensOwed1 > 0n || liquidity > 0n);

  if (!hasOwed) {
    log('Step 2: No owed tokens and no liquidity — position already empty');
    info('Vault should have idle USDC from prior collect. Check balances below.');
  } else {
    log(`Step 2: Collecting owed tokens via executeWithdrawMulti...`);
    info(`  token0=${sym0} (${token0.slice(0,10)}…), token1=${sym1} (${token1.slice(0,10)}…)`);

    // Build multicall: [decreaseLiquidity if needed] + collect
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
    const innerCalls: string[] = [];

    if (liquidity > 0n) {
      info(`  liquidity > 0 — including decreaseLiquidity(${liquidity})`);
      const DECR_IFACE = new ethers.Interface([
        'function decreaseLiquidity(tuple(uint256 tokenId, uint128 liquidity, uint256 amount0Min, uint256 amount1Min, uint256 deadline) params) external payable returns (uint256 amount0, uint256 amount1)',
      ]);
      innerCalls.push(DECR_IFACE.encodeFunctionData('decreaseLiquidity', [{
        tokenId, liquidity, amount0Min: 0n, amount1Min: 0n, deadline,
      }]));
    }

    innerCalls.push(COLLECT_IFACE.encodeFunctionData('collect', [{
      tokenId,
      recipient: VAULT_ADDR,
      amount0Max: MAX_UINT128,
      amount1Max: MAX_UINT128,
    }]));

    const PM_MULTICALL_IFACE = new ethers.Interface([
      'function multicall(bytes[] calldata data) external payable returns (bytes[] memory results)',
    ]);
    const multicallData = PM_MULTICALL_IFACE.encodeFunctionData('multicall', [innerCalls]);

    const receiptHash = ('0x' + crypto.createHash('sha256')
      .update(`recover-${USER_ADDR}-${tokenId}-${Date.now()}`)
      .digest('hex')) as `0x${string}`;

    // Check pos mgr is approved target
    const posApproved = await vaultOwner.approvedTargets(42161, POS_MGR) as boolean;
    if (!posApproved) {
      fail(`PositionManager ${POS_MGR} is not an approved target in vault. Owner must call approveTarget(42161, ${POS_MGR})`);
      process.exit(1);
    }

    // executeWithdrawMulti with deployedAmounts=[0,0] — works regardless of deployed state
    const tx = await vaultAgent.executeWithdrawMulti(
      USER_ADDR,
      [token0, token1],
      [0n, 0n],             // deployedAmounts — 0 since we don't track token0/token1 individually
      POS_MGR,
      multicallData,
      receiptHash,
    );
    console.log(`    tx: ${tx.hash}`);
    await tx.wait(1);
    ok(`Owed tokens collected`);
  }

  // ── Step 3: Rescue any stranded raw ERC20 tokens via vaultSetup ─────────
  // Skip if NFT already burned (tokens should already be rescued)
  // vaultSetup is owner-only and calls arbitrary targets — the only way to
  // recover tokens that landed in the vault raw balance but aren't tracked
  // in balances[user][asset] (caused by executeBatch tracking only one token).

  log('\nStep 3: Rescuing stranded tokens to user wallet...');

  const ERC20_TRANSFER_IFACE = new ethers.Interface([
    'function transfer(address to, uint256 amount) returns (bool)',
    'function balanceOf(address) view returns (uint256)',
  ]);

  const VAULT_SETUP_ABI = [
    'function vaultSetup(address target, bytes calldata data) external',
    'function approveTarget(uint256 chainId, address target) external',
    'function revokeTarget(uint256 chainId, address target) external',
    'function approvedTargets(uint256 chainId, address target) view returns (bool)',
  ];
  const vaultSetupContract = new ethers.Contract(VAULT_ADDR, VAULT_SETUP_ABI, owner);

  // Check vault's raw ERC20 balance for both pool tokens — any untracked balance = stranded
  for (const [addr, sym_] of [[token0, sym0], [token1, sym1]]) {
    const tokenContract = new ethers.Contract(addr, ERC20_TRANSFER_IFACE, provider);
    const rawBal: bigint = await tokenContract.balanceOf(VAULT_ADDR).catch(() => 0n) as bigint;
    const dec_ = addr === token0 ? dec0 : dec1;
    const trackedBal: bigint = await vaultOwner.balances(USER_ADDR, addr).catch(() => 0n) as bigint;

    // Stranded = vault holds it but user doesn't own it in balances
    const stranded = rawBal > trackedBal ? rawBal - trackedBal : 0n;

    if (stranded > 0n) {
      info(`  Stranded ${ethers.formatUnits(stranded, dec_)} ${sym_} in vault — sending to user wallet`);

      // vaultSetup requires target to be approved — temporarily approve token as target
      const alreadyApproved = await vaultSetupContract.approvedTargets(42161n, addr) as boolean;
      if (!alreadyApproved) {
        info(`  Temporarily approving ${sym_} (${addr}) as vault target...`);
        const approveTx = await vaultSetupContract.approveTarget(42161n, addr);
        await approveTx.wait(1);
        ok(`  ${sym_} approved as target`);
      }

      const transferData = ERC20_TRANSFER_IFACE.encodeFunctionData('transfer', [USER_ADDR, stranded]);
      const tx = await vaultSetupContract.vaultSetup(addr, transferData);
      console.log(`    tx: ${tx.hash}`);
      await tx.wait(1);
      ok(`Rescued ${ethers.formatUnits(stranded, dec_)} ${sym_} → ${USER_ADDR.slice(0,10)}…`);

      // Revoke the temporary approval
      if (!alreadyApproved) {
        const revokeTx = await vaultSetupContract.revokeTarget(42161n, addr);
        await revokeTx.wait(1);
        ok(`  ${sym_} approval revoked`);
      }
    } else {
      info(`  ${sym_}: no stranded balance`);
    }
  }

  // ── Step 4: Burn the empty NFT to clean up vault state ───────────────────

  log('\nStep 4: Burning empty NFT...');

  if (nftBurned) {
    ok(`NFT tokenId ${tokenId} already burned — skipping`);
  }

  const posNow = nftBurned ? null : await posMgr.positions(tokenId).catch(() => null);
  const canBurn = !nftBurned && posNow && posNow.liquidity === 0n && posNow.tokensOwed0 === 0n && posNow.tokensOwed1 === 0n;

  if (canBurn) {
    // Use vaultSetup (owner-only) instead of execute() to avoid agent auth check.
    // The vault owns the NFT, so owner→vaultSetup→POS_MGR.burn() works.
    const BURN_IFACE = new ethers.Interface(['function burn(uint256 tokenId) external payable']);
    const burnData = BURN_IFACE.encodeFunctionData('burn', [tokenId]);

    const posApproved = await vaultSetupContract.approvedTargets(42161n, POS_MGR) as boolean;
    if (posApproved) {
      const tx = await vaultSetupContract.vaultSetup(POS_MGR, burnData);
      console.log(`    tx: ${tx.hash}`);
      await tx.wait(1);
      ok(`NFT tokenId ${tokenId} burned — vault is clean`);
    } else {
      info('PositionManager not an approved target — skipping burn (NFT harmless but not cleaned up)');
    }
  } else if (posNow) {
    info(`NFT not burnable yet — liquidity=${posNow.liquidity}, owed0=${posNow.tokensOwed0}, owed1=${posNow.tokensOwed1}`);
  }

  // ── Step 5: Final state ───────────────────────────────────────────────────

  log('\nStep 5: Final vault state...');

  const [usdcFinal, usdtFinal] = await Promise.all([
    vaultOwner.balances(USER_ADDR, USDC) as Promise<bigint>,
    vaultOwner.balances(USER_ADDR, USDT) as Promise<bigint>,
  ]);
  const userUSDC = new ethers.Contract(USDC, ERC20_ABI, provider);
  const userUSDT = new ethers.Contract(USDT, ERC20_ABI, provider);
  const [walletUSDC, walletUSDT] = await Promise.all([
    userUSDC.balanceOf(USER_ADDR) as Promise<bigint>,
    userUSDT.balanceOf(USER_ADDR) as Promise<bigint>,
  ]);

  console.log(`\n  User wallet:`);
  console.log(`    USDC: ${ethers.formatUnits(walletUSDC, 6)}`);
  console.log(`    USDT: ${ethers.formatUnits(walletUSDT, 6)}`);
  console.log(`\n  Vault balances[user]:`);
  console.log(`    USDC idle: ${ethers.formatUnits(usdcFinal, 6)}`);
  console.log(`    USDT idle: ${ethers.formatUnits(usdtFinal, 6)}`);

  ok(`Recovery complete — user funds are back in wallet + vault is clean`);
  info('Agent can now deploy the idle USDC into WETH-ARB on next tick.');

  console.log('\n══════════════════════════════════════════════════════════════\n');
}

main().catch(err => { console.error('\n❌ Fatal:', err.message); process.exit(1); });
