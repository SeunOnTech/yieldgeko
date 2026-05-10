#!/usr/bin/env npx ts-node
/**
 * YieldGeko — Vault Withdrawal Script
 *
 * Two-phase withdrawal:
 *   Phase 1 (agent):  POST /api/withdraw — agent closes the UniV3 position,
 *                     swaps volatile tokens back to USDC, leaves funds idle.
 *   Phase 2 (user):   vault.withdraw(USDC, amount) — user signs this directly.
 *                     Only the user's wallet can call this; agent cannot intercept.
 *
 * Usage:
 *   cd packages/agent && npx ts-node scripts/vault-withdraw.ts
 *
 * Optional env override:
 *   WITHDRAW_ALL=true   (default) — withdraw entire idle USDC balance
 *   WITHDRAW_AMOUNT=0.5 — withdraw a specific USD amount instead
 */

import { ethers } from 'ethers';
import * as dotenv from 'dotenv';
import * as path   from 'node:path';
import * as http   from 'node:http';

dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

// ── Config ────────────────────────────────────────────────────────────────────

const VAULT_ADDRESS  = process.env.VAULT_ADDRESS!;
const ARB_RPC_URL    = process.env.ARB_RPC_URL ?? 'https://arb1.arbitrum.io/rpc';
const USER_ADDRESS   = process.env.TEST_USER_ADDRESS!;
const USER_PRIVKEY   = process.env.TEST_USER_PRIVKEY!;
const AGENT_URL      = `http://localhost:${process.env.SSE_PORT ?? 3001}`;
const USDC           = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831';
const WITHDRAW_AMOUNT = process.env.WITHDRAW_AMOUNT ? parseFloat(process.env.WITHDRAW_AMOUNT) : null;
// Fallback: if agent has no portfolio state, pass TOKEN_ID directly to close the position
const FORCE_TOKEN_ID = process.env.TOKEN_ID ? BigInt(process.env.TOKEN_ID) : null;

const VAULT_ABI = [
  'function withdraw(address asset, uint256 amount) external',
  'function balances(address user, address asset) view returns (uint256)',
];

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
];

// ── Helpers ───────────────────────────────────────────────────────────────────

const ok   = (msg: string) => console.log(`  ✅ ${msg}`);
const fail = (msg: string) => console.error(`  ❌ ${msg}`);
const info = (msg: string) => console.log(`  ℹ  ${msg}`);
const step = (msg: string) => console.log(`\n[${msg}]`);

const AGENT_API_KEY = process.env.AGENT_API_KEY ?? '';

function postJSON(url: string, body: object): Promise<any> {
  return new Promise((resolve, reject) => {
    const data    = JSON.stringify(body);
    const parsed  = new URL(url);
    const authHeaders = AGENT_API_KEY ? { 'Authorization': `Bearer ${AGENT_API_KEY}` } : {};
    const options = {
      hostname: parsed.hostname,
      port:     Number(parsed.port),
      path:     parsed.pathname,
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...authHeaders },
    };
    const req = http.request(options, res => {
      let raw = '';
      res.on('data', d => { raw += d; });
      res.on('end', () => { try { resolve(JSON.parse(raw)); } catch { resolve({ raw }); } });
    });
    req.on('error', reject);
    req.write(data); req.end();
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║  YieldGeko — Vault Withdrawal                               ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  if (!VAULT_ADDRESS) { fail('VAULT_ADDRESS not set'); process.exit(1); }
  if (!USER_ADDRESS)  { fail('TEST_USER_ADDRESS not set'); process.exit(1); }
  if (!USER_PRIVKEY)  { fail('TEST_USER_PRIVKEY not set'); process.exit(1); }

  const provider = new ethers.JsonRpcProvider(ARB_RPC_URL, 42161, { staticNetwork: true });
  const signer   = new ethers.Wallet(USER_PRIVKEY, provider);
  const vault    = new ethers.Contract(VAULT_ADDRESS, VAULT_ABI, signer);
  const usdc     = new ethers.Contract(USDC, ERC20_ABI, provider);

  if (signer.address.toLowerCase() !== USER_ADDRESS.toLowerCase()) {
    fail(`TEST_USER_PRIVKEY address ${signer.address} ≠ TEST_USER_ADDRESS ${USER_ADDRESS}`);
    process.exit(1);
  }

  console.log(`  Vault:   ${VAULT_ADDRESS}`);
  console.log(`  User:    ${USER_ADDRESS}`);
  console.log(`  Agent:   ${AGENT_URL}\n`);

  // ── Check current state ──────────────────────────────────────────────────────

  step('1. Reading current state');

  const [idleBefore, walletBefore] = await Promise.all([
    vault.balances(USER_ADDRESS, USDC) as Promise<bigint>,
    usdc.balanceOf(USER_ADDRESS) as Promise<bigint>,
  ]);

  console.log(`  Vault idle USDC:   ${ethers.formatUnits(idleBefore, 6)}`);
  console.log(`  Wallet USDC:       ${ethers.formatUnits(walletBefore, 6)}`);

  // ── Phase 1: Ask agent to close position and normalise to USDC ──────────────

  step('2. Phase 1 — Agent unwinds position (closes UniV3, swaps to USDC)');
  info('This may take 30–90 seconds (on-chain txs via Pimlico)...');

  let idleUSDCRaw: bigint;

  try {
    const res = await postJSON(`${AGENT_URL}/api/withdraw`, { userAddress: USER_ADDRESS });

    if (!res.ok) {
      if (res.status === 'IDLE_ONLY') {
        info('No active position — vault already has idle USDC');
        idleUSDCRaw = BigInt(res.idleUSDCRaw ?? '0');
      } else {
        fail(`Agent withdrawal failed: ${res.error ?? JSON.stringify(res)}`);
        process.exit(1);
      }
    } else {
      ok(`Position closed — ${res.idleUSDC?.toFixed(6)} USDC now idle in vault`);
      if (res.txs?.length) {
        for (const tx of res.txs) {
          info(`  Position ${tx.positionId.slice(0, 8)}…`);
          info(`    Close tx:     ${tx.closeTxHash?.slice(0, 20)}…`);
          if (tx.normalizeTxHash) {
            info(`    Normalize tx: ${tx.normalizeTxHash?.slice(0, 20)}…`);
          }
        }
      }
      idleUSDCRaw = BigInt(res.idleUSDCRaw ?? '0');
    }
  } catch (err: any) {
    if (FORCE_TOKEN_ID) {
      info(`Agent not reachable — falling back to direct close (TOKEN_ID=${FORCE_TOKEN_ID})`);
      idleUSDCRaw = 0n; // triggers 2b below
    } else {
      fail(`Could not reach agent at ${AGENT_URL}: ${err.message}`);
      fail('Is the agent running? Start it with: pnpm dev');
      process.exit(1);
    }
  }

  // ── Fallback: if agent had no state but we know the token ID, close directly ──

  let idleAfterClose = await vault.balances(USER_ADDRESS, USDC) as bigint;
  if (idleAfterClose === 0n && FORCE_TOKEN_ID) {
    step('2b. Direct close — agent had no portfolio state, closing NFT directly');
    info(`Closing NFT ${FORCE_TOKEN_ID} via AgentExecutor...`);
    try {
      const { AgentExecutor } = await import('../src/orchestrator/execution');
      const executor = new AgentExecutor(
        process.env.AGENT_PRIVATE_KEY!,
        VAULT_ADDRESS,
        ARB_RPC_URL,
      );
      await (executor as any).pimlicoInit;

      // Detect pool address from NFT position
      const provider2 = new ethers.JsonRpcProvider(ARB_RPC_URL, 42161, { staticNetwork: true });
      const nftMgr    = new ethers.Contract(
        '0xC36442b4a4522E871399CD717aBDD847Ab11FE88',
        ['function positions(uint256) view returns (uint96,address,address,address,uint24,int24,int24,uint128,uint256,uint256,uint128,uint128)'],
        provider2,
      );
      const pos = await nftMgr.positions(FORCE_TOKEN_ID);
      const token0: string = pos[2]; const token1: string = pos[3]; const fee: number = Number(pos[4]);
      // Derive pool address
      const FACTORY = '0x1F98431c8aD98523631AE4a59f267346ea31F984';
      const factoryAbi = ['function getPool(address,address,uint24) view returns (address)'];
      const factory    = new ethers.Contract(FACTORY, factoryAbi, provider2);
      const poolAddr: string = await factory.getPool(token0, token1, fee);
      info(`Pool: ${poolAddr}`);

      const prepared = await executor.prepareWithdrawal({
        strategyType:  'DELTA_NEUTRAL',
        asset:         USDC,
        amount:        BigInt(Math.round(2 * 1e6)),
        amountUSD:     2,
        userAddress:   USER_ADDRESS,
        marketAddress: poolAddr,
        tokenId:       FORCE_TOKEN_ID,
        liquidity:     BigInt(pos[7]),
      });
      ok(`Position closed — normalize tx: ${prepared.normalize?.txHash?.slice(0, 20) ?? 'n/a'}…`);
      idleAfterClose = await vault.balances(USER_ADDRESS, USDC) as bigint;
    } catch (err: any) {
      fail(`Direct close failed: ${err.message}`);
      process.exit(1);
    }
  }

  if (idleAfterClose === 0n) {
    fail('Vault idle balance is 0 after close — nothing to withdraw');
    process.exit(1);
  }

  // ── Phase 2: User signs vault.withdraw() ─────────────────────────────────────

  step('3. Phase 2 — User signs vault.withdraw()');

  // Determine amount to withdraw
  let withdrawAmount: bigint;
  if (WITHDRAW_AMOUNT !== null) {
    withdrawAmount = BigInt(Math.round(WITHDRAW_AMOUNT * 1e6));
    if (withdrawAmount > idleAfterClose) {
      fail(`Requested ${WITHDRAW_AMOUNT} USDC but only ${ethers.formatUnits(idleAfterClose, 6)} available`);
      process.exit(1);
    }
    info(`Partial withdrawal: ${ethers.formatUnits(withdrawAmount, 6)} USDC`);
  } else {
    withdrawAmount = idleAfterClose;
    info(`Full withdrawal: ${ethers.formatUnits(withdrawAmount, 6)} USDC`);
  }

  const tx = await vault.withdraw(USDC, withdrawAmount);
  console.log(`  tx: ${tx.hash}`);
  const receipt = await tx.wait(1);
  ok(`vault.withdraw() confirmed (gas: ${receipt.gasUsed})`);

  // ── Final balances ────────────────────────────────────────────────────────────

  step('4. Final state');

  const [idleFinal, walletFinal] = await Promise.all([
    vault.balances(USER_ADDRESS, USDC) as Promise<bigint>,
    usdc.balanceOf(USER_ADDRESS) as Promise<bigint>,
  ]);

  const received = walletFinal - walletBefore;

  console.log(`  Vault idle USDC:   ${ethers.formatUnits(idleFinal, 6)}`);
  console.log(`  Wallet USDC:       ${ethers.formatUnits(walletFinal, 6)}`);
  console.log(`  Received:          ${ethers.formatUnits(received, 6)} USDC`);

  ok('Withdrawal complete — funds are in your wallet.');
  console.log('\n══════════════════════════════════════════════════════════════\n');
}

main().catch(err => { console.error('\n❌ Fatal:', err.message); process.exit(1); });
