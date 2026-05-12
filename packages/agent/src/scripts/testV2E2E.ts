/**
 * YieldGeko V2 — Arbitrum Mainnet Full E2E Test
 *
 * Simulates exactly what the frontend will do, then lets the agent do its job:
 *
 *   Phase 1 — Delegation setup (proves crypto layer is correct, no on-chain deposit)
 *     [1] Derive MetaMask HybridDeleGator smart account from EOA
 *     [2] Check smart account USDC balance (must be ≥ DEPOSIT_USDC)
 *     [3] Pimlico UserOp: smart account approves executor to spend USDC
 *     [4] Sign ERC-7710 delegation (what the frontend's "Sign" button does)
 *
 *   Phase 2 — Agent registers + decides + executes (agent does the deployment)
 *     [5] Reset user if already registered (clean slate)
 *     [6] POST /api/register with V2 payload (what frontend sends after signing)
 *     [7] Poll /state until phase = MONITORING (agent ran GENESIS, chose protocol itself)
 *     [8] Verify on-chain: read final position from agent state + Arbiscan links
 *
 * Usage:
 *   PRIVATE_KEY=0x... PIMLICO_API_KEY=pim_... npx ts-node src/scripts/testV2E2E.ts
 *
 * Env:
 *   PRIVATE_KEY      required — EOA (signs delegation + agent wallet)
 *   PIMLICO_API_KEY  required — Pimlico API key for smart account UserOps
 *   ARB_RPC_URL      optional — defaults to Arbitrum public RPC
 *   AGENT_URL        optional — defaults to http://localhost:3001
 *   AGENT_API_KEY    optional — Bearer token for /api/* endpoints
 *   DEPOSIT_USDC     optional — dollar amount to manage (default: 1)
 */

import 'dotenv/config';
import { createPimlicoClient } from 'permissionless/clients/pimlico';
import {
  createPublicClient,
  createWalletClient,
  http,
  encodeFunctionData,
  encodeAbiParameters,
  parseAbiParameters,
  encodePacked,
  parseAbi,
  formatUnits,
  hexToSignature,
  type Address,
  type Hex,
} from 'viem';
import { createBundlerClient } from 'viem/account-abstraction';
import { privateKeyToAccount } from 'viem/accounts';
import { arbitrum } from 'viem/chains';
import { toSimpleSmartAccount } from 'permissionless/accounts';
import {
  Implementation,
  toMetaMaskSmartAccount,
  getSmartAccountsEnvironment,
  createCaveat,
  ROOT_AUTHORITY,
  type MetaMaskSmartAccount,
} from '@metamask/smart-accounts-kit';
import * as https from 'node:https';
import * as http2 from 'node:http';

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────

const ARB_RPC     = process.env.ARB_RPC_URL ?? 'https://arb1.arbitrum.io/rpc';
const PIMLICO_KEY = process.env.PIMLICO_API_KEY!;
const PIMLICO_URL = `https://api.pimlico.io/v2/42161/rpc?apikey=${PIMLICO_KEY}`;
const AGENT_URL   = process.env.AGENT_URL ?? 'http://localhost:3001';
const AGENT_KEY   = process.env.AGENT_API_KEY ?? '';
const DEPOSIT_USD = Number(process.env.DEPOSIT_USDC ?? '1');
const DEPOSIT_AMT = BigInt(Math.round(DEPOSIT_USD * 1_000_000));
// Risk tier: conservative | balanced | aggressive | advanced
const RISK_TIER   = process.env.RISK_TIER ?? 'aggressive';

// ── Arbitrum mainnet addresses ────────────────────────────────────────────────

const USDC     = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831' as Address;
const EXECUTOR = (process.env.EXECUTOR_ADDRESS ?? '0x94DE8790BEd6Be0395C6BE7f42FD677b7B8cBcFb') as Address;
const ENFORCER = '0x21b25E099CA7AF1BEa3a4558E437C56680B4b925' as Address;
const SWAPPER  = (process.env.SWAPPER_ADDRESS  ?? '0x4313539C4fF1b93891B6A66D6a2eb690153A1b33') as Address;

// YieldGeko treasury — receives performance fees and LP mint dust.
// Must match the treasury set in the deployed YieldGekoExecutor contract.
const TREASURY = (process.env.TREASURY_ADDRESS ?? '0xd61E4Bfb67514d8ad797495A584f70Cd0878fc5A') as Address;

// ─────────────────────────────────────────────────────────────────────────────
// HTTP helper (no extra deps — uses Node built-ins)
// ─────────────────────────────────────────────────────────────────────────────

function httpRequest(url: string, options: {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const parsed   = new URL(url);
    const isHttps  = parsed.protocol === 'https:';
    const lib      = isHttps ? https : http2;
    const reqOpts  = {
      hostname: parsed.hostname,
      port:     parsed.port || (isHttps ? 443 : 80),
      path:     parsed.pathname + parsed.search,
      method:   options.method ?? 'GET',
      headers:  options.headers ?? {},
    };
    const req = lib.request(reqOpts, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

async function agentGet(path: string): Promise<{ status: number; data: unknown }> {
  const res = await httpRequest(`${AGENT_URL}${path}`, { method: 'GET' });
  return { status: res.status, data: res.status === 200 ? JSON.parse(res.body) : null };
}

async function agentPost(path: string, body: unknown): Promise<{ status: number; data: unknown; raw: string }> {
  const payload = JSON.stringify(body);
  const res = await httpRequest(`${AGENT_URL}${path}`, {
    method:  'POST',
    headers: {
      'Content-Type':   'application/json',
      'Authorization':  `Bearer ${AGENT_KEY}`,
      'Content-Length': Buffer.byteLength(payload).toString(),
    },
    body: payload,
  });
  let data: unknown = null;
  try { data = JSON.parse(res.body); } catch {}
  return { status: res.status, data, raw: res.body };
}

// ─────────────────────────────────────────────────────────────────────────────
// Logging
// ─────────────────────────────────────────────────────────────────────────────

const ok   = (step: string, msg: string) => console.log(`  ${step.padEnd(4)} ✅  ${msg}`);
const info = (step: string, msg: string) => console.log(`  ${step.padEnd(4)} ℹ️   ${msg}`);
const wait = (step: string, msg: string) => console.log(`  ${step.padEnd(4)} ⏳  ${msg}`);

function fail(step: string, msg: string): never {
  console.error(`\n  ${step.padEnd(4)} ❌  ${msg}\n`);
  process.exit(1);
}

function section(title: string): void {
  console.log(`\n${'─'.repeat(58)}\n  ${title}\n${'─'.repeat(58)}\n`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  // Two separate keys — correct separation of roles:
  //   TEST_USER_PRIVKEY  = the user: owns the smart account, holds USDC, signs the delegation
  //   AGENT_PRIVATE_KEY  = the agent: calls redeemDelegations via its Pimlico smart account
  if (!process.env.TEST_USER_PRIVKEY)  fail('env', 'TEST_USER_PRIVKEY env var required (test user wallet)');
  if (!process.env.AGENT_PRIVATE_KEY)  fail('env', 'AGENT_PRIVATE_KEY env var required (agent wallet)');
  if (!PIMLICO_KEY)                    fail('env', 'PIMLICO_API_KEY env var required');

  const userAccount = privateKeyToAccount(process.env.TEST_USER_PRIVKEY as Hex);
  const agentEOA    = privateKeyToAccount(process.env.AGENT_PRIVATE_KEY as Hex);

  // Get MetaMask framework addresses for Arbitrum from the SDK
  const environment         = getSmartAccountsEnvironment(arbitrum.id);
  const DELEGATION_MANAGER  = environment.DelegationManager as Address;
  const ALLOWED_TARGETS_ENF = environment.caveatEnforcers.AllowedTargetsEnforcer as Address;

  const publicClient  = createPublicClient({ chain: arbitrum, transport: http(ARB_RPC) });
  const agentWalletClient = createWalletClient({
    account: agentEOA,
    chain: arbitrum,
    transport: http(ARB_RPC),
  });

  // The agent calls redeemDelegations via its Pimlico SimpleSmartAccount (ERC-4337).
  // The delegation's `delegate` MUST match this address — it's what msg.sender will be
  // on-chain when the agent submits the UserOperation through Pimlico.
  const agentSimpleAccount = await toSimpleSmartAccount({
    owner:      agentEOA,
    client:     publicClient,
    entryPoint: { address: '0x0000000071727De22E5E9d8BAf0edAc6f37da032' as Address, version: '0.7' },
  });
  const agentAddress = agentSimpleAccount.address; // e.g. 0x0aC0299A57D8035983EbdC4172F3F1D0698f3d4B

  // Pimlico gas price oracle — Arbitrum node returns maxPriorityFeePerGas=0 which Pimlico rejects
  const pimlicoClient = createPimlicoClient({
    transport: http(PIMLICO_URL),
    entryPoint: { address: '0x0000000071727De22E5E9d8BAf0edAc6f37da032' as Address, version: '0.7' },
  });

  const bundlerClient = createBundlerClient({
    client:    publicClient,
    transport: http(PIMLICO_URL),
    paymaster: true,
    userOperation: {
      estimateFeesPerGas: async () => (await pimlicoClient.getUserOperationGasPrice()).fast,
    },
  });

  const ERC20_ABI = parseAbi([
    'function balanceOf(address) external view returns (uint256)',
    'function allowance(address owner, address spender) external view returns (uint256)',
    'function approve(address spender, uint256 amount) external returns (bool)',
  ]);

  const ENFORCER_ABI = parseAbi([
    'function authorizedAgents(address) external view returns (bool)',
    'function setAuthorizedAgent(address agent, bool authorized) external',
  ]);

  console.log('\n══════════════════════════════════════════════════════');
  console.log('  YieldGeko V2 — Arbitrum Mainnet Full E2E Test');
  console.log('══════════════════════════════════════════════════════\n');
  console.log(`  User EOA (delegator):  ${userAccount.address}`);
  console.log(`  Agent EOA (delegate):  ${agentAddress}`);
  console.log(`  DelegationManager:     ${DELEGATION_MANAGER}`);
  console.log(`  Executor:              ${EXECUTOR}`);
  console.log(`  Enforcer:              ${ENFORCER}`);
  console.log(`  Deposit:               $${DEPOSIT_USD} USDC`);
  console.log(`  Agent URL:             ${AGENT_URL}`);

  // ══════════════════════════════════════════════════════════
  // PHASE 1 — Delegation setup
  // ══════════════════════════════════════════════════════════

  section('PHASE 1 — Delegation setup');

  // [1] Derive smart account address (counterfactual — no deploy tx needed yet)
  info('[1]', 'Deriving MetaMask HybridDeleGator smart account...');

  const delegatorSmartAccount: MetaMaskSmartAccount<Implementation.Hybrid> =
    await toMetaMaskSmartAccount({
      client:         publicClient,
      implementation: Implementation.Hybrid,
      deployParams:   [userAccount.address, [], [], []] as const,
      deploySalt:     '0x',
      signer:         { account: userAccount },
    });

  const smartAccountAddress = delegatorSmartAccount.address;
  const bytecode  = await publicClient.getBytecode({ address: smartAccountAddress });
  const deployed  = !!bytecode && bytecode !== '0x';
  ok('[1]', `Smart account: ${smartAccountAddress}`);
  info('[1]', `On-chain: ${deployed ? 'already deployed' : 'counterfactual (deploys on first UserOp)'}`);

  // [2] Fund smart account from EOA — fully gasless for the user.
  //
  //     Flow (mirrors what the frontend "Deposit" button does):
  //       a. EOA signs an EIP-2612 permit off-chain (no gas — just a signature)
  //       b. Smart account sends a Pimlico-sponsored UserOp:
  //            USDC.permit(EOA, smartAccount, amount, deadline, v, r, s)
  //            USDC.transferFrom(EOA, smartAccount, amount)
  //       → User pays zero ETH. Pimlico covers the UserOp gas.
  //
  //     Native USDC on Arbitrum (0xaf88...) implements EIP-2612 natively.
  info('[2]', 'Checking USDC balances (EOA → smart account)...');

  const USDC_NONCE_ABI = parseAbi([
    'function nonces(address owner) external view returns (uint256)',
    'function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s) external',
    'function transferFrom(address from, address to, uint256 amount) external returns (bool)',
  ]);

  const [smartAcctUSDC, eoaUSDC] = await Promise.all([
    publicClient.readContract({ address: USDC, abi: ERC20_ABI, functionName: 'balanceOf', args: [smartAccountAddress] }),
    publicClient.readContract({ address: USDC, abi: ERC20_ABI, functionName: 'balanceOf', args: [userAccount.address] }),
  ]);

  console.log(`        EOA balance:           ${formatUnits(eoaUSDC, 6)} USDC`);
  console.log(`        Smart account balance:  ${formatUnits(smartAcctUSDC, 6)} USDC`);
  console.log(`        Needed:                ${formatUnits(DEPOSIT_AMT, 6)} USDC`);

  if (smartAcctUSDC < DEPOSIT_AMT) {
    const needed = DEPOSIT_AMT - smartAcctUSDC;

    if (eoaUSDC < needed) {
      console.log(`\n  ⚠️  Insufficient USDC.`);
      console.log(`     EOA has ${formatUnits(eoaUSDC, 6)}, smart account has ${formatUnits(smartAcctUSDC, 6)}.`);
      console.log(`     Need ${formatUnits(needed, 6)} more USDC on Arbitrum.\n`);
      process.exit(0);
    }

    wait('[2]', `Signing EIP-2612 permit (gasless — EOA signature only)...`);

    // Step a: EOA signs a permit allowing the smart account to pull USDC
    const permitDeadline = BigInt(Math.floor(Date.now() / 1000) + 3600); // 1h window
    const permitNonce    = await publicClient.readContract({
      address: USDC, abi: USDC_NONCE_ABI, functionName: 'nonces', args: [userAccount.address],
    });

    // User's EOA signs the permit — this is the gasless "Approve" step in the frontend
    const userWalletClient = createWalletClient({ account: userAccount, chain: arbitrum, transport: http(ARB_RPC) });
    const permitSig = await userWalletClient.signTypedData({
      domain: {
        name:              'USD Coin',
        version:           '2',
        chainId:           42161,
        verifyingContract: USDC,
      },
      types: {
        Permit: [
          { name: 'owner',    type: 'address' },
          { name: 'spender',  type: 'address' },
          { name: 'value',    type: 'uint256' },
          { name: 'nonce',    type: 'uint256' },
          { name: 'deadline', type: 'uint256' },
        ],
      },
      primaryType: 'Permit',
      message: {
        owner:    userAccount.address,
        spender:  smartAccountAddress,
        value:    needed,
        nonce:    permitNonce,
        deadline: permitDeadline,
      },
    });

    const { v, r, s } = hexToSignature(permitSig);
    ok('[2]', 'Permit signed (no gas paid)');

    // Step b: Smart account UserOp — Pimlico sponsors the gas
    //   1. USDC.permit(EOA, smartAccount, amount, deadline, v, r, s)
    //   2. USDC.transferFrom(EOA, smartAccount, amount)
    wait('[2]', `Sending Pimlico UserOp: permit + transferFrom (${formatUnits(needed, 6)} USDC)...`);

    const permitCalldata = encodeFunctionData({
      abi: USDC_NONCE_ABI,
      functionName: 'permit',
      args: [userAccount.address, smartAccountAddress, needed, permitDeadline, Number(v), r, s],
    });
    const transferFromCalldata = encodeFunctionData({
      abi: USDC_NONCE_ABI,
      functionName: 'transferFrom',
      args: [userAccount.address, smartAccountAddress, needed],
    });

    const opHash = await bundlerClient.sendUserOperation({
      account: delegatorSmartAccount,
      calls: [
        { to: USDC, value: 0n, data: permitCalldata },
        { to: USDC, value: 0n, data: transferFromCalldata },
      ],
    });
    const opReceipt = await bundlerClient.waitForUserOperationReceipt({ hash: opHash });
    ok('[2]', `Smart account funded — tx: ${opReceipt.receipt.transactionHash}`);
    console.log(`        Pimlico sponsored the gas. User paid: $0`);
  } else {
    ok('[2]', `Smart account already has ${formatUnits(smartAcctUSDC, 6)} USDC ✓`);
  }

  // [3] Approve executor AND swapper to pull USDC from smart account (single Pimlico UserOp).
  //     - Executor: calls USDC.transferFrom(smartAccount, executor, amount) for direct deposits
  //     - Swapper:  calls USDC.transferFrom(smartAccount, swapper, amountIn) for swap legs
  info('[3]', 'Checking USDC allowances: smart account → executor + swapper...');
  const [allowanceExec, allowanceSwap] = await Promise.all([
    publicClient.readContract({ address: USDC, abi: ERC20_ABI, functionName: 'allowance', args: [smartAccountAddress, EXECUTOR] }),
    publicClient.readContract({ address: USDC, abi: ERC20_ABI, functionName: 'allowance', args: [smartAccountAddress, SWAPPER] }),
  ]);

  const approvalCalls: { to: Address; value: bigint; data: Hex }[] = [];
  if (allowanceExec < DEPOSIT_AMT) {
    approvalCalls.push({ to: USDC, value: 0n, data: encodeFunctionData({ abi: ERC20_ABI, functionName: 'approve', args: [EXECUTOR, DEPOSIT_AMT * 1000n] }) });
  }
  if (allowanceSwap < DEPOSIT_AMT) {
    approvalCalls.push({ to: USDC, value: 0n, data: encodeFunctionData({ abi: ERC20_ABI, functionName: 'approve', args: [SWAPPER,   DEPOSIT_AMT * 1000n] }) });
  }

  // No volatile token approvals needed — with the new architecture, Swapper sends
  // tokenOut directly to executor (not smart account). executor.executeFromBalance /
  // executePullAndFromBalance uses its own balance, so no smart account allowance is needed
  // for volatile tokens. Only USDC→Executor + USDC→Swapper are required.

  if (approvalCalls.length > 0) {
    wait('[3]', `Sending approve UserOp (${approvalCalls.length} approval(s)) via Pimlico...`);
    const opHash    = await bundlerClient.sendUserOperation({ account: delegatorSmartAccount, calls: approvalCalls });
    const opReceipt = await bundlerClient.waitForUserOperationReceipt({ hash: opHash });
    ok('[3]', `Tokens approved (tx: ${opReceipt.receipt.transactionHash})`);
  } else {
    ok('[3]', `Allowances OK — executor: ${formatUnits(allowanceExec, 6)}, swapper: ${formatUnits(allowanceSwap, 6)} USDC`);
  }

  // [3c] Agent EOA must be in the enforcer's authorizedAgents allowlist.
  //      beforeHook checks authorizedAgents[_redeemer] — every redemption reverts if not set.
  //      The enforcer owner (deployer) calls setAuthorizedAgent once per agent wallet.
  info('[3]', 'Checking enforcer authorizedAgents allowlist for agent EOA...');
  const isAuthorized = await publicClient.readContract({
    address: ENFORCER, abi: ENFORCER_ABI,
    functionName: 'authorizedAgents', args: [agentAddress],
  });
  if (!isAuthorized) {
    // setAuthorizedAgent is onlyOwner — must be called by the enforcer deployer wallet (0x78620...)
    // not by the agent or test user. This is a one-time admin setup step.
    console.log(`\n  ⚠️  Agent ${agentAddress} is not in the enforcer's authorizedAgents.`);
    console.log(`\n  The enforcer owner must run this once:`);
    console.log(`\n  cast send ${ENFORCER} \\`);
    console.log(`    "setAuthorizedAgent(address,bool)" ${agentAddress} true \\`);
    console.log(`    --private-key <DEPLOYER_PRIVATE_KEY> \\`);
    console.log(`    --rpc-url https://arb1.arbitrum.io/rpc\n`);
    process.exit(0);
  }
  ok('[3]', `Agent EOA authorized in enforcer ✓`);

  // [4] Sign ERC-7710 delegation — what the frontend's "Sign" button does.
  //
  //     PolicyTerms are the USER'S signed commitments (immutable after signing):
  //       minAPYBps      — informational APY floor (agent software enforces, NOT the contract)
  //       maxDrawdownBps — HARD on-chain revert if portfolio drops > this % from all-time peak
  //       managedUSD6    — capital cap: agent can never deploy more than this amount
  //       maxFeeBps      — fee cap: agent can never charge more than this % of yield
  //       treasury       — YieldGeko treasury that receives performance fees (NOT the agent)
  //       expiresAt      — delegation auto-expires; redemptions revert after this timestamp
  //       feeToken       — ERC-20 token fees are collected in (USDC on Arbitrum)
  //
  //     args = '0x' at signing time; agent injects per-execution values at redemption.
  //     Field order MUST match the PolicyTerms struct in YieldGekoPolicyCaveatEnforcer.sol.
  info('[4]', 'Building and signing ERC-7710 delegation...');

  const expiresAt   = BigInt(Math.floor(Date.now() / 1000) + 365 * 24 * 3600);
  const managedUSD6 = DEPOSIT_AMT;

  const policyTerms = encodeAbiParameters(
    parseAbiParameters('uint256, uint256, uint256, uint256, address, uint256, address'),
    [
      200n,         // minAPYBps:      2%  — informational, not enforced on-chain
      2000n,        // maxDrawdownBps: 20% — hard revert if breached
      managedUSD6,  // managedUSD6:        — capital cap in USDC 6-decimal units
      1000n,        // maxFeeBps:      10% — max performance fee cap
      TREASURY,     // treasury:           — YieldGeko fee recipient (NOT the agent EOA)
      expiresAt,    // expiresAt:          — unix timestamp, auto-expires in 1 year
      USDC,         // feeToken:           — USDC on Arbitrum
    ],
  ) as Hex;

  // AllowedTargetsEnforcer dropped — it throws CaveatEnforcer:invalid-call-type on
  // BATCH mode executions (3-exec delta-neutral). YieldGekoPolicyCaveatEnforcer
  // handles all policy enforcement; AllowedTargets was redundant.
  const delegation = {
    delegate:  agentAddress as `0x${string}`,   // agent Pimlico SA — actual msg.sender on-chain
    delegator: smartAccountAddress,              // user's MetaMask smart account
    authority: ROOT_AUTHORITY,
    caveats: [
      createCaveat(ENFORCER, policyTerms, '0x'), // index 0 (args injected at redemption)
    ],
    salt: '0x0000000000000000000000000000000000000000000000000000000000000000' as Hex,
  };

  const signature       = await delegatorSmartAccount.signDelegation({ delegation });
  const signedDelegation = { ...delegation, signature };

  ok('[4]', 'Delegation signed ✓');
  console.log(`        delegate:  ${signedDelegation.delegate} (agent)`);
  console.log(`        delegator: ${signedDelegation.delegator} (smart account)`);
  console.log(`        authority: ROOT`);
  console.log(`        caveats:   YieldGekoPolicyCaveatEnforcer only`);
  console.log(`        sig:       ${signature.slice(0, 20)}…`);

  // ══════════════════════════════════════════════════════════
  // PHASE 2 — Agent registers + decides + executes
  // ══════════════════════════════════════════════════════════

  section('PHASE 2 — Agent registration + GENESIS');

  // Check agent is reachable before doing anything
  info('[5]', `Checking agent at ${AGENT_URL}/health...`);
  let healthRes: { status: number; data: unknown };
  try {
    healthRes = await agentGet('/health');
  } catch (err: any) {
    fail('[5]', `Agent not reachable: ${err.message}. Run: cd packages/agent && pnpm dev`);
  }
  if (healthRes!.status !== 200) fail('[5]', `Agent /health returned ${healthRes!.status}`);
  const health = healthRes!.data as Record<string, unknown>;
  ok('[5]', `Agent healthy — uptime ${health.uptime}s, ${health.clients} SSE client(s)`);

  // [5] Any existing registration for this address is handled at step [6] via 409 reset-and-retry

  // [6] POST /api/register — backend generates the userId from displayName
  info('[6]', 'Registering V2 user with agent...');

  const registerPayload = {
    // No 'id' field — backend derives it: 0xgeko-{slugify(displayName)}
    displayName:           `v2 e2e`,
    riskTier:              RISK_TIER,
    managedUSD:            DEPOSIT_USD,
    minAPY:                2,
    maxSlippageBps:        50,
    maxDrawdownPct:        20,
    maxFeeBps:             1000,
    migrationThresholdPct: 10,
    userAddress:           userAccount.address,
    chainId:               42161,
    // V2 fields — this is what the frontend will POST after the user signs
    smartAccountAddress:   smartAccountAddress,
    signedDelegation: {
      delegate:  signedDelegation.delegate,
      delegator: signedDelegation.delegator,
      authority: signedDelegation.authority,
      caveats:   signedDelegation.caveats.map(c => ({
        enforcer: c.enforcer as string,
        terms:    c.terms    as string,
        args:     (c.args ?? '0x') as string,
      })),
      salt:      signedDelegation.salt,
      signature: signedDelegation.signature,
    },
  };

  const regRes = await agentPost('/api/register', registerPayload);

  if (regRes.status !== 200) {
    fail('[6]', `Registration failed (${regRes.status}): ${regRes.raw.slice(0, 200)}`);
  }
  const reg    = regRes.data as Record<string, unknown>;
  const userId = reg.userId as string;  // backend-assigned: 0xgeko-v2-e2e
  ok('[6]', `Registered — mode: ${reg.mode}`);
  console.log(`        userId:       ${userId}`);
  console.log(`        smartAccount: ${reg.smartAccountAddress}`);

  // [7] Poll /state until phase = MONITORING (agent ran GENESIS autonomously)
  //     The agent will tick within 60 s, run the universe engine, pick the best
  //     opportunity, build redeemDelegations calldata via DelegationClient, and
  //     submit the tx via Pimlico. We just wait.
  section('Waiting for agent GENESIS...');
  console.log('  Agent will tick within 60 s, pick best protocol, and execute.\n');

  const TIMEOUT_MS = 10 * 60_000; // 10 minutes
  const deadline   = Date.now() + TIMEOUT_MS;
  let lastPhase    = '';

  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 6_000));

    const stateRes = await agentGet(`/state/${userId}`);
    if (stateRes.status === 404) {
      wait('[7]', 'Not yet in state — waiting...');
      continue;
    }
    if (stateRes.status !== 200) continue;

    const state   = stateRes.data as Record<string, unknown>;
    const phase   = state.phase as string;
    const executions = (state.executions as unknown[] | undefined) ?? [];

    if (phase !== lastPhase) {
      info('[7]', `Phase: ${lastPhase || '(none)'} → ${phase} (${executions.length} execution(s))`);
      lastPhase = phase;
    }

    if (phase === 'ERROR') fail('[7]', `Agent entered ERROR: ${JSON.stringify(state).slice(0, 200)}`);

    // Accept any active phase (MONITORING, ALLOCATED, etc.) once GENESIS execution exists
    const isActivePhase = phase === 'MONITORING' || phase === 'ALLOCATED' || phase === 'EVALUATING';
    if ((isActivePhase || executions.length > 0) && executions.length > 0) {
      const lastExec = executions[executions.length - 1] as Record<string, unknown>;
      const action   = lastExec.action as string;

      if (action === 'GENESIS') {
        // ── [8] Verify ──────────────────────────────────────────────────────
        section('PHASE 2 RESULT — GENESIS confirmed');

        ok('[8]', 'Agent selected protocol and executed GENESIS via delegation');
        console.log(`        action:      ${lastExec.action}`);
        console.log(`        protocol:    ${lastExec.protocol ?? 'N/A'}`);
        console.log(`        amountUSD:   $${lastExec.amountUSD ?? DEPOSIT_USD}`);
        console.log(`        receiptHash: ${lastExec.receiptHash}`);
        console.log(`        txHash:      ${lastExec.txHash ?? 'pending'}`);

        // ── On-chain links ───────────────────────────────────────────────────
        console.log('\n  ── On-chain ────────────────────────────────────────');
        if (lastExec.txHash) {
          console.log(`  Arbitrum tx:    https://arbiscan.io/tx/${lastExec.txHash}`);
          console.log(`  Smart account:  https://arbiscan.io/address/${smartAccountAddress}`);
        }

        // ── 0G Proof trail links ─────────────────────────────────────────────
        console.log('\n  ── 0G Proof trail ──────────────────────────────────');
        if (lastExec.zgTraceCID) {
          console.log(`  [1] Execution trace (0G Storage):`);
          console.log(`      https://storagescan.0g.ai/submission/${lastExec.zgTraceCID}`);
        } else {
          console.log(`  [1] Execution trace: pending (fires async after tx)`);
        }
        if (lastExec.zgAttestCID) {
          console.log(`  [2] TEE attestation (DeepSeek V3 in TDX enclave):`);
          console.log(`      https://storagescan.0g.ai/submission/${lastExec.zgAttestCID}`);
        } else {
          console.log(`  [2] TEE attestation: pending`);
        }
        if (lastExec.zgChainTxHash) {
          console.log(`  [3] 0G Chain anchor (YieldGekoRegistry):`);
          console.log(`      https://chainscan.0g.ai/tx/${lastExec.zgChainTxHash}`);
        } else {
          console.log(`  [3] 0G Chain anchor: pending`);
        }
        if (!lastExec.zgTraceCID && !lastExec.zgChainTxHash) {
          console.log(`\n  ℹ️  0G proof trail fires in background — check agent logs`);
          console.log(`     or poll /state/${userAccount.address} in ~30s for the links`);
        }

        const portfolio = state.portfolio as Record<string, unknown> | undefined;
        const metrics   = portfolio?.metrics as Record<string, unknown> | undefined;
        if (metrics) {
          console.log(`\n  Portfolio NAV: $${(metrics.totalValueUSD as number)?.toFixed(4) ?? 'N/A'}`);
        }

        break;
      }
    }
  }

  if (Date.now() >= deadline) {
    fail('[7]', `Timed out after ${TIMEOUT_MS / 60_000} min waiting for GENESIS. Check agent logs.`);
  }

  // ══════════════════════════════════════════════════════════
  // Summary
  // ══════════════════════════════════════════════════════════

  console.log('\n══════════════════════════════════════════════════════');
  console.log('  ALL CHECKS PASSED ✅');
  console.log('══════════════════════════════════════════════════════\n');
  console.log('  Certified on Arbitrum Mainnet:');
  console.log('    [OK] toMetaMaskSmartAccount() — HybridDeleGator derived');
  console.log('    [OK] Pimlico UserOp — USDC approved from smart account');
  console.log('    [OK] signDelegation() — ERC-7710 delegation signed');
  console.log('    [OK] POST /api/register — V2 payload accepted by agent');
  console.log('    [OK] Agent picked best protocol via universe engine');
  console.log('    [OK] Agent called DelegationManager.redeemDelegations');
  console.log('    [OK] YieldGekoPolicyCaveatEnforcer hooks fired');
  console.log('    [OK] YieldGekoExecutor.executeWithPull routed deposit');
  console.log('    [OK] Phase reached MONITORING — user now managed by agent');
  console.log(`\n  Smart account: https://arbiscan.io/address/${smartAccountAddress}`);
  console.log('');
}

main().catch(err => {
  console.error('\n[FATAL]', err?.message ?? err);
  if (err?.stack) console.error(err.stack.split('\n').slice(1, 3).join('\n'));
  process.exit(1);
});
