#!/usr/bin/env npx ts-node
/**
 * YieldGeko — End-to-End Real User Flow Test
 *
 * Smart resume: detects what's already done (deposited, policy registered, deployed)
 * and skips completed steps. Safe to run multiple times.
 *
 * Required env (set in packages/agent/.env):
 *   TEST_USER_ADDRESS   = 0x...  (EOA address)
 *   TEST_USER_PRIVKEY   = 0x...  (EOA private key)
 *   TEST_AMOUNT_USDC    = 1      (USD amount to deposit, default 1)
 *
 * Usage:
 *   cd packages/agent && npx ts-node scripts/e2e-user-test.ts
 */

import { ethers } from 'ethers';
import * as dotenv from 'dotenv';
import * as path  from 'node:path';
import * as http  from 'node:http';

dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

// ── Config ────────────────────────────────────────────────────────────────────

const VAULT_ADDRESS = process.env.VAULT_ADDRESS!;
const ARB_RPC_URL   = process.env.ARB_RPC_URL ?? 'https://arb1.arbitrum.io/rpc';
const USDC_ADDRESS  = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831';

const USER_ADDRESS  = process.env.TEST_USER_ADDRESS!;
const USER_PRIVKEY  = process.env.TEST_USER_PRIVKEY!;
const AMOUNT_USDC   = parseFloat(process.env.TEST_AMOUNT_USDC ?? '1');

const MIN_APY_BPS       = 800;
const MAX_DRAWDOWN_BPS  = 1000;
const MAX_FEE_BPS       = 1000;
const POLICY_DURATION   = 7 * 24 * 60 * 60;

// ── ABIs ──────────────────────────────────────────────────────────────────────

const ERC20_ABI = [
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function balanceOf(address account) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function nonces(address owner) view returns (uint256)',
];

const VAULT_ABI = [
  'function deposit(address asset, uint256 amount) external',
  'function registerPolicy(tuple(address user,uint256 managedUSD,uint256 minAPY,uint256 maxDrawdownBps,uint256 maxFeeBps,uint256 nonce,uint256 deadline) _p, bytes _sig) external',
  'function nonces(address user) view returns (uint256)',
  'function balances(address user, address asset) view returns (uint256)',
  'function deployed(address user, address asset) view returns (uint256)',
  'function policies(address user) view returns (bool active, uint256 managedUSD, uint256 minAPY, uint256 maxDrawdownBps, uint256 maxFeeBps, uint256 registeredAt, uint256 expiresAt)',
  'function domainSeparator() view returns (bytes32)',
  'function POLICY_TYPEHASH() view returns (bytes32)',
];

// ── Helpers ───────────────────────────────────────────────────────────────────

const log  = (step: string, msg: string) => console.log(`\n[${step}] ${msg}`);
const ok   = (msg: string) => console.log(`  ✅ ${msg}`);
const skip = (msg: string) => console.log(`  ⏭  ${msg}`);
const fail = (msg: string) => console.error(`  ❌ ${msg}`);
const info = (msg: string) => console.log(`  ℹ  ${msg}`);

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

const AGENT_API_KEY = process.env.AGENT_API_KEY ?? '';

async function postJSON(url: string, body: object): Promise<any> {
  return new Promise((resolve, reject) => {
    const data    = JSON.stringify(body, (_k, v) => typeof v === 'bigint' ? v.toString() : v);
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

async function getJSON(url: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const parsed  = new URL(url);
    const options = { hostname: parsed.hostname, port: Number(parsed.port), path: parsed.pathname, method: 'GET' };
    const req = http.request(options, res => {
      let raw = '';
      res.on('data', d => { raw += d; });
      res.on('end', () => { try { resolve(JSON.parse(raw)); } catch { resolve(null); } });
    });
    req.on('error', reject);
    req.end();
  });
}

// Auto-detect agent port — tries SSE_PORT, then 3001, then 3002
async function detectAgentUrl(): Promise<string> {
  const candidates = [
    `http://localhost:${process.env.SSE_PORT ?? 3001}`,
    'http://localhost:3001',
    'http://localhost:3002',
  ];
  for (const url of [...new Set(candidates)]) {
    try {
      const res = await getJSON(`${url}/health`);
      if (res) return url;
    } catch { /* try next */ }
  }
  throw new Error('Agent not reachable on port 3001 or 3002 — start it first: pnpm dev');
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║  YieldGeko — End-to-End Real User Test (smart resume)       ║');
  console.log('║  Detects completed steps and skips them automatically       ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');

  if (!VAULT_ADDRESS) { fail('VAULT_ADDRESS not set in .env'); process.exit(1); }
  if (!USER_ADDRESS)  { fail('TEST_USER_ADDRESS not set in .env'); process.exit(1); }
  if (!USER_PRIVKEY)  { fail('TEST_USER_PRIVKEY not set in .env'); process.exit(1); }

  // ── Detect agent ─────────────────────────────────────────────────────────────

  log('0', 'Detecting agent...');
  const agentUrl = await detectAgentUrl();
  ok(`Agent reachable at ${agentUrl}`);

  // ── Set up provider + signer ─────────────────────────────────────────────────

  const provider = new ethers.JsonRpcProvider(ARB_RPC_URL, 42161, { staticNetwork: true });
  const signer   = new ethers.Wallet(USER_PRIVKEY, provider);
  const usdc     = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, signer);
  const vault    = new ethers.Contract(VAULT_ADDRESS, VAULT_ABI, signer);

  const decimals = Number(await usdc.decimals());
  const amountRaw = BigInt(Math.round(AMOUNT_USDC * 10 ** decimals));

  console.log(`\n  Vault:    ${VAULT_ADDRESS}`);
  console.log(`  User:     ${USER_ADDRESS}`);
  console.log(`  Amount:   $${AMOUNT_USDC} USDC`);
  console.log(`  Agent:    ${agentUrl}`);

  // ── Step 1: Check existing on-chain state ─────────────────────────────────────

  log('1', 'Reading on-chain state...');

  const [usdcBalance, ethBalance, idleBalance, deployedBalance, policyRaw] = await Promise.all([
    usdc.balanceOf(USER_ADDRESS)                    as Promise<bigint>,
    provider.getBalance(USER_ADDRESS),
    vault.balances(USER_ADDRESS, USDC_ADDRESS)      as Promise<bigint>,
    vault.deployed(USER_ADDRESS, USDC_ADDRESS)      as Promise<bigint>,
    vault.policies(USER_ADDRESS).catch(() => null)  as Promise<any>,
  ]);

  const policyActive  = policyRaw?.[0] === true;
  const alreadyIdle   = idleBalance > 0n;
  const alreadyDeployed = deployedBalance > 0n;

  console.log(`  Wallet USDC:  ${ethers.formatUnits(usdcBalance, decimals)} USDC`);
  console.log(`  Wallet ETH:   ${ethers.formatEther(ethBalance)} ETH`);
  console.log(`  Vault idle:   ${ethers.formatUnits(idleBalance, decimals)} USDC`);
  console.log(`  Vault deployed: ${ethers.formatUnits(deployedBalance, decimals)} USDC`);
  console.log(`  Policy active: ${policyActive}`);

  if (alreadyDeployed) {
    ok('Already deployed — GENESIS already executed. Jumping to monitoring.');
  } else if (alreadyIdle) {
    ok('Funds already in vault — skipping deposit. Agent should deploy on next tick.');
  } else {
    info('No vault balance detected — will run full onboarding flow.');
  }

  if (ethBalance === 0n && !alreadyIdle && !alreadyDeployed) {
    fail('No ETH for gas — user needs ETH on Arbitrum for vault.deposit');
    process.exit(1);
  }

  // ── Step 2: Sign + register policy (skip if already active) ──────────────────

  if (!policyActive) {
    log('2', 'Signing EIP-712 policy...');

    const nonce       = await vault.nonces(USER_ADDRESS) as bigint;
    const deadline    = BigInt(Math.floor(Date.now() / 1000) + POLICY_DURATION);
    const managedRaw  = amountRaw * 2n;  // 2× deposit as cap

    const domainSep   = await vault.domainSeparator() as string;
    const typeHash    = await vault.POLICY_TYPEHASH()  as string;

    const structHash  = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
      ['bytes32','address','uint256','uint256','uint256','uint256','uint256','uint256'],
      [typeHash, USER_ADDRESS, managedRaw, MIN_APY_BPS, MAX_DRAWDOWN_BPS, MAX_FEE_BPS, nonce, deadline],
    ));
    const digest    = ethers.keccak256(ethers.concat(['0x1901', domainSep, structHash]));
    const policySig = ethers.Signature.from(signer.signingKey.sign(digest)).serialized;

    ok(`Policy signed — nonce ${nonce}`);

    log('3', 'Signing USDC permit (EIP-2612, no gas)...');

    const permitDeadline = BigInt(Math.floor(Date.now() / 1000) + POLICY_DURATION);
    const usdcNonce      = await usdc.nonces(USER_ADDRESS) as bigint;
    const permitSig      = await signer.signTypedData(
      { name: 'USD Coin', version: '2', chainId: 42161, verifyingContract: USDC_ADDRESS },
      { Permit: [
        { name: 'owner',    type: 'address' },
        { name: 'spender',  type: 'address' },
        { name: 'value',    type: 'uint256' },
        { name: 'nonce',    type: 'uint256' },
        { name: 'deadline', type: 'uint256' },
      ]},
      { owner: USER_ADDRESS, spender: VAULT_ADDRESS, value: amountRaw, nonce: usdcNonce, deadline: permitDeadline },
    );
    ok(`Permit signed — nonce ${usdcNonce}`);

    log('4', 'POST /api/onboard — agent sponsors registerPolicy + USDC.permit...');
    const onboardRes = await postJSON(`${agentUrl}/api/onboard`, {
      userAddress: USER_ADDRESS,
      policy: {
        user: USER_ADDRESS, managedUSD: managedRaw.toString(),
        minAPY: String(MIN_APY_BPS), maxDrawdownBps: String(MAX_DRAWDOWN_BPS),
        maxFeeBps: String(MAX_FEE_BPS), nonce: nonce.toString(), deadline: deadline.toString(),
      },
      policySig,
      permitSig,
      permitAmount:   amountRaw.toString(),
      permitDeadline: permitDeadline.toString(),
    });
    if (onboardRes.error) { fail(`/api/onboard: ${onboardRes.error}`); process.exit(1); }
    ok(`registerPolicy tx: ${onboardRes.registerTxHash?.slice(0, 20)}…`);
    ok(`USDC.permit tx:     ${onboardRes.permitTxHash?.slice(0, 20)}…`);
  } else {
    skip('Policy already registered on-chain — skipping sign + onboard');
  }

  // ── Step 5: Deposit (skip if already in vault) ────────────────────────────────

  if (!alreadyIdle && !alreadyDeployed) {
    log('5', `vault.deposit — user pays ~$0.03 gas`);
    const allowance = await usdc.allowance(USER_ADDRESS, VAULT_ADDRESS) as bigint;
    if (allowance < amountRaw) {
      const approveTx = await usdc.approve(VAULT_ADDRESS, amountRaw);
      await approveTx.wait(1);
      ok(`USDC approved`);
    }
    const tx = await (vault as any).deposit(USDC_ADDRESS, amountRaw);
    console.log(`  tx: ${tx.hash}`);
    await tx.wait(1);
    ok(`Deposited $${AMOUNT_USDC} — ${tx.hash.slice(0, 20)}…`);

    const newIdle = await vault.balances(USER_ADDRESS, USDC_ADDRESS) as bigint;
    ok(`vault.balances[user][USDC] = ${ethers.formatUnits(newIdle, decimals)} USDC`);
  } else {
    skip(`Deposit already in vault ($${ethers.formatUnits(deployedBalance > 0n ? deployedBalance : idleBalance, decimals)} USDC)`);
  }

  // ── Step 6: Register with agent + force-reset stale state ────────────────────

  log('6', 'Registering with agent (POST /api/register)...');
  try {
    const res = await postJSON(`${agentUrl}/api/register`, {
      userId:      USER_ADDRESS,
      userAddress: USER_ADDRESS,
      isReal:      true,
      riskProfile: 'aggressive',
      managedUSD:  AMOUNT_USDC,
    });
    ok(`Agent registered: phase=${res?.phase ?? 'unknown'}`);
  } catch (err: any) {
    fail(`Agent registration failed: ${err.message}`);
    process.exit(1);
  }

  // Always reset to IDLE after registration — clears any stale portfolio state
  // (burned NFTs, old positions) that may have been loaded from persistence.
  // Safe to call even on a fresh registration.
  const userId = `user-${USER_ADDRESS.slice(2, 10)}`;
  log('6b', `Force-resetting agent state to IDLE for ${userId}...`);
  try {
    const resetRes = await postJSON(`${agentUrl}/api/reset-user`, { userId });
    if (resetRes?.ok) {
      ok(`State reset to IDLE — agent will run GENESIS on next tick`);
    } else {
      info(`Reset returned: ${JSON.stringify(resetRes)}`);
    }
  } catch (err: any) {
    info(`Reset endpoint not available: ${err.message}`);
  }

  // ── Step 7: Wait for GENESIS + show full position state ───────────────────────

  log('7', 'Waiting for agent GENESIS execution...');
  console.log('  (screener runs first tick — up to 2 minutes)\n');

  let executed = false;
  for (let i = 0; i < 30; i++) {
    await sleep(5_000);

    let deployed: bigint;
    try {
      deployed = await vault.deployed(USER_ADDRESS, USDC_ADDRESS) as bigint;
    } catch (err: any) {
      process.stdout.write(`  RPC retry… (${(i + 1) * 5}s elapsed)\r`);
      continue;
    }

    if (deployed > 0n) {
      executed = true;
      ok(`GENESIS executed! vault.deployed = ${ethers.formatUnits(deployed, decimals)} USDC`);

      // Show full agent position state including new LVR + range fields
      try {
        const state = await getJSON(`${agentUrl}/state`);
        const userState = state?.users?.[USER_ADDRESS] ?? state?.users?.[USER_ADDRESS.toLowerCase()];

        if (userState?.portfolio?.positions?.length > 0) {
          console.log(`\n  ┌─ Portfolio — ${userState.portfolio.positions.length} position(s) ─────────────────────────`);
          for (const pos of userState.portfolio.positions) {
            console.log(`  │`);
            console.log(`  │  Strategy:     ${pos.strategyType}`);
            console.log(`  │  Pool:         ${pos.venueName}`);
            console.log(`  │  Pool address: ${pos.venueAddress ?? pos.uniV3EntryPool ?? 'n/a'}`);
            console.log(`  │  Allocated:    $${pos.allocationUSD?.toFixed(2)}`);
            console.log(`  │  Current val:  $${pos.currentUSD?.toFixed(4)}`);
            console.log(`  │  Entry APY:    ${pos.entryAPY?.toFixed(2)}%`);
            console.log(`  │  Net APY:      ${pos.currentNetAPY?.toFixed(2)}%`);

            if (pos.strategyType === 'DELTA_NEUTRAL') {
              console.log(`  │`);
              console.log(`  │  ── UniV3 Range ─────────────────────────────`);
              console.log(`  │  Range:        ±${pos.uniV3RangePct ?? '?'}%`);
              console.log(`  │  Tick lower:   ${pos.uniV3TickLower ?? 'pending'}`);
              console.log(`  │  Tick upper:   ${pos.uniV3TickUpper ?? 'pending'}`);
              console.log(`  │  Center tick:  ${pos.uniV3CenterTick ?? 'pending'}`);
              console.log(`  │  TokenId:      ${pos.uniV3TokenId ?? 'pending'}`);
              console.log(`  │  Drift:        ${pos.uniV3LastDriftPct !== undefined ? (pos.uniV3LastDriftPct * 100).toFixed(1) + '%' : '0% (just opened)'}`);
              console.log(`  │  Rebalances:   ${pos.uniV3Rebalances ?? 0}`);
              console.log(`  │`);
              console.log(`  │  ── LVR Screener ────────────────────────────`);
              // Look up opportunity in agent state for LVR fields
              const opp = state?.opportunities?.find((o: any) => o.address === (pos.venueAddress ?? pos.uniV3EntryPool));
              if (opp) {
                console.log(`  │  DeFiLlama APY: ${opp.grossAPY?.toFixed(1)}%`);
                console.log(`  │  Adj fee APY:   ${opp.lvrAdjFeeAPY?.toFixed(1) ?? 'n/a'}%`);
                console.log(`  │  LVR cost:      ${opp.lvrNetAPY !== undefined ? (opp.grossAPY - opp.lvrNetAPY)?.toFixed(1) : 'n/a'}%`);
                console.log(`  │  Net APY:       ${opp.lvrNetAPY?.toFixed(1) ?? 'n/a'}%`);
                console.log(`  │  C_avg:         ${opp.lvrCAvg?.toFixed(1) ?? 'n/a'}×`);
                console.log(`  │  σ daily:       ${opp.lvrSigmaDaily?.toFixed(2) ?? 'n/a'}%`);
                console.log(`  │  Epoch ratio:   ${opp.lvrEpochRatio?.toFixed(2) ?? 'n/a'}×`);
              }
            }

            console.log(`  │`);
            console.log(`  │  IL:           ${pos.ilPct?.toFixed(3) ?? '0'}%  ($${pos.ilUSD?.toFixed(4) ?? '0'})`);
            console.log(`  │  Fees earned:  $${pos.feesEarnedUSD?.toFixed(6) ?? '0'}`);
            console.log(`  │  GeckoScore:   ${pos.geckoScore?.toFixed(1)}`);
          }
          console.log(`  └─────────────────────────────────────────────────────`);
          console.log(`\n  Phase: ${userState.phase}`);
          console.log(`  Weighted APY: ${userState.portfolio?.metrics?.weightedNetAPY?.toFixed(2) ?? 'n/a'}%`);
        }
      } catch (err: any) {
        info(`Could not fetch agent state: ${err.message}`);
      }

      break;
    }

    process.stdout.write(`  waiting… (${(i + 1) * 5}s elapsed)\r`);
  }

  if (!executed) {
    console.log('\n');
    fail('Agent did not execute within 2.5 minutes');
    console.log('  Possible causes:');
    console.log('  · Screener still running first scan (wait 1 more minute)');
    console.log('  · No pool passed LVR screen — check agent logs');
    console.log('  · VAULT_ADDRESS mismatch between script and agent .env');
    console.log('  · Safety gate failing — check agent SSE logs at ' + agentUrl + '/events');
  }

  // ── Summary ───────────────────────────────────────────────────────────────────

  console.log('\n══════════════════════════════════════════════════════════════');
  console.log('  Arbiscan:  https://arbiscan.io/address/' + USER_ADDRESS);
  console.log('  Agent SSE: ' + agentUrl + '/events');
  console.log('  Agent state: ' + agentUrl + '/state');
  console.log('══════════════════════════════════════════════════════════════\n');
}

main().catch(err => { console.error('\n❌ Fatal:', err.message); process.exit(1); });
